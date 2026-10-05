/**
 * 声明本插件自己的消息来源 kind（模块增强）。
 *
 * 官方约定：`MessageSourceMap` 是 merge-extensible 的，每个生产者（桥）声明自己的 kind
 * —— 例如 `webhook` 声明 `{ kind: 'webhook', provider, source, deliveryId, ruleId }`、
 * `schedule` 用 `kind: 'schedule'`（证据：`packages/webhook/webhook/src/session.ts:156`、
 * `packages/schedule/schedule/tests/runtime.spec.ts:70`）。这样会话历史里能区分消息来源。
 */
import type { MessageSource } from "@deepseek-ai/dsh-llm";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    /** 来自飞书 / Lark 的远程 UI 消息。 */
    feishu: {
      readonly kind: "feishu";
      /** 飞书 chat id（`oc_…` / 单聊也是 chat）。 */
      readonly chatId: string;
      /** 飞书 message id（`om_…`）。 */
      readonly messageId: string;
      /** 发送者 open_id（`ou_…`）。 */
      readonly senderId?: string;
      /** 话题 id（群话题场景）。 */
      readonly threadId?: string;
    };
  }
}

/** 构造飞书来源标记；返回真实 `MessageSource` 类型，便于直接喂给 createUserMessage。 */
export function feishuSource(input: {
  readonly chatId: string;
  readonly messageId: string;
  readonly senderId?: string;
  readonly threadId?: string;
}): MessageSource {
  return {
    kind: "feishu",
    chatId: input.chatId,
    messageId: input.messageId,
    ...(input.senderId ? { senderId: input.senderId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
}
