/**
 * 会话管理命令规划器规格。
 *
 * 复用的纯逻辑（`matchSession` / `sessionLine` / `useErrorText` / `isPermissionPreset` / `presetLabel`）
 * 来自上游搬运模块；本文件只验证"命令 → 动作计划"的规划语义。
 */
import { describe, expect, test } from "vitest";
import { parseCommand } from "../src/bridge/commands.js";
import { planSessionCommand, renderCurrent, renderSessionList } from "../src/bridge/session-commands.js";
import type { SessionEntry } from "../src/bridge/session-map.js";

const ENTRIES: SessionEntry[] = [
  { sessionID: "ses_aaa111", title: "一", updatedAt: 1 },
  { sessionID: "ses_bbb222", title: "", updatedAt: 2 },
];

function plan(text: string, over: Partial<Parameters<typeof planSessionCommand>[0]> = {}) {
  const parsed = parseCommand(text);
  if (!parsed) throw new Error(`not a command: ${text}`);
  return planSessionCommand({
    parsed,
    scope: "main",
    sessions: ENTRIES,
    activeId: "ses_aaa111",
    ...over,
  });
}

describe("渲染", () => {
  test("renderSessionList：编号 + 当前标记 + /use 提示；空列表给建会话引导", () => {
    const text = renderSessionList(ENTRIES, "ses_aaa111");
    expect(text).toContain("1. 一");
    expect(text).toContain("← 当前");
    expect(text).toContain("/use <序号|会话id前缀>");
    expect(renderSessionList([], undefined)).toContain("/new");
  });

  test("renderCurrent：标题/会话 id/档位/目录；无会话给引导", () => {
    const text = renderCurrent(ENTRIES[1], { chatId: "oc_1", openId: "ou_1", perm: "askHigh", dir: "/work" });
    expect(text).toContain("(未命名)");
    expect(text).toContain("ses_bbb222");
    expect(text).toContain("⚠️ 高风险审批");
    expect(text).toContain("/work");
    expect(renderCurrent(undefined, undefined)).toContain("/new");
  });
});

describe("planSessionCommand", () => {
  test("/current → blue 提示卡（主聊天流用当前会话）", () => {
    expect(plan("/current")).toMatchObject({ kind: "notice", template: "blue" });
    expect((plan("/current") as { text: string }).text).toContain("ses_aaa111");
  });

  test("/sessions → 蓝色列表卡", () => {
    expect(plan("/sessions")).toMatchObject({ kind: "notice", template: "blue" });
    expect((plan("/ls") as { text: string }).text).toContain("ses_bbb222");
  });

  test("/use 序号 命中 → set-active；未知 → 橙色提示", () => {
    expect(plan("/use 2")).toMatchObject({ kind: "set-active", sessionId: "ses_bbb222" });
    expect(plan("/use ses_aaa")).toMatchObject({ kind: "set-active", sessionId: "ses_aaa111" });
    expect(plan("/use 9")).toMatchObject({ kind: "notice", template: "orange" });
    expect(plan("/use")).toMatchObject({ kind: "notice", template: "orange" });
  });

  test("话题内 /use 被白名单拦在前层；规划器也给 unsupported（双保险）", () => {
    expect(plan("/use 1", { scope: "thread", threadSessionId: "ses_bbb222" })).toMatchObject({
      kind: "unsupported",
    });
  });

  test("/perm 无参 → 显示当前档位与可选项", () => {
    const out = plan("/perm", { link: { chatId: "oc_1", openId: "ou_1", perm: "edit" } });
    expect(out).toMatchObject({ kind: "notice" });
    expect((out as { text: string }).text).toContain("✏️ 可编辑");
    expect((out as { text: string }).text).toContain("readonly");
  });

  test("/perm <档位> → set-perm；非法档位 → 橙色提示", () => {
    expect(plan("/perm trust")).toMatchObject({ kind: "set-perm", sessionId: "ses_aaa111", perm: "trust" });
    expect(plan("/perm bogus")).toMatchObject({ kind: "notice", template: "orange" });
  });

  test("/perm 无会话 → 灰色提示（不凭空造会话）", () => {
    expect(plan("/perm trust", { activeId: undefined })).toMatchObject({ kind: "notice", template: "grey" });
  });

  test("/steer <文本> → steer 计划；空文本 → 用法提示；无会话 → 灰色提示", () => {
    expect(plan("/steer 先看这个 bug")).toEqual({
      kind: "steer",
      sessionId: "ses_aaa111",
      text: "先看这个 bug",
    });
    expect(plan("/steer")).toMatchObject({ kind: "notice", template: "orange" });
    expect(plan("/steer x", { activeId: undefined })).toMatchObject({ kind: "notice", template: "grey" });
  });

  test("话题内 /current /sessions /perm /steer 都作用于话题会话", () => {
    const over = { scope: "thread" as const, threadSessionId: "ses_bbb222" };
    expect((plan("/current", over) as { text: string }).text).toContain("ses_bbb222");
    expect(plan("/perm trust", over)).toMatchObject({ kind: "set-perm", sessionId: "ses_bbb222" });
    expect(plan("/steer 干活", over)).toMatchObject({ kind: "steer", sessionId: "ses_bbb222" });
  });

  test("尚未移植的命令明确回报原因（不假装成功）", () => {
    for (const [text, needle] of [
      ["/model", "模型选择"],
      ["/cd /tmp", "工作目录"],
      ["/now", "park"],
      ["/resume", "尚未移植"],
      ["/dir /tmp", "尚未移植"],
      ["/cancel", "尚未移植"],
      ["/frobnicate", "未知命令"],
    ] as const) {
      const out = plan(text);
      expect(out).toMatchObject({ kind: "unsupported" });
      expect((out as { reason: string }).reason).toContain(needle);
    }
  });
});
