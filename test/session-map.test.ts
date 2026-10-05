/**
 * 绑定层规格（S1「删镜像」后的新契约）。
 *
 * 旧版这里测的是"会话清单镜像"（`listSessions` / `addSession` / `removeSession` …）。
 * 那些**已经删掉**：会话的权威来源是 `ctx.sessionQuery`，我们只存 dsh 不拥有的东西 ——
 * 绑定关系、插件自有元数据、最后活动时间。
 *
 * 因此本文件覆盖三件事：
 * 1. 绑定的读写与冷启动回填；
 * 2. **不再有会话清单**（显式断言不写 `:sessions`）；
 * 3. 旧版 `:sessions` 的**一次性降级迁移**（只取 active，不保留清单）。
 */
import { describe, expect, test, vi } from "vitest";
import {
  ACTIVE_SUFFIX,
  CHAT_KEY_PREFIX,
  LEGACY_SESSIONS_SUFFIX,
  SESSION_KEY_PREFIX,
  SessionMap,
  THREAD_KEY_PREFIX,
} from "../src/bridge/session-map.js";
import { MemoryStorage, type Logger, type StorageLike } from "../src/types.js";

const LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function make(storage: StorageLike = new MemoryStorage(), now = () => 1_000): SessionMap {
  return new SessionMap(storage, LOG, { now });
}

/** MemoryStorage 内部是 Map；测试里只关心"写了哪些键"。 */
function keysOf(storage: MemoryStorage): string[] {
  return [...(storage as unknown as { data: Map<string, unknown> }).data.keys()];
}

describe("绑定：会话 → 飞书投递目标", () => {
  test("link 之后可同步判定（审批 waterfall 的热路径）", async () => {
    const map = make();
    expect(map.hasSession("s1")).toBe(false);
    await map.link("oc_1", "s1", "ou_1");
    expect(map.hasSession("s1")).toBe(true);
    expect(map.getLink("s1")?.chatId).toBe("oc_1");
  });

  test("link 是幂等的：已存在时保留元数据，不重置 lastActivityAt", async () => {
    const map = make();
    await map.link("oc_1", "s1", "ou_1");
    await map.setSessionMeta("s1", { perm: "trust", lastActivityAt: 500 });
    await map.link("oc_1", "s1", "ou_1");
    expect(map.getLink("s1")?.perm).toBe("trust");
    expect(map.getLink("s1")?.lastActivityAt).toBe(500);
  });

  test("冷启动回填：新实例从 storage 读回", async () => {
    const storage = new MemoryStorage();
    await make(storage).link("oc_1", "s1", "ou_1");
    const fresh = make(storage);
    expect(fresh.hasSession("s1")).toBe(false);
    expect((await fresh.resolveBySession("s1"))?.chatId).toBe("oc_1");
    expect(fresh.hasSession("s1")).toBe(true);
  });

  test("没有记录 / 记录里缺 chatId → undefined", async () => {
    const storage = new MemoryStorage({ initial: { [`${SESSION_KEY_PREFIX}s1`]: { openId: "ou_1" }  } });
    expect(await make(storage).resolveBySession("s1")).toBeUndefined();
  });
});

describe("绑定：当前会话", () => {
  test("setActive 之后 getActiveId 能读到", async () => {
    const map = make();
    await map.link("oc_1", "s1", "ou_1");
    expect(await map.setActive("oc_1", "s1")).toBe(true);
    expect(await map.getActiveId("oc_1")).toBe("s1");
  });

  test("拒绝把未绑定的会话设为当前（避免指向死会话）", async () => {
    const map = make();
    expect(await map.setActive("oc_1", "ghost")).toBe(false);
    expect(await map.getActiveId("oc_1")).toBeUndefined();
  });

  test("冷启动回填当前会话", async () => {
    const storage = new MemoryStorage();
    const map = make(storage);
    await map.link("oc_1", "s1", "ou_1");
    await map.setActive("oc_1", "s1");
    expect(await make(storage).getActiveId("oc_1")).toBe("s1");
  });

  test("resolveByChat 返回当前会话与其 openId", async () => {
    const map = make();
    await map.link("oc_1", "s1", "ou_1");
    await map.setActive("oc_1", "s1");
    expect(await map.resolveByChat("oc_1")).toEqual({ sessionID: "s1", openId: "ou_1" });
  });

  test("没有当前会话时 resolveByChat → undefined", async () => {
    expect(await make().resolveByChat("oc_1")).toBeUndefined();
  });

  test("getSessionIdForChat 是同步缓存视图", async () => {
    const map = make();
    expect(map.getSessionIdForChat("oc_1")).toBeUndefined();
    await map.link("oc_1", "s1", "ou_1");
    expect(map.getSessionIdForChat("oc_1")).toBe("s1");
  });
});

