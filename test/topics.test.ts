import { describe, expect, test } from "vitest";
import {
  FEISHU_TOPICS_DOMAIN,
  MemoryTopicStore,
  openTopicStore,
  topicKey,
  topicTitle,
  type StorageDomainLike,
} from "../src/bridge/topics.js";
import type { Logger } from "../src/types.js";

const LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("topicKey / topicTitle", () => {
  test("有 threadId 用话题维度，否则用 chat 维度", () => {
    expect(topicKey({ chatId: "oc_1" })).toBe("chat:oc_1");
    expect(topicKey({ chatId: "oc_1", threadId: "omt_9" })).toBe("thread:omt_9");
  });

  test("标题压缩空白并截断到 20 字符；空文本回退", () => {
    expect(topicTitle("  帮我   看看构建  ")).toBe("帮我 看看构建");
    expect(topicTitle("")).toBe("飞书会话");
    expect(topicTitle("一".repeat(30))).toBe(`${"一".repeat(20)}…`);
  });
});

describe("领域声明", () => {
  test("域名单表名合法（defineDomain 会在模块加载时抛错，这里断言形状）", () => {
    expect(FEISHU_TOPICS_DOMAIN.name).toBe("feishu_topics");
    expect(FEISHU_TOPICS_DOMAIN.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(FEISHU_TOPICS_DOMAIN.version).toBe(1);
    expect(Object.keys(FEISHU_TOPICS_DOMAIN.tables)).toEqual(["topics"]);
  });
});

describe("MemoryTopicStore", () => {
  test("读写删与 entries", async () => {
    const store = new MemoryTopicStore();
    expect(store.get("chat:oc_1")).toBeUndefined();
    const record = {
      sessionId: "feishu-1",
      cwd: "/tmp",
      title: "标题",
      chatId: "oc_1",
      updatedAt: 1,
    };
    await store.put("chat:oc_1", record);
    expect(store.get("chat:oc_1")).toEqual(record);
    expect(store.entries()).toEqual([["chat:oc_1", record]]);
    await store.remove("chat:oc_1");
    expect(store.get("chat:oc_1")).toBeUndefined();
  });
});

describe("openTopicStore", () => {
  function fakeDomain(initial: Record<string, unknown> = {}, failOnOpen = false): StorageDomainLike {
    const data = new Map(Object.entries(initial));
    return {
      open: async () => {
        if (failOnOpen) throw new Error("backend not configured");
        return {
          table: () => ({
            get: (key: string) => data.get(key),
            put: async (key: string, value: unknown) => {
              data.set(key, value);
            },
            delete: async (key: string) => data.delete(key),
            entries: () => data.entries(),
          }),
          close: () => {},
        };
      },
    };
  }

  test("正常路径：读写走域表", async () => {
    const store = await openTopicStore(fakeDomain(), LOG);
    const record = { sessionId: "feishu-1", cwd: "/tmp", title: "t", chatId: "oc_1", updatedAt: 1 };
    await store.put("chat:oc_1", record);
    expect(store.get("chat:oc_1")).toEqual(record);
    expect(store.entries()).toEqual([["chat:oc_1", record]]);
    await store.remove("chat:oc_1");
    expect(store.get("chat:oc_1")).toBeUndefined();
  });

  test("形状非法的记录被丢弃（不把脏数据当映射用）", async () => {
    const store = await openTopicStore(fakeDomain({ "chat:oc_1": { sessionId: 42 } }), LOG);
    expect(store.get("chat:oc_1")).toBeUndefined();
    expect(store.entries()).toEqual([]);
  });

  test("open 失败时抛错，交由调用方降级", async () => {
    await expect(openTopicStore(fakeDomain({}, true), LOG)).rejects.toThrow("backend not configured");
  });
});
