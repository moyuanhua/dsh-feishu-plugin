/**
 * dsh-feishu-plugin —— DeepSeek Harness（Cordis）插件入口。
 *
 * 形态与 dsh 插件约定一致：导出 `name` / `inject` / `Config` / `apply`，
 * 由 profile 的 `cordis.patch.yml` 里一条 `insert` 条目挂载（见 cordis.patch.yml）。
 *
 * 进度（逐层搬运上游逻辑，每层先搬上游规格测试）：
 * - ✅ 配置 schema + 卡片按钮自签 token 内核
 * - ✅ 长连接 supervisor（世代化 + 有界退避 + dispose 收敛）
 * - ✅ **路由**（`bridge/routing.ts` ← 上游 routing.ts）
 * - ✅ **会话映射**（`bridge/session-map.ts` ← 上游 session-map.ts 五层 key + 多会话）
 * - ✅ **命令矩阵**（`bridge/commands.ts` ← 上游 commands.ts 16 命令 + 双 scope）
 * - ✅ **投递决策**（`bridge/delivery.ts` ← 上游 delivery.ts：steer/queue + 判活）
 * - ✅ 运行卡（流式正文 + 工具块 + 强停按钮，先发卡再投递）
 * - ⬜ 审批卡 / 提问卡 / 看门狗 / 附件 / 建会话表单 / 会话列表卡（后续层）
 *
 * 入站主流程与上游 `src/index.ts:816-918` 的 `handleMessage` 同序：
 *   p2p 门禁 → owner 白名单 → 空文本 → (threadRouting=false 回退) → 命令优先拦截 →
 *   路由（thread → root → create-in-thread → main-hint）→ 先发运行卡再投递
 *
 * cordis 服务访问的两条硬规则（实测）：必需服务写 `inject` 后属性访问；可选服务用
 * `ctx.inject([...], sub => …)`（`ctx.get(name)` 对未 inject 的服务返回 undefined）。
 *
 * 关于"保活"：dsh 没有 opencode 的 location 空闲回收，插件与宿主进程同寿，
 * `ctx.effect` 负责卸载清理；会话不存活时按需 `ctx.agents.resume()` 恢复。
 */
import type { Context } from "@deepseek-ai/cordis";
// 仅为载入 approval 事件的类型声明合并（`approval/request` 的类型来自该包）。
import type {} from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-user-questions";
import {
  defaultSessionTitle,
  helpText,
  isCommandAllowedInThread,
  parseCommand,
  threadForbiddenText,
  topicTitle,
} from "./bridge/commands.js";
import { ApprovalBridge } from "./bridge/approval.js";
import { attachmentNotice, ingestAttachments, type InboundResourceLike } from "./bridge/attachments.js";
import { QuestionBridge } from "./bridge/questions.js";
import { createSessionRecovery } from "./bridge/session-recovery.js";
import { startWatchdog } from "./bridge/watchdog.js";
import { deliverToSession, type DeliveryPort } from "./bridge/deliver.js";
import { ExecutionTracker } from "./bridge/delivery.js";
import { decideInbound, type InboundDecision, type InboundMessageLike } from "./bridge/inbound.js";
import {
  mapSessionEvent,
  mapStreamFrame,
  RunCard,
  type AssistantStreamFrameLike,
  type CardPort,
  type SessionEventLike,
} from "./bridge/outbound.js";
import { commandScope, decideRoute } from "./bridge/routing.js";
import { planSessionCommand } from "./bridge/session-commands.js";
import { isTerminal } from "./bridge/run-state.js";
import { SessionMap } from "./bridge/session-map.js";
import { Config, resolveConfig, type Config as ConfigShape } from "./config.js";
import { createDshPort } from "./dsh/port.js";
import { openDomainKv } from "./dsh/storage.js";
import { buildNoticeCard } from "./feishu/cards.js";
import { createFeishuChannel } from "./feishu/channel.js";
import type { CardActionResponse } from "@larksuite/channel";
import { ConnectionSupervisor } from "./feishu/connection.js";
import { createLogger, createLogSink, errorMessage, maskId } from "./logger.js";
import { matchesAny, OwnerPolicy } from "./security/allowlist.js";
import {
  ReplayGuard,
  signAllowSession,
  signApproval,
  signStop,
  verifyAllowSession,
  verifyApproval,
  verifyStop,
} from "./security/token.js";
import { MemoryStorage } from "./types.js";

