/**
 * 会话映射规格。
 *
 * **规格来源**：opencode-feishu-plugin `test/session-map.test.ts`（MIT，Copyright (c) 2026 moyuanhua），
 * 逐条搬运（仅改 import 路径、并用本地 FakeStorage）。这是"复制逻辑"的执行规格。
 */
import { describe, expect, test } from "vitest";
import {
  CHAT_KEY_PREFIX,
  CHAT_SESSIONS_SUFFIX,
  ROOT_KEY_PREFIX,
  SESSION_KEY_PREFIX,
  SESSION_THREAD_KEY_PREFIX,
  SessionMap,
  THREAD_KEY_PREFIX,
} from "../src/bridge/session-map.js";
import { createLogger } from "../src/logger.js";
import type { StorageLike } from "../src/types.js";

class FakeStorage implements StorageLike {
  private readonly data = new Map<string, unknown>();

  seed(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  raw(key: string): unknown {
    return this.data.get(key);
  }

  get(key: string): unknown {
    return this.data.get(key);
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  remove(key: string): void {
    this.data.delete(key);
  }
}

const log = createLogger({ level: "error", sink: () => undefined });
const NOW = 1_700_000_000_000;
const sessionsKey = (chatId: string) => `${CHAT_KEY_PREFIX}${chatId}${CHAT_SESSIONS_SUFFIX}`;

describe("SessionMap 多会话", () => {
  test("addSession 双向持久化 + 内存可同步判定", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "标题一", "ou_1");

    expect(map.hasSession("ses_1")).toBe(true);
    expect(map.getSessionIdForChat("oc_1")).toBe("ses_1");
    expect(storage.raw(sessionsKey("oc_1"))).toEqual({
      sessions: [{ sessionID: "ses_1", title: "标题一", updatedAt: NOW }],
      active: "ses_1",
    });
    expect(storage.raw(`${SESSION_KEY_PREFIX}ses_1`)).toEqual({ chatId: "oc_1", openId: "ou_1" });
  });

  test("多会话：listSessions 保持插入顺序，setActive 切换当前", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "一", "ou_1");
    await map.addSession("oc_1", "ses_2", "二", "ou_1");
    await map.addSession("oc_1", "ses_3", "三", "ou_1");

    const list = await map.listSessions("oc_1");
    expect(list.map((s) => s.sessionID)).toEqual(["ses_1", "ses_2", "ses_3"]);
    expect((await map.getActive("oc_1"))?.sessionID).toBe("ses_3");

    expect(await map.setActive("oc_1", "ses_2")).toBe(true);
    expect((await map.getActive("oc_1"))?.sessionID).toBe("ses_2");
    expect(map.getSessionIdForChat("oc_1")).toBe("ses_2");
    // 非当前会话仍然可被权限路由解析
    expect(await map.resolveBySession("ses_1")).toEqual({ chatId: "oc_1", openId: "ou_1" });
  });

  test("setActive 未知会话返回 false 且不改动 active", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "一", "ou_1");

    expect(await map.setActive("oc_1", "ses_x")).toBe(false);
    expect((await map.getActive("oc_1"))?.sessionID).toBe("ses_1");
  });

  test("removeSession：移除当前会话回退到剩余最后一个，并删 session 索引", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "一", "ou_1");
    await map.addSession("oc_1", "ses_2", "二", "ou_1");

    expect(await map.removeSession("oc_1", "ses_2")).toBe(true);
    expect((await map.listSessions("oc_1")).map((s) => s.sessionID)).toEqual(["ses_1"]);
    expect((await map.getActive("oc_1"))?.sessionID).toBe("ses_1");
    expect(storage.raw(`${SESSION_KEY_PREFIX}ses_2`)).toBeUndefined();
    expect(await map.removeSession("oc_1", "ses_x")).toBe(false);
  });

  test("renameSession 更新标题；不存在返回 false", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "旧", "ou_1");

    expect(await map.renameSession("oc_1", "ses_1", "新")).toBe(true);
    expect((await map.listSessions("oc_1"))[0]?.title).toBe("新");
    expect(await map.renameSession("oc_1", "ses_x", "新")).toBe(false);
  });

  test("向后兼容：读到旧单值 key 时迁移成多会话结构", async () => {
    const storage = new FakeStorage();
    storage.seed(`${CHAT_KEY_PREFIX}oc_legacy`, { sessionID: "ses_old", openId: "ou_old" });
    const map = new SessionMap(storage, log, { now: () => NOW });

    const active = await map.getActive("oc_legacy");
    expect(active?.sessionID).toBe("ses_old");
    expect(map.getSessionIdForChat("oc_legacy")).toBe("ses_old");
    expect(map.hasSession("ses_old")).toBe(true);
    // 新结构已写入，旧 key 已删除
    expect(storage.raw(sessionsKey("oc_legacy"))).toEqual({
      sessions: [{ sessionID: "ses_old", title: "", updatedAt: NOW }],
      active: "ses_old",
    });
    expect(storage.raw(`${CHAT_KEY_PREFIX}oc_legacy`)).toBeUndefined();
    expect(storage.raw(`${SESSION_KEY_PREFIX}ses_old`)).toEqual({ chatId: "oc_legacy", openId: "ou_old" });
    // 迁移后可正常新增/切换
    await map.addSession("oc_legacy", "ses_new", "新", "ou_old");
    expect(await map.setActive("oc_legacy", "ses_old")).toBe(true);
  });

  test("冷缓存时从 session 索引回填", async () => {
    const storage = new FakeStorage();
    storage.seed(`${SESSION_KEY_PREFIX}ses_9`, { chatId: "oc_9", openId: "ou_9" });
    const map = new SessionMap(storage, log);

    expect(await map.resolveBySession("ses_9")).toEqual({ chatId: "oc_9", openId: "ou_9" });
    expect(map.hasSession("ses_9")).toBe(true);
  });

  test("storage 无记录返回 undefined", async () => {
    const map = new SessionMap(new FakeStorage(), log);
    expect(await map.resolveBySession("ses_x")).toBeUndefined();
    expect(await map.resolveByChat("oc_x")).toBeUndefined();
    expect(await map.getActive("oc_x")).toBeUndefined();
    expect(await map.listSessions("oc_x")).toEqual([]);
  });

  test("storage 异常时降级不抛", async () => {
    const broken: StorageLike = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => {
        throw new Error("boom");
      },
      remove: async () => {
        throw new Error("boom");
      },
    };
    const map = new SessionMap(broken, log);
    expect(await map.resolveBySession("ses_x")).toBeUndefined();
    expect(await map.getActive("oc_x")).toBeUndefined();
    await expect(map.addSession("oc_1", "ses_1", "t", "ou_1")).resolves.toBeUndefined();
    // 内存仍可用
    expect(map.hasSession("ses_1")).toBe(true);
  });
});

