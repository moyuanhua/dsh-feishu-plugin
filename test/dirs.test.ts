/**
 * 工作目录策略规格。
 *
 * 这是缺陷 2 的回归测试：旧实现让 `cwd` 回落到 `process.cwd()`，于是飞书会话的
 * 工作目录变成了宿主进程碰巧启动的地方（实测 `/private/tmp`），用户既看不见也改不了。
 */
import { describe, expect, test } from "vitest";
import { isWithin, normalizeDir, resolveWorkingDir } from "../src/bridge/dirs.js";

const ROOTS = ["/Users/code/wps"];

describe("normalizeDir", () => {
  test("折叠 . 与 ..、去掉结尾分隔符", () => {
    expect(normalizeDir("/a/b/../c")).toBe("/a/c");
    expect(normalizeDir("/a/b/")).toBe("/a/b");
    expect(normalizeDir("/a/./b")).toBe("/a/b");
  });

  test("根目录保持为 /（不会被截成空串）", () => {
    expect(normalizeDir("/")).toBe("/");
  });

  test("空串归一化为空串（调用方据此判断未提供）", () => {
    expect(normalizeDir("   ")).toBe("");
  });
});

describe("isWithin", () => {
  test("相等或真子树为真；同前缀但不是子树为假", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/b/c", "/a/b")).toBe(true);
    // 关键：按路径段比较，避免 /a/bc 被误判为 /a/b 的子目录
    expect(isWithin("/a/bc", "/a/b")).toBe(false);
    expect(isWithin("/a", "/a/b")).toBe(false);
  });
});

describe("resolveWorkingDir", () => {
  test("显式目录优先于默认目录", () => {
    const result = resolveWorkingDir({
      requested: "/Users/code/wps/proj",
      defaultDir: "/Users/code/wps/other",
      allowedRoots: ROOTS,
    });
    expect(result).toEqual({ ok: true, dir: "/Users/code/wps/proj" });
  });

  test("没有显式目录时用配置的默认目录", () => {
    expect(
      resolveWorkingDir({ defaultDir: "/Users/code/wps/default", allowedRoots: ROOTS }),
    ).toEqual({ ok: true, dir: "/Users/code/wps/default" });
  });

  test("没有配置也没有显式目录时用 allowedRoots 第一项 —— 而不是 process.cwd()", () => {
    const result = resolveWorkingDir({ allowedRoots: ROOTS });
    expect(result).toEqual({ ok: true, dir: "/Users/code/wps" });
    expect(result.ok && result.dir).not.toBe(process.cwd());
  });

  test("allowedRoots 为空 → 拒绝（对齐上游「无法确定默认目录」）", () => {
    const result = resolveWorkingDir({ allowedRoots: [] });
    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain("allowedRoots");
  });

  test("越界目录被拒绝，且提示里列出允许的根", () => {
    const result = resolveWorkingDir({ requested: "/opt/elsewhere", allowedRoots: ROOTS });
    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain("不在允许范围内");
    expect(result.ok || result.message).toContain("/Users/code/wps");
  });

  test("系统目录被拒绝（即使它落在 allowedRoots 内）", () => {
    const result = resolveWorkingDir({ requested: "/usr/local/x", allowedRoots: ["/usr"] });
    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain("系统目录");
  });

  test("根目录 / 被单独拒绝（文案与上游一致）", () => {
    const result = resolveWorkingDir({ requested: "/", allowedRoots: ["/"] });
    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain("根目录");
  });

  test("相对路径归一化后落在允许范围内则通过，越界则拒绝", () => {
    // normalizeDir 会 resolve 成绝对路径，因此相对写法不会被当成"非法路径"
    expect(resolveWorkingDir({ requested: "/Users/code/wps/a/../b", allowedRoots: ROOTS })).toEqual({
      ok: true,
      dir: "/Users/code/wps/b",
    });
  });

  test("同前缀但不是子目录的路径被拒绝", () => {
    const result = resolveWorkingDir({ requested: "/Users/code/wps-other", allowedRoots: ROOTS });
    expect(result.ok).toBe(false);
  });
});