export const name = "feishu";

/** 必需服务：投递消息要 agents；会话映射要 storageDomain。 */
export const inject: readonly string[] = ["agents", "storageDomain", "attachments"];

export { Config, resolveConfig };
export type { ResolvedConfig } from "./config.js";

/** 从 Session / Agent 上取会话 id（0.2.0-rc.2 的形状，做一点防御性兜底）。 */
function sessionIdOfSession(session: unknown): string | undefined {
  const candidate = session as { id?: unknown; header?: { id?: unknown } } | undefined;
  const raw = candidate?.id ?? candidate?.header?.id;
  return typeof raw === "string" ? raw : undefined;
}

function sessionIdOfAgent(agent: unknown): string | undefined {
  const candidate = agent as { session?: unknown; sessionId?: unknown } | undefined;
  const fromSession = sessionIdOfSession(candidate?.session);
  if (fromSession) return fromSession;
  return typeof candidate?.sessionId === "string" ? candidate.sessionId : undefined;
}

/** 强停按钮的 value 形状（见 `src/feishu/cards.ts`）。 */
interface StopActionValue {
  readonly kind?: string;
  readonly token?: string;
}

function readStopValue(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as StopActionValue;
  return candidate.kind === "stop" && typeof candidate.token === "string" ? candidate.token : undefined;
}

