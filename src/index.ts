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
import { readdirSync } from "node:fs";
import { join } from "node:path";
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
import { presetLabel } from "./bridge/perm-presets.js";
import { BOT_MENU_EVENT, parseBotMenuEvent } from "./bridge/menu.js";
import {
  buildSetupFormCard,
  isSetupSubmit,
  parseSetupSubmit,
  splitModelRef,
  type SetupModelChoice,
} from "./bridge/setup-form.js";
import {
  buildIntentPrompt,
  parseIntentDecision,
  resolveIntentDir,
  resolveIntentModel,
  type IntentCandidateDir,
  type IntentModelOption,
} from "./bridge/intent.js";
import { createIntentGenerator } from "./dsh/intent.js";
import { planSessionCommand } from "./bridge/session-commands.js";
import { isTerminal } from "./bridge/run-state.js";
import { SessionMap } from "./bridge/session-map.js";
import { attachAgentDefaultModel, resolveModel } from "./dsh/model.js";
import { createHostSessionQuery, type HostSessionQuery } from "./dsh/session-query.js";
import {
  paginate,
  sortByActivityDesc,
  type CatalogInput,
  type CatalogPage,
} from "./bridge/session-catalog.js";
import {
  buildSessionListCard,
  buildSessionMissingCard,
  buildSessionRootCard,
  parseSessionListAction,
  type SessionListAction,
} from "./feishu/session-cards.js";
import {
  dominantPhase,
  INITIAL_TOPIC_STATUS,
  reduceTopicStatus,
  topicStatusView,
  type TopicStatusState,
} from "./bridge/topic-status.js";
import { resolveWorkingDir } from "./bridge/dirs.js";
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
import { MemoryStorage, type PermissionPreset } from "./types.js";

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
  /** 宿主默认模型（可选服务）；拿不到 + 没配覆盖 = 拒绝建会话。 */
  const getHostModel = attachAgentDefaultModel(ctx, log);

  /** 解析模型路由的公共入口（建会话与 resume 共用同一套规则）。 */
  const currentModel = () =>
    resolveModel(
      getHostModel,
      { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort },
      log,
    );

  const port: DeliveryPort = createDshPort(ctx, log, {
    // resume 与会话创建共用同一套模型解析：否则 agent 被回收后下一条消息会
    // 以"没有模型"的状态恢复，重现同一个失败。
    resolveAgentOptions: () => {
      const model = currentModel();
      return model.ok ? model.selection : undefined;
    },
  });
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
    sendCard: async (target, card) => {
      // 有 replyTo 就走 reply —— 飞书的"话题"是**回复关系**，不是发送目标。
      // 顶层 send 会把卡片丢到主聊天流，用户看到的是"话题里只有我问的那句"。
      if (target.replyTo) {
        try {
          const result = await channel.reply(
            {
              chatId: target.chatId,
              messageId: target.replyTo,
              ...(target.threadId ? { threadId: target.threadId } : {}),
            },
            { card },
          );
          return result.messageId;
        } catch (error) {
          // 回复失败（消息被撤回 / id 失效）不能让整轮挂掉：退化成顶层发送，
          // 最坏结果是卡片位置不对，而不是这一轮没有任何反馈。
          log.warn("回复到话题失败，退化为顶层发送", {
            reason: errorMessage(error),
            messageId: target.replyTo,
          });
        }
      }
      const result = await channel.send(target.chatId, { card });
      return result.messageId;
    },
    patchCard: (messageId, card) => channel.updateCard(messageId, card),
  };

  /** sessionId → 运行卡（一个会话同一时刻只挂一张）。 */
  const runCards = new Map<string, RunCard>();
  /** open_id → 私聊 chat id（机器人菜单事件里没有 chat id，需要还原）。 */
  const chatIdByUser = new Map<string, string>();
  /** 已发出、等待提交的建会话表单：卡片 messageId → 待建会话信息。 */
  const pendingSetups = new Map<string, { readonly title: string; readonly chatId: string; readonly openId: string }>();

  /** 可选服务：列模型用（拿不到就不渲染模型下拉，而不是渲染一个空下拉）。 */
  let llmService:
    | {
        listProviders(): readonly { id: string; name?: string }[];
        listModels(provider: string): Promise<readonly { id: string; name?: string }[]>;
      }
    | undefined;
  ctx.inject(["llm"], (sub) => {
    llmService = (sub as unknown as { llm?: typeof llmService }).llm;
  });

  /** 列可选模型；任何失败都退化成"没有模型下拉"，绝不因此挡住建会话。 */
  async function listModelChoices(): Promise<SetupModelChoice[]> {
    if (!llmService) return [];
    try {
      const choices: SetupModelChoice[] = [];
      for (const provider of llmService.listProviders()) {
        const models = await llmService.listModels(provider.id);
        for (const model of models) {
          choices.push({
            provider: provider.id,
            model: model.id,
            label: `${model.name?.trim() || model.id}（${provider.id}）`,
          });
        }
      }
      return choices.slice(0, 30);
    } catch (error) {
      log.warn("列举模型失败，表单不渲染模型下拉", { reason: errorMessage(error) });
      return [];
    }
  }

  /** 扫一级子目录，给目录下拉用；失败就返回空列表。 */
  function listDirChoices(root: string): string[] {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => join(root, entry.name))
        .slice(0, 20);
    } catch (error) {
      log.debug("扫描允许根目录的一级子目录失败", { root, reason: errorMessage(error) });
      return [];
    }
  }

  /** 宿主会话查询（全量列表 + 批量标题）。服务缺失时是空实现。 */
  const hostSessions: HostSessionQuery = createHostSessionQuery(ctx, log);

  /**
   * 会话标题：**先看话题根卡基线，再问宿主**。
   *
   * 我们不再镜像标题，所以标题有两个真实来源：
   * - 根卡基线（建会话时记下的，用户可能更认可这个）；
   * - `readTitleSnapshots` 从会话日志折叠出的标题（权威，含 GUI 里建的会话）。
   */
  async function sessionTitle(sessionId: string): Promise<string> {
    const map = await sessionMap();
    const base = (await map.getRootCard(sessionId))?.title?.trim();
    if (base) return base;
    const titles = await hostSessions.titles([sessionId]);
    return titles.get(sessionId) ?? "飞书会话";
  }

  /**
   * 会话目录：宿主全量会话 → 排序后的行。
   *
   * 排序依据是"最后活动"，而 dsh 没有这个字段：
   * - 经飞书驱动过的会话，我们用 `session/event` 自己记了 `lastActivityAt`；
   * - 没记过的（纯 GUI 建的）回退 `createdAt`。
   *
   * 子 agent 会话不进列表 —— 它们是实现细节，不是用户"会话"。
   */
  async function loadCatalog(chatId: string): Promise<CatalogInput[]> {
    const records = await hostSessions.list();
    const visible = records.filter((r) => r.origin !== "subagent" && !r.parentSession);
    const titles = await hostSessions.titles(visible.map((r) => r.id));
    const map = await sessionMap();
    const activeId = await map.getActiveId(chatId);

    const items: CatalogInput[] = [];
    for (const record of visible) {
      const link = await map.resolveBySession(record.id);
      const bound = link ? Boolean(await map.threadIdForSession(record.id)) : false;
      items.push({
        id: record.id,
        createdAt: record.createdAt,
        activityAt: link?.lastActivityAt ?? record.createdAt,
        ...(titles.get(record.id) ? { title: titles.get(record.id)! } : {}),
        ...(record.cwd ? { cwd: record.cwd } : {}),
        bound,
        active: record.id === activeId,
      });
    }
    return sortByActivityDesc(items);
  }

  /** 渲染某一页会话列表卡。 */
  async function sessionListCard(chatId: string, page: number): Promise<CatalogPage> {
    return paginate(await loadCatalog(chatId), page, config.sessionPageSize, Date.now());
  }
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

  type SessionCreation =
    | {
        readonly ok: true;
        readonly sessionId: string;
        readonly dir: string;
        readonly modelLabel: string;
        readonly perm?: PermissionPreset;
      }
    | { readonly ok: false; readonly message: string };

  /**
   * 建会话的**唯一入口**：先把「模型 + 目录」两件事确定下来，再交给宿主。
   *
   * 旧实现直接 `port.createSession({ cwd: config.cwd, title })`：
   *  - `config.cwd` 当时会回落 `process.cwd()`，于是会话目录取决于宿主从哪启动；
   *  - 完全没有模型，于是会话建出来就注定跑不起来。
   * 两个问题都是"先建了再说"，所以现在改成**先解析、失败就不建**：
   * 用户拿到一张可操作的提示卡，而不是一个坏掉的会话。
   *
   * 模型来源顺序：插件配置覆盖 → dsh 默认模型（`agentDefaultModel`）→ 失败。
   * 目录来源顺序：显式请求 → 配置 `cwd` → `allowedRoots[0]`，随后做越界与系统目录校验。
   */
  async function createSession(input: {
    readonly title: string;
    readonly requestedDir?: string | undefined;
    /** 表单里选的模型（`provider/model`）；留空 = 走默认解析。 */
    readonly modelRef?: string | undefined;
    /** 表单里选的权限档位。 */
    readonly perm?: PermissionPreset | undefined;
  }): Promise<SessionCreation> {
    // 用户显式选的模型优先；没选才去问宿主默认。
    const picked = splitModelRef(input.modelRef);
    let selection: { provider: string; model: string; reasoningEffort?: string };
    let modelSource: string;
    if (picked) {
      selection = picked;
      modelSource = "form";
    } else {
      const resolved = currentModel();
      if (!resolved.ok) return { ok: false, message: resolved.message };
      selection = resolved.selection;
      modelSource = resolved.source;
    }

    const dir = resolveWorkingDir({
      requested: input.requestedDir,
      defaultDir: config.cwd,
      allowedRoots: config.allowedRoots,
    });
    if (!dir.ok) return { ok: false, message: dir.message };

    const modelLabel = `${selection.provider}/${selection.model}`;
    try {
      const sessionId = await port.createSession({
        cwd: dir.dir,
        title: input.title,
        model: selection,
      });
      log.info("会话已创建", { sessionId, dir: dir.dir, model: modelLabel, modelSource });
      return {
        ok: true,
        sessionId,
        dir: dir.dir,
        modelLabel,
        ...(input.perm ? { perm: input.perm } : {}),
      };
    } catch (error) {
      const reason = errorMessage(error);
      log.error("创建会话失败", { reason, dir: dir.dir, model: modelLabel });
      return { ok: false, message: `**创建会话失败**：${reason}` };
    }
  }

  /**
   * 处理建会话表单提交。
   *
   * 卡片回调必须**尽快**返回（飞书约 3 秒超时），所以立刻回一个 toast，
   * 建会话与改卡放到后台做 —— 与上游 `session-commands.ts:114-123` 同一处理。
   *
   * 成功时**表单这张卡自己变成话题根卡**（上游语义）：回复它即进入该话题，
   * 不需要再发一张新卡。
   */
  async function handleSetupSubmit(event: {
    readonly messageId: string;
    readonly chatId: string;
    readonly operator: { readonly openId: string };
    readonly action: { readonly name?: string; readonly formValue?: Record<string, unknown> };
  }): Promise<CardActionResponse> {
    const pending = pendingSetups.get(event.messageId);
    if (!pending) {
      return { toast: { type: "warning", content: "这张表单已失效，请重新发送 /new" } };
    }
    if (!ownerPolicy.isAllowed(event.operator.openId)) {
      return { toast: { type: "error", content: "无权操作" } };
    }
    // 先摘掉再干活：挡住连点造成的重复建会话。
    pendingSetups.delete(event.messageId);

    const submit = parseSetupSubmit(event.action.formValue);
    log.info("收到建会话表单提交", {
      messageId: event.messageId,
      dir: submit.dir,
      model: submit.model,
      perm: submit.perm,
    });

    void (async () => {
      try {
        const created = await createSession({
          title: pending.title,
          requestedDir: submit.dir,
          modelRef: submit.model,
          perm: submit.perm,
        });

        if (!created.ok) {
          // 失败就把表单换成说明卡，并把 pending 放回去让用户重新 /new。
          await channel.updateCard(
            event.messageId,
            buildNoticeCard({ title: "建会话失败", text: created.message, template: "orange" }),
          );
          pendingSetups.set(event.messageId, pending);
          log.warn("表单建会话失败", { messageId: event.messageId });
          return;
        }

        const map = await sessionMap();
        await map.link(pending.chatId, created.sessionId, pending.openId);
        await map.setActive(pending.chatId, created.sessionId);
        await map.setRootCard(created.sessionId, {
          style: "created",
          sessionID: created.sessionId,
          title: pending.title,
          dir: created.dir,
          model: created.modelLabel,
          ...(created.perm ? { perm: created.perm } : {}),
        });
        if (created.perm) await map.setSessionMeta(created.sessionId, { perm: created.perm });

        await channel.updateCard(
          event.messageId,
          buildNoticeCard({
            title: "会话已创建",
            text: [
              `**${pending.title}**`,
              "",
              `- 目录：\`${created.dir}\``,
              `- 模型：\`${created.modelLabel}\``,
              ...(created.perm ? [`- 权限：${presetLabel(created.perm)}`] : []),
              "",
              "**回复本条消息**即可开始对话（回复即进入该会话的话题）。",
            ].join("\n"),
            template: "green",
          }),
        );
        await map.bindRoot(event.messageId, created.sessionId);
        rootMessages.set(created.sessionId, event.messageId);
        topicStatus.set(created.sessionId, INITIAL_TOPIC_STATUS);
        log.info("表单建会话完成", { sessionId: created.sessionId, rootMessageId: event.messageId });
      } catch (error) {
        log.error("表单建会话异常", { reason: errorMessage(error) });
      }
    })();

    return { toast: { type: "success", content: "正在创建会话…" } };
  }

  /**
   * sessionId → 话题根卡状态。
   *
   * 内存态 + 从事件重建：重启后第一次事件就会把状态折回来。
   * （下一步可以迁到 `ctx.sessionProjections.register()`，让框架接管持久化与冷读重建；
   * 迁的时候只需要换存储，`reduceTopicStatus` 这个纯函数不动。）
   */
  const topicStatus = new Map<string, TopicStatusState>();
  /** sessionId → rootId：根卡要重渲在哪条消息上。 */
  const rootMessages = new Map<string, string>();

  /**
   * 把一个会话事件折叠进根卡状态，**档位变化时**才重渲根卡。
   *
   * 只在变化时 patch，是为了守住飞书"同一卡片 ≤10 次/秒"的更新频率限制 ——
   * `session/event` 是高频流，每个事件都刷会让卡片被限流。
   */
  async function refreshTopicStatus(sessionId: string, event: unknown): Promise<void> {
    const previous = topicStatus.get(sessionId) ?? INITIAL_TOPIC_STATUS;
    const next = reduceTopicStatus(previous, event as never);
    topicStatus.set(sessionId, next);
    if (dominantPhase(previous) === dominantPhase(next)) return;

    const rootId = rootMessages.get(sessionId);
    if (!rootId) return;
    const map = await sessionMap();
    const base = await map.getRootCard(sessionId);
    if (!base) return;
    try {
      await channel.updateCard(rootId, buildSessionRootCard(base, topicStatusView(next, Date.now())));
    } catch (error) {
      log.warn("根卡状态刷新失败", { sessionId, reason: errorMessage(error) });
    }
  }

  /** 辅助模型调用（意图识别）。服务缺失时恒为 undefined，调用方降级为空表单。 */
  const generateIntent = createIntentGenerator(ctx, log, config.intentTimeoutMs);

  /** 从会话目录里推出"候选目录"（去重，带会话标题作语义线索）。 */
  function candidateDirs(catalog: readonly CatalogInput[]): IntentCandidateDir[] {
    const out: IntentCandidateDir[] = [];
    const seen = new Set<string>();
    const push = (path: string, label?: string) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      out.push(label ? { path, label } : { path });
    };
    // 一级子目录优先（用户最常用），其次才是历史会话目录。
    for (const root of config.allowedRoots.slice(0, 3)) {
      for (const dir of listDirChoices(root)) push(dir);
    }
    for (const item of catalog) if (item.cwd) push(item.cwd, item.title);
    return out.slice(0, 60);
  }

  /**
   * 主聊天流的普通文本 → AI 理解意图。
   *
   * **关键约束（修上游 U1）**：那张"🤔 正在识别意图…"的回执卡**必须**走到底 ——
   * 成功就 patch 成列表卡/表单卡，失败就 patch 成管理台卡。上游在异常路径上只发新卡、
   * 从不 patch，于是那张卡永远停在"正在识别…"。
   */
  async function handleQuickNew(
    message: { readonly chatId: string; readonly senderId?: string | undefined },
    text: string,
  ): Promise<void> {
    let ackId: string | undefined;
    try {
      const ack = await channel.send(message.chatId, {
        card: buildNoticeCard({
          title: "🤔 正在识别意图…",
          text: "正在判断这条消息的意图，并解析目录 / 权限 / 模型等信息…",
          template: "blue",
        }),
      });
      ackId = ack.messageId;
    } catch (error) {
      log.warn("回执卡发送失败，直接回管理台卡", { reason: errorMessage(error) });
      await sendMainHint(message.chatId);
      return;
    }

    // 无论走哪条分支，回执卡都会被 patch 成一个终态 —— 用 finally 兜底。
    let settled = false;
    const patchAck = async (card: object): Promise<void> => {
      settled = true;
      await channel.updateCard(ackId!, card);
    };

    try {
      const [catalog, models] = await Promise.all([
        loadCatalog(message.chatId),
        listModelChoices(),
      ]);

      const route = currentModel();
      let decision;
      if (route.ok) {
        const raw = await generateIntent({
          prompt: buildIntentPrompt({
            text,
            candidates: candidateDirs(catalog),
            models: models.map((m) => ({ provider: m.provider, model: m.model, label: m.label })),
            allowedRoots: config.allowedRoots,
          }),
          provider: route.selection.provider,
          model: route.selection.model,
          reasoningEffort: route.selection.reasoningEffort,
          signal: AbortSignal.timeout(config.intentTimeoutMs),
        });
        decision = parseIntentDecision(raw);
        log.debug("意图识别结果", { intent: decision?.intent ?? "（未解析）" });
      } else {
        log.warn("没有可用模型，跳过意图识别", { reason: route.message });
      }

      if (decision?.intent === "list") {
        const page = await sessionListCard(message.chatId, 0);
        await patchAck(buildSessionListCard({ page, chatId: message.chatId }));
        return;
      }

      if (decision?.intent === "create") {
        const candidates = candidateDirs(catalog);
        const dir = resolveIntentDir({
          decision,
          candidates,
          allowedRoots: config.allowedRoots,
          title: text,
          validateDir: (path) => {
            const resolved = resolveWorkingDir({ requested: path, allowedRoots: config.allowedRoots });
            return resolved.ok ? { ok: true, path: resolved.dir } : { ok: false, message: resolved.message };
          },
        });
        const defaultModel: IntentModelOption | undefined = route.ok
          ? { provider: route.selection.provider, model: route.selection.model }
          : undefined;
        const picked = resolveIntentModel(
          decision,
          models.map((m) => ({ provider: m.provider, model: m.model, label: m.label })),
          defaultModel,
        );

        const title = decision.title?.trim() || defaultSessionTitle(Date.now());
        const notices = [dir.notice, picked.notice].filter(Boolean).join("\n\n");
        const fallbackDir = defaultWorkingDir();
        if (dir.dir === undefined && fallbackDir === undefined) {
          await patchAck(
            buildNoticeCard({ title: "无法建会话", text: dir.notice, template: "orange" }),
          );
          return;
        }
        await patchAck(
          buildSetupFormCard({
            title,
            defaultDir: dir.dir ?? fallbackDir!,
            allowedRoots: config.allowedRoots,
            dirChoices: listDirChoices(config.allowedRoots[0]!),
            models,
            defaultPerm: decision.perm ?? "edit",
            ...(notices ? { notice: notices } : {}),
          }),
        );
        pendingSetups.set(ackId!, { title, chatId: message.chatId, openId: message.senderId ?? "" });
        return;
      }

      // intent=chat、解析失败、模型不可用 —— 都回管理台卡。
      await patchAck(
        buildNoticeCard({
          title: "🛠️ 飞书管理台",
          text: [
            "这里是**会话管理台**，普通文本不会进入任何会话。",
            "",
            "- 说一句要做的任务（如「看下 wps 那个仓库的报错」）→ 我帮你把会话建好",
            "- `/sessions` — 列出全部会话",
            "- `/new [标题]` — 直接打开发建会话表单",
            "- `/help` — 查看全部命令",
            "",
            "进入话题后直接发消息，会话就在那里干活。",
          ].join("\n"),
          template: "grey",
        }),
      );
    } catch (error) {
      log.error("意图识别流程异常，回退管理台卡", { reason: errorMessage(error) });
      if (!settled && ackId) {
        // 兜底：异常也必须把回执卡收掉，不能让它停在"正在识别…"。
        try {
          await channel.updateCard(
            ackId,
            buildNoticeCard({
              title: "🛠️ 飞书管理台",
              text: "识别这条消息时出错了，可以直接用 `/new` 建会话。",
              template: "orange",
            }),
          );
        } catch {
          /* 连兜底都失败就只能算了，至少主流程已经记了 error */
        }
      }
    }
  }

  /**
   * 发出建会话表单，并登记 pending（供提交时查回）。
   *
   * `/new`、机器人菜单、以及会话列表卡的「➕ 新建会话」三个入口共用。
   */
  async function sendSetupForm(
    chatId: string,
    openId: string,
    title: string,
    defaultDir: string,
  ): Promise<string> {
    const sent = await channel.send(chatId, {
      card: buildSetupFormCard({
        title,
        defaultDir,
        allowedRoots: config.allowedRoots,
        dirChoices: listDirChoices(config.allowedRoots[0]!),
        models: await listModelChoices(),
        defaultPerm: "edit",
      }),
    });
    pendingSetups.set(sent.messageId, { title, chatId, openId });
    log.info("已发出建会话表单", { messageId: sent.messageId, title });
    return sent.messageId;
  }

  /** 建会话表单的默认目录（越界或没有 allowedRoots 时返回 undefined）。 */
  function defaultWorkingDir(): string | undefined {
    const resolved = resolveWorkingDir({ defaultDir: config.cwd, allowedRoots: config.allowedRoots });
    return resolved.ok ? resolved.dir : undefined;
  }

  /**
   * 会话列表卡的三个动作。
   *
   * `open` 会**先探活再绑定** —— 上游的 `/resume` 不做存在性检查，
   * 于是可能把一个话题绑到一个已经删掉的会话上，症状要等到发消息才暴露。
   */
  async function handleSessionListAction(
    event: {
      readonly messageId: string;
      readonly chatId: string;
      readonly operator: { readonly openId: string };
    },
    action: SessionListAction,
  ): Promise<CardActionResponse | undefined> {
    if (!ownerPolicy.isAllowed(event.operator.openId)) {
      return { toast: { type: "error", content: "无操作权限" } };
    }
    const map = await sessionMap();

    if (action.cmd === "list") {
      const page = await sessionListCard(event.chatId, action.p ?? 0);
      await channel.updateCard(event.messageId, buildSessionListCard({ page, chatId: event.chatId }));
      return { toast: { type: "info", content: "已翻页" } };
    }

    if (action.cmd === "new") {
      const dir = defaultWorkingDir();
      if (dir === undefined) {
        await sendCreateFailure(event.chatId, "没有可用的默认工作目录，无法打开建会话表单。");
        return { toast: { type: "error", content: "无法打开表单" } };
      }
      await sendSetupForm(event.chatId, event.operator.openId, defaultSessionTitle(Date.now()), dir);
      return { toast: { type: "success", content: "正在打开表单…" } };
    }

    // action.cmd === "open"
    const sessionId = action.s!;
    if (!(await hostSessions.exists(sessionId))) {
      await channel.updateCard(event.messageId, buildSessionMissingCard(sessionId));
      log.warn("进入话题失败：会话不存在", { sessionId });
      return { toast: { type: "error", content: "会话不存在" } };
    }

    const title = await sessionTitle(sessionId);
    await map.link(event.chatId, sessionId, event.operator.openId);
    await map.setActive(event.chatId, sessionId);
    // 发一张新的根卡：回复它即进入这个话题（上游 `enterSessionThread` 的同款做法）。
    const root = await channel.send(event.chatId, {
      card: buildNoticeCard({
        title: `🔄 ${title}`,
        text: [
          `会话「${title}」：\`${sessionId}\``,
          "",
          "**回复本条消息**即可继续这个会话（回复即进入它的话题）。",
        ].join("\n"),
        template: "green",
      }),
    });
    await map.bindRoot(root.messageId, sessionId);
    rootMessages.set(sessionId, root.messageId);
    log.info("已进入会话", { sessionId, rootMessageId: root.messageId });
    return { toast: { type: "info", content: "正在进入话题…" } };
  }

  /** 建会话失败时的提示卡（把原因原样给用户，附带当前解析到的默认值）。 */  async function sendCreateFailure(chatId: string, message: string): Promise<void> {
    const hints = [
      message,
      "",
      "---",
      `当前默认目录：\`${config.cwd}\``,
      `允许的根目录：${config.allowedRoots.map((root) => `\`${root}\``).join("、")}`,
      config.provider && config.model
        ? `当前配置的模型：\`${config.provider}/${config.model}\``
        : "当前未配置模型覆盖（使用 DSH 默认模型）。",
    ];
    await sendNotice(chatId, hints.join("\n"), "orange");
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
        // 一步建会话表单（对齐上游 `/new`）：目录 + 模型 + 权限一次填完。
        // 提交后**表单那张卡自己变成话题根卡**（上游语义），所以在提交前就把
        // 它的 messageId 记下来。
        //
        // 先在发卡前做一次"能不能建"的预检：拿不到模型 / 目录越界这类问题
        // 现在就该说清楚，而不是等用户填完再报错。
        const openId = message.senderId ?? "";
        const title = parsed.args || defaultSessionTitle(Date.now());
        const precheck = currentModel();
        if (!precheck.ok) {
          await sendCreateFailure(message.chatId, precheck.message);
          return;
        }
        const defaultDir = resolveWorkingDir({
          defaultDir: config.cwd,
          allowedRoots: config.allowedRoots,
        });
        if (!defaultDir.ok) {
          await sendCreateFailure(message.chatId, defaultDir.message);
          return;
        }

        await sendSetupForm(message.chatId, openId, title, defaultDir.dir);
        return;
      }
      case "stop": {
        const map = await sessionMap();
        const target =
          scope === "thread" && message.threadId
            ? (await map.resolveByThread(message.threadId))?.sessionID
            : await map.getActiveId(message.chatId);
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
    const catalog = await loadCatalog(message.chatId);
    const sessions = catalog.map((item) => ({ sessionID: item.id, title: item.title ?? "" }));
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
      case "session-list": {
        const page = await sessionListCard(message.chatId, 0);
        await channel.send(message.chatId, { card: buildSessionListCard({ page, chatId: message.chatId }) });
        return;
      }
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
      const title = await sessionTitle(sessionId);
      card = new RunCard(cardPort, log, {
        // 话题内触发 → 回复触发消息，卡片才留在话题里（上游 `im.message.reply` 的语义）。
        // 只在真有 threadId 时回复：主聊天流的消息若也去 reply，飞书会凭空开出一个话题。
        target: {
          chatId: message.chatId,
          ...(message.threadId && message.messageId
            ? { replyTo: message.messageId, threadId: message.threadId }
            : {}),
        },
        title,
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

  /**
   * 机器人自定义菜单：把菜单 key 合成等价命令，走**与文本完全相同**的管线。
   *
   * `onRawEvent` 的原始事件不过安全管线，所以白名单要在这里自己再过一遍；
   * 拿不到 chat id（用户从没发过消息）时静默忽略 —— 与上游一致。
   */
  channel.onRawEvent(BOT_MENU_EVENT, async (payload) => {
    if (disposed) return;
    // 原始事件不过管线，所以先记一条：菜单点了没反应时，这行日志能立刻区分
    // 「事件没到」和「到了但被忽略」。
    log.debug("收到机器人菜单事件", { payloadType: typeof payload });
    const menu = parseBotMenuEvent(payload);
    if (!menu) return;

    const allowed = await ownerPolicy.admit(menu.openId);
    if (!allowed) {
      log.warn("菜单点击者不在白名单，忽略", { sender: maskId(menu.openId) });
      return;
    }
    const chatId = chatIdByUser.get(menu.openId);
    if (!chatId) {
      log.warn("菜单点击者尚未发过消息，无法确定 chat，忽略", {
        sender: maskId(menu.openId),
        key: menu.eventKey,
      });
      return;
    }
    log.info("菜单事件已合成为命令", { key: menu.eventKey, command: menu.command, chatId: maskId(chatId) });
    try {
      await handleCommand(menu.command, { chatId, senderId: menu.openId });
    } catch (error) {
      log.error("菜单命令处理失败", { reason: errorMessage(error), key: menu.eventKey });
    }
  });

  channel.onReconnecting(() => supervisor.noteReconnecting());
  channel.onReconnected(() => supervisor.noteReconnected());

  channel.onReject((event) => {
    log.info("入站消息被通道策略拒绝", { reason: event.reason, chatId: maskId(event.chatId) });
  });

  channel.onCardAction(async (event) => {
    if (disposed) return;

    // 建会话表单提交优先：它不是审批/提问 value，形状是 `action.name` + `form_value`。
    if (isSetupSubmit(event.action.name)) {
      return handleSetupSubmit(event);
    }

    // 会话列表卡的三个动作（进入 / 翻页 / 新建）。
    const listAction = parseSessionListAction(event.action.value);
    if (listAction) return handleSessionListAction(event, listAction);

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

    // 记住「用户 → 私聊 chat」：机器人自定义菜单的事件里**没有 chat id**，
    // 需要靠这张表把它还原成一个可以发卡片的会话（上游同做法，只存内存）。
    if (message.senderId && message.chatId) chatIdByUser.set(message.senderId, message.chatId);

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
      const activeId = await map.getActiveId(message.chatId);
      if (!activeId) {
        await sendMainHint(message.chatId);
        return;
      }
      await runInSession(activeId, inbound, gate);
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
      // 主聊天流 = 管理台：普通文本交给 AI 理解意图（建会话引导 / 列会话 / 回管理台卡）。
      if (config.intentRouting) {
        await handleQuickNew(message, gate.text);
      } else {
        await sendMainHint(message.chatId);
      }
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
    const created = await createSession({ title });
    if (!created.ok) {
      await sendCreateFailure(message.chatId, created.message);
      return;
    }
    await map.link(message.chatId, created.sessionId, message.senderId ?? "");
    await map.setRootCard(created.sessionId, {
      style: "created",
      sessionID: created.sessionId,
      title,
      dir: created.dir,
      model: created.modelLabel,
    });
    const anchor = message.rootId ?? message.messageId;
    await map.bindThread(message.threadId!, created.sessionId, message.chatId, message.senderId ?? "", anchor);
    await map.bindRoot(anchor, created.sessionId);
    log.info("话题新建会话", {
      sessionId: created.sessionId,
      threadId: message.threadId,
      chatId: maskId(message.chatId),
    });
    await runInSession(created.sessionId, inbound, gate);
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
    // 最后活动时间：dsh 没有这个字段，会话列表的"最近用过"排序靠它（见 SessionLink.lastActivityAt）。
    void sessionMap()
      .then((map) => map.touchActivity(sessionId, event.time ?? Date.now()))
      .catch(() => {});
    // 话题根卡状态：从会话事件折叠（待审核 > 运行中 > 待回复 > 失败/中断 > 完成）。
    void refreshTopicStatus(sessionId, event).catch(() => {});
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
      // 菜单事件已注册（需要在开发者后台订阅 `application.bot.menu_v6` 才会真的送来）。
      menuEvent: BOT_MENU_EVENT,
      // 建会话的默认目录与模型来源，方便一眼看出"为什么建不出来"。
      defaultDir: config.cwd,
      modelOverride: config.provider && config.model ? `${config.provider}/${config.model}` : "（用 DSH 默认模型）",
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
