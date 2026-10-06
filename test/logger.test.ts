/**
 * 日志规格：**脱敏**、id 遮盖、错误取文案、文件 sink、飞书 SDK logger 适配。
 *
 * 脱敏是这个模块存在的主要理由 —— 日志会进文件、会贴进 issue，
 * 凭据与 open_id 不该跟着出去。因此这里逐条锁住：
 * - 顶层 / 嵌套 / 数组里的敏感键名都要被替换；
 * - 循环引用不炸；
 * - 落盘文件是 0600。
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createLogger,
  createLogSink,
  errorMessage,
  maskId,
  redactMeta,
  toChannelLogger,
} from "../src/logger.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-log-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 收集 sink 收到的原始行。 */
function lineSpy() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => void lines.push(line) };
}

/** 把一行 JSON 日志解出来。 */
function parseLine(line: string): { level: string; msg: string; meta?: Record<string, unknown> } {
  return JSON.parse(line.slice(line.indexOf("{"))) as never;
}

describe("redactMeta —— 纵深防御", () => {
  test("顶层敏感键名被替换（大小写不敏感）", () => {
    expect(
      redactMeta({ appSecret: "s", APP_TOKEN: "t", password: "p", apiKey: "k", normal: "ok" }),
    ).toEqual({
      appSecret: "<redacted>",
      APP_TOKEN: "<redacted>",
      password: "<redacted>",
      apiKey: "<redacted>",
      normal: "ok",
    });
  });

  test("嵌套对象里的敏感键也被替换（旧版只看顶层，会漏）", () => {
    expect(redactMeta({ opts: { appSecret: "leak" } })).toEqual({
      opts: { appSecret: "<redacted>" },
    });
  });

  test("数组元素里的敏感键也被替换", () => {
    expect(redactMeta({ list: [{ token: "t" }, { ok: 1 }] })).toEqual({
      list: [{ token: "<redacted>" }, { ok: 1 }],
    });
  });

  test("超长字符串被截断并标注原长度", () => {
    const long = "x".repeat(600);
    const result = redactMeta({ body: long }).body as string;
    expect(result.startsWith("x".repeat(512))).toBe(true);
    expect(result).toContain("len=600");
  });

  test("未超长的字符串原样", () => {
    expect(redactMeta({ body: "short" }).body).toBe("short");
  });

  test("undefined 原样返回（不制造空对象）", () => {
    expect(redactMeta(undefined)).toBeUndefined();
  });

  test("循环引用不炸，并标记 [circular]", () => {
    const meta: Record<string, unknown> = { name: "x" };
    meta.self = meta;
    const result = redactMeta(meta);
    expect(result.name).toBe("x");
    expect(result.self).toBe("[circular]");
  });

  test("数组循环引用也不炸", () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    const result = redactMeta({ arr });
    expect(JSON.stringify(result)).toContain("circular");
  });

  test("同层出现的两个相同子对象不被误判为环", () => {
    const shared = { ok: 1 };
    expect(redactMeta({ a: shared, b: shared })).toEqual({ a: { ok: 1 }, b: { ok: 1 } });
  });

  test("非对象值原样保留", () => {
    expect(redactMeta({ n: 1, b: true, z: null })).toEqual({ n: 1, b: true, z: null });
  });

  test("回归：`path` 不能被误伤（旧正则有 `pat` 子串，会把 path 判成敏感）", () => {
    expect(redactMeta({ path: "/Users/code/wps", dir: "/a", sessionId: "s", toolName: "bash" })).toEqual({
      path: "/Users/code/wps",
      dir: "/a",
      sessionId: "s",
      toolName: "bash",
    });
  });

  test("回归：apiKey / api_key / accessKey 都要脱敏", () => {
    expect(redactMeta({ apiKey: "k", api_key: "k", accessKey: "k", publicKey: "k" })).toEqual({
      apiKey: "<redacted>",
      api_key: "<redacted>",
      accessKey: "<redacted>",
      publicKey: "<redacted>",
    });
  });
});

describe("maskId", () => {
  test("只留前 8 位并加省略号", () => {
    expect(maskId("ou_3c14f3a59eaf2825")).toBe("ou_3c14f…");
  });
  test("恰好 8 位不加省略号", () => {
    expect(maskId("12345678")).toBe("12345678");
  });
  test("undefined / 空串 → 空串", () => {
    expect(maskId(undefined)).toBe("");
    expect(maskId("")).toBe("");
  });
});

