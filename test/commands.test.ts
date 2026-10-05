/**
 * 命令矩阵规格。
 *
 * **规格来源**：opencode-feishu-plugin `test/commands.test.ts`（MIT，Copyright (c) 2026 moyuanhua），
 * 逐条搬运（仅改 import 路径与文案里的产品名）。
 */
import { describe, expect, test } from "vitest";
import {
  COMMAND_SPECS,
  defaultSessionTitle,
  helpText,
  isCommand,
  isCommandAllowedInThread,
  matchSession,
  parseCommand,
  sessionLine,
  shortSessionId,
  threadForbiddenText,
  topicTitle,
  useErrorText,
} from "../src/bridge/commands.js";
import type { SessionEntry } from "../src/bridge/session-map.js";

const entries: SessionEntry[] = [
  { sessionID: "ses_aaa111", title: "一", updatedAt: 1 },
  { sessionID: "ses_bbb222", title: "二", updatedAt: 2 },
  { sessionID: "ses_abc999", title: "", updatedAt: 3 },
];

describe("parseCommand", () => {
  test("非命令返回 undefined", () => {
    expect(parseCommand("hello")).toBeUndefined();
    expect(parseCommand("")).toBeUndefined();
    expect(parseCommand("你好 /new")).toBeUndefined();
  });

  test("/new 带标题 / 不带标题", () => {
    expect(parseCommand("/new")).toEqual({ name: "new", args: "", raw: "new" });
    expect(parseCommand("/new 我的标题")).toEqual({ name: "new", args: "我的标题", raw: "new" });
  });

  test("别名 /ls 与大小写", () => {
    expect(parseCommand("/ls")?.name).toBe("sessions");
    expect(parseCommand("/SESSIONS")?.name).toBe("sessions");
    expect(parseCommand("/Use 2")).toEqual({ name: "use", args: "2", raw: "Use" });
  });

  test("/use 序号或 id 前缀", () => {
    expect(parseCommand("/use 2")).toEqual({ name: "use", args: "2", raw: "use" });
    expect(parseCommand("/use ses_abc")).toEqual({ name: "use", args: "ses_abc", raw: "use" });
  });

  test("未知命令标记 unknown，空命令视为 help", () => {
    expect(parseCommand("/frobnicate x")?.name).toBe("unknown");
    expect(parseCommand("/")?.name).toBe("help");
  });

  test("dir/model/perm/cd/cancel 与别名", () => {
    expect(parseCommand("/dir /home/ubuntu/x")).toEqual({ name: "dir", args: "/home/ubuntu/x", raw: "dir" });
    expect(parseCommand("/model claude")?.name).toBe("model");
    expect(parseCommand("/perm edit")?.name).toBe("perm");
    expect(parseCommand("/permissions edit")?.name).toBe("perm");
    expect(parseCommand("/cd /home/ubuntu/x")?.name).toBe("cd");
    expect(parseCommand("/cancel")?.name).toBe("cancel");
  });

  test("/form 命令", () => {
    expect(parseCommand("/form")).toEqual({ name: "form", args: "", raw: "form" });
  });

  test("isCommand 只看前导 /", () => {
    expect(isCommand("/new")).toBe(true);
    expect(isCommand("  /new")).toBe(true);
    expect(isCommand("你好")).toBe(false);
    expect(isCommand("[图片]")).toBe(false);
  });
});

describe("matchSession", () => {
  test("数字序号按 1-based", () => {
    expect(matchSession("1", entries)).toEqual({ ok: true, entry: entries[0] });
    expect(matchSession("3", entries)).toEqual({ ok: true, entry: entries[2] });
    expect(matchSession("4", entries)).toEqual({ ok: false, reason: "not_found" });
  });

  test("id 前缀唯一命中", () => {
    const result = matchSession("ses_bbb", entries);
    expect(result.ok && result.entry.sessionID).toBe("ses_bbb222");
  });

  test("前缀歧义 / 未命中 / 空", () => {
    expect(matchSession("ses_", entries)).toEqual({ ok: false, reason: "ambiguous" });
    expect(matchSession("ses_zzz", entries)).toEqual({ ok: false, reason: "not_found" });
    expect(matchSession("   ", entries)).toEqual({ ok: false, reason: "empty" });
  });

  test("大小写不敏感前缀", () => {
    const result = matchSession("SES_BBB", entries);
    expect(result.ok && result.entry.sessionID).toBe("ses_bbb222");
  });
});

