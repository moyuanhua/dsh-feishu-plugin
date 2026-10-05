/**
 * 入站消息 → 会话的投递编排。
 *
 * 拆成两步是**故意的**（上游 opencode 版的 `beginRun` 就是"先发回执卡，再 prompt"，
 * `src/index.ts:1242`）：
 *
 *   prepareDelivery  —— 解析/新建会话，写映射；**不**向会话注入任何东西
 *   （调用方在这里发出运行卡）
 *   sendDelivery     —— 解析 agent 并 followup/steer
 *
 * 为什么必须拆：`followup()` 会立刻唤醒 agent 开始跑，如果先投递再发卡，
 * 这一轮最早的流式事件会在运行卡登记前到达并被丢弃 —— 卡片会永远停在「运行中」。
 * 这是 M3b 首次真实联调踩到的坑（截图上出现了「⏳ 卡住 + ✅ 另一张」两张卡）。
 */
import { applyDelivery, type InboundDecision, type InboundMessageLike } from "./inbound.js";
import { topicTitle } from "./commands.js";
import { topicKey, type TopicRecord, type TopicStore } from "./topics.js";
import type { HostPort } from "../types.js";

export type DeliverDecision = Extract<InboundDecision, { kind: "deliver" }>;

export interface DeliveryPort extends HostPort {
  /** 新建一个会话，返回 sessionId。 */
  createSession(input: { readonly cwd: string; readonly title: string }): Promise<string>;
}

export interface DeliverOptions {
  /** 新会话的工作目录（绝对路径）。 */
  readonly cwd: string;
  readonly now?: () => number;
  /** 话题标题最大字符数（来自配置）。 */
  readonly titleMaxChars?: number;
}

/** `prepareDelivery` 的产物：会话已就绪，但消息还没投进去。 */
export interface PreparedDelivery {
  readonly sessionId: string;
  /** true = 本次为话题新建了会话（首次消息）。 */
  readonly created: boolean;
  readonly title: string;
  readonly cwd: string;
}

export interface DeliveryResult {
  readonly sessionId: string;
  /** true = 本次为话题新建了会话（首次消息）。 */
  readonly created: boolean;
}

/** 第一步：解析或新建会话并写入映射（幂等：同一话题复用同一会话）。 */
export async function prepareDelivery(
  store: TopicStore,
  port: DeliveryPort,
  message: InboundMessageLike,
  decision: DeliverDecision,
  options: DeliverOptions,
): Promise<PreparedDelivery> {
  const now = options.now ?? (() => Date.now());
  const key = topicKey(message);
  const title = topicTitle(decision.text, options.titleMaxChars);

  const existing = store.get(key);
  if (existing) {
    await store.put(key, { ...existing, updatedAt: now() });
    return { sessionId: existing.sessionId, created: false, title: existing.title, cwd: existing.cwd };
  }

  const sessionId = await port.createSession({ cwd: options.cwd, title });
  const fresh: TopicRecord = {
    sessionId,
    cwd: options.cwd,
    title,
    chatId: message.chatId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    updatedAt: now(),
  };
  await store.put(key, fresh);
  return { sessionId, created: true, title, cwd: options.cwd };
}

/** 第二步：把这条消息投进已就绪的会话（`followup` 或 `steer`）。 */
export async function sendDelivery(
  prepared: PreparedDelivery,
  port: DeliveryPort,
  message: InboundMessageLike,
  decision: DeliverDecision,
): Promise<void> {
  const agent = await port.resolveAgent(prepared.sessionId);
  if (!agent) {
    throw new Error(`会话 ${prepared.sessionId} 无法解析为存活 agent（可能已被 dispose 且不可 resume）`);
  }
  await applyDelivery(decision, message, agent, port);
}

/** 便捷组合（单测与不需要"先发卡"的调用方用）。 */
export async function deliverInbound(
  store: TopicStore,
  port: DeliveryPort,
  message: InboundMessageLike,
  decision: DeliverDecision,
  options: DeliverOptions,
): Promise<DeliveryResult> {
  const prepared = await prepareDelivery(store, port, message, decision, options);
  await sendDelivery(prepared, port, message, decision);
  return { sessionId: prepared.sessionId, created: prepared.created };
}