describe("errorMessage", () => {
  test("Error 取 message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  test("带 msg 字段的对象取 msg", () => {
    expect(errorMessage({ msg: "自定义" })).toBe("自定义");
  });
  test("字符串与其它类型转字符串", () => {
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("createLogger", () => {
  test("级别过滤：低于阈值的日志被丢弃", () => {
    const { lines, sink } = lineSpy();
    const log = createLogger({ level: "warn", sink, now: () => 0 });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => parseLine(l).level)).toEqual(["warn", "error"]);
  });

  test("debug 级别全都输出", () => {
    const { lines, sink } = lineSpy();
    const log = createLogger({ level: "debug", sink, now: () => 0 });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toHaveLength(4);
  });

  test("行格式：前缀 + JSON（含时间戳/级别/消息）", () => {
    const { lines, sink } = lineSpy();
    const log = createLogger({ level: "info", sink, prefix: "[p]", now: () => 0 });
    log.info("已加载");
    expect(lines[0]?.startsWith("[p] {")).toBe(true);
    const entry = parseLine(lines[0]!);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("已加载");
    expect(lines[0]).toContain("1970-01-01T00:00:00.000Z");
  });

  test("meta 先脱敏再落盘（含嵌套）", () => {
    const { lines, sink } = lineSpy();
    const log = createLogger({ level: "info", sink, now: () => 0 });
    log.info("x", { appSecret: "leak", nested: { token: "leak2" }, ok: 1 });
    expect(JSON.stringify(lines[0])).not.toContain("leak");
    expect(parseLine(lines[0]!).meta).toEqual({
      appSecret: "<redacted>",
      nested: { token: "<redacted>" },
      ok: 1,
    });
  });

  test("空 meta 不写 meta 字段", () => {
    const { lines, sink } = lineSpy();
    const log = createLogger({ level: "info", sink, now: () => 0 });
    log.info("x", {});
    expect(parseLine(lines[0]!).meta).toBeUndefined();
  });

  test("默认前缀是 [dsh-feishu]", () => {
    const { lines, sink } = lineSpy();
    createLogger({ level: "info", sink, now: () => 0 }).info("x");
    expect(lines[0]?.startsWith("[dsh-feishu] ")).toBe(true);
  });
});

describe("createLogSink", () => {
  test("undefined → undefined（不落盘）", () => {
    expect(createLogSink(undefined)).toBeUndefined();
  });

  /** 写流是异步的：轮询等文件真的落盘。 */
  async function waitForFile(file: string, timeoutMs = 2_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const text = readFileSync(file, "utf8");
        if (text.length > 0) return text;
      } catch {
        /* 还没建出来 */
      }
      if (Date.now() > deadline) throw new Error(`日志文件迟迟没落盘：${file}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test("写入 JSON Lines，凭据不落盘", async () => {
    const file = join(tempDir(), "sub", "app.log");
    const sink = createLogSink(file)!;
    const log = createLogger({ level: "info", sink: sink.sink, now: () => 0 });
    log.info("已加载", { appSecret: "leak-me" });
    const text = await waitForFile(file);
    sink.close();

    expect(text).not.toContain("leak-me");
    expect(JSON.parse(text.trim().slice(text.indexOf("{"))).msg).toBe("已加载");
  });

  test("自动创建父目录", async () => {
    const file = join(tempDir(), "a", "b", "c.log");
    const sink = createLogSink(file)!;
    sink.sink("x\n");
    await waitForFile(file);
    sink.close();
    expect(() => statSync(file)).not.toThrow();
  });

  test("文件权限 0600", async () => {
    const file = join(tempDir(), "app.log");
    const sink = createLogSink(file)!;
    sink.sink("x\n");
    await waitForFile(file);
    sink.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("close 幂等", () => {
    const file = join(tempDir(), "app.log");
    const sink = createLogSink(file)!;
    sink.close();
    expect(() => sink.close()).not.toThrow();
  });

  /**
   * 用「父路径是普通文件」造不可写路径：`mkdirSync('<file>/sub')` 在任何平台都抛 ENOTDIR。
   *
   * 之前这里写死 `/proc/...`，那是**平台相关**的：Linux 上与 macOS 行为不同，
   * 于是 `createLogSink` 返回了 sink → 断言失败 → **而那个 sink 从未被 close** →
   * 未释放的 write stream 让 vitest worker 永不退出，CI 无限挂起。
   * 所以这里即使断言失败也必须把可能的返回值关掉。
   */
  test("路径不可写 → undefined（插件照常启动）", () => {
    const blocker = join(tempDir(), "not-a-dir");
    writeFileSync(blocker, "x");
    const sink = createLogSink(join(blocker, "sub", "app.log"));
    try {
      expect(sink).toBeUndefined();
    } finally {
      sink?.close();
    }
  });
});

describe("toChannelLogger", () => {
  test("四个级别都被映射，参数拼成一行", () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const channel = toChannelLogger(log);
    channel.debug?.("a", "b");
    channel.info?.("c");
    channel.warn?.("d");
    channel.error?.("e");
    expect(log.debug).toHaveBeenCalledWith("a b");
    expect(log.info).toHaveBeenCalledWith("c");
    expect(log.warn).toHaveBeenCalledWith("d");
    expect(log.error).toHaveBeenCalledWith("e");
  });

  test("对象被 JSON 化，Error 取 message，不出 [object Object]", () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const channel = toChannelLogger(log);
    channel.info?.("x", { a: 1 });
    expect(log.info).toHaveBeenLastCalledWith('x {"a":1}');
    channel.info?.(new Error("boom"));
    expect(log.info).toHaveBeenLastCalledWith("boom");
  });
});