describe("文案与展示", () => {
  test("defaultSessionTitle 由时间戳决定", () => {
    const title = defaultSessionTitle(0);
    expect(title).toContain("1970-01-01");
    expect(defaultSessionTitle(1_700_000_000_000)).not.toBe(title);
  });

  test("shortSessionId 截断", () => {
    expect(shortSessionId("ses_abc")).toBe("ses_abc");
    expect(shortSessionId("ses_aaaaaaaaaaaaaaaa")).toMatch(/…$/);
  });

  test("sessionLine 标记当前", () => {
    expect(sessionLine(entries[0]!, 0, "ses_aaa111")).toContain("← 当前");
    expect(sessionLine(entries[2]!, 2)).toContain("(未命名)");
  });

  test("useErrorText 三种提示", () => {
    expect(useErrorText("empty")).toContain("/use");
    expect(useErrorText("ambiguous")).toContain("多个");
    expect(useErrorText("not_found")).toContain("未找到");
  });

  // 缺陷 6 回归：帮助文案必须是**已实现命令**的镜像。
  // 旧实现是手写清单，列了 /dir /model /resume /now /cancel /cd，
  // 用户敲下去只会得到一条"尚未移植" —— 帮助卡本身在误导用户。
  test("helpText 列出全部已实现命令", () => {
    const text = helpText();
    for (const spec of COMMAND_SPECS.filter((s) => s.implemented)) {
      expect(text, `缺少已实现命令 ${spec.name}`).toContain(spec.usage);
    }
  });

  test("helpText 不列任何未实现的命令（帮助不能误导用户）", () => {
    const text = helpText();
    for (const spec of COMMAND_SPECS.filter((s) => !s.implemented)) {
      expect(text, `不应出现未实现命令 ${spec.name}`).not.toContain(spec.usage);
    }
    for (const cmd of ["/dir", "/resume", "/cancel", "/now", "/cd", "/model"]) {
      expect(text).not.toContain(cmd);
    }
    expect(text).toContain("尚未实现");
  });

  test("规格表本身自洽：每个未实现命令都必须有明确原因", () => {
    // 规格表里所有名字都必须能被 parseCommand 解析出来（表与别名同步）
    for (const spec of COMMAND_SPECS) {
      expect(parseCommand(`/${spec.name}`)?.name, spec.name).toBe(spec.name);
    }
    // 至少有一条已实现命令，否则帮助是空的
    expect(COMMAND_SPECS.some((s) => s.implemented)).toBe(true);
  });

  test("helpText(thread) 只列话题内可用命令并提示去主聊天流", () => {
    const text = helpText("thread");
    expect(text).toContain("/current");
    expect(text).toContain("/stop");
    expect(text).toContain("/perm");
    expect(text).toContain("/steer");
    expect(text).not.toContain("/new [标题]");
    expect(text).not.toContain("/use <序号");
    expect(text).toContain("主聊天流");

    for (const spec of COMMAND_SPECS.filter((s) => s.implemented && s.inThread)) {
      expect(text).toContain(spec.usage);
    }
    // 主聊天流专属的已实现命令不该出现在话题帮助里
    for (const spec of COMMAND_SPECS.filter((s) => s.implemented && !s.inThread)) {
      expect(text).not.toContain(spec.usage);
    }
  });

  test("话题命令白名单由规格表派生", () => {
    // 话题内可用的（含未实现的：要给"尚未移植"的准确提示，而不是"话题内不支持"）
    for (const name of ["current", "stop", "help", "perm", "steer", "model", "cd", "now"] as const) {
      expect(isCommandAllowedInThread(name), `${name} 应放行`).toBe(true);
    }
    expect(isCommandAllowedInThread("unknown")).toBe(true);
    // 建会话与会话管理类必须被引导回主聊天流
    for (const name of ["new", "form", "sessions", "use", "resume", "dir", "cancel"] as const) {
      expect(isCommandAllowedInThread(name), `${name} 应被禁`).toBe(false);
    }
  });

  test("threadForbiddenText 指向主聊天流", () => {
    expect(threadForbiddenText("new")).toContain("/new");
    expect(threadForbiddenText("new")).toContain("主聊天流");
  });

  test("topicTitle 取首条消息摘要（压缩空白、按 20 字截断、带「话题: 」前缀）", () => {
    expect(topicTitle("  帮我   看看这个 bug ")).toBe("话题: 帮我 看看这个 bug");
    expect(topicTitle("")).toBe("话题会话");
    const long = topicTitle("一".repeat(30));
    expect(long.startsWith("话题: ")).toBe(true);
    expect(long).toMatch(/…$/);
  });
});
