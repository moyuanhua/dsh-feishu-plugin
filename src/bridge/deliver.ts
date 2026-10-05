/**
 * 入站消息 → 会话的投递编排。
 *
 * 职责边界：本文件只管"这条消息该落到哪个会话、以及怎么投进去"，不关心飞书协议，
 * 也不关心 dsh 服务怎么取（那是 `src/dsh/port.ts` 的事）。因此整条路径可用假 port + 内存 store 单测。
 */
import { applyDelivery, type InboundDecision, type InboundMessageLike } from "./inbound.js";
import { topicKey, topicTitle, type TopicRecord, type TopicStore } from "./topics.js";
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
}

export interface DeliveryResult {
  readonly sessionId: string;
  /** true = 本次为话题新建了会话（首次消息）。 */
  readonly created: boolean;
}

export async function deliverInbound(
  store: TopicStore,
  port: DeliveryPort,
  message: InboundMessageLike,
  decision: DeliverDecision,
  options: DeliverOptions,
): Promise<DeliveryResult> {
  const now = options.now ?? (() => Date.now());
  const key = topicKey(message);
  const title = topicTitle(decision.text);

  let record = store.get(key);
  let created = false;
  if (!record) {
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
    record = fresh;
    created = true;
  } else {
    await store.put(key, { ...record, updatedAt: now() });
  }

  const agent = await port.resolveAgent(record.sessionId);
  if (!agent) {
    throw new Error(`会话 ${record.sessionId} 无法解析为存活 agent（可能已被 dispose 且不可 resume）`);
  }
  await applyDelivery(decision, message, agent, port);
  return { sessionId: record.sessionId, created };
}
