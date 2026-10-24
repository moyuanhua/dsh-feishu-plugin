/**
 * Durable bridge state: owner, thread/root → session bindings, and per-session
 * thread aliases. Stored as one atomically replaced JSON document.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord, str } from "./utils.js";

const VERSION = 1;

function emptyState() {
  return {
    version: VERSION,
    ownerOpenId: "",
    threads: {},
    roots: {},
    sessionThreads: {},
  };
}

function normalize(raw) {
  const state = emptyState();
  if (!isRecord(raw)) return state;
  state.ownerOpenId = str(raw.ownerOpenId);
  if (isRecord(raw.threads)) {
    for (const [threadId, value] of Object.entries(raw.threads)) {
      if (!isRecord(value) || !str(value.sessionId)) continue;
      state.threads[threadId] = {
        sessionId: str(value.sessionId),
        chatId: str(value.chatId),
        openId: str(value.openId),
        anchorMessageId: str(value.anchorMessageId),
        title: str(value.title),
        createdAt: Number(value.createdAt) || Date.now(),
      };
    }
  }
  if (isRecord(raw.roots)) {
    for (const [rootId, value] of Object.entries(raw.roots)) {
      if (typeof value === "string" && value) state.roots[rootId] = value;
    }
  }
  if (isRecord(raw.sessionThreads)) {
    for (const [sessionId, value] of Object.entries(raw.sessionThreads)) {
      if (!Array.isArray(value)) continue;
      const threads = value.map((item) => str(item)).filter(Boolean);
      if (threads.length) state.sessionThreads[sessionId] = [...new Set(threads)];
    }
  }
  return state;
}

export class StateStore {
  constructor({ file, log }) {
    this.file = file;
    this.log = log;
    this.state = emptyState();
    this.saving = Promise.resolve();
  }

  async load() {
    try {
      const text = await readFile(this.file, "utf8");
      this.state = normalize(JSON.parse(text));
      this.log?.info?.("已加载飞书桥接状态", {
        threads: Object.keys(this.state.threads).length,
        hasOwner: Boolean(this.state.ownerOpenId),
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.log?.warn?.("读取状态失败，使用空状态", { error: String(error) });
      }
      this.state = emptyState();
    }
    return this.state;
  }

  async save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const file = this.file;
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, file);
      })
      .catch((error) => {
        this.log?.warn?.("保存状态失败", { error: String(error) });
      });
    return this.saving;
  }

  // ---- owner / allowlist -------------------------------------------------

  isAllowed(openId, allowUsers) {
    const id = str(openId);
    if (!id) return false;
    if (Array.isArray(allowUsers) && allowUsers.includes(id)) return true;
    if (this.state.ownerOpenId) return this.state.ownerOpenId === id;
    // Empty allowlist and no owner yet: first sender claims ownership.
    if (!Array.isArray(allowUsers) || allowUsers.length === 0) {
      this.state.ownerOpenId = id;
      void this.save();
      this.log?.info?.("首个飞书用户已绑定为 owner");
      return true;
    }
    return false;
  }

  // ---- thread bindings ---------------------------------------------------

  bindThread({ threadId, rootId, sessionId, chatId, openId, anchorMessageId, title }) {
    const sid = str(sessionId);
    if (!sid) return;
    const link = {
      sessionId: sid,
      chatId: str(chatId),
      openId: str(openId),
      anchorMessageId: str(anchorMessageId),
      title: str(title),
      createdAt: Date.now(),
    };
    const alias = threadId || (rootId ? `root:${rootId}` : undefined);
    if (alias) {
      this.state.threads[alias] = link;
      this.addSessionThread(sid, alias);
    }
    if (rootId) {
      this.state.roots[rootId] = alias ?? sid;
    }
    void this.save();
  }

  addSessionThread(sessionId, threadId) {
    const current = this.state.sessionThreads[sessionId] ?? [];
    if (!current.includes(threadId)) current.push(threadId);
    this.state.sessionThreads[sessionId] = current;
  }

  sessionForThread(threadId) {
    const link = this.state.threads[threadId];
    return link?.sessionId;
  }

  threadLink(threadId) {
    return this.state.threads[threadId];
  }

  sessionForRoot(rootId) {
    const value = this.state.roots[rootId];
    if (!value) return undefined;
    if (this.state.threads[value]) return this.state.threads[value].sessionId;
    return value.startsWith("root:") ? undefined : value;
  }

  /** Most recently created live thread for a session, used for out-of-band cards. */
  threadForSession(sessionId) {
    const aliases = this.state.sessionThreads[sessionId] ?? [];
    for (let i = aliases.length - 1; i >= 0; i -= 1) {
      const alias = aliases[i];
      const link = this.state.threads[alias];
      if (link?.anchorMessageId) return alias;
    }
    return undefined;
  }

  linkForSession(sessionId) {
    const threadId = this.threadForSession(sessionId);
    if (!threadId) return undefined;
    return this.state.threads[threadId];
  }

  chatForSession(sessionId) {
    return this.linkForSession(sessionId)?.chatId;
  }

  updateTitle(sessionId, title) {
    for (const link of Object.values(this.state.threads)) {
      if (link.sessionId === sessionId) link.title = str(title);
    }
    void this.save();
  }
}
