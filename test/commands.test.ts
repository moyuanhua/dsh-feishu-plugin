import { describe, expect, test } from "vitest";
import { COMMANDS, findCommand, isCommandLine, parseCommand } from "../src/bridge/commands.js";

describe("isCommandLine", () => {
  test("以 / + 小写字母开头才算命令", () => {
    expect(isCommandLine("/status")).toBe(true);
    expect(isCommandLine("  /stop  ")).toBe(true);
    expect(isCommandLine("/Status")).toBe(false);
    expect(isCommandLine("状态 /status")).toBe(false);
    expect(isCommandLine("/")).toBe(false);
    expect(isCommandLine("/ 空格")).toBe(false);
  });
});

describe("parseCommand", () => {
  test("解析命令名与 rawInput（rawInput 保留参数内部空白）", () => {
    expect(parseCommand("/status")).toEqual({ name: "/status", rawInput: "" });
    expect(parseCommand("/stop 理由 是 这个")).toEqual({ name: "/stop", rawInput: " 理由 是 这个" });
    // 整行先 trim：行尾空白不进 rawInput（与上游一致）
    expect(parseCommand("  /help  ")).toEqual({ name: "/help", rawInput: "" });
  });

  test("命令名支持字母/数字/短横线/下划线", () => {
    expect(parseCommand("/feishu-dev")?.name).toBe("/feishu-dev");
    expect(parseCommand("/a_b2")?.name).toBe("/a_b2");
  });

  test("非命令或非法命令名返回 undefined", () => {
    expect(parseCommand("你好")).toBeUndefined();
    expect(parseCommand("/")).toBeUndefined();
    expect(parseCommand("/状态")).toBeUndefined();
    expect(parseCommand("/-x")).toBeUndefined();
  });
});

describe("findCommand", () => {
  test("命中命令表（大小写不敏感）并返回描述", () => {
    expect(findCommand("/help")?.description).toBe("显示可用命令");
    expect(findCommand("/STATUS")?.name).toBe("/status");
  });

  test("未知命令返回 undefined", () => {
    expect(findCommand("/nope")).toBeUndefined();
  });

  test("命令表里的名字都合法且唯一", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(parseCommand(name)?.name).toBe(name);
      expect(name.startsWith("/")).toBe(true);
    }
  });
});
