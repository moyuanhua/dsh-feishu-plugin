/** Bridge orchestration: routing, commands, session creation, prompt delivery. */
import { access, mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  approvalResultCard,
  compactResultCard,
  createdHintCard,
  errorCard,
  helpCard,
  mainHintCard,
  modelCard,
  modelLabel,
  newSessionFormCard,
  openedSessionCard,
  permissionCard,
  runCard,
  sessionListCard,
  stoppedCard,
  thinkingCard,
} from "./cards.js";
import { MAIN_ONLY, parseCommand } from "./commands.js";
import {
  INTENT_SYSTEM,
  buildIntentPrompt,
  fallbackIntent,
  parseIntentDecision,
  resolveIntent,
} from "./console/intent.js";
import { DshBridge } from "./dsh/controller.js";
import { RunCards } from "./dsh/runs.js";
import { FeishuApprovals } from "./dsh/approvals.js";
import { FeishuQuestions } from "./dsh/questions.js";
import { createFeishuClient, startGateway } from "./feishu/gateway.js";
import { createSender } from "./feishu/sender.js";
import { Dedup, createSigner, newRequestId } from "./security.js";
import { StateStore } from "./state.js";
import {
  describeError,
  errorMessage,
  formatBytes,
  isRecord,
  maskId,
  shortId,
  str,
  truncate,
  validateDirectory,
} from "./utils.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function detectImageType(bytes, contentType) {
  const header = str(contentType).split(";")[0].trim().toLowerCase();
  if (IMAGE_TYPES.has(header)) return header;
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/png";
}

function sanitizeName(name, fallback = "attachment") {
  const cleaned = str(name)
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return cleaned || fallback;
}

export class FeishuApp {
  constructor({ ctx, config, rawConfig, log }) {
    this.ctx = ctx;
    this.config = config;
    this.rawConfig = rawConfig;
    this.log = log;
    this.reconfiguring = undefined;
    this.state = new StateStore({ file: config.stateFile, log });
    this.signer = createSigner(config.signSecret);
    this.dedup = new Dedup();
    this.threadCreates = new Map();
    this.disposers = [];
    this.gateway = undefined;
    this.startedAt = Date.now();
  }

  async init() {
    await this.state.load();
    const client = createFeishuClient(this.config);
    this.sender = createSender(client, this.log);
    this.bridge = new DshBridge(this.ctx, this.config, this.log);
    this.runs = new RunCards({
      bridge: this.bridge,
      sender: this.sender,
      state: this.state,
      config: this.config,
      log: this.log,
    });
    this.approvals = new FeishuApprovals({
      ctx: this.ctx,
      bridge: this.bridge,
      sender: this.sender,
      state: this.state,
      config: this.config,
      log: this.log,
      isAllowed: (openId) => this.state.isAllowed(openId, this.config.allowUsers),
    });
    this.questions = new FeishuQuestions({
      ctx: this.ctx,
      bridge: this.bridge,
      sender: this.sender,
      state: this.state,
      config: this.config,
      log: this.log,
      isAllowed: (openId) => this.state.isAllowed(openId, this.config.allowUsers),
    });

    this.disposers.push(
      this.ctx.on("session/event", (session, event) => this.runs.onSessionEvent(session, event)),
      this.ctx.on("agent/assistant-stream", (payload) => this.runs.onStream(payload)),
      this.ctx.on("agent/status", (payload) => this.runs.onStatus(payload)),
      this.ctx.on("agent/error", (payload) => this.runs.onAgentError(payload)),
    );
  }

  start() {
    this.gateway = startGateway({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: this.config.domain,
      log: this.log,
      debug: this.config.logLevel === "debug",
      onMessage: (message) => this.handleMessage(message),
      onCardAction: (action) => this.handleCardAction(action),
    });
  }

  dispose() {
    this.gateway?.stop();
    this.runs?.dispose();
    this.approvals?.close();
    this.questions?.close();
    for (const dispose of this.disposers) {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    }
    this.disposers = [];
    this.threadCreates.clear();
  }

  /**
   * Apply a live credential/config change from the DSH settings page: rebuild
   * the Feishu client, restart the long connection, and keep every dependent
   * helper pointed at the fresh resolved config.
   */
  async reconfigure() {
    if (this.reconfiguring) return this.reconfiguring;
    this.reconfiguring = (async () => {
      const { resolveConfig } = await import("./config.js");
      const next = resolveConfig(this.rawConfig);
      if (!next.enabled) {
        this.gateway?.stop();
        this.gateway = undefined;
        this.config = next;
        this.log.warn("飞书凭据已清空，长连接已停止");
        return;
      }
      const changed =
        next.appId !== this.config.appId ||
        next.appSecret !== this.config.appSecret ||
        next.domain !== this.config.domain;
      this.config = next;
      this.log.setLevel?.(next.logLevel);
      this.runs.config = next;
      const signer = createSigner(next.signSecret);
      this.signer = signer;
      this.approvals.config = next;
      this.approvals.signer = signer;
      this.questions.config = next;
      this.questions.signer = signer;
      if (!changed && this.gateway) {
        this.log.info("飞书配置已更新（凭据未变）");
        return;
      }
      this.gateway?.stop();
      const client = createFeishuClient(next);
      this.sender = createSender(client, this.log);
      this.runs.sender = this.sender;
      this.approvals.sender = this.sender;
      this.questions.sender = this.sender;
      this.start();
      this.log.info("飞书凭据已更新，长连接已重启", { appId: maskId(next.appId), domain: next.domain });
    })().finally(() => {
      this.reconfiguring = undefined;
    });
    return this.reconfiguring;
  }

