/**
 * 飞书绑定关系（**只存 dsh 不拥有的东西**）。
 *
 * 旧版是 `opencode-feishu-plugin` 的 `session-map.ts` 逐行搬运（598 行），里面有一半是
 * **会话清单的镜像**：`feishu:v2:chat:<chatId>:sessions` 抄了一份
 * `{sessionID, title, updatedAt}` 列表，还要跟宿主对账。
 *
 * 那份镜像在 DSH 里是**多余的、而且注定漂移**：会话的权威来源是
 * `ctx.sessionQuery.listSessions()` / `readTitleSnapshots()`（全量、标题从日志折叠）。
 * 本模块因此**删掉全部会话清单**，只保留 dsh 没有概念的两类数据：
 *
 * 1. **绑定**：哪个飞书话题/根消息 ↔ 哪个 dsh 会话；哪个聊天当前的会话是谁；
 * 2. **插件自有元数据**：会话级放行工具表、话题根卡基线、最后活动时间。
 *
 * 存储布局（键名与旧版一致，保证已有绑定不丢）：
 * - `feishu:v2:chat:<chatId>:active`   → 当前会话 id（**旧版是 `:sessions` 列表**，只读降级迁移）
 * - `feishu:v2:session:<sid>`          → `{ chatId, openId, replyMessageId?, perm?, gateMode?, dir?, model?, allowActions?, lastActivityAt?, rootCard? }`
 * - `feishu:v2:thread:<tid>`           → `{ sessionID, chatId, openId, anchorMessageId? }`（话题）
 * - `feishu:v2:root:<rootId>`          → `{ sessionID }`（回复根卡进入会话）
 * - `feishu:v2:session-thread:<sid>`   → `{ threadId }`（会话 → 最近话题反向索引）
 *
 * 内存缓存供热路径**同步**读取（`hasSession` / `getLink` / `getSessionIdForChat`）。
 */
import { errorMessage } from "../logger.js";
import type {
  Logger,
  ModelRef,
  PermissionPreset,
  SessionGateMode,
  SessionLink,
  SessionRootCardBase,
  StorageLike,
  ThreadLink,
} from "../types.js";

export const CHAT_KEY_PREFIX = "feishu:v2:chat:";
export const SESSION_KEY_PREFIX = "feishu:v2:session:";
/** 当前会话：`feishu:v2:chat:<chatId>:active`。 */
export const ACTIVE_SUFFIX = ":active";
/** **旧版**多会话清单后缀，只用于一次性降级读取。 */
export const LEGACY_SESSIONS_SUFFIX = ":sessions";
/** 话题 → 会话映射：`feishu:v2:thread:<threadId>`。 */
export const THREAD_KEY_PREFIX = "feishu:v2:thread:";
/** 话题根消息 → 会话映射：`feishu:v2:root:<rootId>`。 */
export const ROOT_KEY_PREFIX = "feishu:v2:root:";
/** 会话 → 最近话题 反向索引：`feishu:v2:session-thread:<sessionID>`。 */
export const SESSION_THREAD_KEY_PREFIX = "feishu:v2:session-thread:";

interface ChatRecord {
  readonly sessionID: string;
  readonly openId: string;
}

export interface SessionMapOptions {
  /** 时间源，便于单测。默认 Date.now。 */
  readonly now?: () => number;
}

export class SessionMap {
  private readonly sessionToChat = new Map<string, SessionLink>();
  /** chat → 当前会话 id（内存缓存，供同步读取）。 */
  private readonly chatToActive = new Map<string, string>();
  /** threadId → 会话映射（内存缓存）。 */
  private readonly threadCache = new Map<string, ThreadLink>();
  /** rootId → sessionID（内存缓存）。 */
  private readonly rootCache = new Map<string, string>();
  /** sessionID → 最近绑定的话题 id（反向索引内存缓存）。 */
  private readonly sessionToThread = new Map<string, string>();
  private readonly now: () => number;

