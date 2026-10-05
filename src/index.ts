/**
 * dsh-feishu-plugin —— DeepSeek Harness（Cordis）插件入口。
 *
 * 形态与 dsh 插件约定一致：导出 `name` / `inject` / `Config` / `apply`，
 * 由 profile 的 `cordis.patch.yml` 里一条 `insert` 条目挂载（见 cordis.patch.yml）。
 *
 * 进度：
 * - M1 ✅ 配置 schema + 卡片 token 内核
 * - M2 ✅ 长连接 supervisor；入站决策；单人 owner 绑定
 * - M3a ✅ 话题↔会话映射（storageDomain）、会话创建、真实投递
 * - M3b ✅ 运行卡（流式回显 + 工具块 + 强停按钮）、`/help` `/status` `/stop`
 * - M4 ⬜ 审批卡 / 提问卡 / 看门狗 / 附件
 * - M5 ⬜ 扫码 onboarding、locale/icon、peer 区间、发布
 *
 * 官方文档核对过的三条硬规则（`docs/user/develop/`）：
 * 1. 必需服务写 `inject` 后属性访问；**可选服务用 `ctx.inject([...], sub => …)`**
 *    —— 实测 `ctx.get('sessionTitle')` 返回 undefined，而属性访问会抛
 *    `cannot get property "x" without inject`（M3a 首次真实投递就栽在这里）。
 * 2. 与宿主共享实例的 dsh 包必须同时出现在 `peerDependencies` 与 `devDependencies`。
 * 3. 卸载清理逆序但异步并发 → 顺序相关的清理放进同一个 `ctx.effect`，并用 `disposed` 标志
 *    防止拆除过程中的事件回调继续访问已停止的通道。
 *
 * 关于"保活"：dsh 没有 opencode 的 location 空闲回收，插件与宿主进程同寿，
 * `ctx.effect` 负责卸载清理；会话不存活时按需 `ctx.agents.resume()` 恢复。
 */
import type { Context } from "@deepseek-ai/cordis";
import { COMMANDS, findCommand, parseCommand } from "./bridge/commands.js";
import { prepareDelivery, sendDelivery, type DeliveryPort } from "./bridge/deliver.js";
import { decideInbound, type InboundMessageLike } from "./bridge/inbound.js";
import {
  mapSessionEvent,
  mapStreamFrame,
  RunCard,
  type AssistantStreamFrameLike,
  type CardPort,
  type SessionEventLike,
} from "./bridge/outbound.js";
import { isTerminal } from "./bridge/run-state.js";
import { MemoryTopicStore, openTopicStore, topicKey, type TopicStore } from "./bridge/topics.js";
import { Config, resolveConfig, type Config as ConfigShape } from "./config.js";
import { createDshPort } from "./dsh/port.js";
import { buildHelpCard, buildNoticeCard } from "./feishu/cards.js";
import { createFeishuChannel } from "./feishu/channel.js";
import { ConnectionSupervisor } from "./feishu/connection.js";
import { createLogger, createLogSink, errorMessage, maskId } from "./logger.js";
import { OwnerPolicy } from "./security/allowlist.js";
import { ReplayGuard, signStop, verifyStop } from "./security/token.js";
import { MemoryStorage } from "./types.js";

export const name = "feishu";

/** 必需服务：投递消息要 agents；话题映射要 storageDomain。 */
export const inject: readonly string[] = ["agents", "storageDomain"];

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

/** 强停按钮的 value 形状（见 `src/feishu/cards.ts` 的 `stop.value`）。 */
interface StopActionValue {
  readonly kind?: string;
  readonly token?: string;
}

function readStopValue(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as StopActionValue;
  return candidate.kind === "stop" && typeof candidate.token === "string" ? candidate.token : undefined;
}

/**
 * 一次性打开话题映射表。
 *
 * 域表打开失败（后端未配置 / 域版本不符）不致命：降级为内存表并告警 ——
 * 映射丢失只会导致"下次消息新建一个会话"，不该让整条飞书通道不可用。
 */
