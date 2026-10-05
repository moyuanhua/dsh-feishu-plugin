import { describe, expect, test } from "vitest";
import { isUserAllowed, matchesAny, OWNER_STORAGE_KEY, OwnerPolicy } from "../src/security/allowlist.js";
import { MemoryStorage } from "../src/types.js";

describe("isUserAllowed / matchesAny", () => {
  test("空白名单不放行任何人（空 = 交给 owner 引导）", () => {
    expect(isUserAllowed("ou_1", [])).toBe(false);
    expect(isUserAllowed(undefined, ["ou_1"])).toBe(false);
    expect(isUserAllowed("ou_1", ["ou_1"])).toBe(true);
  });

  test("matchesAny 支持精确、前缀通配与全通配", () => {
    expect(matchesAny("bash", ["bash"])).toBe(true);
    expect(matchesAny("bash", ["read", "write"])).toBe(false);
    expect(matchesAny("mcp__github__create_issue", ["mcp__github__*"])).toBe(true);
    expect(matchesAny("anything", ["*"])).toBe(true);
  });
});

describe("OwnerPolicy", () => {
  test("配置了 allowUsers 时只放行名单，不做 owner 绑定", async () => {
    const storage = new MemoryStorage();
    const policy = new OwnerPolicy(storage, ["ou_owner"]);
    await policy.load();
    expect(await policy.admit("ou_owner")).toBe(true);
    expect(await policy.admit("ou_stranger")).toBe(false);
    expect(policy.ownerId).toBe("ou_owner");
    expect(await storage.get(OWNER_STORAGE_KEY)).toBeUndefined();
  });

  test("allowUsers 为空时首个发送者被绑定为 owner 并持久化", async () => {
    const storage = new MemoryStorage();
    const policy = new OwnerPolicy(storage, []);
    expect(await policy.admit("ou_first")).toBe(true);
    expect(await policy.admit("ou_second")).toBe(false);
    expect(policy.ownerId).toBe("ou_first");
    expect(await storage.get(OWNER_STORAGE_KEY)).toBe("ou_first");
  });

  test("重启后从存储恢复 owner（不重新绑定）", async () => {
    const storage = new MemoryStorage({ initial: { [OWNER_STORAGE_KEY]: "ou_owner" } });
    const policy = new OwnerPolicy(storage, []);
    await policy.load();
    expect(policy.isAllowed("ou_owner")).toBe(true);
    expect(await policy.admit("ou_stranger")).toBe(false);
  });

  test("无 senderId 一律拒绝；storage 抛错不影响本次放行", async () => {
    const broken = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => {
        throw new Error("boom");
      },
    };
    const policy = new OwnerPolicy(broken, []);
    expect(await policy.admit(undefined)).toBe(false);
    expect(await policy.admit("ou_first")).toBe(true);
    expect(policy.isAllowed("ou_first")).toBe(true);
  });
});