describe("SessionMap 话题 / root 映射", () => {
  test("bindThread 持久化 + resolveByThread（含冷缓存回填）", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.bindThread("omt_1", "ses_1", "oc_1", "ou_1", "om_root");

    expect(storage.raw(`${THREAD_KEY_PREFIX}omt_1`)).toEqual({
      sessionID: "ses_1",
      chatId: "oc_1",
      openId: "ou_1",
      anchorMessageId: "om_root",
    });
    expect(await map.resolveByThread("omt_1")).toEqual({
      sessionID: "ses_1",
      chatId: "oc_1",
      openId: "ou_1",
      anchorMessageId: "om_root",
    });

    // 冷启动：新实例仅凭 storage 回填。
    const fresh = new SessionMap(storage, log);
    expect((await fresh.resolveByThread("omt_1"))?.sessionID).toBe("ses_1");
  });

  test("bindThread 同步写 session 索引的 replyMessageId（审批卡落话题）", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "t", "ou_1");
    await map.bindThread("omt_1", "ses_1", "oc_1", "ou_1", "om_root");

    expect(storage.raw(`${SESSION_KEY_PREFIX}ses_1`)).toEqual({
      chatId: "oc_1",
      openId: "ou_1",
      replyMessageId: "om_root",
    });
    // 内存缓存同步可见
    expect(map.getLink("ses_1")?.replyMessageId).toBe("om_root");
    // addSession 再调用不应冲掉锚点
    await map.addSession("oc_1", "ses_1", "t2", "ou_1");
    expect(map.getLink("ses_1")?.replyMessageId).toBe("om_root");
  });

  test("threadIdForSession 反向索引（含再开话题更新）", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.bindThread("omt_1", "ses_1", "oc_1", "ou_1", "om_root");
    expect(await map.threadIdForSession("ses_1")).toBe("omt_1");
    expect(storage.raw(`${SESSION_THREAD_KEY_PREFIX}ses_1`)).toEqual({ threadId: "omt_1" });
    // 冷启动回填
    expect(await new SessionMap(storage, log).threadIdForSession("ses_1")).toBe("omt_1");
    // 同一会话再开话题 → 反向索引更新为最近一次
    await map.bindThread("omt_2", "ses_1", "oc_1", "ou_1");
    expect(await map.threadIdForSession("ses_1")).toBe("omt_2");
    // 未绑定返回 undefined
    expect(await map.threadIdForSession("ses_x")).toBeUndefined();
  });

  test("bindRoot / resolveByRoot（含冷缓存回填）", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.bindRoot("om_card", "ses_1");
    expect(storage.raw(`${ROOT_KEY_PREFIX}om_card`)).toEqual({ sessionID: "ses_1" });
    expect(await map.resolveByRoot("om_card")).toEqual({ sessionID: "ses_1" });
    expect(await new SessionMap(storage, log).resolveByRoot("om_card")).toEqual({ sessionID: "ses_1" });
    expect(await map.resolveByRoot("om_unknown")).toBeUndefined();
  });

  test("空 id 直接忽略，不写 storage", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log);
    await map.bindThread("", "ses_1", "oc_1", "ou_1");
    await map.bindThread("omt_1", "", "oc_1", "ou_1");
    await map.bindRoot("", "ses_1");
    expect(await map.resolveByThread("omt_1")).toBeUndefined();
    expect(await map.resolveByRoot("om_card")).toBeUndefined();
  });

  test("ThreadLink 缺 sessionID 视为非法", async () => {
    const storage = new FakeStorage();
    storage.seed(`${THREAD_KEY_PREFIX}omt_bad`, { chatId: "oc_1", openId: "ou_1" });
    const map = new SessionMap(storage, log);
    expect(await map.resolveByThread("omt_bad")).toBeUndefined();
  });

  test("addSession setActive=false 不抢走当前会话", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "一", "ou_1");
    await map.addSession("oc_1", "ses_2", "话题", "ou_1", { setActive: false });
    expect((await map.getActive("oc_1"))?.sessionID).toBe("ses_1");
    expect((await map.listSessions("oc_1")).map((s) => s.sessionID)).toEqual(["ses_1", "ses_2"]);
    // 没有任何会话时 setActive=false 仍应落到新会话，避免"无当前"。
    await map.addSession("oc_2", "ses_3", "首", "ou_1", { setActive: false });
    expect((await map.getActive("oc_2"))?.sessionID).toBe("ses_3");
  });
});

