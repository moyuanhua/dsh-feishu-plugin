import { describe, expect, test } from "vitest";
import {
  applyDelivery,
  decideInbound,
  stripMentions,
  type InboundFacts,
  type InboundMessageLike,
} from "../src/bridge/inbound.js";
import type { AgentLike, HostPort } from "../src/types.js";

const BASE_FACTS: InboundFacts = {
  allowed: true,
  groupEnabled: false,
  busy: false,
  busyDelivery: "steer",
};

function message(overrides: Partial<InboundMessageLike> = {}): InboundMessageLike {
  return {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "p2p",
    senderId: "ou_1",
    content: "帮我看看构建为什么失败",
    ...overrides,
  };
}

describe("decideInbound", () => {
  test("私聊普通文本 → steer（空闲时 decideDelivery 返回 steer，见 delivery.ts 规格）", () => {
    expect(decideInbound(message(), BASE_FACTS)).toEqual({
      kind: "deliver",
      text: "帮我看看构建为什么失败",
      delivery: "steer",
      attachmentCount: 0,
    });
  });

  test("空闲时恒为 steer；忙碌时按 busyDelivery 偏好（steer 插队 / queue 排队）", () => {
    // 空闲：无论偏好都是 steer（无队可插）—— decideDelivery 规格
    expect(decideInbound(message(), { ...BASE_FACTS, busy: false, busyDelivery: "queue" })).toMatchObject({
      delivery: "steer",
    });
    const busySteer = decideInbound(message(), { ...BASE_FACTS, busy: true, busyDelivery: "steer" });
    const busyQueue = decideInbound(message(), { ...BASE_FACTS, busy: true, busyDelivery: "queue" });
    expect(busySteer).toMatchObject({ kind: "deliver", delivery: "steer" });
    expect(busyQueue).toMatchObject({ kind: "deliver", delivery: "queue" });
  });

  test("bot 的消息一律忽略", () => {
    expect(decideInbound(message({ senderIsBot: true }), BASE_FACTS)).toEqual({
      kind: "ignore",
      reason: "from-bot",
    });
  });

  test("群消息在 groupEnabled=false 时忽略，开启后投递", () => {
    const group = message({ chatType: "group", chatMode: "topic" });
    expect(decideInbound(group, BASE_FACTS)).toEqual({ kind: "ignore", reason: "group-disabled" });
    expect(decideInbound(group, { ...BASE_FACTS, groupEnabled: true })).toMatchObject({ kind: "deliver" });
  });

  test("非白名单用户忽略（单人边界）", () => {
    expect(decideInbound(message(), { ...BASE_FACTS, allowed: false })).toEqual({
      kind: "ignore",
      reason: "not-allowed",
    });
  });

  test("空文本且无附件忽略；只有附件也算有效消息", () => {
    expect(decideInbound(message({ content: "   " }), BASE_FACTS)).toEqual({ kind: "ignore", reason: "empty" });
    expect(
      decideInbound(message({ content: "", resources: [{ type: "image", fileKey: "fk_1" }] }), BASE_FACTS),
    ).toMatchObject({ kind: "deliver", attachmentCount: 1 });
  });

  test("斜杠开头识别为命令（M3 执行）", () => {
    expect(decideInbound(message({ content: "/stop" }), BASE_FACTS)).toEqual({ kind: "command", text: "/stop" });
  });

  test("群内 @ 占位被剔除，正文以 @ 开头不会误判为命令", () => {
    const withMention = message({
      chatType: "group",
      content: "@_user_1 /status",
      mentions: [{ key: "@_user_1", name: "bot" }],
    });
    expect(stripMentions(withMention.content, withMention.mentions)).toBe(" /status");
    expect(decideInbound(withMention, { ...BASE_FACTS, groupEnabled: true })).toEqual({
      kind: "command",
      text: "/status",
    });
  });
});

describe("applyDelivery", () => {
  function harness(): { calls: string[]; agent: AgentLike; port: HostPort } {
    const calls: string[] = [];
    const agent: AgentLike = {
      followup: () => calls.push("followup"),
      steer: () => calls.push("steer"),
      inject: () => calls.push("inject"),
      cancel: () => calls.push("cancel"),
    };
    const port: HostPort = {
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      createUserMessage: ({ text, source }) => ({ text, source }),
      resolveAgent: () => agent,
    };
    return { calls, agent, port };
  }

  test("deliver(steer) 调 steer 并把 source 标成 feishu", async () => {
    const { calls, agent, port } = harness();
    const built: unknown[] = [];
    const spyPort: HostPort = {
      ...port,
      createUserMessage: (input) => {
        built.push(input);
        return { kind: "user-message" };
      },
    };
    await applyDelivery(
      { kind: "deliver", text: "干活", delivery: "steer", attachmentCount: 0 },
      message(),
      agent,
      spyPort,
    );
    expect(calls).toEqual(["steer"]);
    expect(built[0]).toEqual({
      text: "干活",
      source: { kind: "feishu", senderId: "ou_1", chatId: "oc_1", messageId: "om_1" },
    });
  });

  test("deliver(queue) 调 followup；deliver(steer) 调 steer；ignore/command 不触碰 agent", async () => {
    const { calls, agent, port } = harness();
    await applyDelivery({ kind: "deliver", text: "任务", delivery: "queue", attachmentCount: 0 }, message(), agent, port);
    await applyDelivery({ kind: "ignore", reason: "empty" }, message(), agent, port);
    await applyDelivery({ kind: "command", text: "/stop" }, message(), agent, port);
    expect(calls).toEqual(["followup"]);
  });
});
