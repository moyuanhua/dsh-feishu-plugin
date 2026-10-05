/**
 * 飞书 / Lark 长连接与出站封装 —— 基于官方 `@larksuite/channel`。
 *
 * 与上游 opencode 版的区别：上游自己用 `@larksuiteoapi/node-sdk` 实现了长连接、
 * 事件归一化、卡片流式、去重与队列（那 6,962 行的 `feishu/`）；这里全部交给官方
 * Channel SDK，本文件只做三件事：
 *   1. 把本插件的配置映射成 SDK 的 `policy`（最小权限的关键一环）；
 *   2. 把 SDK 的 logger 接到本插件带脱敏的 logger；
 *   3. 收窄事件与出站方法，只暴露本插件需要的形状（便于单测替换）。
 *
 * 已核实的一处 SDK 事实：`PolicyConfig.dmMode` 的 `'pair'` 在实现里没有分支
 * （只有 `'disabled'` / `'allowlist'` 生效，`'pair'` 等同 `'open'`），
 * 因此单人绑定必须由本插件的 OwnerPolicy 自己做，不能依赖 SDK。
 */
import { createLarkChannel } from "@larksuite/channel";
import type {
  CardActionEvent,
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
  RejectEvent,
  SendInput,
  SendOptions,
  SendResult,
} from "@larksuite/channel";
import { toChannelLogger } from "../logger.js";
import type { Logger } from "../types.js";

export interface FeishuChannelConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** 开放平台域名；缺省飞书。 */
  readonly domain?: string;
  /** 显式白名单；非空时叠加 SDK 层 `dmMode: 'allowlist'`（默认走我们的 OwnerPolicy）。 */
  readonly allowUsers: readonly string[];
  /** 群入口开关（预留）：默认 false，且平台层不会投递群消息（未申请群 scope）。 */
  readonly groupEnabled: boolean;
  /** 群白名单（chat id，`oc_…`）。 */
  readonly groupAllowlist?: readonly string[];
  /** 群内是否需要 @；默认 true。 */
  readonly requireMention?: boolean;
  /** 流式卡片节流（ms）。 */
  readonly streamThrottleMs?: number;
  /** User-Agent 里的来源标识。 */
  readonly source?: string;
  readonly log: Logger;
}

/** 只暴露本插件需要的形状，便于单测替换与未来换 SDK。 */
export interface FeishuChannel {
  readonly raw: LarkChannel;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (message: NormalizedMessage) => void | Promise<void>): () => void;
  onCardAction(handler: (event: CardActionEvent) => void | Promise<void>): () => void;
  onReject(handler: (event: RejectEvent) => void): () => void;
  onReconnecting(handler: () => void): () => void;
  onReconnected(handler: () => void): () => void;
  send(chatId: string, input: SendInput, options?: SendOptions): Promise<SendResult>;
  reply(
    target: Pick<NormalizedMessage, "chatId" | "messageId" | "threadId">,
    input: SendInput,
    options?: SendOptions,
  ): Promise<SendResult>;
  updateCard(messageId: string, card: object): Promise<void>;
}

export function createFeishuChannel(config: FeishuChannelConfig): FeishuChannel {
  const hasAllowlist = config.allowUsers.length > 0;
  const hasGroupAllowlist = (config.groupAllowlist?.length ?? 0) > 0;

  const options: LarkChannelOptions = {
    appId: config.appId,
    appSecret: config.appSecret,
    transport: "websocket",
    source: config.source ?? "dsh-feishu-plugin",
    logger: toChannelLogger(config.log) as LarkChannelOptions["logger"],
    // 只有群场景才需要区分「话题群 / 普通群」（话题=会话的路由依据）；单聊模式不付这次 API 调用。
    resolveChatMode: config.groupEnabled,
    resolveSenderNames: false,
    policy: {
      // SDK 的 dmMode 只有 'disabled' / 'allowlist' 真正生效；
      // 未配白名单时走 'open'，单人边界由「应用可用范围 + OwnerPolicy」保证。
      dmMode: hasAllowlist ? "allowlist" : "open",
      ...(hasAllowlist ? { dmAllowlist: [...config.allowUsers] } : {}),
      requireMention: config.requireMention ?? true,
      ...(hasGroupAllowlist ? { groupAllowlist: [...config.groupAllowlist!] } : {}),
      respondToMentionAll: false,
      // 两个 bot 互相 @ 的死循环防护（SDK 建议 onTrip: 'reject' 以便调用方感知）。
      botLoopGuard: { enabled: true, onTrip: "reject" },
    },
    ...(config.streamThrottleMs !== undefined ? { outbound: { streamThrottleMs: config.streamThrottleMs } } : {}),
    ...(config.domain ? { domain: config.domain } : {}),
  };

  const raw = createLarkChannel(options);

  return {
    raw,
    connect: () => raw.connect(),
    disconnect: () => raw.disconnect(),
    onMessage: (handler) => raw.on("message", handler),
    onCardAction: (handler) => raw.on("cardAction", handler),
    onReject: (handler) => raw.on("reject", handler),
    onReconnecting: (handler) => raw.on("reconnecting", handler),
    onReconnected: (handler) => raw.on("reconnected", handler),
    send: (chatId, input, sendOptions) => raw.send(chatId, input, sendOptions),
    reply: (target, input, sendOptions) => raw.reply(target, input, sendOptions),
    updateCard: (messageId, card) => raw.updateCard(messageId, card),
  };
}
