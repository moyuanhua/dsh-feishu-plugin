/** Small dependency-free helpers shared by every module. */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** RemoteError carries a stable `code` worth surfacing without a stack. */
export function describeError(error) {
  if (!isRecord(error)) return errorMessage(error);
  const code = str(error.code);
  const message = errorMessage(error);
  return code ? `${code}: ${message}` : message;
}

export function maskId(value) {
  const text = str(value);
  if (text.length <= 8) return text ? `${text.slice(0, 2)}***` : "";
  return `${text.slice(0, 5)}***${text.slice(-3)}`;
}

export function shortId(value) {
  const text = str(value);
  return text.length > 10 ? text.slice(0, 10) : text;
}

export function uniqueId(prefix = "") {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function truncate(text, max) {
  const value = str(text);
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Keep both ends, which reads better for paths. */
export function truncateMiddle(text, max) {
  const value = str(text);
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function relativeTime(fromMs, nowMs = Date.now()) {
  if (!Number.isFinite(fromMs) || fromMs <= 0) return "时间未知";
  const diff = nowMs - fromMs;
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const date = new Date(fromMs);
  const pad = (n) => (n < 10 ? `0${n}` : String(n));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function expandHome(input) {
  const value = str(input).trim();
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

export function isUnder(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && rel !== `.${sep}..`);
}

const FORBIDDEN_ROOTS = new Set(["/", "/bin", "/etc", "/sbin", "/usr", "/var", "/System", "/Library"]);

/**
 * Validate a requested working directory: absolute, inside one of the allowed
 * roots, and not a bare system root. The directory is created when missing.
 */
export function validateDirectory(rawPath, allowedRoots) {
  const expanded = expandHome(rawPath);
  if (!expanded) return { ok: false, reason: "目录不能为空" };
  if (!isAbsolute(expanded)) return { ok: false, reason: "请填写绝对路径（例如 /Users/you/project）" };
  const resolved = resolve(expanded);
  if (FORBIDDEN_ROOTS.has(resolved)) return { ok: false, reason: `不能使用系统目录 ${resolved}` };
  const roots = (allowedRoots ?? []).map((r) => resolve(expandHome(r))).filter(Boolean);
  if (roots.length > 0 && !roots.some((root) => isUnder(resolved, root))) {
    return { ok: false, reason: `目录必须位于允许范围内：${roots.join("、")}` };
  }
  return { ok: true, path: resolved };
}

export function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* ignore */
      }
      rejectPromise(new Error(`timeout after ${ms}ms`));
    }, Math.max(1, ms));
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

export function sleep(ms) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, Math.max(0, ms));
    timer.unref?.();
  });
}

/** Build a human one-line preview for tool arguments. */
export function toolPreview(name, rawArguments) {
  const args = safeJsonParse(str(rawArguments));
  if (isRecord(args)) {
    const interesting = ["path", "file_path", "command", "query", "url", "pattern", "target", "description"];
    for (const key of interesting) {
      if (typeof args[key] === "string" && args[key].trim()) {
        return truncate(args[key].trim().replace(/\s+/g, " "), 160);
      }
    }
  }
  if (typeof rawArguments === "string" && rawArguments.trim()) {
    return truncate(rawArguments.trim().replace(/\s+/g, " "), 160);
  }
  return name;
}
