/**
 * 审批桥规格。
 *
 * 语义来自上游 `ApprovalManager`（opencode-feishu-plugin `src/permission.ts`，MIT）：
 * 策略判定、token 绑 operator、点击校验序（验签 → 白名单 → 会话匹配 → nonce 防重放）、
 * 拒绝级联、本会话放行、TTL 超时、卸载收敛。这里按 dsh 的 waterfall 形状（await 点击 → 返回结果词）重写。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApprovalBridge, type ApprovalOutcome } from "../src/bridge/approval.js";
import type { GateConfig } from "../src/bridge/permission.js";
import {
  ReplayGuard,
  signAllowSession,
  signApproval,
  verifyAllowSession,
  verifyApproval,
} from "../src/security/token.js";
import type { Logger, SessionLink } from "../src/types.js";

const SECRET = "test-secret";
const NOW = 1_700_000_000_000;
const LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const BASE_CONFIG: GateConfig = {
  permissionGate: "gate",
  allowTools: ["read", "glob"],
  denyTools: [],
  approvalTtlMs: 60_000,
  maxResourcesShown: 8,
};

interface Harness {
  bridge: ApprovalBridge;
  sent: Array<{ chatId: string; card: unknown }>;
  patched: Array<{ messageId: string; card: unknown }>;
  metaWrites: Array<{ sessionId: string; patch: Record<string, unknown> }>;
  nextCalls: () => number;
  next: () => Promise<ApprovalOutcome>;
}

function harness(
  options: { link?: SessionLink | undefined; config?: Partial<GateConfig>; sessionAllowButton?: boolean } = {},
): Harness {
  const sent: Array<{ chatId: string; card: unknown }> = [];
  const patched: Array<{ messageId: string; card: unknown }> = [];
  const metaWrites: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
  let nextCalls = 0;
  const link = "link" in options ? options.link : { chatId: "oc_1", openId: "ou_owner" };

  const bridge = new ApprovalBridge({
    config: { ...BASE_CONFIG, ...options.config },
    log: LOG,
    cardPort: {
      sendCard: async (chatId, card) => {
        sent.push({ chatId, card });
        return "om_card";
      },
      patchCard: async (messageId, card) => {
        patched.push({ messageId, card });
      },
    },
    getLink: async () => link,
    setSessionMeta: async (sessionId, patch) => {
      metaWrites.push({ sessionId, patch: patch as Record<string, unknown> });
      return true;
    },
    isAllowed: (openId) => openId === "ou_owner",
    sign: ({ requestID, sessionID, openId }) =>
      signApproval({ r: requestID, s: sessionID, u: openId, ttlMs: 60_000, now: NOW }, SECRET, {
        nonce: `n_${requestID}`,
      }),
    verify: (token, expect) => verifyApproval(token, SECRET, { now: NOW, ...(expect ? { expect } : {}) }),
    replay: new ReplayGuard(60_000, () => NOW),
    ...(options.sessionAllowButton === false ? { sessionAllowButton: false } : {}),
    signAllowSession: ({ requestID, sessionID, action }) =>
      signAllowSession({ requestID, sessionID, action, ttlMs: 60_000, now: NOW }, SECRET, {
        nonce: `a_${requestID}`,
      }),
    verifyAllowSession: (token, expect) => verifyAllowSession(token, SECRET, { now: NOW, ...(expect ?? {}) }),
    now: () => NOW,
  });

  return {
    bridge,
    sent,
    patched,
    metaWrites,
    nextCalls: () => nextCalls,
    next: async () => {
      nextCalls += 1;
      return "unavailable";
    },
  };
}

function approvalToken(requestID: string, sessionID = "ses_1", openId = "ou_owner"): string {
  return signApproval({ r: requestID, s: sessionID, u: openId, ttlMs: 60_000, now: NOW }, SECRET, {
    nonce: `n_${requestID}`,
  });
}

function allowSessionToken(requestID: string, action: string, sessionID = "ses_1"): string {
  return signAllowSession({ requestID, sessionID, action, ttlMs: 60_000, now: NOW }, SECRET, {
    nonce: `a_${requestID}`,
  });
}

function click(operator: string, value: unknown): { operator: { openId: string }; action: { value: unknown } } {
  return { operator: { openId: operator }, action: { value } };
}

/** 等内部 await 链推进（sendCard/getLink 都是 async）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ApprovalBridge.handle（策略判定）", () => {
  test("白名单动作 → allowed-once，不发卡", async () => {
    const h = harness();
    expect(await h.bridge.handle("ses_1", { toolName: "read", callId: "c1" }, h.next)).toBe("allowed-once");
    expect(h.sent).toHaveLength(0);
    expect(h.nextCalls()).toBe(0);
  });

  test("denyTools → rejected，不发卡", async () => {
    const h = harness({ config: { denyTools: ["bash"] } });
    expect(await h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next)).toBe("rejected");
    expect(h.sent).toHaveLength(0);
  });

  test("permissionGate=off → 完全不介入（委托宿主）", async () => {
    const h = harness({ config: { permissionGate: "off" } });
    expect(await h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next)).toBe("unavailable");
    expect(h.nextCalls()).toBe(1);
  });

  test("会话预设 trust（gateMode=off）→ 委托宿主，不接管", async () => {
    const h = harness({ link: { chatId: "oc_1", openId: "ou_owner", perm: "trust" } });
    expect(await h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next)).toBe("unavailable");
    expect(h.nextCalls()).toBe(1);
  });

  test("会话预设 readonly → 直接拒绝 bash（ruleset deny 的等价效果由 askActions 推导）", async () => {
    // readonly 的 gateMode=off → 委托；因此这里用 edit 预设（shell/bash → ask）验证"会发卡"
    const h = harness({ link: { chatId: "oc_1", openId: "ou_owner", perm: "edit" } });
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    expect(h.sent).toHaveLength(1);
    await h.bridge.handleCardAction(click("ou_owner", { t: approvalToken("c1"), d: "once" }));
    expect(await promise).toBe("allowed-once");
  });

  test("无飞书映射 → 委托宿主（绝不接管 GUI/TUI 会话）", async () => {
    const h = harness({ link: undefined });
    expect(await h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next)).toBe("unavailable");
    expect(h.nextCalls()).toBe(1);
    expect(h.sent).toHaveLength(0);
  });

  test("无 callId → 委托宿主", async () => {
    const h = harness();
    expect(await h.bridge.handle("ses_1", { toolName: "bash" }, h.next)).toBe("unavailable");
    expect(h.nextCalls()).toBe(1);
  });

  test("无 sessionId → 委托宿主", async () => {
    const h = harness();
    expect(await h.bridge.handle(undefined, { toolName: "bash", callId: "c1" }, h.next)).toBe("unavailable");
    expect(h.nextCalls()).toBe(1);
  });

  test("卡片发送失败 → unavailable（不把轮次挂在等点击上）", async () => {
    const h = harness();
    const broken = new ApprovalBridge({
      config: BASE_CONFIG,
      log: LOG,
      cardPort: {
        sendCard: async () => {
          throw new Error("飞书 500");
        },
        patchCard: async () => {},
      },
      getLink: async () => ({ chatId: "oc_1", openId: "ou_owner" }),
      setSessionMeta: async () => true,
      isAllowed: () => true,
      sign: () => approvalToken("c1"),
      verify: (token) => verifyApproval(token, SECRET, { now: NOW }),
      replay: new ReplayGuard(60_000, () => NOW),
      now: () => NOW,
    });
    expect(await broken.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next)).toBe("unavailable");
  });
});

describe("ApprovalBridge.handleCardAction（点击校验序）", () => {
  test("允许一次：patch 成结果卡并放行", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    const response = await h.bridge.handleCardAction(click("ou_owner", { t: approvalToken("c1"), d: "once" }));
    expect(await promise).toBe("allowed-once");
    expect(h.patched).toHaveLength(1);
    expect(JSON.stringify(h.patched[0]?.card)).toContain("已允许一次");
    expect(JSON.stringify(response)).toContain("已允许一次");
  });

  test("拒绝：patch 成红色结果卡并驳回", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    await h.bridge.handleCardAction(click("ou_owner", { t: approvalToken("c1"), d: "reject" }));
    expect(await promise).toBe("rejected");
    expect(JSON.stringify(h.patched[0]?.card)).toContain("已拒绝");
  });

  test("拒绝级联：同会话其余待批一并驳回", async () => {
    const h = harness();
    const first = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    const second = h.bridge.handle("ses_1", { toolName: "edit", callId: "c2" }, h.next);
    await flush();
    expect(h.bridge.pendingCount).toBe(2);

    await h.bridge.handleCardAction(click("ou_owner", { t: approvalToken("c1"), d: "reject" }));
    expect(await first).toBe("rejected");
    expect(await second).toBe("rejected");
    expect(h.bridge.pendingCount).toBe(0);
  });

  test("点击人必须与 token 绑定的 operator 一致", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    const response = await h.bridge.handleCardAction(click("ou_other", { t: approvalToken("c1"), d: "once" }));
    expect(JSON.stringify(response)).toContain("不是发给你的审批");
    expect(h.bridge.pendingCount).toBe(1);
    // 正确的人点仍然可以
    await h.bridge.handleCardAction(click("ou_owner", { t: approvalToken("c1"), d: "once" }));
    expect(await promise).toBe("allowed-once");
  });

  test("非白名单用户即使 token 绑的是他也被拒", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    const strangerToken = approvalToken("c1", "ses_1", "ou_stranger");
    const response = await h.bridge.handleCardAction(click("ou_stranger", { t: strangerToken, d: "once" }));
    expect(JSON.stringify(response)).toContain("无权操作");
    expect(h.bridge.pendingCount).toBe(1);
    void promise;
  });

  test("同一 token 重复点击 → 已处理（防重放）", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    await h.bridge.handleCardAction(click("ou_owner", { t: approvalToken("c1"), d: "once" }));
    const again = await h.bridge.handleCardAction(click("ou_owner", { t: approvalToken("c1"), d: "once" }));
    expect(JSON.stringify(again)).toContain("已处理");
    expect(await promise).toBe("allowed-once");
  });

  test("伪造 token → 失效提示", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    const response = await h.bridge.handleCardAction(click("ou_owner", { t: "forged.token", d: "once" }));
    expect(JSON.stringify(response)).toContain("操作已失效");
    void promise;
  });

  test("非审批按钮（未知 value）→ 不响应", async () => {
    const h = harness();
    expect(await h.bridge.handleCardAction(click("ou_owner", { foo: "bar" }))).toBeUndefined();
  });

  test("TTL 到期 → cancelled，并 patch 结果卡", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await promise).toBe("cancelled");
    expect(h.bridge.pendingCount).toBe(0);
    expect(h.patched).toHaveLength(1);
  });

  test("dispose 把待批全部收敛为 cancelled", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    h.bridge.dispose();
    expect(await promise).toBe("cancelled");
    expect(h.bridge.pendingCount).toBe(0);
  });
});

describe("本会话内允许该工具", () => {
  test("写入 allowActions（shell/bash 联动）并顺带放行当前请求", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    const response = await h.bridge.handleCardAction(
      click("ou_owner", { cmd: "allow_session", a: "bash", t: allowSessionToken("c1", "bash") }),
    );
    expect(h.metaWrites).toEqual([{ sessionId: "ses_1", patch: { allowActions: ["shell", "bash"] } }]);
    expect(await promise).toBe("allowed-once");
    expect(JSON.stringify(response)).toContain("已允许本会话内 bash");
    expect(JSON.stringify(h.patched[0]?.card)).toContain("已允许本会话内");
  });

  test("已有 allowActions 时合并去重", async () => {
    const h = harness({ link: { chatId: "oc_1", openId: "ou_owner", allowActions: ["edit"] } });
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    await h.bridge.handleCardAction(
      click("ou_owner", { cmd: "allow_session", a: "bash", t: allowSessionToken("c1", "bash") }),
    );
    expect(h.metaWrites[0]?.patch).toEqual({ allowActions: ["edit", "shell", "bash"] });
    expect(await promise).toBe("allowed-once");
  });

  test("sessionAllowButton=false → 卡片不渲染该按钮", async () => {
    const h = harness({ sessionAllowButton: false });
    const promise = h.bridge.handle("ses_1", { toolName: "bash", callId: "c1" }, h.next);
    await flush();
    expect(JSON.stringify(h.sent[0]?.card)).not.toContain("allow_session");
    await h.bridge.handleCardAction(click("ou_owner", { t: approvalToken("c1"), d: "reject" }));
    expect(await promise).toBe("rejected");
  });
});
