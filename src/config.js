/** Configuration parsing. Never throws: a bad config disables the bridge. */
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, isRecord, str } from "./utils.js";

const LEVELS = new Set(["debug", "info", "warn", "error"]);

function unwrap(value) {
  // Schemastery volatile fields arrive as live references with get()/set().
  if (value && typeof value.get === "function" && typeof value !== "string") {
    try {
      return value.get();
    } catch {
      return value;
    }
  }
  return value;
}

function expandEnv(value) {
  const text = str(value);
  return text
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "")
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

function bool(value, fallback) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function number(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(str(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => str(item).trim()).filter(Boolean);
}

function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}

export function resolveConfig(raw) {
  const config = isRecord(raw) ? raw : {};
  const warnings = [];
  const appId = expandEnv(unwrap(config.appId)).trim();
  const appSecret = expandEnv(unwrap(config.appSecret)).trim();
  const domain = str(unwrap(config.domain)).toLowerCase() === "lark" ? "lark" : "feishu";

  const dataDir = join(dshHome(), "feishu-plugin");
  const logFileRaw = unwrap(config.logFile);
  const logFile =
    logFileRaw === false
      ? undefined
      : typeof logFileRaw === "string" && logFileRaw.trim()
        ? expandHome(expandEnv(logFileRaw).trim())
        : join(dataDir, "feishu.log");

  const allowedRoots = stringList(unwrap(config.allowedRoots)).map((path) => expandHome(path));
  if (allowedRoots.length === 0) {
    allowedRoots.push(homedir(), process.cwd());
  }

  const defaultDirectory = expandHome(expandEnv(unwrap(config.defaultDirectory))) || process.cwd();
  const debugLog = bool(unwrap(config.debugLog), false);
  const configuredLevel = LEVELS.has(str(unwrap(config.logLevel))) ? str(unwrap(config.logLevel)) : "info";
  const logLevel = debugLog ? "debug" : configuredLevel;
  const env = isRecord(config.env) ? config.env : undefined;

  return {
    enabled: Boolean(appId && appSecret),
    disabledReason: !appId ? "missing appId" : !appSecret ? "missing appSecret" : undefined,
    warnings,
    appId,
    appSecret,
    domain,
    allowUsers: stringList(unwrap(config.allowUsers)),
    allowedRoots: [...new Set(allowedRoots)],
    defaultDirectory,
    defaultModel: isRecord(unwrap(config.defaultModel))
      ? {
          provider: str(unwrap(config.defaultModel).provider).trim(),
          model: str(unwrap(config.defaultModel).model).trim(),
        }
      : undefined,
    defaultPermissionPreset: str(unwrap(config.defaultPermissionPreset)).trim() || undefined,
    busyDelivery: str(unwrap(config.busyDelivery)) === "steer" ? "steer" : "queue",
    acceptAttachments: bool(unwrap(config.acceptAttachments), true),
    attachmentMaxBytes: number(unwrap(config.attachmentMaxBytes), 20 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    attachmentTimeoutMs: number(unwrap(config.attachmentTimeoutMs), 30_000, 5_000, 120_000),
    stream: bool(unwrap(config.stream), true),
    streamThrottleMs: number(unwrap(config.streamThrottleMs), 700, 300, 5_000),
    approvalTtlMs: number(unwrap(config.approvalTtlMs), 10 * 60_000, 30_000, 24 * 60 * 60_000),
    questionTtlMs: number(unwrap(config.questionTtlMs), 10 * 60_000, 30_000, 24 * 60 * 60_000),
    staleMessageMs: number(unwrap(config.staleMessageMs), 120_000, 0, 600_000),
    sessionPageSize: number(unwrap(config.sessionPageSize), 8, 4, 20),
    maxAnswerChars: number(unwrap(config.maxAnswerChars), 12_000, 1_000, 28_000),
    debugLog,
    consoleIntent: bool(unwrap(config.consoleIntent), false),
    intentTimeoutMs: number(unwrap(config.intentTimeoutMs), 8_000, 2_000, 30_000),
    intentHistoryTurns: number(unwrap(config.intentHistoryTurns), 8, 0, 20),
    logLevel,
    logFile,
    dataDir,
    stateFile: typeof unwrap(config.stateFile) === "string" && unwrap(config.stateFile).trim()
      ? expandHome(expandEnv(unwrap(config.stateFile)).trim())
      : join(dataDir, "state.json"),
    signSecret: str(unwrap(config.signSecret)).trim() || appSecret,
    env,
  };
}
