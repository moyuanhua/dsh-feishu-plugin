/**
 * `ctx.sessionQuery` 适配器规格。
 *
 * 这一层是 S1「删镜像」的接缝：会话列表与标题全部来自宿主，我们不再自建。
 * 因此要覆盖三件事：
 * 1. **形状容错**：宿主返回的记录可能缺字段，缺一个不能整条丢掉列表；
 * 2. **失败降级**：服务缺失、抛异常、返回非数组 —— 全部降级为空结果并记 warn；
 * 3. **不碰 search**：`dsh-base` 的 sqlite 是 `openAt: never`，搜索会失败（这条是设计约束）。
 */
import { describe, expect, test, vi } from "vitest";
import { createHostSessionQuery } from "../src/dsh/session-query.js";
import type { Logger } from "../src/types.js";

const LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * 造一个最小的 cordis `ctx`：只需要 `inject` 与 `get`。
 *
 * `inject` 的行为与宿主一致 —— 服务可用时**立即**执行回调并把子 ctx 传进去。
 */
function fakeCtx(service: unknown): never {
  const sub = { sessionQuery: service };
  return {
    inject: (names: readonly string[], fn: (s: unknown) => void) => {
      if (names.includes("sessionQuery") && service !== undefined) fn(sub);
    },
    get: (name: string) => (name === "sessionQuery" ? service : undefined),
  } as never;
}

const RECORDS = [
  { header: { id: "s1", createdAt: 100, cwd: "/a", isSeeded: false } },
  { header: { id: "s2", createdAt: 200, origin: "subagent", parentSession: "s0", isSeeded: false } },
  { header: { id: "s3", createdAt: 300, isSeeded: false } },
];

