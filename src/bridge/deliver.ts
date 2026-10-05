/**
 * 投递：把一条消息投进**已由路由解析好的会话**。
 *
 * **逻辑来源**：opencode-feishu-plugin 的 `runInSession`（`src/index.ts:1242` 附近的
 * `beginRun` + `promptSession`）：先按会话取回 agent（必要时 resume），
 * 再用 `decideDelivery(running, busyDelivery)` 决定 `steer`（插队）还是 `queue`（排队），
 * 最后把用户消息投进去。
 *
 * 会话的**归属**由路由层决定（`decideRoute` + `SessionMap`），本文件不做路由，
 * 因此它只有一件事：投递，并且投递顺序（发卡 → 投递）由调用方掌控。
 */
import { decideDelivery, type Delivery } from "./delivery.js";
import { applyDelivery, type InboundDecision, type InboundMessageLike } from "./inbound.js";
import type { HostPort } from "../types.js";

export type DeliverDecision = Extract<InboundDecision, { kind: "deliver" }>;

export interface DeliveryPort extends HostPort {
  /** 新建一个 dsh 会话，返回 sessionId。 */
  createSession(input: { readonly cwd: string; readonly title: string }): Promise<string>;
}

export interface DeliverOptions {
  /** 该会话当前是否在跑（由 `ExecutionTracker` 维护）。 */
  readonly running: boolean;
  /** 忙时投递偏好（上游 `busyDelivery`）。 */
  readonly busyDelivery: Delivery;
}

/** 投递结果里带上实际使用的投递方式，便于日志与断言。 */
export interface DeliveryOutcome {
  readonly delivery: Delivery;
}

export async function deliverToSession(
  port: DeliveryPort,
  sessionId: string,
  message: InboundMessageLike,
  decision: DeliverDecision,
  options: DeliverOptions,
): Promise<DeliveryOutcome> {
  const agent = await port.resolveAgent(sessionId);
  if (!agent) {
    throw new Error(`会话 ${sessionId} 无法解析为存活 agent（可能已被 dispose 且不可 resume）`);
  }
  const delivery = decideDelivery(options.running, options.busyDelivery);
  await applyDelivery(decision, message, agent, port, delivery);
  return { delivery };
}