  isAllowed(openId) {
    return this.state.isAllowed(openId, this.config.allowUsers);
  }

  // ---- routing -----------------------------------------------------------

  async handleMessage(message) {
    if (message.chatType !== "p2p") return;
    if (!this.dedup.take(message.messageId) || (message.eventId && !this.dedup.take(message.eventId))) {
      this.log.debug("忽略重复飞书消息", { messageId: message.messageId });
      return;
    }
    if (this.config.staleMessageMs > 0 && message.createTime) {
      const created = Number(message.createTime);
      if (Number.isFinite(created) && Date.now() - created > this.config.staleMessageMs) {
        this.log.warn("忽略过期飞书消息", { messageId: message.messageId, ageMs: Date.now() - created });
        return;
      }
    }
    if (!this.isAllowed(message.senderOpenId)) {
      this.log.warn("忽略未授权飞书用户", { openId: maskId(message.senderOpenId) });
      return;
    }

    this.log.debug("收到飞书消息", {
      messageId: message.messageId,
      chatType: message.chatType,
      threadId: message.threadId,
      rootId: message.rootId,
      textPreview: truncate(message.text, 80),
      attachments: message.attachments.length,
    });
    const command = parseCommand(message.text);
    let threadId = message.threadId;
    let rootId = message.rootId;
    let sessionId = (threadId && this.state.sessionForThread(threadId)) || (rootId && this.state.sessionForRoot(rootId));

    // A thread's first event may only carry root_id. Read the message back once.
    if (!sessionId && !threadId && rootId) {
      const meta = await this.sender.getMessageMeta(message.messageId);
      if (meta?.threadId) {
        threadId = meta.threadId;
        sessionId = this.state.sessionForThread(threadId);
      }
      if (!rootId && meta?.rootId) rootId = meta.rootId;
    }

    if (sessionId && threadId && !this.state.sessionForThread(threadId)) {
      const view = await this.bridge.viewOf(sessionId);
      this.state.bindThread({
        threadId,
        rootId,
        sessionId,
        chatId: message.chatId,
        openId: message.senderOpenId,
        anchorMessageId: message.messageId,
        title: view.title,
      });
    }

    this.log.debug("消息路由", {
      command: command?.name,
      sessionId,
      threadId,
      rootId,
      hasSession: Boolean(sessionId),
    });
    if (command) {
      await this.handleCommand({ message, command, sessionId, threadId, rootId });
      return;
    }

    if (sessionId) {
      if (threadId) this.state.touchThread(threadId, message.messageId);
      else if (rootId) this.state.touchThread(`root:${rootId}`, message.messageId);
      if (await this.questions.tryAnswerText(sessionId, message.text)) return;
      await this.promptSession(sessionId, message, message.messageId, message.chatId, threadId);
      return;
    }

    if (threadId) {
      await this.createSessionInThread(message, threadId, rootId);
      return;
    }

    await this.handleMainText(message);
  }