describe("SessionMap 会话元数据", () => {
  test("setSessionMeta 持久化 perm/gateMode/dir/model，并保留其它字段", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "t", "ou_1");
    await map.bindThread("omt_1", "ses_1", "oc_1", "ou_1", "om_root");

    expect(await map.setSessionMeta("ses_1", { perm: "edit", gateMode: "gate", dir: "/tmp/a" })).toBe(true);
    expect(await map.setSessionMeta("ses_1", { model: { providerID: "deepseek", id: "deepseek-chat" } })).toBe(true);

    const link = await map.resolveBySession("ses_1");
    expect(link).toMatchObject({
      chatId: "oc_1",
      openId: "ou_1",
      replyMessageId: "om_root",
      perm: "edit",
      gateMode: "gate",
      dir: "/tmp/a",
      model: { providerID: "deepseek", id: "deepseek-chat" },
    });
    // 冷启动回填
    expect((await new SessionMap(storage, log).resolveBySession("ses_1"))?.perm).toBe("edit");
  });

  test("addSession / bindThread 不冲掉已有元数据", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "t", "ou_1");
    await map.setSessionMeta("ses_1", { perm: "trust", dir: "/tmp/b" });
    await map.addSession("oc_1", "ses_1", "t2", "ou_1");
    await map.bindThread("omt_9", "ses_1", "oc_1", "ou_1", "om_anchor");
    const link = await map.resolveBySession("ses_1");
    expect(link).toMatchObject({ perm: "trust", dir: "/tmp/b", replyMessageId: "om_anchor" });
  });

  test("setSessionMeta 未知会话返回 false", async () => {
    const map = new SessionMap(new FakeStorage(), log);
    expect(await map.setSessionMeta("ses_x", { dir: "/tmp" })).toBe(false);
  });

  test("allowActions 持久化 + 冷启动回填 + 非法值过滤（写入不归一化、读取才归一化）", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "t", "ou_1");
    await map.setSessionMeta("ses_1", { allowActions: ["bash", " edit ", "bash"] });

    // 写入侧原样落盘（上游语义：归一化发生在读取侧；调用方自己保证干净）
    expect((storage.raw(`${SESSION_KEY_PREFIX}ses_1`) as { allowActions?: string[] }).allowActions).toEqual([
      "bash",
      " edit ",
      "bash",
    ]);
    // 冷启动读取：去空白 + 去重
    expect((await new SessionMap(storage, log).resolveBySession("ses_1"))?.allowActions).toEqual(["bash", "edit"]);

    // 非法值（非数组 / 非字符串项）被过滤成空数组 → 字段被省略
    storage.seed(`${SESSION_KEY_PREFIX}ses_bad`, { chatId: "oc_1", openId: "ou_1", allowActions: [1, null, "  "] });
    expect((await new SessionMap(storage, log).resolveBySession("ses_bad"))?.allowActions).toBeUndefined();
  });

  test("话题根卡 rootCard：持久化 + 冷启动回填 + setRootCard/getRootCard", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "t", "ou_1");

    expect(
      await map.setRootCard("ses_1", {
        style: "created",
        sessionID: "ses_1",
        title: "话题",
        dir: "/tmp/c",
        summary: "摘要",
        updatedAt: NOW,
      }),
    ).toBe(true);
    const base = await map.getRootCard("ses_1");
    expect(base).toEqual({
      style: "created",
      sessionID: "ses_1",
      title: "话题",
      dir: "/tmp/c",
      summary: "摘要",
      updatedAt: NOW,
    });
    // 冷启动回填
    expect((await new SessionMap(storage, log).getRootCard("ses_1"))?.summary).toBe("摘要");

    // 清除
    expect(await map.setRootCard("ses_1", undefined)).toBe(true);
    expect(await map.getRootCard("ses_1")).toBeUndefined();

    // 非法 rootCard（缺 style/sessionID）在解析时被丢弃
    storage.seed(`${SESSION_KEY_PREFIX}ses_bad2`, { chatId: "oc_1", openId: "ou_1", rootCard: { title: "x" } });
    expect((await new SessionMap(storage, log).resolveBySession("ses_bad2"))?.rootCard).toBeUndefined();

    // 未知会话不凭空造卡
    expect(await map.setRootCard("ses_x", { style: "created", sessionID: "ses_x", title: "t" })).toBe(false);
  });
});

describe("SessionMap.ensureSessionLink（外部会话）", () => {
  test("无映射的外部会话 → 补建索引（含 dir），且可被权限路由解析", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.ensureSessionLink("ses_ext", { chatId: "oc_1", openId: "ou_1", directory: "/tmp/ext" });

    expect(map.hasSession("ses_ext")).toBe(true);
    expect(await map.resolveBySession("ses_ext")).toEqual({
      chatId: "oc_1",
      openId: "ou_1",
      dir: "/tmp/ext",
    });
  });

  test("已有映射 → 保留 perm/model 等元数据，只补缺失字段", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "t", "ou_1");
    await map.setSessionMeta("ses_1", { perm: "askHigh", dir: "/tmp/keep" });
    await map.ensureSessionLink("ses_1", { chatId: "oc_1", openId: "ou_1" });
    expect(await map.resolveBySession("ses_1")).toMatchObject({ perm: "askHigh", dir: "/tmp/keep" });
  });

  test("缺少 chatId/openId → 不创建", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log);
    await map.ensureSessionLink("ses_x", { chatId: "", openId: "ou_1" });
    await map.ensureSessionLink("", { chatId: "oc_1", openId: "ou_1" });
    expect(map.hasSession("ses_x")).toBe(false);
  });
});
