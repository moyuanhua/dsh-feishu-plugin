/**
 * 投递层规格。
 *
 * 上游没有独立的 `deliver.test.ts`（投递逻辑在 `index.ts` 的 `runInSession` 里），
 * 这里按上游语义把可测部分固化成规格：**先由路由拿到会话，再在投递时用
 * `decideDelivery(running, busyDelivery)` 决定 steer / queue**（判定规格见
 * `test/delivery.test.ts`），并保证 `steer → agent.steer()`、`queue → agent.followup()` 的映射。
 */
import { describe, expect, test } from "vitest";
import { deliverToSession, type DeliveryPort } from "../src/bridge/deliver.js";
import type { InboundMessageLike } from "../src/bridge/inbound.js";
import type { AgentLike } from "../src/types.js";

const MESSAGE: InboundMessageLike = {
  messageId: "om_1",
  chatId: "oc_1",
  chatType: "p2p",
  senderId: "ou_1",
  content: "帮我看看构建为什么失败",
};

const DECISION = { kind: "deliver", text: "帮我看看构建为什么失败", attachmentCount: 0 } as const;

interface Harness {
  port: DeliveryPort;
  calls: string[];
  built: unknown[];
}

function harness(options: { resolveAgent?: boolean } = {}): Harness {
  const calls: string[] = [];
  const built: unknown[] = [];
  const agent: AgentLike = {
    followup: () => calls.push("followup"),
    steer: () => calls.push("steer"),
    inject: () => calls.push("inject"),
    cancel: () => calls.push("cancel"),
  };
  const port: DeliveryPort = {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    createSession: async () => "feishu-session-1",
    resolveAgent: () => (options.resolveAgent === false ? undefined : agent),
    createUserMessage: (input) => {
      built.push(input);
      return { kind: "user-message" };
    },
  };
  return { port, calls, built };
}

describe("deliverToSession", () => {
  test("空闲 → steer（decideDelivery 规格：空闲恒为 steer）", async () => {
    const h = harness();
    const outcome = await deliverToSession(h.port, "ses_1", MESSAGE, DECISION, {
      running: false,
      busyDelivery: "queue",
    });
    expect(outcome).toEqual({ delivery: "steer" });
    expect(h.calls).toEqual(["steer"]);
  });

  test("忙 + busyDelivery=steer → steer 插队", async () => {
    const h = harness();
    const outcome = await deliverToSession(h.port, "ses_1", MESSAGE, DECISION, {
      running: true,
      busyDelivery: "steer",
    });
    expect(outcome.delivery).toBe("steer");
    expect(h.calls).toEqual(["steer"]);
  });

  test("忙 + busyDelivery=queue → queue 映射到 followup 排队", async () => {
    const h = harness();
    const outcome = await deliverToSession(h.port, "ses_1", MESSAGE, DECISION, {
      running: true,
      busyDelivery: "queue",
    });
    expect(outcome.delivery).toBe("queue");
    expect(h.calls).toEqual(["followup"]);
  });

  test("消息来源标记为 feishu 并带上 chat/message/sender", async () => {
    const h = harness();
    await deliverToSession(h.port, "ses_1", MESSAGE, DECISION, { running: false, busyDelivery: "steer" });
    expect(h.built[0]).toEqual({
      text: "帮我看看构建为什么失败",
      source: { kind: "feishu", senderId: "ou_1", chatId: "oc_1", messageId: "om_1" },
    });
  });

  test("threadId 透传进来源标记", async () => {
    const h = harness();
    await deliverToSession(h.port, "ses_1", { ...MESSAGE, threadId: "omt_9" }, DECISION, {
      running: false,
      busyDelivery: "steer",
    });
    expect((h.built[0] as { source: Record<string, unknown> }).source).toMatchObject({ threadId: "omt_9" });
  });

  test("agent 无法解析时抛错（调用方记日志并把运行卡收成 failed）", async () => {
    const h = harness({ resolveAgent: false });
    await expect(
      deliverToSession(h.port, "ses_1", MESSAGE, DECISION, { running: false, busyDelivery: "steer" }),
    ).rejects.toThrow(/无法解析为存活 agent/);
    expect(h.calls).toEqual([]);
  });
});