  async handleMainText(message) {
    const text = str(message.text).trim();
    if (!this.config.consoleIntent || !text) {
      await this.sender.sendCard(message.chatId, mainHintCard({}));
      return;
    }

    const ack = await this.sender.sendCard(message.chatId, thinkingCard());
    if (!ack.ok || !ack.messageId) {
      await this.sender.sendCard(message.chatId, mainHintCard({}));
      return;
    }

    const started = Date.now();
    let context;
    try {
      context = await this.intentContext();
      const prompt = buildIntentPrompt({ text, ...context });
      // Intent recognition follows the same default model configured on the
      // plugin page; there is no separate intent-model setting.
      // opencode-go requires a routing session header; reuse the most recent
      // DSH session id (no new session is created for intent recognition).
      const routingSessionId = context.sessions[0]?.sessionId;
      const raw = await this.bridge.completeText({
        system: INTENT_SYSTEM,
        prompt,
        ...(routingSessionId ? { sessionId: routingSessionId } : {}),
        maxTokens: 500,
        timeoutMs: this.config.intentTimeoutMs,
      });
      const decision = parseIntentDecision(raw);
      const resolved = resolveIntent(decision, context);
      this.log.info("主聊天意图识别", {
        ms: Date.now() - started,
        intent: resolved?.intent,
        rawIntent: decision?.intent,
        target: decision?.target,
        dir: resolved?.directory,
        model: resolved?.model ? `${resolved.model.provider}/${resolved.model.model}` : undefined,
        perm: resolved?.perm,
        question: resolved?.question ? truncate(resolved.question, 80) : undefined,
      });

      if (!resolved) {
        await this.finishThinking(ack.messageId, message.chatId, mainHintCard({}));
        return;
      }

      if (resolved.intent === "list") {
        const views = await this.bridge.views();
        await this.finishThinking(
          ack.messageId,
          message.chatId,
          sessionListCard({ sessions: views, page: 0, pageSize: this.config.sessionPageSize }),
        );
        return;
      }

      if (resolved.intent === "open") {
        const views = await this.bridge.views();
        await this.finishThinking(
          ack.messageId,
          message.chatId,
          sessionListCard({
            sessions: views,
            page: 0,
            pageSize: this.config.sessionPageSize,
            title: "🧭 开启会话",
            intro: "想新建一个会话，还是继续最近的会话？直接点下面的按钮即可。",
          }),
        );
        return;
      }

      if (resolved.intent === "create") {
        const extras = await this.formExtras();
        const card = newSessionFormCard({
          values: {
            title: resolved.title ?? "",
            dir: resolved.directory ?? "",
            model: resolved.model,
            perm: resolved.perm,
          },
          ...extras,
          roots: this.config.allowedRoots,
        });
        await this.finishThinking(ack.messageId, message.chatId, card);
        return;
      }

      if (resolved.intent === "enter") {
          const opened = await this.openSessionThread(
          resolved.sessionId,
          ack.messageId,
          message.chatId,
          message.senderOpenId,
          "resumed",
        );
        await this.finishThinking(
          ack.messageId,
          message.chatId,
          openedSessionCard({ view: opened.view, style: "entered" }),
        );
        return;
      }

      await this.finishThinking(ack.messageId, message.chatId, mainHintCard({}));
    } catch (error) {
      this.log.warn("主聊天意图识别失败，尝试确定性回退", {
        error: describeError(error),
        ms: Date.now() - started,
      });
      const fallback = fallbackIntent(text, context ?? {
        defaults: {
          directory: this.config.defaultDirectory,
          model: this.defaultModelSelection(),
          perm: this.config.defaultPermissionPreset,
        },
        sessions: [],
      });
      try {
        if (fallback.intent === "list") {
          const views = await this.bridge.views();
          await this.finishThinking(
            ack.messageId,
            message.chatId,
            sessionListCard({ sessions: views, page: 0, pageSize: this.config.sessionPageSize }),
          );
        } else if (fallback.intent === "open") {
          const views = await this.bridge.views();
          await this.finishThinking(
            ack.messageId,
            message.chatId,
            sessionListCard({
              sessions: views,
              page: 0,
              pageSize: this.config.sessionPageSize,
              title: "🧭 开启会话",
              intro: "想新建一个会话，还是继续最近的会话？直接点下面的按钮即可。",
            }),
          );
        } else if (fallback.intent === "enter") {
          const opened = await this.openSessionThread(
            fallback.sessionId,
            ack.messageId,
            message.chatId,
            message.senderOpenId,
            "resumed",
          );
          await this.finishThinking(
            ack.messageId,
            message.chatId,
            openedSessionCard({ view: opened.view, style: "entered" }),
          );
        } else if (fallback.intent === "create" && fallback.directory) {
          const extras = await this.formExtras();
          await this.finishThinking(
            ack.messageId,
            message.chatId,
            newSessionFormCard({
              values: {
                title: fallback.title ?? "",
                dir: fallback.directory,
                model: fallback.model,
                perm: fallback.perm,
              },
              ...extras,
              roots: this.config.allowedRoots,
            }),
          );
        } else {
          await this.finishThinking(ack.messageId, message.chatId, mainHintCard({}));
        }
      } catch (fallbackError) {
        this.log.warn("意图识别确定性回退失败", { error: describeError(fallbackError) });
        await this.finishThinking(ack.messageId, message.chatId, mainHintCard({}));
      }
    }
  }

  async finishThinking(messageId, chatId, card) {
    const patched = await this.sender.patchCard(messageId, card);
    if (!patched.ok) await this.sender.sendCard(chatId, card);
  }

  async intentContext() {
    const [views, catalog, extras] = await Promise.all([
      this.bridge.views().catch(() => []),
      this.bridge.modelCatalog().catch(() => ({ models: [], default: undefined })),
      this.formExtras().catch(() => ({ models: [], perms: [], dirs: [] })),
    ]);
    const dirs = [];
    const seen = new Set();
    const pushDir = (path, label) => {
      const value = str(path).trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      dirs.push({ path: value, ...(label ? { label } : {}) });
    };
    pushDir(this.config.defaultDirectory, "默认");
    for (const dir of extras.dirs ?? []) pushDir(dir.path, dir.name);
    for (const view of views) if (view.cwd) pushDir(view.cwd, view.title);
    return {
      sessions: views.slice(0, 30),
      dirs,
      models: catalog.models ?? [],
      perms: this.bridge.permissionCatalog().options ?? [],
      roots: this.config.allowedRoots,
      defaults: {
        directory: this.config.defaultDirectory,
        model: this.defaultModelSelection(),
        perm: this.config.defaultPermissionPreset,
      },
    };
  }

