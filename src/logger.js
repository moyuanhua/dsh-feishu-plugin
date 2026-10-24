/** Leveled logger that mirrors to stderr and an append-only file. */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "./utils.js";

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

function formatMeta(meta) {
  if (!isRecord(meta) || Object.keys(meta).length === 0) return "";
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return " {meta unavailable}";
  }
}

export function createLogger({ level = "info", file } = {}) {
  const threshold = ORDER[level] ?? ORDER.info;
  let ready = false;

  const ensureDir = () => {
    if (ready || !file) return;
    ready = true;
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      /* logging must never break the plugin */
    }
  };

  const write = (name, message, meta) => {
    if ((ORDER[name] ?? 0) < threshold) return;
    const line = `${new Date().toISOString()} ${name.toUpperCase()} ${message}${formatMeta(meta)}\n`;
    try {
      process.stderr.write(line);
    } catch {
      /* ignore */
    }
    if (!file) return;
    ensureDir();
    try {
      appendFileSync(file, line);
    } catch {
      /* ignore */
    }
  };

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}
