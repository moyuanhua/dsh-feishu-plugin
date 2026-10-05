/**
 * 结构化日志。
 *
 * 安全红线：任何 secret（appSecret / token）都不允许进入日志字段。
 * 需要表达「有没有」时只记录布尔值。
 *
 * 移植来源：opencode-feishu-plugin（MIT，Copyright (c) 2026 moyuanhua）
 * 原文件：src/logger.ts（逻辑逐行搬运；前缀改为 `[dsh-feishu]`，
 * 类型改为本仓库 src/types.ts，去掉了仅服务于 opencode stderr 场景的说明）
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger, LogLevel } from "./types.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  /** 最低输出级别，默认 info。 */
  readonly level: LogLevel;
  /** 自定义输出目标，默认 process.stderr.write。 */
  readonly sink?: (line: string) => void;
  /** 日志前缀，默认 `[dsh-feishu]`。 */
  readonly prefix?: string;
  /** 时间戳函数，便于测试。 */
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把 meta 里疑似密钥的键值替换成 `<redacted>`。
 * 这是纵深防御：调用方本就不该传 secret，但仍兜底。
 */
export function redactMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const secretKey = /(secret|token|password|pat|authorization|appsecret)/i;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (secretKey.test(key)) {
      out[key] = "<redacted>";
    } else if (typeof value === "string" && value.length > 512) {
      out[key] = `${value.slice(0, 512)}…(len=${value.length})`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level;
  const sink = options.sink ?? ((line: string) => process.stderr.write(line));
  const prefix = options.prefix ?? "[dsh-feishu]";
  const now = options.now ?? (() => Date.now());

  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const payload: Record<string, unknown> = { t: new Date(now()).toISOString(), level: lvl, msg };
    const safe = redactMeta(meta);
    if (safe && Object.keys(safe).length > 0) payload.meta = safe;
    sink(`${prefix} ${JSON.stringify(payload)}\n`);
  };

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
  };
}

/** 只保留 open_id 前 8 位用于日志，避免完整 ID 泄漏。 */
export function maskId(id: string | undefined): string {
  if (!id) return "";
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isRecord(err) && typeof err.msg === "string") return err.msg;
  return String(err);
}

/** 文件日志 sink（append 模式）。`close()` 只应在确定不再写入时调用。 */
export interface LogSink {
  readonly sink: (line: string) => void;
  readonly close: () => void;
}

/** `logFile` 配置时把日志追加写入文件（0600）；写入失败只回退 stderr，绝不影响插件。 */
export function createLogSink(logFile: string | undefined): LogSink | undefined {
  if (!logFile) return undefined;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const stream = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    stream.on("error", () => {});
    return {
      sink: (line: string) => {
        stream.write(line);
      },
      close: () => {
        try {
          stream.end();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return undefined;
  }
}

/** 把本插件的 Logger 适配成 `@larksuite/channel` 的 Logger 形状（同样的字段脱敏）。 */
export interface ChannelLoggerLike {
  debug?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
}

export function toChannelLogger(log: Logger): ChannelLoggerLike {
  const flat = (args: unknown[]): string =>
    args
      .map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? arg.message : JSON.stringify(arg)))
      .join(" ");
  return {
    debug: (...args) => log.debug(flat(args)),
    info: (...args) => log.info(flat(args)),
    warn: (...args) => log.warn(flat(args)),
    error: (...args) => log.error(flat(args)),
  };
}