describe("list", () => {
  test("映射出 id / createdAt / cwd / parent / origin", async () => {
    const port = createHostSessionQuery(fakeCtx({ listSessions: async () => RECORDS }), LOG);
    expect(await port.list()).toEqual([
      { id: "s1", createdAt: 100, cwd: "/a" },
      { id: "s2", createdAt: 200, parentSession: "s0", origin: "subagent" },
      { id: "s3", createdAt: 300 },
    ]);
  });

  test("缺 header / 缺 id 的记录被跳过，其余照常返回", async () => {
    const port = createHostSessionQuery(
      fakeCtx({ listSessions: async () => [null, {}, { header: {} }, RECORDS[0]] }),
      LOG,
    );
    expect(await port.list()).toEqual([{ id: "s1", createdAt: 100, cwd: "/a" }]);
  });

  test("createdAt 缺失按 0（不丢整条记录）", async () => {
    const port = createHostSessionQuery(fakeCtx({ listSessions: async () => [{ header: { id: "x" } }] }), LOG);
    expect(await port.list()).toEqual([{ id: "x", createdAt: 0 }]);
  });

  test("空字符串的 cwd / parent / origin 不写入（避免出现无意义的字段）", async () => {
    const port = createHostSessionQuery(
      fakeCtx({ listSessions: async () => [{ header: { id: "x", createdAt: 1, cwd: "", origin: "" } }] }),
      LOG,
    );
    expect(await port.list()).toEqual([{ id: "x", createdAt: 1 }]);
  });

  test("返回非数组 → 空列表", async () => {
    const port = createHostSessionQuery(fakeCtx({ listSessions: async () => ({ nope: true }) }), LOG);
    expect(await port.list()).toEqual([]);
  });

  test("抛异常 → 空列表 + warn（列表空了但插件不崩）", async () => {
    const warn = vi.fn();
    const port = createHostSessionQuery(
      fakeCtx({
        listSessions: async () => {
          throw new Error("boom");
        },
      }),
      { ...LOG, warn },
    );
    expect(await port.list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  test("服务缺失 → 空列表 + warn", async () => {
    const warn = vi.fn();
    const port = createHostSessionQuery(fakeCtx(undefined), { ...LOG, warn });
    expect(await port.list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  test("服务存在但没有 listSessions 方法 → 空列表", async () => {
    const port = createHostSessionQuery(fakeCtx({}), LOG);
    expect(await port.list()).toEqual([]);
  });
});

describe("titles", () => {
  const service = {
    readTitleSnapshots: async () => [
      { sessionId: "s1", status: "fulfilled", value: { title: { title: "修复编译报错" } } },
      { sessionId: "s2", status: "rejected", reason: "boom" },
      { sessionId: "s3", status: "fulfilled", value: {} },
      { sessionId: "s4", status: "fulfilled", value: { title: { title: "   " } } },
    ],
  };

  test("只收 fulfilled 且有非空标题的项", async () => {
    const port = createHostSessionQuery(fakeCtx(service), LOG);
    const titles = await port.titles(["s1", "s2", "s3", "s4"]);
    expect([...titles.entries()]).toEqual([["s1", "修复编译报错"]]);
  });

  test("标题去掉首尾空白", async () => {
    const port = createHostSessionQuery(
      fakeCtx({
        readTitleSnapshots: async () => [
          { sessionId: "s1", status: "fulfilled", value: { title: { title: "  X  " } } },
        ],
      }),
      LOG,
    );
    expect((await port.titles(["s1"])).get("s1")).toBe("X");
  });

  test("空入参不调用宿主", async () => {
    const spy = vi.fn();
    const port = createHostSessionQuery(fakeCtx({ readTitleSnapshots: spy }), LOG);
    expect(await port.titles([])).toEqual(new Map());
    expect(spy).not.toHaveBeenCalled();
  });

  test("方法缺失 / 抛异常 / 非数组 → 空 Map（列表仍能渲染，只是没标题）", async () => {
    expect((await createHostSessionQuery(fakeCtx({}), LOG).titles(["s1"])).size).toBe(0);
    const throwing = createHostSessionQuery(
      fakeCtx({
        readTitleSnapshots: async () => {
          throw new Error("boom");
        },
      }),
      LOG,
    );
    expect((await throwing.titles(["s1"])).size).toBe(0);
    const wrongShape = createHostSessionQuery(fakeCtx({ readTitleSnapshots: async () => "nope" }), LOG);
    expect((await wrongShape.titles(["s1"])).size).toBe(0);
  });
});

describe("exists（/resume 与列表「进入」前的探活）", () => {
  test("readTitle 有返回 → 存在", async () => {
    const port = createHostSessionQuery(fakeCtx({ readTitle: async () => ({ title: "t" }) }), LOG);
    expect(await port.exists("s1")).toBe(true);
  });

  test("readTitle 返回 undefined → 不存在", async () => {
    const port = createHostSessionQuery(fakeCtx({ readTitle: async () => undefined }), LOG);
    expect(await port.exists("s1")).toBe(false);
  });

  test("readTitle 抛异常时退到 observeSession 探活，并释放 lease", async () => {
    const dispose = vi.fn();
    const port = createHostSessionQuery(
      fakeCtx({
        readTitle: async () => {
          throw new Error("boom");
        },
        observeSession: async () => ({ dispose }),
      }),
      LOG,
    );
    expect(await port.exists("s1")).toBe(true);
    expect(dispose).toHaveBeenCalled();
  });

  test("两个方法都没有 → false", async () => {
    expect(await createHostSessionQuery(fakeCtx({}), LOG).exists("s1")).toBe(false);
  });

  test("observeSession 抛异常 → false（不冒到调用方）", async () => {
    const port = createHostSessionQuery(
      fakeCtx({
        observeSession: async () => {
          throw new Error("gone");
        },
      }),
      LOG,
    );
    expect(await port.exists("s1")).toBe(false);
  });
});

describe("设计约束：绝不使用 searchSessions", () => {
  test("宿主提供 searchSessions 也不会被调用（sqlite 默认 openAt: never，搜索会失败）", async () => {
    const searchSpy = vi.fn();
    const port = createHostSessionQuery(
      fakeCtx({ listSessions: async () => RECORDS, searchSessions: searchSpy }),
      LOG,
    );
    await port.list();
    await port.titles(["s1"]);
    await port.exists("s1");
    expect(searchSpy).not.toHaveBeenCalled();
  });
});