  async createSessionInThread(message, threadId, rootId) {
    const pending = this.threadCreates.get(threadId);
    if (pending) {
      try {
        const sessionId = await pending;
        if (sessionId) {
          this.state.touchThread(threadId, message.messageId);
          await this.promptSession(sessionId, message, message.messageId, message.chatId, threadId);
        }
      } catch (error) {
        this.log.warn("等待话题建会话失败", { threadId, error: describeError(error) });
      }
      return;
    }
    const creation = (async () => {
      const sessionId = await this.bridge.createSession({
        cwd: this.config.defaultDirectory,
        preset: this.config.defaultPermissionPreset,
        model: this.defaultModelSelection(),
      });
      const view = await this.bridge.viewOf(sessionId);
      const sent = await this.sender.replyCard(message.messageId, openedSessionCard({ view, style: "created" }));
      if (!sent.ok) throw new Error(sent.error ?? "无法发送话题根卡");
      this.state.bindThread({
        threadId,
        rootId: rootId ?? sent.rootId ?? sent.messageId,
        sessionId,
        chatId: message.chatId,
        openId: message.senderOpenId,
        anchorMessageId: message.messageId,
        title: view.title,
      });
      return sessionId;
    })();
    this.threadCreates.set(threadId, creation);
    try {
      const sessionId = await creation;
      await this.promptSession(sessionId, message, message.messageId, message.chatId, threadId);
    } catch (error) {
      this.log.warn("话题内自动建会话失败", { error: describeError(error) });
      await this.sender.replyCard(message.messageId, errorCard("无法创建会话", describeError(error)));
    } finally {
      this.threadCreates.delete(threadId);
    }
  }

  // ---- commands ----------------------------------------------------------

  async handleCommand({ message, command, sessionId, threadId }) {
    const main = !threadId;
    const name = command.name;

    if (name === "help" || name === "unknown") {
      await this.replyFor(message, helpCard());
      return;
    }
    if (name === "cancel") {
        await this.replyFor(message, compactResultCard({ title: "已取消", lines: ["未提交的临时状态已清空。"], template: "grey" }));
      return;
    }
    if (name === "sessions" || name === "ls") {
      if (!main) {
        await this.replyFor(message, errorCard("请在主聊天流操作", "会话列表会新开话题，请回到主聊天流发送 `/sessions`。"));
        return;
      }
      await this.sendSessionList(message.chatId);
      return;
    }
    if (name === "new") {
      if (!main) {
        await this.replyFor(message, errorCard("请在主聊天流新建", "在话题里请直接发消息；要新建会话请回到主聊天流发送 `/new`。"));
        return;
      }
      await this.sendNewForm(message.chatId, command.args || undefined);
      return;
    }
    if (name === "open" || name === "resume" || name === "use") {
      if (!main) {
        await this.replyFor(message, errorCard("请在主聊天流操作", "请回到主聊天流选择会话。"));
        return;
      }
      await this.openByIndex(message, command.args);
      return;
    }
    if (name === "brief") {
      if (!sessionId) {
        await this.replyFor(message, errorCard("没有会话", "请在话题里使用 `/brief`。"));
        return;
      }
      const view = await this.bridge.viewOf(sessionId);
      const brief = await this.bridge.sessionBrief(sessionId).catch(() => undefined);
      const lines = [`**标题**：${truncate(view.title, 100)}`];
      if (view.cwd) lines.push(`**目录**：\`${view.cwd}\``);
      if (brief?.summary) lines.push("", "**历史摘要**", ...brief.summary.split("\n").map((line) => `> ${line}`));
      if (brief?.lastUser) lines.push("", "**你的上一条**", ...brief.lastUser.split("\n").map((line) => `> ${line}`));
      if (brief?.lastAssistant) lines.push("", "**上次回复**", ...brief.lastAssistant.split("\n").map((line) => `> ${line}`));
      if (lines.length === 1) lines.push("", "这个会话还没有可读取的消息历史。");
      await this.replyFor(message, compactResultCard({ title: "📄 会话简介", lines, template: "blue" }));
      return;
    }
    if (name === "current") {
      if (!sessionId) {
        await this.replyFor(message, mainHintCard({}));
        return;
      }
      const view = await this.bridge.viewOf(sessionId);
      await this.replyFor(
        message,
        compactResultCard({
          title: "📌 当前会话",
          template: "blue",
          lines: [
            `**标题**：${truncate(view.title, 100)}`,
            `**ID**：\`${shortId(view.sessionId)}\``,
            view.cwd ? `**目录**：\`${view.cwd}\`` : "",
            `**模型**：${view.model ? `${view.model.provider}/${view.model.model}` : "(默认)"}`,
            `**权限**：${view.perm ?? "(未知)"}`,
            view.running ? "**状态**：⚡ 运行中" : "**状态**：空闲",
          ].filter(Boolean),
        }),
      );
      return;
    }
    if (name === "stop") {
      if (!sessionId) {
        await this.replyFor(message, mainHintCard({}));
        return;
      }
      await this.runs.stop(sessionId);
      await this.replyFor(message, stoppedCard());
      return;
    }
    if (name === "model") {
      if (!sessionId) {
        await this.replyFor(message, errorCard("没有会话", "请在话题里使用 `/model`。"));
        return;
      }
      await this.handleModelCommand(sessionId, command.args, message);
      return;
    }
    if (name === "perm" || name === "dir") {
      if (!sessionId) {
        await this.replyFor(message, errorCard("没有会话", "请在话题里使用 `/perm`。"));
        return;
      }
      await this.handlePermissionCommand(sessionId, command.args, message);
      return;
    }
    if (name === "cd") {
      if (!sessionId) {
        await this.replyFor(message, errorCard("没有会话", "请在话题里使用 `/cd`。"));
        return;
      }
      if (!command.args) {
        const view = await this.bridge.viewOf(sessionId);
        await this.replyFor(message, compactResultCard({ title: "📁 当前目录", lines: [`\`${view.cwd ?? "(未知)"}\``] }));
        return;
      }
      try {
        const path = await this.bridge.changeDirectory(sessionId, command.args);
        await this.replyFor(message, compactResultCard({ title: "📁 目录已切换", lines: [`\`${path}\``], template: "green" }));
      } catch (error) {
        await this.replyFor(message, errorCard("切换目录失败", describeError(error)));
      }
      return;
    }
    if (name === "rename") {
      if (!sessionId) {
        await this.replyFor(message, errorCard("没有会话", "请在话题里使用 `/rename`。"));
        return;
      }
      if (!command.args) {
        await this.replyFor(message, errorCard("缺少标题", "用法：`/rename 新标题`"));
        return;
      }
      try {
        const result = await this.bridge.controller().rename({ sessionId, title: command.args });
        this.state.updateTitle(sessionId, result.title);
        await this.replyFor(message, compactResultCard({ title: "✏️ 已重命名", lines: [`**${result.title}**`], template: "green" }));
      } catch (error) {
        await this.replyFor(message, errorCard("重命名失败", describeError(error)));
      }
      return;
    }
    if (name === "steer" || name === "queue") {
      if (!sessionId) {
        await this.replyFor(message, errorCard("没有会话", "请在话题里使用该命令。"));
        return;
      }
      if (!command.args) {
        await this.replyFor(message, errorCard("缺少内容", `用法：\`/${name} 文本\``));
        return;
      }
      await this.promptSession(
        sessionId,
        { ...message, text: command.args, attachments: [] },
        message.messageId,
        message.chatId,
        name,
      );
      return;
    }
    await this.replyFor(message, helpCard());
  }