describe("不再镜像会话清单（S1 的核心断言）", () => {
  test("建绑定**不会**写出 `:sessions` 清单键", async () => {
    const storage = new MemoryStorage();
    const map = make(storage);
    await map.link("oc_1", "s1", "ou_1");
    await map.setActive("oc_1", "s1");

    expect(keysOf(storage).some((k) => k.endsWith(LEGACY_SESSIONS_SUFFIX))).toBe(false);
    expect(storage.get(`${CHAT_KEY_PREFIX}oc_1${ACTIVE_SUFFIX}`)).toBe("s1");
  });

  test("会话记录里不再有 title / updatedAt（镜像字段已删）", async () => {
    const storage = new MemoryStorage();
    const map = make(storage);
    await map.link("oc_1", "s1", "ou_1");
    await map.setActive("oc_1", "s1");

    const raw = storage.get(`${SESSION_KEY_PREFIX}s1`) as Record<string, unknown>;
    expect(raw.title).toBeUndefined();
    expect(raw.updatedAt).toBeUndefined();
    expect(raw.chatId).toBe("oc_1");
  });
});

describe("旧版清单的降级迁移", () => {
  const legacy = (sessions: string[], active?: string) => ({
    sessions: sessions.map((id) => ({ sessionID: id, title: id, updatedAt: 1 })),
    ...(active ? { active } : {}),
  });

  test("只迁移 active", async () => {
    const storage = new MemoryStorage({
      initial: { [`${CHAT_KEY_PREFIX}oc_1${LEGACY_SESSIONS_SUFFIX}`]: legacy(["a", "b"], "b") },
    });
    expect(await make(storage).getActiveId("oc_1")).toBe("b");
  });

  test("active 悬空时退回列表最后一项（与旧版一致）", async () => {
    const storage = new MemoryStorage({
      initial: { [`${CHAT_KEY_PREFIX}oc_1${LEGACY_SESSIONS_SUFFIX}`]: legacy(["a", "b"], "gone") },
    });
    expect(await make(storage).getActiveId("oc_1")).toBe("b");
  });

  test("没有 active 字段 → 取最后一项", async () => {
    const storage = new MemoryStorage({
      initial: { [`${CHAT_KEY_PREFIX}oc_1${LEGACY_SESSIONS_SUFFIX}`]: legacy(["a", "b"]) },
    });
    expect(await make(storage).getActiveId("oc_1")).toBe("b");
  });

  test("形状不认识 → undefined（不抛）", async () => {
    for (const bad of [null, 42, {}, { sessions: "no" }, []]) {
      const storage = new MemoryStorage({ initial: { [`${CHAT_KEY_PREFIX}oc_1${LEGACY_SESSIONS_SUFFIX}`]: bad  } });
      expect(await make(storage).getActiveId("oc_1"), JSON.stringify(bad)).toBeUndefined();
    }
  });

  test("新键存在时优先读新键", async () => {
    const storage = new MemoryStorage({
      initial: {
        [`${CHAT_KEY_PREFIX}oc_1${ACTIVE_SUFFIX}`]: "new",
        [`${CHAT_KEY_PREFIX}oc_1${LEGACY_SESSIONS_SUFFIX}`]: legacy(["old"], "old"),
      },
    });
    expect(await make(storage).getActiveId("oc_1")).toBe("new");
  });
});

describe("话题 / 根卡映射", () => {
  test("bindThread → resolveByThread，并建立反向索引", async () => {
    const map = make();
    await map.bindThread("t1", "s1", "oc_1", "ou_1", "om_anchor");
    expect(await map.resolveByThread("t1")).toEqual({
      sessionID: "s1",
      chatId: "oc_1",
      openId: "ou_1",
      anchorMessageId: "om_anchor",
    });
    expect(await map.threadIdForSession("s1")).toBe("t1");
  });

  test("冷启动回填话题与反向索引（含 storage 里的键名）", async () => {
    const storage = new MemoryStorage();
    await make(storage).bindThread("t1", "s1", "oc_1", "ou_1");
    expect(keysOf(storage)).toContain(`${THREAD_KEY_PREFIX}t1`);
    const fresh = make(storage);
    expect((await fresh.resolveByThread("t1"))?.sessionID).toBe("s1");
    expect(await fresh.threadIdForSession("s1")).toBe("t1");
  });

  test("没有锚点时也能绑定", async () => {
    const map = make();
    await map.bindThread("t1", "s1", "oc_1", "ou_1");
    expect((await map.resolveByThread("t1"))?.anchorMessageId).toBeUndefined();
  });

  test("bindRoot → resolveByRoot（回复根卡进入会话）", async () => {
    const storage = new MemoryStorage();
    await make(storage).bindRoot("om_root", "s1");
    expect(await make(storage).resolveByRoot("om_root")).toEqual({ sessionID: "s1" });
  });

  test("未绑定的 thread/root → undefined", async () => {
    const map = make();
    expect(await map.resolveByThread("nope")).toBeUndefined();
    expect(await map.resolveByRoot("nope")).toBeUndefined();
    expect(await map.threadIdForSession("nope")).toBeUndefined();
  });
});

