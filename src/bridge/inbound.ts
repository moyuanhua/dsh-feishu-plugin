/**
 * 入站决策（纯函数）+ 投递执行。
 *
 * 决策与副作用分离，是上游架构里最值得保留的一条：飞书事件 → 纯函数判定
 * （忽略 / 命令 / 投递）→ 只有"投递"才触碰宿主，且投递方式（插队 vs 排队）
 * 由 busyDelivery 决定。这样单人边界、群开关、空消息、bot 自回环等规则
 * 全部可以脱离 dsh 运行时单测。
 *
 * 与上游的差异：
 *   · 去重、按 chat 串行、过期丢弃已由 `@larksuite/channel` 的 SafetyConfig 负责，
 *     本文件不再重复实现（上游的 dedup.ts 因此不需要移植）；
 *   · 命令分支在 M2 只做识别，执行留给 M3 的 `ctx.commands`。
 */
import type { Delivery } from "./delivery.js";
import type { AgentLike, HostPort, MessageSource } from "../types.js";

export interface InboundResourceLike {
  readonly type: string;
  readonly fileKey: string;
  readonly fileName?: string;
}

export interface InboundMentionLike {
  /** 正文里的占位 key，如 `@_user_1`。 */
  readonly key: string;
  readonly name?: string;
}

/** 只声明决策需要的字段：`@larksuite/channel` 的 NormalizedMessage 结构上兼容。 */
export interface InboundMessageLike {
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: "p2p" | "group";
  readonly chatMode?: string;
  readonly senderId?: string;
  readonly senderIsBot?: boolean;
  readonly senderType?: string;
  readonly content: string;
  readonly resources?: readonly InboundResourceLike[];
  readonly mentions?: readonly InboundMentionLike[];
  readonly threadId?: string;
  readonly rootId?: string;
  readonly mentionedBot?: boolean;
}

/**
 * 门禁事实。
 *
 * 注意**没有** `busy` / `busyDelivery`：上游的入站决策只回答"要不要处理、处理什么"，
 * 投递方式（steer / queue）在真正投递时才由 `decideDelivery(running, busyDelivery)` 判定
 * （运行态由 `ExecutionTracker` 用宿主事件维护）。
 */
export interface InboundFacts {
  /** OwnerPolicy 的判定结果。 */
  readonly allowed: boolean;
  /** 群入口开关（预留）；false 时群消息一律忽略。 */
  readonly groupEnabled: boolean;
}

export type InboundDecision =
  | { readonly kind: "ignore"; readonly reason: string }
  | { readonly kind: "command"; readonly text: string }
  | {
      readonly kind: "deliver";
      readonly text: string;
      readonly attachmentCount: number;
    };

/** 去掉正文里的 @ 占位（群场景）；单聊没有 mention。 */
export function stripMentions(content: string, mentions: readonly InboundMentionLike[] | undefined): string {
  if (!mentions || mentions.length === 0) return content;
  let out = content;
  for (const mention of mentions) {
    if (mention.key) out = out.split(mention.key).join("");
  }
  return out;
}

export function decideInbound(message: InboundMessageLike, facts: InboundFacts): InboundDecision {
  // bot 自己的回声/其它 bot：SDK 已按 senderIsBot 标注，缺失时视为"未知"而非"非 bot"。
  if (message.senderIsBot === true) return { kind: "ignore", reason: "from-bot" };
  if (message.chatType === "group" && !facts.groupEnabled) return { kind: "ignore", reason: "group-disabled" };
  if (!facts.allowed) return { kind: "ignore", reason: "not-allowed" };

  const text = stripMentions(message.content ?? "", message.mentions).trim();
  const attachmentCount = message.resources?.length ?? 0;
  if (text.length === 0 && attachmentCount === 0) return { kind: "ignore", reason: "empty" };

  if (/^\/[a-z]/.test(text)) return { kind: "command", text };

  // 投递方式**不在这里判定**：上游在真正投递时才调 `decideDelivery(running, busyDelivery)`
  // （见 `delivery.ts` 与 `deliverToSession`），因此入站决策只回答"是不是要投、投什么"。
  return { kind: "deliver", text, attachmentCount };
}

function sourceOf(message: InboundMessageLike): MessageSource {
  return {
    kind: "feishu",
    ...(message.senderId ? { senderId: message.senderId } : {}),
    chatId: message.chatId,
    messageId: message.messageId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
  };
}

/**
 * 执行投递：按上游词表映射到 dsh 的调用。
 *
 * - `steer` → `agent.steer()`：提交到最近 step（空闲则起一轮）；
 * - `queue` → `agent.followup()`：排队到下一轮并唤醒驱动器。
 *
 * `delivery` 由调用方用 `decideDelivery(running, busyDelivery)` 判定（上游同序：
 * 先路由拿会话，再在投递时决定插队/排队）。
 */
export async function applyDelivery(
  decision: InboundDecision,
  message: InboundMessageLike,
  agent: AgentLike,
  port: HostPort,
  delivery: Delivery,
  parts?: readonly unknown[],
): Promise<void> {
  if (decision.kind !== "deliver") return;
  const userMessage = port.createUserMessage({
    text: decision.text,
    source: sourceOf(message),
    ...(parts && parts.length > 0 ? { parts } : {}),
  });
  if (delivery === "steer") {
    await agent.steer(userMessage);
    return;
  }
  await agent.followup(userMessage);
}