  async replyFor(message, card) {
    if (message.threadId) return this.sender.replyCard(message.messageId, card);
    return this.sender.sendCard(message.chatId, card);
  }

  // ---- session creation / opening ---------------------------------------

  async scanDirs() {
    const out = [];
    const seen = new Set();
    for (const root of this.config.allowedRoots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      const dirs = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
        .slice(0, 60);
      for (const entry of dirs) {
        const path = join(root, entry.name);
        if (seen.has(path)) continue;
        seen.add(path);
        let isRepo = false;
        try {
          await access(join(path, ".git"));
          isRepo = true;
        } catch {
          /* not a repo */
        }
        out.push({ name: entry.name, path, isRepo });
        if (out.length >= 24) return out;
      }
    }
    return out;
  }

  async formExtras() {
    const [catalog, dirs] = await Promise.all([
      this.bridge.modelCatalog().catch(() => ({ models: [], default: undefined })),
      this.scanDirs(),
    ]);
    const permissions = this.bridge.permissionCatalog();
    return { models: catalog.models, defaultModel: catalog.default, perms: permissions.options, dirs };
  }

  async sendNewForm(chatId, title) {
    try {
      const extras = await this.formExtras();
      const card = newSessionFormCard({
        values: {
          title: title ?? "",
          dir: this.config.defaultDirectory ?? "",
          model: this.defaultModelSelection(),
          perm: this.config.defaultPermissionPreset,
        },
        models: extras.models,
        defaultModel: extras.defaultModel,
        perms: extras.perms,
        dirs: extras.dirs,
        roots: this.config.allowedRoots,
      });
      await this.sender.sendCard(chatId, card);
    } catch (error) {
      await this.sender.sendCard(chatId, errorCard("无法打开新建表单", describeError(error)));
    }
  }