async function resolveTopicStore(ctx: Context, log: ReturnType<typeof createLogger>): Promise<TopicStore> {
  try {
    return await openTopicStore(ctx.storageDomain, log);
  } catch (error) {
    log.warn("话题映射域表打开失败，降级为内存表（映射不跨重启）", { reason: errorMessage(error) });
    return new MemoryTopicStore();
  }
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

  let storePromise: Promise<TopicStore> | undefined;
  const store = (): Promise<TopicStore> => (storePromise ??= resolveTopicStore(ctx, log));

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
  /** sessionId → chatId（事件回来时要找到发到哪个 chat）。 */
  const sessionChats = new Map<string, string>();
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

  async function sendNotice(chatId: string, text: string, template?: "blue" | "grey" | "green" | "red" | "orange") {
    try {
      await channel.send(chatId, { card: buildNoticeCard({ text, ...(template ? { template } : {}) }) });
    } catch (error) {
      log.warn("提示卡发送失败", { reason: errorMessage(error) });
    }
  }

  /** 结束并登记一张运行卡（终态刷新后从活动表移除）。 */
  async function settleRunCard(sessionId: string): Promise<void> {
    const card = runCards.get(sessionId);
    if (!card) return;
    await card.finish();
    await card.drain();
    runCards.delete(sessionId);
  }

  async function handleCommand(text: string, message: { chatId: string }): Promise<void> {
    const parsed = parseCommand(text);
    const spec = parsed ? findCommand(parsed.name) : undefined;
    if (!spec) {
      await sendNotice(message.chatId, `未知命令：\`${text}\`\n\n${helpMarkdown()}`, "orange");
      return;
    }

    switch (spec.name) {
      case "/help":
        await channel.send(message.chatId, { card: buildHelpCard(COMMANDS) });
        return;
      case "/status": {
        const topicStore = await store();
        const bound = topicStore.entries().length;
        await sendNotice(
          message.chatId,
          [
            "**飞书桥状态**",
            `- 长连接：\`${supervisor.state}\``,
            `- 已绑定会话：${bound}`,
            `- 权限门：\`${config.permissionGate}\``,
            `- 群入口：${config.groupEnabled ? "已开启" : "关闭（未申请群权限）"}`,
          ].join("\n"),
          "blue",
        );
        return;
      }
      case "/stop": {
        const topicStore = await store();
        const record = topicStore.get(topicKey(message));
        if (!record) {
          await sendNotice(message.chatId, "当前聊天还没有绑定会话。", "grey");
          return;
        }
        const agent = await port.resolveAgent(record.sessionId);
        if (!agent) {
          await sendNotice(message.chatId, "会话没有存活的 agent，无法中断。", "grey");
          return;
        }
        await agent.cancel({ kind: "user" });
        await sendNotice(message.chatId, `已请求中断会话 \`${record.sessionId}\`。`, "orange");
        return;
      }
      default:
        await sendNotice(message.chatId, helpMarkdown(), "grey");
    }
  }

  function helpMarkdown(): string {
    return COMMANDS.map((command) => `- \`${command.name}\` — ${command.description}`).join("\n");
  }

  // —— 飞书侧事件 ——

  channel.onReconnecting(() => supervisor.noteReconnecting());
  channel.onReconnected(() => supervisor.noteReconnected());

  channel.onReject((event) => {
    log.info("入站消息被通道策略拒绝", { reason: event.reason, chatId: maskId(event.chatId) });
  });

  channel.onCardAction(async (event) => {
    if (disposed) return;
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
    const agent = await port.resolveAgent(verified.claims.s);
    if (!agent) return { toast: { type: "warning", content: "会话已结束" } };
    await agent.cancel({ kind: "user" });
    log.info("已按卡片强停会话", { sessionId: verified.claims.s });
    return { toast: { type: "success", content: "已请求中断" } };
  });

  channel.onMessage(async (message) => {
    if (disposed) return;
    const allowed = await ownerPolicy.admit(message.senderId);
    const inbound = message as InboundMessageLike;
    const decision = decideInbound(inbound, {
      allowed,
      groupEnabled: config.groupEnabled,
      // M4：改为读 agent 投影状态（不轮询，用事件维护）。
      busy: false,
      busyDelivery: config.busyDelivery,
    });

    if (decision.kind === "ignore") {
      log.debug("忽略入站消息", { reason: decision.reason, sender: maskId(message.senderId) });
      return;
    }
    if (decision.kind === "command") {
      try {
        await handleCommand(decision.text, { chatId: message.chatId });
      } catch (error) {
        log.error("命令处理失败", { reason: errorMessage(error) });
      }
      return;
    }

    let attemptedSession: string | undefined;
    try {
      const topicStore = await store();
      // 顺序不能反：先解析/建会话 → 再发运行卡 → 最后才投递。
      // followup() 会立刻唤醒 agent，先投递再发卡会丢掉这一轮最早的流式事件（M3b 的双卡 bug）。
      const prepared = await prepareDelivery(topicStore, port, inbound, decision, {
        cwd: config.cwd,
        titleMaxChars: config.topicTitleMaxChars,
      });
      attemptedSession = prepared.sessionId;
      sessionChats.set(prepared.sessionId, message.chatId);

      let card = runCards.get(prepared.sessionId);
      if (card && isTerminal(card.currentState)) {
        // 上一轮已结束：收尾旧卡，这一轮换一张新卡。
        await settleRunCard(prepared.sessionId);
        card = undefined;
      }
      if (!card) {
        card = new RunCard(cardPort, log, {
          chatId: message.chatId,
          title: prepared.title,
          stopToken: signStop({ sessionID: prepared.sessionId, ttlMs: config.approvalTtlMs }, config.signSecret),
          throttleMs: config.cardThrottleMs,
          maxTextChars: config.cardMaxTextChars,
          maxToolBlocks: config.cardMaxToolBlocks,
          maxCardChars: config.cardMaxChars,
        });
        runCards.set(prepared.sessionId, card);
        await card.start();
      }

      await sendDelivery(prepared, port, inbound, decision);

      log.info("已投递到会话", {
        sessionId: prepared.sessionId,
        created: prepared.created,
        delivery: decision.delivery,
        attachments: decision.attachmentCount,
        chars: decision.text.length,
        sender: maskId(message.senderId),
      });
    } catch (error) {
      const reason = errorMessage(error);
      log.error("投递失败", { reason, sender: maskId(message.senderId) });
      // 卡片可能已经发出去了：收成失败态，绝不留下永远「运行中」的卡。
      if (attemptedSession) {
        const card = runCards.get(attemptedSession);
        if (card && !isTerminal(card.currentState)) {
          card.handle({ type: "turn-end", outcome: "failed", reason });
          await settleRunCard(attemptedSession);
        }
      }
      await sendNotice(message.chatId, `投递失败：${reason}`, "red");
    }
  });

  // —— dsh 侧事件：流式正文 + 持久结算 ——

  ctx.on("agent/assistant-stream", (payload) => {
    if (disposed) return;
    const sessionId = sessionIdOfAgent(payload.agent);
    if (!sessionId) return;
    const card = runCards.get(sessionId);
    if (!card) return;
    const event = mapStreamFrame(payload.frame as unknown as AssistantStreamFrameLike);
    if (event) card.handle(event);
  });

  ctx.on("session/event", (session, event) => {
    if (disposed) return;
    const sessionId = sessionIdOfSession(session);
    if (!sessionId) return;
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
      groupEnabled: config.groupEnabled,
      roots: config.allowedRoots.length,
      cardThrottleMs: config.cardThrottleMs,
    });
    supervisor.start();
    return async () => {
      // 先置位再拆：清理期间到达的事件/消息一律短路（卸载清理是并发执行的）。
      disposed = true;
      await supervisor.stop();
      for (const sessionId of [...runCards.keys()]) {
        await settleRunCard(sessionId);
      }
      sink?.close();
    };
  });
}
