import { describe, expect, test } from "vitest";
import { deliverInbound, prepareDelivery, sendDelivery, type DeliveryPort } from "../src/bridge/deliver.js";
import type { InboundMessageLike } from "../src/bridge/inbound.js";
import { MemoryTopicStore } from "../src/bridge/topics.js";
import type { AgentLike } from "../src/types.js";

const MESSAGE: InboundMessageLike = {
  messageId: "om_1",
  chatId: "oc_1",
  chatType: "p2p",
  senderId: "ou_1",
  content: "帮我看看构建为什么失败",
};

const DECISION = { kind: "deliver", text: "帮我看看构建为什么失败", delivery: "followup", attachmentCount: 0 } as const;

function harness(options: { failResolve?: boolean } = {}) {
  const created: Array<{ cwd: string; title: string }> = [];
  const steered: unknown[] = [];
  const followed: unknown[] = [];
  const agent: AgentLike = {
    followup: (message) => followed.push(message),
    steer: (message) => steered.push(message),
    inject: () => {},
    cancel: () => {},
  };
  const port: DeliveryPort = {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    createUserMessage: ({ text, source }) => ({ text, source }),
    createSession: async ({ cwd, title }) => {
      created.push({ cwd, title });
      return `feishu-session-${created.length}`;
    },
    resolveAgent: () => (options.failResolve ? undefined : agent),
  };
  return { created, steered, followed, agent, port };
}

describe("prepareDelivery / sendDelivery（先发卡再投递的顺序保证）", () => {
  test("prepare 只解析/建会话，不向会话注入消息", async () => {
    const store = new MemoryTopicStore();
    const h = harness();
    const prepared = await prepareDelivery(store, h.port, MESSAGE, DECISION, { cwd: "/tmp/work", now: () => 7 });

    expect(prepared).toEqual({
      sessionId: "feishu-session-1",
      created: true,
      title: "帮我看看构建为什么失败",
      cwd: "/tmp/work",
    });
    expect(h.followed).toHaveLength(0);
    expect(h.steered).toHaveLength(0);
    expect(store.get("chat:oc_1")?.sessionId).toBe("feishu-session-1");

    // 第二步才注入
    await sendDelivery(prepared, h.port, MESSAGE, DECISION);
    expect(h.followed).toHaveLength(1);
  });

  test("prepare 幂等：第二次返回同一会话且 created=false", async () => {
    const store = new MemoryTopicStore();
    const h = harness();
    const first = await prepareDelivery(store, h.port, MESSAGE, DECISION, { cwd: "/tmp/work", now: () => 1 });
    const second = await prepareDelivery(store, h.port, MESSAGE, DECISION, { cwd: "/tmp/work", now: () => 2 });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.created).toBe(false);
    expect(h.created).toHaveLength(1);
    expect(store.get("chat:oc_1")?.updatedAt).toBe(2);
  });

  test("titleMaxChars 透传给标题生成", async () => {
    const store = new MemoryTopicStore();
    const h = harness();
    const prepared = await prepareDelivery(store, h.port, MESSAGE, DECISION, { cwd: "/tmp/work", titleMaxChars: 4 });
    expect(prepared.title).toBe("帮我看看…");
  });
});

describe("deliverInbound", () => {
  test("首次消息：新建会话、写入映射、followup 投递", async () => {
    const store = new MemoryTopicStore();
    const h = harness();
    const result = await deliverInbound(store, h.port, MESSAGE, DECISION, { cwd: "/tmp/work", now: () => 1000 });

    expect(result).toEqual({ sessionId: "feishu-session-1", created: true });
    expect(h.created).toEqual([{ cwd: "/tmp/work", title: "帮我看看构建为什么失败" }]);
    expect(h.followed).toHaveLength(1);
    expect(h.steered).toHaveLength(0);
    expect(store.get("chat:oc_1")).toEqual({
      sessionId: "feishu-session-1",
      cwd: "/tmp/work",
      title: "帮我看看构建为什么失败",
      chatId: "oc_1",
      updatedAt: 1000,
    });
  });

  test("同一 chat 的后续消息复用会话，只刷新 updatedAt", async () => {
    const store = new MemoryTopicStore();
    const h = harness();
    await deliverInbound(store, h.port, MESSAGE, DECISION, { cwd: "/tmp/work", now: () => 1000 });
    const second = await deliverInbound(store, h.port, MESSAGE, DECISION, { cwd: "/tmp/work", now: () => 2000 });

    expect(second).toEqual({ sessionId: "feishu-session-1", created: false });
    expect(h.created).toHaveLength(1);
    expect(store.get("chat:oc_1")?.updatedAt).toBe(2000);
    expect(h.followed).toHaveLength(2);
  });

  test("话题维度独立：带 threadId 的消息走自己的会话", async () => {
    const store = new MemoryTopicStore();
    const h = harness();
    await deliverInbound(store, h.port, MESSAGE, DECISION, { cwd: "/tmp/work", now: () => 1 });
    const threaded = { ...MESSAGE, threadId: "omt_9" };
    const result = await deliverInbound(store, h.port, threaded, DECISION, { cwd: "/tmp/work", now: () => 2 });

    expect(result.sessionId).toBe("feishu-session-2");
    expect(store.get("thread:omt_9")?.threadId).toBe("omt_9");
    expect(h.created).toHaveLength(2);
  });

  test("steer 决策走插队路径", async () => {
    const store = new MemoryTopicStore();
    const h = harness();
    await deliverInbound(store, h.port, MESSAGE, { ...DECISION, delivery: "steer" }, { cwd: "/tmp/work" });
    expect(h.steered).toHaveLength(1);
    expect(h.followed).toHaveLength(0);
  });

  test("agent 无法解析时抛错（调用方记日志，不静默丢消息）", async () => {
    const store = new MemoryTopicStore();
    const h = harness({ failResolve: true });
    await expect(deliverInbound(store, h.port, MESSAGE, DECISION, { cwd: "/tmp/work" })).rejects.toThrow(
      /无法解析为存活 agent/,
    );
  });
});