  async openSessionThread(sessionId, anchorMessageId, chatId, openId, style) {
    const view = await this.bridge.viewOf(sessionId);
    const brief =
      style === "created"
        ? undefined
        : await Promise.race([
            this.bridge.sessionBrief(sessionId).catch(() => undefined),
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve(undefined), 2_000);
              timer.unref?.();
            }),
          ]);
    // Match OpenCode's resume flow: every entry creates a fresh Feishu topic
    // (card) and simply binds it to the existing DSH session. The previous
    // topic stays intact; replies still follow the topic the user writes in.
    const sent = await this.sender.replyCard(anchorMessageId, openedSessionCard({ view, style, brief }), { replyInThread: true });
    if (!sent.ok) throw new Error(sent.error ?? "无法创建话题");
    const meta = sent.threadId ? undefined : await this.sender.getMessageMeta(sent.messageId);
    const threadId = sent.threadId ?? meta?.threadId;
    const rootId = sent.rootId ?? meta?.rootId ?? sent.messageId;
    this.state.bindThread({
      threadId,
      rootId,
      sessionId,
      chatId,
      openId,
      anchorMessageId: sent.messageId,
      title: view.title,
      style,
    });
    return { sent, threadId, view, brief };
  }

  async openByIndex(message, args) {
    try {
      const views = await this.bridge.views();
      if (views.length === 0) {
        await this.replyFor(message, mainHintCard({}));
        return;
      }
      let index = 0;
      if (args.trim()) {
        const parsed = Number.parseInt(args.trim(), 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > views.length) {
          await this.replyFor(message, errorCard("序号无效", `当前共 ${views.length} 个会话，请用 1–${views.length}。`));
        return;
        }
        index = parsed - 1;
      }
      await this.openSessionThread(
        views[index].sessionId,
        message.messageId,
        message.chatId,
        message.senderOpenId,
        "resumed",
      );
    } catch (error) {
      await this.replyFor(message, errorCard("进入会话失败", describeError(error)));
    }
  }

  async sendSessionList(chatId) {
    try {
      const views = await this.bridge.views();
      await this.sender.sendCard(chatId, sessionListCard({ sessions: views, page: 0, pageSize: this.config.sessionPageSize }));
    } catch (error) {
      await this.sender.sendCard(chatId, errorCard("读取会话列表失败", describeError(error)));
    }
  }

  defaultModelSelection() {
    const model = this.config.defaultModel;
    return model?.provider && model?.model ? { provider: model.provider, model: model.model } : undefined;
  }

  defaultSessionTitle() {
    const now = new Date();
    const pad = (n) => (n < 10 ? `0${n}` : String(n));
    return `新会话 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  async createFromForm(action) {
    const form = isRecord(action.formValue) ? action.formValue : {};
    const values = {
      title: str(form.title).trim(),
      dir: str(form.dir).trim(),
      dirSelect: str(form.dir_select).trim(),
      model: str(form.model).trim(),
      perm: str(form.perm).trim(),
    };
    let model;
    if (values.model) {
      const [provider, modelId] = values.model.split("::");
      if (provider && modelId) model = { provider, model: modelId };
    }
    const selectedDir = values.dirSelect && values.dirSelect !== "__custom__" ? values.dirSelect : values.dir;
    const cwd = selectedDir || this.config.defaultDirectory;

    try {
      const title = values.title || this.defaultSessionTitle();
      const sessionId = await this.bridge.createSession({
        cwd,
        title,
        model: model ?? this.defaultModelSelection(),
        preset: values.perm || this.config.defaultPermissionPreset,
      });
      const opened = await this.openSessionThread(
        sessionId,
        action.messageId,
        action.chatId,
        action.operatorOpenId,
        "created",
      );
      // Like the OpenCode plugin: the submitted form card itself turns into
      // the session card; the separate card in the new topic is its root.
      // The form message becomes the new topic's anchor, so update it after the
      // callback settles rather than returning a card in the same response.
      this.patchCardSoon(action, openedSessionCard({ view: opened.view, style: "created" }));
      return { toast: { type: "success", content: "会话已创建" } };
    } catch (error) {
      this.log.warn("表单建会话失败", { error: describeError(error) });
      const extras = await this.formExtras().catch(() => ({ models: [], perms: [], dirs: [], defaultModel: undefined }));
      if (action.messageId) {
        await this.sender.patchCard(
          action.messageId,
          newSessionFormCard({
            values: {
              title: values.title,
              dir: selectedDir,
              model,
              perm: values.perm,
            },
            models: extras.models,
            defaultModel: extras.defaultModel,
            perms: extras.perms,
            dirs: extras.dirs,
            roots: this.config.allowedRoots,
            error: describeError(error),
          }),
        );
      }
      return { toast: { type: "error", content: truncate(describeError(error), 100) } };
    }
  }

  // ---- prompt delivery ---------------------------------------------------

  async promptSession(sessionId, message, anchorMessageId, chatId, threadId, overrideMode) {
    const view = await this.bridge.viewOf(sessionId).catch(() => undefined);
    const active = this.runs.active(sessionId);
    if (active && threadId && active.threadId && active.threadId !== threadId) {
      // The session already has a live run card in another Feishu topic. Do not
      // attach this turn to that card, or the answer would appear in the wrong topic.
      this.log.warn("会话运行中但话题不同，已拒绝跨话题输出", {
        sessionId,
        activeThread: active.threadId,
        messageThread: threadId,
      });
      await this.sender.replyCard(
        anchorMessageId,
        errorCard("会话正在另一个话题处理中", "请稍候，或回到正在处理的那个话题继续。"),
      );
      return;
    }
    const run = await this.runs.beginPrompt(sessionId, { anchorMessageId, chatId, threadId });
    try {
      const content = await this.buildPromptContent(sessionId, message);
      const mode = overrideMode ?? (view?.running || this.bridge.isRunning(sessionId) ? this.config.busyDelivery : "queue");
      await this.bridge.prompt(
        sessionId,
        content,
        mode === "steer" ? "steer" : "queue",
        newRequestId(`feishu-${message.messageId}`),
      );
      this.log.info("已提交飞书消息", { sessionId, mode, parts: content.length, messageId: message.messageId });
    } catch (error) {
      this.log.warn("提交消息失败", {
        sessionId,
        mode,
        parts: content.length,
        error: describeError(error),
        errorName: error instanceof Error ? error.name : typeof error,
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.runs.finish(run, "error", describeError(error));
    }
  }

  async buildPromptContent(sessionId, message) {
    const parts = [];
    const notes = [];
    const text = str(message.text).trim();
    if (text && text !== "[图片]" && text !== "[文件]") parts.push({ type: "text", text });

    for (const attachment of message.attachments ?? []) {
      try {
        if (this.config.acceptAttachments !== true) {
          notes.push(`[附件未处理：附件接收已关闭]`);
          continue;
        }
        const resource = await this.sender.downloadResource(message.messageId, attachment.fileKey, attachment.kind);
        if (!resource.ok) {
          notes.push(`[${attachment.kind === "image" ? "图片" : "文件"}下载失败：${truncate(resource.error, 200)}]`);
          continue;
        }
        if (resource.bytes.length > this.config.attachmentMaxBytes) {
          notes.push(`[附件超过大小上限 ${formatBytes(this.config.attachmentMaxBytes)}]`);
          continue;
        }
        if (attachment.kind === "image") {
          parts.push({
            type: "image",
            mediaType: detectImageType(resource.bytes, resource.contentType),
            data: resource.bytes.toString("base64"),
            name: sanitizeName(attachment.fileName, "image"),
          });
        } else {
          const name = sanitizeName(attachment.fileName, "file");
          try {
            const uploaded = await this.bridge.uploadFile(sessionId, resource.bytes, name);
            if (uploaded?.receiptId) parts.push({ type: "file", receiptId: uploaded.receiptId });
            else notes.push(`[文件「${name}」上传失败]`);
          } catch (error) {
            notes.push(`[文件「${name}」上传失败：${truncate(describeError(error), 160)}]`);
          }
        }
      } catch (error) {
        notes.push(`[附件处理失败：${truncate(describeError(error), 160)}]`);
      }
    }

    if (notes.length) parts.push({ type: "text", text: notes.join("\n") });
    if (parts.length === 0) parts.push({ type: "text", text: "[空消息]" });
    return parts;
  }

  // ---- model / permission ------------------------------------------------

  async handleModelCommand(sessionId, args, message) {
    const view = await this.bridge.viewOf(sessionId);
    const catalog = await this.bridge.modelCatalog();
    const query = args.trim().toLowerCase();
    const matches = query
      ? catalog.models.filter((model) => {
          const haystack = `${model.provider}/${model.model} ${model.providerName} ${model.name}`.toLowerCase();
          return haystack.includes(query);
        })
      : catalog.models;
    const exact = query
      ? matches.find((model) => `${model.provider}/${model.model}`.toLowerCase() === query)
      : undefined;
    if (exact || (query && matches.length === 1)) {
      const target = exact ?? matches[0];
      try {
        await this.bridge.controller().selectModel({
          sessionId,
          provider: target.provider,
          model: target.model,
        });
        await this.replyFor(
          message,
          compactResultCard({
            title: "🧠 模型已切换",
            template: "green",
            lines: [`后续回复使用 **${target.provider}/${target.model}**。`],
          }),
        );
      } catch (error) {
        await this.replyFor(message, errorCard("切换模型失败", describeError(error)));
      }
      return;
    }
    const card = modelCard({
      sid: sessionId,
      current: view.model,
      models: query ? matches : catalog.models,
      page: 0,
    });
    await this.replyFor(message, card);
  }

  async handlePermissionCommand(sessionId, args, message) {
    const catalog = this.bridge.permissionCatalog();
    const view = await this.bridge.viewOf(sessionId);
    const query = args.trim().toLowerCase();
    const match = query
      ? catalog.options.find((option) => option.value.toLowerCase() === query || option.name.toLowerCase() === query)
      : undefined;
    if (match) {
      try {
        await this.bridge.setPermission(sessionId, match.value);
        await this.replyFor(
          message,
          compactResultCard({
            title: "🔐 权限已切换",
            template: "green",
            lines: [`当前预设：**${match.name}**（${match.value}）`],
          }),
        );
      } catch (error) {
        await this.replyFor(message, errorCard("切换权限失败", describeError(error)));
      }
      return;
    }
    await this.replyFor(
      message,
      permissionCard({ sid: sessionId, current: view.perm, perms: catalog.options }),
    );
  }

  // ---- card actions ------------------------------------------------------

  /**
   * Return a card from the callback response (authoritative) and also patch
   * once after the response settles. Feishu applies the response card, but a
   * delayed patch keeps the state durable if a client missed the response.
   */
  respondCard(action, card, toast) {
    if (action.messageId) {
      const timer = setTimeout(() => {
        void this.sender.patchCard(action.messageId, card);
      }, 1_200);
      timer.unref?.();
    }
    return { card: { type: "raw", data: card }, toast };
  }

  patchCardSoon(action, card) {
    if (!action?.messageId) return;
    const timer = setTimeout(() => {
      void this.sender.patchCard(action.messageId, card);
    }, 1_200);
    timer.unref?.();
  }

  async handleCardAction(action) {
    this.log.info("收到卡片操作", {
      kind: isRecord(action.value) ? str(action.value.a) : "(none)",
      messageId: action.messageId,
      chatId: action.chatId,
      operator: maskId(action.operatorOpenId),
      formValueKeys: isRecord(action.formValue) ? Object.keys(action.formValue) : undefined,
    });
    if (!this.isAllowed(action.operatorOpenId)) {
      return { toast: { type: "error", content: "你不在允许名单内" } };
    }
    const value = isRecord(action.value) ? action.value : {};
    const kind = str(value.a);

    if (kind === "approve" || kind === "reject") return this.approvals.handleAction(action);
    if (kind === "answer") return this.questions.handleAction(action);

    if (kind === "stop") {
      const sessionId = str(value.s);
      if (!sessionId) return { toast: { type: "error", content: "缺少会话" } };
      await this.runs.stop(sessionId);
      return { toast: { type: "info", content: "已请求停止" } };
    }

    if (kind === "new") {
      await this.sendNewForm(action.chatId);
      return { toast: { type: "info", content: "已发送新建表单" } };
    }

    if (kind === "help") {
      await this.sender.sendCard(action.chatId, helpCard());
      return { toast: { type: "info", content: "已发送帮助" } };
    }

    if (kind === "list") {
      const views = await this.bridge.views();
      const card = sessionListCard({
        sessions: views,
        page: Number(value.p) || 0,
        pageSize: this.config.sessionPageSize,
      });
      this.log.info("会话列表卡片刷新", {
        count: views.length,
        page: Number(value.p) || 0,
        messageId: action.messageId,
      });
      // Return the card in the callback response. A separate im.message.patch
      // issued before the callback settles is undone by Feishu when the
      // response arrives; the response card is authoritative.
      return this.respondCard(action, card, { type: "info", content: "已刷新" });
    }

    if (kind === "open") {
      const sessionId = str(value.s);
      this.log.info("进入会话请求", { sessionId, messageId: action.messageId, value });
      if (!sessionId) return { toast: { type: "error", content: "缺少会话 ID" } };
      try {
        const opened = await this.openSessionThread(
          sessionId,
          action.messageId,
          action.chatId,
          action.operatorOpenId,
          "resumed",
        );
        const view = opened?.view ?? (await this.bridge.viewOf(sessionId));
        this.log.info("进入会话完成", {
          sessionId,
          threadId: opened?.threadId,
          title: view?.title,
        });
        // Do not return the card in this callback: it starts a thread on the
        // same message, and Feishu can reject a simultaneous card update.
        // Patch the list card after the callback settles instead.
        this.patchCardSoon(action, openedSessionCard({ view, style: "entered" }));
        return { toast: { type: "success", content: "已进入话题" } };
      } catch (error) {
        const detail = describeError(error);
        this.log.warn("进入会话失败", {
          sessionId,
          error: detail,
          stack: error instanceof Error ? error.stack : undefined,
        });
        return { toast: { type: "error", content: truncate(detail || "进入会话失败", 80) } };
      }
    }

    if (kind === "create") return this.createFromForm(action);

    if (kind === "modelpage") {
      const sid = str(value.s);
      const view = await this.bridge.viewOf(sid);
      const catalog = await this.bridge.modelCatalog();
      const card = modelCard({ sid, current: view.model, models: catalog.models, page: Number(value.p) || 0 });
      return this.respondCard(action, card, { type: "info", content: "已翻页" });
    }

    if (kind === "model") {
      const sid = str(value.s);
      const provider = str(value.p);
      const model = str(value.m);
      if (!sid || !provider || !model) return { toast: { type: "error", content: "参数不完整" } };
      try {
        await this.bridge.controller().selectModel({ sessionId: sid, provider, model });
        const card = compactResultCard({
          title: "🧠 模型已切换",
          template: "green",
          lines: [`后续回复使用 **${provider}/${model}**。`],
        });
        return this.respondCard(action, card, { type: "success", content: "已切换模型" });
      } catch (error) {
        return { toast: { type: "error", content: truncate(describeError(error), 80) } };
      }
    }

    if (kind === "perm") {
      const sid = str(value.s);
      const preset = str(value.v);
      if (!sid || !preset) return { toast: { type: "error", content: "参数不完整" } };
      try {
        await this.bridge.setPermission(sid, preset);
        const card = compactResultCard({
          title: "🔐 权限已切换",
          template: "green",
          lines: [`当前预设：**${preset}**`],
        });
        return this.respondCard(action, card, { type: "success", content: "已切换权限" });
      } catch (error) {
        return { toast: { type: "error", content: truncate(describeError(error), 80) } };
      }
    }

    return {};
  }
}