describe("会话元数据", () => {
  test("setSessionMeta 打补丁并保留其它字段；undefined 表示删除", async () => {
    const map = make();
    await map.link("oc_1", "s1", "ou_1");
    await map.setSessionMeta("s1", { perm: "edit", dir: "/a" });
    await map.setSessionMeta("s1", { dir: undefined, gateMode: "off" });

    const link = map.getLink("s1")!;
    expect(link.chatId).toBe("oc_1");
    expect(link.openId).toBe("ou_1");
    expect(link.perm).toBe("edit");
    expect(link.gateMode).toBe("off");
    expect(link.dir).toBeUndefined();
  });

  test("会话不存在 → false（不凭空造记录）", async () => {
    expect(await make().setSessionMeta("ghost", { perm: "trust" })).toBe(false);
  });

  test("allowActions 去重且过滤非法值（读取即归一化）", async () => {
    const storage = new MemoryStorage({
      initial: {
        [`${SESSION_KEY_PREFIX}s1`]: {
          chatId: "oc_1",
          openId: "ou_1",
          allowActions: ["shell", "shell", "", 42, "read"],
        },
      },
    });
    expect((await make(storage).resolveBySession("s1"))?.allowActions).toEqual(["shell", "read"]);
  });

  test("非法 perm / 不完整 model / 非法 gateMode 被丢弃", async () => {
    const storage = new MemoryStorage({
      initial: {
        [`${SESSION_KEY_PREFIX}s1`]: {
          chatId: "oc_1",
          openId: "ou_1",
          perm: "god",
          model: { providerID: "p" },
          gateMode: "weird",
        },
      },
    });
    const link = await make(storage).resolveBySession("s1");
    expect(link?.perm).toBeUndefined();
    expect(link?.model).toBeUndefined();
    expect(link?.gateMode).toBeUndefined();
  });

  test("rootCard 持久化 + 冷启动回填", async () => {
    const storage = new MemoryStorage();
    const map = make(storage);
    await map.link("oc_1", "s1", "ou_1");
    await map.setRootCard("s1", { style: "created", sessionID: "s1", title: "T", dir: "/a" });
    expect((await make(storage).getRootCard("s1"))?.title).toBe("T");
  });

  test("形状不对的 rootCard 被丢弃", async () => {
    const storage = new MemoryStorage({
      initial: { [`${SESSION_KEY_PREFIX}s1`]: { chatId: "oc_1", openId: "ou_1", rootCard: { style: "weird" } } },
    });
    expect(await make(storage).getRootCard("s1")).toBeUndefined();
  });
});

describe("最后活动时间（dsh 没有这个字段，我们自己记）", () => {
  test("touchActivity 记录并单调递增（乱序事件不倒退）", async () => {
    const map = make();
    await map.link("oc_1", "s1", "ou_1");
    await map.touchActivity("s1", 2_000);
    expect(map.getActivity("s1")).toBe(2_000);
    await map.touchActivity("s1", 1_000);
    expect(map.getActivity("s1")).toBe(2_000);
    await map.touchActivity("s1", 3_000);
    expect(map.getActivity("s1")).toBe(3_000);
  });

  test("没有绑定的会话不记活动（不为无关会话建记录）", async () => {
    const map = make();
    await map.touchActivity("outsider", 5_000);
    expect(map.getActivity("outsider")).toBeUndefined();
  });

  test("未变新时不写盘（高频事件流不放大 IO）", async () => {
    const storage = new MemoryStorage();
    const map = make(storage);
    await map.link("oc_1", "s1", "ou_1");
    await map.touchActivity("s1", 5_000);
    const setSpy = vi.spyOn(storage, "set");
    await map.touchActivity("s1", 4_000);
    await map.touchActivity("s1", 5_000);
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  test("冷启动回填", async () => {
    const storage = new MemoryStorage();
    const map = make(storage);
    await map.link("oc_1", "s1", "ou_1");
    await map.touchActivity("s1", 9_000);
    expect((await make(storage).resolveBySession("s1"))?.lastActivityAt).toBe(9_000);
  });

  test("默认时间源用注入的 now", async () => {
    const map = new SessionMap(new MemoryStorage(), LOG, { now: () => 12_345 });
    await map.link("oc_1", "s1", "ou_1");
    await map.touchActivity("s1");
    expect(map.getActivity("s1")).toBe(12_345);
  });
});

describe("存储异常降级（不让宿主错误冒到会话执行）", () => {
  const broken: StorageLike = {
    get: () => {
      throw new Error("boom");
    },
    set: () => {
      throw new Error("boom");
    },
    remove: () => {
      throw new Error("boom");
    },
  };

  test("读失败 → undefined，且记 warn", async () => {
    const warn = vi.fn();
    const map = new SessionMap(broken, { ...LOG, warn });
    expect(await map.resolveBySession("s1")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  test("写失败 → 不抛，内存里仍然可用", async () => {
    const map = new SessionMap(broken, LOG);
    await expect(map.link("oc_1", "s1", "ou_1")).resolves.toBeDefined();
    expect(map.hasSession("s1")).toBe(true);
  });
});