  constructor(
    private readonly storage: StorageLike,
    private readonly log: Logger,
    options: SessionMapOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 同步判定：是否有已知飞书投递目标（审批 waterfall 的热路径用）。 */
  hasSession(sessionID: string): boolean {
    return this.sessionToChat.has(sessionID);
  }

  getLink(sessionID: string): SessionLink | undefined {
    return this.sessionToChat.get(sessionID);
  }

  /** 当前激活会话 id（仅内存缓存；冷启动请用 `getActiveId`）。 */
  getSessionIdForChat(chatId: string): string | undefined {
    return this.chatToActive.get(chatId);
  }

  /** 最后活动时间（同步，缓存未命中返回 undefined）。 */
  getActivity(sessionID: string): number | undefined {
    return this.sessionToChat.get(sessionID)?.lastActivityAt;
  }

  /** 冷启动/缓存未命中时从 storage 回填。 */
  async resolveBySession(sessionID: string): Promise<SessionLink | undefined> {
    const cached = this.sessionToChat.get(sessionID);
    if (cached) return cached;
    const stored = await this.safeGet(`${SESSION_KEY_PREFIX}${sessionID}`);
    const link = parseSessionLink(stored);
    if (!link) return undefined;
    this.remember(sessionID, link);
    return link;
  }

  /**
   * 更新会话元数据（perm/gateMode/dir/model/allowActions/lastActivityAt/rootCard），
   * 保留 chatId/openId/replyMessageId。会话不存在返回 false。
   * patch 中值为 `undefined` 表示删除该字段。
   */
  async setSessionMeta(
    sessionID: string,
    patch: Partial<Omit<SessionLink, "chatId" | "openId">>,
  ): Promise<boolean> {
    const existing = await this.resolveBySession(sessionID);
    if (!existing) return false;
    const next: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const link = next as unknown as SessionLink;
    this.remember(sessionID, link);
    await this.safeSet(`${SESSION_KEY_PREFIX}${sessionID}`, serializeSession(link));
    return true;
  }

  /**
   * 记录一次活动。
   *
   * 只在**变新**时写盘：`session/event` 是高频流，每个事件都落盘会放大 I/O，
   * 而列表排序只关心单调递增的最后时间。
   */
  async touchActivity(sessionID: string, at = this.now()): Promise<void> {
    const existing = this.sessionToChat.get(sessionID) ?? (await this.resolveBySession(sessionID));
    if (!existing) return; // 没有绑定 = 不是我们驱动的会话，不值得为它建一条记录
    if (existing.lastActivityAt !== undefined && existing.lastActivityAt >= at) return;
    await this.setSessionMeta(sessionID, { lastActivityAt: at });
  }

  /** 建立/更新「会话 → 飞书投递目标」这条绑定（会话已存在则保留其元数据）。 */
  async link(chatId: string, sessionID: string, openId: string): Promise<SessionLink> {
    const existing = await this.resolveBySession(sessionID);
    if (existing) return existing;
    const link: SessionLink = { chatId, openId, lastActivityAt: this.now() };
    this.remember(sessionID, link);
    await this.safeSet(`${SESSION_KEY_PREFIX}${sessionID}`, serializeSession(link));
    return link;
  }

  /** 设置某聊天当前的会话。会话没有绑定关系时拒绝（避免指向一个死会话）。 */
  async setActive(chatId: string, sessionID: string): Promise<boolean> {
    const link = await this.resolveBySession(sessionID);
    if (!link) {
      this.log.warn("拒绝把未绑定的会话设为当前会话", { chatId, sessionID });
      return false;
    }
    this.chatToActive.set(chatId, sessionID);
    await this.safeSet(`${CHAT_KEY_PREFIX}${chatId}${ACTIVE_SUFFIX}`, sessionID);
    return true;
  }

  /** 当前会话 id（冷启动会从 storage 回填，并迁移旧版的列表结构）。 */
  async getActiveId(chatId: string): Promise<string | undefined> {
    const cached = this.chatToActive.get(chatId);
    if (cached) return cached;
    const stored = await this.safeGet(`${CHAT_KEY_PREFIX}${chatId}${ACTIVE_SUFFIX}`);
    const direct = str(stored);
    if (direct) {
      this.chatToActive.set(chatId, direct);
      return direct;
    }
    // 旧版把整个会话列表 + active 存在 `:sessions` 下 —— 只迁移 active，不再保留清单。
    const legacy = await this.safeGet(`${CHAT_KEY_PREFIX}${chatId}${LEGACY_SESSIONS_SUFFIX}`);
    const migrated = parseLegacyActive(legacy);
    if (!migrated) return undefined;
    this.log.info("已把旧版会话清单迁移为单一的当前会话", { chatId, sessionID: migrated });
    this.chatToActive.set(chatId, migrated);
    await this.safeSet(`${CHAT_KEY_PREFIX}${chatId}${ACTIVE_SUFFIX}`, migrated);
    return migrated;
  }

  /** 会话 → 该会话的飞书投递目标（含 chat/openId/锚点）。 */
  async resolveByChat(chatId: string): Promise<ChatRecord | undefined> {
    const sessionID = await this.getActiveId(chatId);
    if (!sessionID) return undefined;
    const link = await this.resolveBySession(sessionID);
    return link ? { sessionID, openId: link.openId } : undefined;
  }

  async bindThread(
    threadId: string,
    sessionID: string,
    chatId: string,
    openId: string,
    anchorMessageId?: string,
  ): Promise<void> {
    const link: ThreadLink = {
      sessionID,
      chatId,
      openId,
      ...(anchorMessageId ? { anchorMessageId } : {}),
    };
    this.threadCache.set(threadId, link);
    this.sessionToThread.set(sessionID, threadId);
    await this.safeSet(`${THREAD_KEY_PREFIX}${threadId}`, serializeThread(link));
    await this.safeSet(`${SESSION_THREAD_KEY_PREFIX}${sessionID}`, { threadId });
  }

  async resolveByThread(threadId: string): Promise<ThreadLink | undefined> {
    const cached = this.threadCache.get(threadId);
    if (cached) return cached;
    const stored = await this.safeGet(`${THREAD_KEY_PREFIX}${threadId}`);
    const link = parseThreadLink(stored);
    if (!link) return undefined;
    this.threadCache.set(threadId, link);
    this.sessionToThread.set(link.sessionID, threadId);
    return link;
  }

  /** 该会话最近绑定的话题 id（会话列表卡上的「💬 已绑话题」用它）。 */
  async threadIdForSession(sessionID: string): Promise<string | undefined> {
    const cached = this.sessionToThread.get(sessionID);
    if (cached) return cached;
    const stored = await this.safeGet(`${SESSION_THREAD_KEY_PREFIX}${sessionID}`);
    const threadId = isRecord(stored) ? str(stored.threadId) : "";
    if (!threadId) return undefined;
    this.sessionToThread.set(sessionID, threadId);
    return threadId;
  }

  async bindRoot(rootId: string, sessionID: string): Promise<void> {
    this.rootCache.set(rootId, sessionID);
    await this.safeSet(`${ROOT_KEY_PREFIX}${rootId}`, { sessionID });
  }

  async resolveByRoot(rootId: string): Promise<{ sessionID: string } | undefined> {
    const cached = this.rootCache.get(rootId);
    if (cached) return { sessionID: cached };
    const stored = await this.safeGet(`${ROOT_KEY_PREFIX}${rootId}`);
    const sessionID = isRecord(stored) ? str(stored.sessionID) : "";
    if (!sessionID) return undefined;
    this.rootCache.set(rootId, sessionID);
    return { sessionID };
  }

  async setRootCard(sessionID: string, base: SessionRootCardBase | undefined): Promise<boolean> {
    return this.setSessionMeta(sessionID, { rootCard: base });
  }

  async getRootCard(sessionID: string): Promise<SessionRootCardBase | undefined> {
    return (await this.resolveBySession(sessionID))?.rootCard;
  }

  private remember(sessionID: string, link: SessionLink): void {
    this.sessionToChat.set(sessionID, link);
    this.chatToActive.set(link.chatId, this.chatToActive.get(link.chatId) ?? sessionID);
  }

  private async safeGet(key: string): Promise<unknown> {
    try {
      return await this.storage.get(key);
    } catch (error) {
      this.log.warn("读取绑定关系失败", { key, reason: errorMessage(error) });
      return undefined;
    }
  }

  private async safeSet(key: string, value: unknown): Promise<void> {
    try {
      await this.storage.set(key, value);
    } catch (error) {
      // 写入失败只影响持久化，不影响本次会话可用性 —— 记为 warn 而不是 error。
      this.log.warn("写入绑定关系失败", { key, reason: errorMessage(error) });
    }
  }
}

/* ------------------------------------------------------------------ *
 * 序列化 / 解析（容错读取：字段缺失或类型不对一律当作没有，不抛）
 * ------------------------------------------------------------------ */

function serializeSession(link: SessionLink): Record<string, unknown> {
  return {
    chatId: link.chatId,
    openId: link.openId,
    ...(link.replyMessageId ? { replyMessageId: link.replyMessageId } : {}),
    ...(link.perm ? { perm: link.perm } : {}),
    ...(link.gateMode ? { gateMode: link.gateMode } : {}),
    ...(link.dir ? { dir: link.dir } : {}),
    ...(link.model ? { model: link.model } : {}),
    ...(link.allowActions && link.allowActions.length > 0 ? { allowActions: [...link.allowActions] } : {}),
    ...(typeof link.lastActivityAt === "number" ? { lastActivityAt: link.lastActivityAt } : {}),
    ...(link.rootCard ? { rootCard: link.rootCard } : {}),
  };
}

/** 解析 session 索引；缺 chatId 视为非法。 */
function parseSessionLink(value: unknown): SessionLink | undefined {
  if (!isRecord(value)) return undefined;
  const chatId = str(value.chatId);
  if (!chatId) return undefined;
  const openId = str(value.openId);
  const replyMessageId = str(value.replyMessageId);
  const perm = isPreset(value.perm) ? value.perm : undefined;
  const gateMode = value.gateMode === "off" || value.gateMode === "gate" ? value.gateMode : undefined;
  const dir = str(value.dir);
  const model = parseModelRef(value.model);
  const allowActions = parseStringArray(value.allowActions);
  const lastActivityAt = typeof value.lastActivityAt === "number" ? value.lastActivityAt : undefined;
  const rootCard = parseRootCard(value.rootCard);
  return {
    chatId,
    openId,
    ...(replyMessageId ? { replyMessageId } : {}),
    ...(perm ? { perm } : {}),
    ...(gateMode ? { gateMode } : {}),
    ...(dir ? { dir } : {}),
    ...(model ? { model } : {}),
    ...(allowActions.length > 0 ? { allowActions } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(rootCard ? { rootCard } : {}),
  };
}

function parseRootCard(value: unknown): SessionRootCardBase | undefined {
  if (!isRecord(value)) return undefined;
  const style = value.style === "created" || value.style === "resumed" ? value.style : undefined;
  const sessionID = str(value.sessionID);
  if (!style || !sessionID) return undefined;
  const title = str(value.title);
  const dir = str(value.dir);
  const model = str(value.model);
  const perm = str(value.perm);
  const summary = str(value.summary);
  const summaryLabel = str(value.summaryLabel);
  const compactError = str(value.compactError);
  const note = str(value.note);
  const updatedAt = typeof value.updatedAt === "number" ? value.updatedAt : undefined;
  return {
    style,
    sessionID,
    title,
    ...(dir ? { dir } : {}),
    ...(model ? { model } : {}),
    ...(perm ? { perm } : {}),
    ...(summary ? { summary } : {}),
    ...(summaryLabel ? { summaryLabel } : {}),
    ...(compactError ? { compactError } : {}),
    ...(note ? { note } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(value.summaryPending === true ? { summaryPending: true as const } : {}),
    ...(value.compactPending === true ? { compactPending: true as const } : {}),
    ...(value.compactButton === true ? { compactButton: true as const } : {}),
    ...(value.openedTopic === true ? { openedTopic: true as const } : {}),
  };
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = str(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

function isPreset(value: unknown): value is PermissionPreset {
  return value === "readonly" || value === "edit" || value === "askHigh" || value === "trust";
}

function parseModelRef(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const providerID = str(value.providerID);
  const id = str(value.id);
  if (!providerID || !id) return undefined;
  const name = str(value.name);
  return { providerID, id, ...(name ? { name } : {}) };
}

function serializeThread(link: ThreadLink): Record<string, unknown> {
  return {
    sessionID: link.sessionID,
    chatId: link.chatId,
    openId: link.openId,
    ...(link.anchorMessageId ? { anchorMessageId: link.anchorMessageId } : {}),
  };
}

function parseThreadLink(value: unknown): ThreadLink | undefined {
  if (!isRecord(value)) return undefined;
  const sessionID = str(value.sessionID);
  if (!sessionID) return undefined;
  const chatId = str(value.chatId);
  const openId = str(value.openId);
  const anchorMessageId = str(value.anchorMessageId);
  return { sessionID, chatId, openId, ...(anchorMessageId ? { anchorMessageId } : {}) };
}

/**
 * 旧版 `:sessions` 结构里取出 `active`。
 *
 * 只认 `active`，**不迁移清单** —— 清单本来就是我们要删掉的镜像。
 * `active` 悬空（不在列表里）时退回列表最后一项，与旧版 `parseChatSessions` 行为一致。
 */
function parseLegacyActive(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return undefined;
  const ids = value.sessions
    .map((item) => (isRecord(item) ? str(item.sessionID) : ""))
    .filter((id): id is string => Boolean(id));
  const active = str(value.active);
  if (active && ids.includes(active)) return active;
  return ids[ids.length - 1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type { ChatRecord };