export function apply(ctx: Context, raw: ConfigShape = {}): void {
  const config = resolveConfig(raw);
  const sink = createLogSink(typeof config.logFile === "string" ? config.logFile : undefined);
  const log = createLogger({
    level: config.logLevel,
    ...(sink ? { sink: sink.sink } : {}),
  });

  if (!config.enabled) {
    log.warn("未配置飞书凭据（appId + appSecret/appSecretRef），插件保持禁用");
    sink?.close();
    return;
  }

  /** 拆除标志：清理开始后，所有事件/消息回调立即短路。 */
  let disposed = false;

  const ownerPolicy = new OwnerPolicy(new MemoryStorage(), config.allowUsers);
  const port: DeliveryPort = createDshPort(ctx, log);
  const stopGuard = new ReplayGuard(config.approvalTtlMs);
  /** 执行态跟踪（上游 `ExecutionTracker`）：决定 steer / queue。 */
  const tracker = new ExecutionTracker();

  /**
   * 会话映射：懒打开域表（`ctx.storageDomain` 的一张 KV 表承载上游五层 key）。
   * 打开失败降级为内存 KV，保证通道可用（映射不跨重启）。
   */
  let sessionMapPromise: Promise<SessionMap> | undefined;
  let mapInstance: SessionMap | undefined;
  let closeKv: (() => void) | undefined;
  const sessionMap = (): Promise<SessionMap> =>
    (sessionMapPromise ??= (async () => {
      try {
        const kv = await openDomainKv(ctx.storageDomain, log);
        closeKv = kv.close;
        mapInstance = new SessionMap(kv, log);
        return mapInstance;
      } catch (error) {
        log.warn("会话映射域表打开失败，降级为内存表（映射不跨重启）", { reason: errorMessage(error) });
        mapInstance = new SessionMap(new MemoryStorage(), log);
        return mapInstance;
      }
    })());

  const channel = createFeishuChannel({
    appId: config.appId!,
    appSecret: config.appSecret!,
    ...(config.domain ? { domain: config.domain } : {}),
    allowUsers: config.allowUsers,
    groupEnabled: config.groupEnabled,
    log,
  });

  const cardPort: CardPort = {
    sendCard: async (chatId, card) => {
      const result = await channel.send(chatId, { card });
      return result.messageId;
    },
    patchCard: (messageId, card) => channel.updateCard(messageId, card),
  };

  /** sessionId → 运行卡（一个会话同一时刻只挂一张）。 */
  const runCards = new Map<string, RunCard>();
  /** sessionId → (callId → 工具名)：`tool/result` 不带 name，必须由 `tool/call` 配对。 */
  const pendingToolNames = new Map<string, Map<string, string>>();

  const supervisor = new ConnectionSupervisor({
    connect: () => channel.connect(),
    disconnect: () => channel.disconnect(),
    log,
    backoff: {
      initialMs: config.connectBackoffInitialMs,
      maxMs: config.connectBackoffMaxMs,
      maxAttempts: config.connectBackoffMaxAttempts,
    },
    onState: (state, detail) => {
      if (state === "failed") log.error("长连接进入失败终态", { ...detail });
    },
  });

  /**
   * 审批桥：把 dsh 的 `approval/request` waterfall 接到飞书卡片。
   *
   * 安全边界（上游语义）：只有**本桥拥有**（有飞书映射）的会话才接管；无映射一律委托宿主，
   * 否则 GUI/TUI 会话会被挂在这里等飞书点击。
   */
  const approvals = new ApprovalBridge({
    config: {
      permissionGate: config.permissionGate,
      allowTools: config.allowTools,
      denyTools: config.denyTools,
      approvalTtlMs: config.approvalTtlMs,
      maxResourcesShown: config.approvalMaxResourcesShown,
    },
    log,
    cardPort,
    getLink: async (sessionId) => (await sessionMap()).resolveBySession(sessionId),
    setSessionMeta: async (sessionId, patch) => (await sessionMap()).setSessionMeta(sessionId, patch),
    isAllowed: (openId) => ownerPolicy.isAllowed(openId),
    sign: ({ requestID, sessionID, openId }) =>
      signApproval(
        { r: requestID, s: sessionID, u: openId, ttlMs: config.approvalTtlMs },
        config.signSecret,
      ),
    verify: (token, expect) =>
      verifyApproval(token, config.signSecret, expect ? { expect } : {}),
    replay: new ReplayGuard(config.approvalTtlMs),
    signAllowSession: ({ requestID, sessionID, action }) =>
      signAllowSession(
        { requestID, sessionID, action, ttlMs: config.approvalTtlMs },
        config.signSecret,
      ),
    verifyAllowSession: (token, expect) =>
      verifyAllowSession(token, config.signSecret, {
        ...(expect?.sessionID ? { expectSessionID: expect.sessionID } : {}),
        ...(expect?.action ? { expectAction: expect.action } : {}),
      }),
    hasSessionAllow: (sessionId, action) => {
      const link = mapInstance?.getLink(sessionId);
      return Boolean(link?.allowActions?.length && matchesAny(action, link.allowActions));
    },
  });

  /**
   * 提问桥：把 dsh 的 `user-questions/request` waterfall 接到飞书卡片。
   * 与审批桥同样的安全边界：只有本桥拥有的会话才接管，其余交回宿主。
   */
  const questions = new QuestionBridge({
    log,
    cardPort,
    getLink: async (sessionId) => (await sessionMap()).resolveBySession(sessionId),
    isAllowed: (openId) => ownerPolicy.isAllowed(openId),
    timeoutMs: config.questionTtlMs,
  });

  async function sendNotice(
    chatId: string,
    text: string,
    template?: "blue" | "grey" | "green" | "red" | "orange",
  ): Promise<void> {
    try {
      await channel.send(chatId, { card: buildNoticeCard({ text, ...(template ? { template } : {}) }) });
    } catch (error) {
      log.warn("提示卡发送失败", { reason: errorMessage(error) });
    }
  }

  /** 管理台提示卡（上游 `main-hint` 分支：没有 quickNew 时回提示卡，普通文本不进会话）。 */
  async function sendMainHint(chatId: string): Promise<void> {
    await sendNotice(
      chatId,
      [
        "**主聊天流 = 管理台**",
        "普通文本不会进入任何会话；先建会话，再在话题里发指令。",
        "",
        helpText("main"),
      ].join("\n"),
      "grey",
    );
  }

  /** 结束并登记一张运行卡（终态刷新后从活动表移除）。 */
  async function settleRunCard(sessionId: string): Promise<void> {
    const card = runCards.get(sessionId);
    if (!card) return;
    await card.finish();
    await card.drain();
    runCards.delete(sessionId);
  }

  /**
   * 会话恢复例程：**卡片强停按钮与看门狗共用**（上游一致性要求）。
   *
   * dsh 映射：`interrupt` → `agent.cancel({kind:'user'})`（默认清空 inbox，因此 `cancelQueued` 是 no-op）；
   * `finalizeCard` → 把运行卡收成 stopped 并结算；`notify` → 给该会话的 chat 发中断提示卡。
   */
  const recovery = createSessionRecovery({
    log,
    resolveLink: async (sessionId) => (await sessionMap()).resolveBySession(sessionId),
    interrupt: async (sessionId) => {
      const agent = await port.resolveAgent(sessionId);
      if (!agent) throw new Error("会话没有存活的 agent");
      await agent.cancel({ kind: "user" });
    },
    // dsh 的 cancel() 默认清空 inbox；没有 opencode 那种独立的 park 队列取消 API。
    cancelQueued: async () => ({ cancelled: 0 }),
    markEnded: (sessionId) => tracker.markEnded(sessionId),
    finalizeCard: (sessionId, text) => {
      const card = runCards.get(sessionId);
      if (!card) return;
      card.handle({ type: "turn-end", outcome: "stopped", reason: text });
      void settleRunCard(sessionId);
    },
    notify: async (sessionId, reason, ok) => {
      const link = await (await sessionMap()).resolveBySession(sessionId);
      if (!link) return;
      await sendNotice(link.chatId, `⏹ 已中断（${reason}）${ok ? "" : "，但过程有异常（见日志）"}`, "orange");
    },
  });

  /**
   * 命令分发（上游 `index.ts:849-852` 的"命令优先拦截"落点）。
   *
   * 顺序与上游一致：解析 → 话题内白名单校验（被禁则引导回主聊天流）→ 按 scope 执行。
   * 已完整移植 `/help` 与 `/stop`；其余命令依赖后续层（会话列表卡 / 建会话表单 /
   * 模型与权限预设），这里显式回报尚未移植，绝不假装成功。
   */
  async function handleCommand(
    text: string,
    message: { chatId: string; threadId?: string; senderId?: string; messageId?: string },
  ): Promise<void> {
    const parsed = parseCommand(text);
    if (!parsed) return;
    const scope = commandScope(Boolean(message.threadId));

    if (scope === "thread" && !isCommandAllowedInThread(parsed.name)) {
      await sendNotice(message.chatId, threadForbiddenText(parsed.raw), "grey");
      return;
    }

    switch (parsed.name) {
      case "help":
        await sendNotice(message.chatId, helpText(scope), "blue");
        return;
      case "new":
      case "form": {
        // 最小可用版 `/new`（完整表单卡＝目录/模型/权限预填属于后续层）：
        // 建会话 → 记为当前 → 发一张"根卡"并把它的 messageId 绑成 root。
        // 用户**回复**这张卡时消息只带 root_id（没有 thread_id），正是
        // `decideRoute` 的 root 兜底分支所在（上游 `session-map.ts` 的 root 映射即此用途）。
        const openId = message.senderId ?? "";
        const title = parsed.args || defaultSessionTitle(Date.now());
        const sessionId = await port.createSession({ cwd: config.cwd, title });
        const map = await sessionMap();
        await map.addSession(message.chatId, sessionId, title, openId, { setActive: true });
        const root = await channel.send(message.chatId, {
          card: buildNoticeCard({
            title: "会话已创建",
            text: `${title}\n\n**回复本条消息**即可开始对话（回复即进入该会话的话题）。`,
            template: "green",
          }),
        });
        await map.bindRoot(root.messageId, sessionId);
        log.info("已建会话并开话题锚点", { sessionId, rootMessageId: root.messageId });
        return;
      }
      case "stop": {
        const map = await sessionMap();
        const target =
          scope === "thread" && message.threadId
            ? (await map.resolveByThread(message.threadId))?.sessionID
            : (await map.getActive(message.chatId))?.sessionID;
        if (!target) {
          await sendNotice(message.chatId, "当前聊天还没有绑定会话。", "grey");
          return;
        }
        const result = await recovery.interrupt(target, "/stop");
        await sendNotice(
          message.chatId,
          `已请求中断会话 \`${target}\`（${result.ok ? "成功" : "有异常，见日志"}）。`,
          result.ok ? "orange" : "red",
        );
        return;
      }
      default:
        break;
    }

    // 其余命令交给纯规划器（会话列表 / 切换 / 档位 / 插队），执行器只翻译计划。
    const mapForCommand = await sessionMap();
    const sessions = await mapForCommand.listSessions(message.chatId);
    const activeId = mapForCommand.getSessionIdForChat(message.chatId);
    const threadSessionId = message.threadId
      ? (await mapForCommand.resolveByThread(message.threadId))?.sessionID
      : undefined;
    const targetId = scope === "thread" ? threadSessionId : activeId;
    const link = targetId ? await mapForCommand.resolveBySession(targetId) : undefined;

    const plan = planSessionCommand({
      parsed,
      scope,
      sessions,
      ...(activeId ? { activeId } : {}),
      ...(threadSessionId ? { threadSessionId } : {}),
      ...(link ? { link } : {}),
    });

    switch (plan.kind) {
      case "notice":
        await sendNotice(message.chatId, plan.text, plan.template);
        return;
      case "set-active":
        await mapForCommand.setActive(message.chatId, plan.sessionId);
        await sendNotice(message.chatId, plan.note, "green");
        return;
      case "set-perm":
        await mapForCommand.setSessionMeta(plan.sessionId, { perm: plan.perm });
        log.info("会话权限档位已更新", { sessionId: plan.sessionId, perm: plan.perm });
        await sendNotice(message.chatId, plan.note, "green");
        return;
      case "steer": {
        // 强制插队：用 synthesized message 走同一投递路径（forceSteer → decideDelivery 返回 steer）。
        const synthesized = {
          messageId: message.messageId ?? `cmd_${Date.now()}`,
          chatId: message.chatId,
          chatType: "p2p" as const,
          ...(message.senderId ? { senderId: message.senderId } : {}),
          ...(message.threadId ? { threadId: message.threadId } : {}),
          content: plan.text,
        };
        await runInSession(plan.sessionId, synthesized, { kind: "deliver", text: plan.text, attachmentCount: 0 }, {
          forceSteer: true,
        });
        return;
      }
      case "unsupported":
        await sendNotice(
          message.chatId,
          `命令 \`/${plan.raw}\` 尚未移植到 dsh 版：${plan.reason}。\n\n${helpText(scope)}`,
          "orange",
        );
        return;
    }
  }

  /**
   * 投递到已解析好的会话：**先发运行卡，再投递**。
   *
   * 顺序来自上游 `beginRun`（`src/index.ts:1242`）：`followup()` 会立刻唤醒 agent，
   * 先投递再发卡会丢掉这一轮最早的流式事件（卡片会永远停在「运行中」，实测出现过双卡）。
   */
  async function runInSession(
    sessionId: string,
    message: InboundMessageLike,
    decision: Extract<InboundDecision, { kind: "deliver" }>,
    options: { readonly forceSteer?: boolean } = {},
  ): Promise<void> {
    const running = options.forceSteer ? true : tracker.isRunning(sessionId);

    let card = runCards.get(sessionId);
    if (card && isTerminal(card.currentState)) {
      await settleRunCard(sessionId);
      card = undefined;
    }
    if (!card) {
      const map = await sessionMap();
      const entry = await map.getSession(message.chatId, sessionId);
      card = new RunCard(cardPort, log, {
        chatId: message.chatId,
        title: entry?.title || "飞书会话",
        stopToken: signStop({ sessionID: sessionId, ttlMs: config.approvalTtlMs }, config.signSecret),
        throttleMs: config.cardThrottleMs,
        maxTextChars: config.cardMaxTextChars,
        maxToolBlocks: config.cardMaxToolBlocks,
        maxCardChars: config.cardMaxChars,
      });
      runCards.set(sessionId, card);
      await card.start();
    }

    tracker.markStarted(sessionId);

    // 入站附件：下载 → 交给附件服务换持久引用；失败/不支持类型降级为占位文本（不阻断消息）。
    const resources = (message.resources ?? []) as readonly InboundResourceLike[];
    let parts: unknown[] = [];
    let text = decision.text;
    if (resources.length > 0) {
      const ingested = await ingestAttachments(message.messageId, resources, {
        log,
        download: async ({ messageId, fileKey, type }) => {
          const data = await channel.downloadResource(messageId, fileKey, type);
          return { data: new Uint8Array(data) };
        },
        admitImage: async (input) => {
          const store = port.attachments;
          if (!store) throw new Error("附件服务不可用");
          return store.admitImage(input);
        },
        saveFile: async (input) => {
          const store = port.attachments;
          if (!store) throw new Error("附件服务不可用");
          return store.saveFile(input);
        },
        maxBytes: config.maxAttachmentBytes,
        timeoutMs: config.attachmentTimeoutMs,
      });
      parts = ingested.filter((item) => item.ok).map((item) => item.part);
      const notice = attachmentNotice(ingested);
      if (notice) text = `${text}\n\n${notice}`;
      log.info("附件已处理", { sessionId, total: resources.length, accepted: parts.length });
    }

    try {
      const outcome = await deliverToSession(port, sessionId, message, { ...decision, text }, {
        running,
        busyDelivery: options.forceSteer ? "steer" : config.busyDelivery,
        ...(parts.length > 0 ? { parts } : {}),
      });
      log.info("已投递到会话", {
        sessionId,
        delivery: outcome.delivery,
        attachments: decision.attachmentCount,
        chars: decision.text.length,
        sender: maskId(message.senderId),
      });
    } catch (error) {
      const reason = errorMessage(error);
      log.error("投递失败", { reason, sender: maskId(message.senderId) });
      card.handle({ type: "turn-end", outcome: "failed", reason });
      await settleRunCard(sessionId);
      await sendNotice(message.chatId, `投递失败：${reason}`, "red");
    }
  }

  // —— 飞书侧事件 ——

  channel.onReconnecting(() => supervisor.noteReconnecting());
  channel.onReconnected(() => supervisor.noteReconnected());

  channel.onReject((event) => {
    log.info("入站消息被通道策略拒绝", { reason: event.reason, chatId: maskId(event.chatId) });
  });

  channel.onCardAction(async (event) => {
    if (disposed) return;
    // 审批按钮优先（审批 value 形状与强停不同，桥对非审批 value 返回 undefined）。
    const approvalResponse = await approvals.handleCardAction(event);
    if (approvalResponse !== undefined && approvalResponse !== null) return approvalResponse as CardActionResponse;
    const questionResponse = await questions.handleCardAction(event);
    if (questionResponse !== undefined && questionResponse !== null) {
      return questionResponse as CardActionResponse;
    }

    const token = readStopValue(event.action.value);
    if (!token) return;
    const operator = event.operator.openId;
    if (!ownerPolicy.isAllowed(operator)) {
      log.warn("拒绝非白名单用户的卡片操作", { sender: maskId(operator) });
      return { toast: { type: "error", content: "无权操作" } };
    }
    const verified = verifyStop(token, config.signSecret);
    if (!verified.ok) {
      log.warn("强停 token 校验失败", { reason: verified.reason });
      return { toast: { type: "error", content: "操作已失效，请重新发起" } };
    }
    if (!stopGuard.consume(verified.claims.n, config.approvalTtlMs)) {
      return { toast: { type: "warning", content: "该操作已被处理" } };
    }
    const result = await recovery.interrupt(verified.claims.s, "强制停止");
    log.info("已按卡片强停会话", { sessionId: verified.claims.s, ok: result.ok });
    return result.ok
      ? { toast: { type: "success", content: "已请求中断" } }
      : { toast: { type: "error", content: "中断过程有异常，见日志" } };
  });

  /** 入站主流程（与上游 `handleMessage` 同序）。 */
  channel.onMessage(async (message) => {
    if (disposed) return;
    const inbound = message as InboundMessageLike;

    // 1) owner 白名单（首个发消息者绑定为 owner）。
    const allowed = await ownerPolicy.admit(message.senderId);

    // 2) 门禁与命令识别（群开关 / bot 回环 / 空消息 / 命令）。
    const gate = decideInbound(inbound, { allowed, groupEnabled: config.groupEnabled });
    if (gate.kind === "ignore") {
      log.debug("忽略入站消息", { reason: gate.reason, sender: maskId(message.senderId) });
      return;
    }

    // 3) 命令优先拦截：绝不把 `/xxx` 当 prompt 发给模型。
    if (gate.kind === "command") {
      try {
        await handleCommand(gate.text, {
          chatId: message.chatId,
          messageId: message.messageId,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          ...(message.senderId ? { senderId: message.senderId } : {}),
        });
      } catch (error) {
        log.error("命令处理失败", { reason: errorMessage(error) });
      }
      return;
    }

    const map = await sessionMap();

    // 4) threadRouting=false 的回退：忽略 thread/root，普通文本进"当前活动会话"。
    if (!config.threadRouting) {
      const active = await map.getActive(message.chatId);
      if (!active) {
        await sendMainHint(message.chatId);
        return;
      }
      await runInSession(active.sessionID, inbound, gate);
      return;
    }

    // 5) 路由：thread 命中 → root 命中（即使没有 threadId 也算，回复卡片走这条）
    //    → 话题首条消息建会话 → 主聊天流回管理台提示卡。
    const hasThread = Boolean(message.threadId);
    const threadLink = hasThread ? await map.resolveByThread(message.threadId!) : undefined;
    const rootLink = !threadLink && message.rootId ? await map.resolveByRoot(message.rootId) : undefined;
    const route = decideRoute({
      hasThread,
      isCommand: false,
      threadKnown: Boolean(threadLink),
      rootKnown: Boolean(rootLink),
    });

    if (route.kind === "main-hint") {
      await sendMainHint(message.chatId);
      return;
    }

    if (route.kind === "use-session") {
      const sessionId = threadLink?.sessionID ?? rootLink?.sessionID;
      if (!sessionId) return;
      const anchor = message.rootId ?? message.messageId;
      // root 命中补写 thread 映射；thread 命中但缺锚点时补齐锚点（审批卡出站要落同一话题）。
      if (route.source === "root" || (threadLink && !threadLink.anchorMessageId)) {
        if (message.threadId) {
          await map.bindThread(message.threadId, sessionId, message.chatId, message.senderId ?? "", anchor);
        }
      }
      // 该会话若有「等待自由文本」的提问字段，这条文本作为答案消费，不再当 prompt。
      if (questions.consumeText(sessionId, gate.text)) {
        log.debug("聊天文本已作为提问答案消费", { sessionId });
        return;
      }
      log.debug("话题路由命中会话", { source: route.source, sessionId, threadId: message.threadId });
      await runInSession(sessionId, inbound, gate);
      return;
    }

    // create-in-thread：话题内第一条消息 → 新建会话并绑定 thread/root。
    const title = topicTitle(gate.text, config.topicTitleMaxChars);
    const sessionId = await port.createSession({ cwd: config.cwd, title });
    await map.addSession(message.chatId, sessionId, title, message.senderId ?? "", { setActive: false });
    const anchor = message.rootId ?? message.messageId;
    await map.bindThread(message.threadId!, sessionId, message.chatId, message.senderId ?? "", anchor);
    await map.bindRoot(anchor, sessionId);
    log.info("话题新建会话", { sessionId, threadId: message.threadId, chatId: maskId(message.chatId) });
    await runInSession(sessionId, inbound, gate);
  });

  // —— dsh 侧事件：判活（steer/queue）+ 流式正文 + 持久结算 ——

  // 审批：waterfall 直接返回结果词（只有 allowed-once 是授权）。
  ctx.on("approval/request", (req, next) =>
    approvals.handle(sessionIdOfAgent(req.agent), req, () => next()),
  );

  // 提问：waterfall 直接返回结构化答案；无法作答（无映射 / 超时 / 取消）时交回宿主。
  ctx.on("user-questions/request", (req, next) =>
    questions.handle(sessionIdOfAgent(req.agent), req, () => next()),
  );

  ctx.on("agent/assistant-stream", (payload) => {
    if (disposed) return;
    const sessionId = sessionIdOfAgent(payload.agent);
    if (!sessionId) return;
    tracker.touch(sessionId);
    const card = runCards.get(sessionId);
    if (!card) return;
    const event = mapStreamFrame(payload.frame as unknown as AssistantStreamFrameLike);
    if (event) card.handle(event);
  });

  ctx.on("session/event", (session, event) => {
    if (disposed) return;
    const sessionId = sessionIdOfSession(session);
    if (!sessionId) return;
    tracker.touch(sessionId);
    if (event.type === "step/start") tracker.markStarted(sessionId);
    if (event.type === "turn/end") tracker.markEnded(sessionId);

    const card = runCards.get(sessionId);
    if (!card) return;

    // tool/call → 记住 callId→name；tool/result → 用它补上 name（事件本身不带名字）。
    if (event.type === "tool/call") {
      const callId = String(event.data.callId);
      const name = event.data.name;
      const names = pendingToolNames.get(sessionId) ?? new Map<string, string>();
      names.set(callId, name);
      pendingToolNames.set(sessionId, names);
      card.handle({ type: "tool-start", name });
      return;
    }
    if (event.type === "tool/result") {
      // 结果消息自己带 toolCallId（与 tool/call 的 callId 配对），事件层没有 callId 字段。
      const callId = String(event.data.message.toolCallId);
      const names = pendingToolNames.get(sessionId);
      const name = names?.get(callId);
      names?.delete(callId);
      if (!name) return;
      const detail = event.data.error?.reason;
      card.handle({
        type: "tool-end",
        name,
        ok: event.data.message.isError !== true,
        ...(detail ? { detail } : {}),
      });
      return;
    }

    const mapped = mapSessionEvent(event as unknown as SessionEventLike);
    if (!mapped) return;
    card.handle(mapped);

    if (mapped.type === "turn-end") {
      pendingToolNames.delete(sessionId);
      void settleRunCard(sessionId);
    }
  });

  ctx.effect(() => {
    log.info("已加载", {
      domain: config.domain,
      gate: config.permissionGate,
      busyDelivery: config.busyDelivery,
      threadRouting: config.threadRouting,
      groupEnabled: config.groupEnabled,
      roots: config.allowedRoots.length,
      cardThrottleMs: config.cardThrottleMs,
      questionTtlMs: config.questionTtlMs,
    });
    supervisor.start();
    // 看门狗：陈旧执行 → 真实中断（等待用户点击的审批/提问算「合法等待」，不误杀）。
    const stopWatchdog =
      config.staleExecutionMs > 0
        ? startWatchdog({
            log,
            staleExecutionMs: config.staleExecutionMs,
            staleExecutions: () =>
              tracker.stale(config.staleExecutionMs, Date.now(), (sessionId) => {
                return approvals.hasPendingFor(sessionId) || questions.hasPendingFor(sessionId);
              }),
            // dsh 没有 opencode 的 park 队列；排队由宿主 inbox 管理，取消已由 interrupt 覆盖。
            staleQueued: () => [],
            recover: (sessionId, reason) => recovery.recover(sessionId, reason),
          })
        : () => {};
    return async () => {
      // 先置位再拆：清理期间到达的事件/消息一律短路（卸载清理是并发执行的）。
      disposed = true;
      stopWatchdog();
      approvals.dispose();
      questions.dispose();
      await supervisor.stop();
      for (const sessionId of [...runCards.keys()]) {
        await settleRunCard(sessionId);
      }
      closeKv?.();
      sink?.close();
    };
  });
}
