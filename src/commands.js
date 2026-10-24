/** Slash-command parsing for the management chat and topics. */
import { str } from "./utils.js";

const KNOWN = new Set([
  "new",
  "sessions",
  "ls",
  "resume",
  "open",
  "use",
  "current",
  "brief",
  "stop",
  "help",
  "model",
  "perm",
  "cd",
  "dir",
  "rename",
  "steer",
  "queue",
  "cancel",
]);

export function parseCommand(text) {
  const value = str(text).trim();
  if (!value.startsWith("/")) return undefined;
  const match = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(value);
  if (!match) return { name: "unknown", args: "", raw: value };
  const name = match[1].toLowerCase();
  return {
    name: KNOWN.has(name) ? name : "unknown",
    args: (match[2] ?? "").trim(),
    raw: value,
  };
}

export const MAIN_ONLY = new Set(["sessions", "ls", "open", "use", "new"]);
