/** Turns DSH session events into one live Feishu card per turn. */
import { describeError, errorMessage, formatDuration, truncate, toolPreview } from "../utils.js";
import { answerPartCard, runCard, splitAnswerForCards } from "../cards.js";
import { mdToPosts } from "../post-render.js";

function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

export class RunCards {
  constructor({ bridge, sender, state, config, log }) {
    this.bridge = bridge;
    this.sender = sender;
    this.state = state;
    this.config = config;
    this.log = log;
    // Post mode answers as ordinary rich-text messages instead of a live card.
    // A card can be patched while the model streams; a post cannot, so post
    // mode trades streaming for a chat-like transcript.
    this.postMode = config.answerMode === "post";
    this.runs = new Map();
    this.heartbeat = setInterval(() => {
      for (const run of this.runs.values()) {
        if (run.status === "running" || run.status === "starting") this.schedule(run);
      }
    }, 5_000);
    this.heartbeat.unref?.();
  }

  dispose() {
    clearInterval(this.heartbeat);
    for (const run of this.runs.values()) {
      if (run.timer) clearTimeout(run.timer);
    }
    this.runs.clear();
  }

  active(sessionId) {
    const run = this.runs.get(sessionId);
    return run && !run.finished ? run : undefined;
  }

  async beginPrompt(sessionId, { anchorMessageId, chatId, threadId }) {
    const current = this.active(sessionId);
    if (current) {
      current.promptCount += 1;
      this.schedule(current);
      return current;
    }
    const view = await this.bridge.viewOf(sessionId);
    const run = {
      sessionId,
      chatId: chatId || view.chatId,
      anchorMessageId,
      threadId,
      messageId: "",
      status: "starting",
      startedAt: Date.now(),
      finishedAt: 0,
      tools: [],
      toolTotal: 0,
      text: "",
      streamingText: "",
      streamingReasoning: "",
      turn: 0,
      step: 0,
      error: "",
      canStop: false,
      promptCount: 1,
      model: view.model ? `${view.model.provider}/${view.model.model}` : undefined,
      perm: view.perm,
      timer: undefined,
      patchTimer: undefined,
      finished: false,
    };
    this.runs.set(sessionId, run);
    if (this.postMode) {
      await this.sendAck(run, "\u{1F914} 处理中…");
    } else {
      const card = runCard({ run, maxAnswerChars: this.config.maxAnswerChars });
      const sent = anchorMessageId
        ? await this.sender.replyCard(anchorMessageId, card)
        : await this.sender.sendCard(chatId, card);
      if (sent.ok) run.messageId = sent.messageId;
      else run.error = sent.error ?? "无法发送运行卡片";
    }
    this.schedule(run, true);
    return run;
  }

  /**
   * Post mode has no card to patch, so the only progress signal is a short
   * placeholder that `sendAnswer` recalls once the turn ends.
   */
  async sendAck(run, text) {
    const sent = run.anchorMessageId
      ? await this.sender.replyText(run.anchorMessageId, text, { replyInThread: Boolean(run.threadId) })
      : await this.sender.sendText(run.chatId, text);
    if (sent.ok) run.ackMessageId = sent.messageId;
    else run.error = sent.error ?? "无法发送处理中提示";
    return sent;
  }

  /**
   * Close the current run card and open a fresh one for the rest of the same
   * turn. Used after ask-user-question is answered: the model keeps working,
   * but its answer should appear under the user's reply, not inside the card
   * that was already on screen before the question.
   */
  async rotate(sessionId, { anchorMessageId, chatId, threadId } = {}) {
    const old = this.runs.get(sessionId);
    if (!old || old.finished) return undefined;
    old.finished = true;
    old.finishedAt = Date.now();
    old.status = "continued";
    old.canStop = false;
    if (old.patchTimer) {
      clearTimeout(old.patchTimer);
      old.patchTimer = undefined;
    }
    // Keep the tool/thinking history, but hide the partial answer in the old
    // card; the complete answer will be streamed into the new card.
    old.text = "";
    old.streamingText = "";
    if (this.postMode) {
      if (old.ackMessageId) {
        void this.sender.recallMessage(old.ackMessageId);
        old.ackMessageId = undefined;
      }
    } else {
      void this.patch(old);
    }

    const run = {
      sessionId,
      chatId: chatId || old.chatId,
      anchorMessageId,
      threadId: threadId || old.threadId,
      messageId: "",
      status: "starting",
      startedAt: Date.now(),
      finishedAt: 0,
      tools: [],
      toolTotal: 0,
      text: "",
      streamingText: "",
      streamingReasoning: "",
      turn: old.turn,
      step: old.step,
      error: "",
      canStop: true,
      promptCount: old.promptCount,
      model: old.model,
      perm: old.perm,
      timer: undefined,
      patchTimer: undefined,
      finished: false,
      continued: true,
    };
    this.runs.set(sessionId, run);
    if (this.postMode) {
      await this.sendAck(run, "\u{1F914} 继续处理中…");
    } else {
      const card = runCard({ run, maxAnswerChars: this.config.maxAnswerChars });
      let sent = anchorMessageId
        ? await this.sender.replyCard(anchorMessageId, card)
        : { ok: false, error: "missing anchor" };
      if (!sent.ok && (chatId || run.chatId)) {
        sent = await this.sender.sendCard(chatId || run.chatId, card);
      }
      if (sent.ok) run.messageId = sent.messageId;
      else run.error = sent.error ?? "无法发送继续处理卡片";
    }
    this.schedule(run, true);
    return run;
  }

  schedule(run, immediate = false, delayOverride) {
    // Nothing on screen changes during a post-mode turn: skip the timer churn.
    if (this.postMode) return;
    if (run.finished && !immediate) return;
    if (run.patchTimer) return;
    const delay = immediate ? 0 : (delayOverride ?? this.config.streamThrottleMs);
    run.patchTimer = setTimeout(() => {
      run.patchTimer = undefined;
      void this.patch(run);
    }, delay);
    run.patchTimer.unref?.();
  }

  async patch(run, force = false) {
    if (this.postMode) return;
    if (!run.messageId) return;
    // Serialize card updates. Streaming patches are async; without this, a
    // slow "处理中" update that started before turn/end can land after the
    // final "回合完成" update and revert the card to the running state.
    // `force` appends one final update after any in-flight/queued stale one.
    if (!force && run.patchQueued) return run.patchChain;
    run.patchQueued = true;
    run.patchChain = (run.patchChain ?? Promise.resolve())
      .then(async () => {
        const card = runCard({ run, maxAnswerChars: this.config.maxAnswerChars });
        const result = await this.sender.patchCard(run.messageId, card);
        if (!result.ok) this.log.debug("运行卡片更新失败", { sessionId: run.sessionId, error: result.error });
      })
      .catch((error) => {
        this.log.warn("运行卡片更新异常", { sessionId: run.sessionId, error: describeError(error) });
      })
      .finally(() => {
        run.patchQueued = false;
      });
    return run.patchChain;
  }

  finish(run, status, error = "") {
    if (run.finished) return;
    run.finished = true;
    run.finishedAt = Date.now();
    run.status = status;
    run.canStop = false;
    if (error) run.error = error;
    if (run.patchTimer) {
      clearTimeout(run.patchTimer);
      run.patchTimer = undefined;
    }
    let splitParts = [];
    if (!this.postMode && (status === "done" || status === "stopped")) {
      const answer = String(run.text || run.streamingText || "").trim();
      if (answer) {
        // Keep three tables per card: the documented limit is five, but a
        // card that also carries reasoning/tool panels can push the renderer
        // over it. Dedicated part cards are the reliable delivery path.
        const chunks = splitAnswerForCards(answer, { maxTables: 3, maxBytes: 20_000 });
        if (chunks.length > 1) {
          const maxParts = 5;
          splitParts = chunks.slice(0, maxParts);
          run.answerHidden = true;
          run.splitParts = splitParts;
          const omitted = chunks.length - splitParts.length;
          run.answerNote =
            `回答较长，已分成 ${chunks.length} 段，见下方卡片。` +
            (omitted > 0 ? `另有 ${omitted} 段未发送，完整内容在 DSH Web 会话里。` : "");
        }
      }
    }
    if (this.postMode) {
      void this.sendAnswer(run);
    } else {
      void this.patch(run, true).then(() => {
        if (splitParts.length > 0) void this.sendParts(run);
      });
    }
    this.log.info("回合结束", {
      sessionId: run.sessionId,
      status,
      ms: run.finishedAt - run.startedAt,
      tools: run.tools.length,
      error,
    });
  }

  /**
   * Post mode delivery: recall the "processing" line, then send the answer as
   * one or more rich-text messages. Errors and stops become plain text; a
   * failed post falls back to text so the answer is never lost.
   */
  async sendAnswer(run) {
    const ackId = run.ackMessageId;
    run.ackMessageId = undefined;
    const quiet = async (fn) => {
      try {
        return await fn();
      } catch (error) {
        this.log.warn("回答发送失败", { sessionId: run.sessionId, error: describeError(error) });
        return undefined;
      }
    };
    if (ackId) await quiet(() => this.sender.recallMessage(ackId));
    const reply = async (post) =>
      run.anchorMessageId
        ? await this.sender.replyPost(run.anchorMessageId, post)
        : await this.sender.sendPost(run.chatId, post);
    const replyText = async (text) =>
      run.anchorMessageId
        ? await this.sender.replyText(run.anchorMessageId, text, { replyInThread: Boolean(run.threadId) })
        : await this.sender.sendText(run.chatId, text);

    if (run.status === "error") {
      await quiet(() => replyText(`\u274C ${truncate(run.error || "出错", 1_500)}`));
      return;
    }
    if (run.status === "stopped") {
      await quiet(() => replyText("\u23F9 已停止"));
      return;
    }

    const answer = String(run.text || run.streamingText || "").trim();
    if (!answer) return;
    for (const post of mdToPosts(answer)) {
      const sent = await quiet(() => reply(post));
      if (sent?.ok) continue;
      this.log.warn("富文本发送失败，回退纯文本", { sessionId: run.sessionId, error: sent?.error });
      await quiet(() => replyText(answer.length > 4_000 ? `${answer.slice(0, 4_000)}\n…` : answer));
      return;
    }
  }

  onSessionEvent(session, event) {
    const sessionId = String(session?.id ?? "");
    const run = this.runs.get(sessionId);
    if (!run) return;
    const type = String(event?.type ?? "");
    const data = event?.data ?? {};

    switch (type) {
      case "turn/start":
        run.turn = Number(data.turn) || run.turn;
        run.status = "running";
        run.canStop = true;
        this.schedule(run, true);
        break;
      case "step/start":
        run.step = Number(data.step) || run.step;
        break;
      case "tool/call": {
        run.toolTotal = (run.toolTotal ?? 0) + 1;
        run.tools.push({
          callId: String(data.callId ?? ""),
          name: String(data.name ?? "tool"),
          preview: toolPreview(String(data.name ?? ""), data.arguments),
          status: "running",
        });
        if (run.tools.length > 12) run.tools.splice(0, run.tools.length - 12);
        this.schedule(run);
        break;
      }
      case "tool/result": {
        const callId = String(data.message?.toolCallId ?? "");
        const tool = [...run.tools].reverse().find((item) => item.callId === callId) ??
          [...run.tools].reverse().find((item) => item.status === "running");
        if (tool) tool.status = data.error || data.message?.isError ? "error" : "done";
        this.schedule(run);
        break;
      }
      case "assistant/message": {
        const text = textOfMessage(data.message);
        if (text.trim()) run.text = text;
        const usage = data.usage;
        if (usage?.outputTokens !== undefined) run.usage = usage;
        this.schedule(run);
        break;
      }
      case "assistant/attempt":
        if (!run.text) run.streamingText = "";
        break;
      case "turn/end": {
        const reason = data.reason ?? {};
        if (reason.kind === "error") {
          this.finish(run, "error", reason.error?.message ?? "模型请求失败");
        } else if (reason.kind === "aborted") {
          this.finish(run, "stopped");
        } else {
          this.finish(run, "done");
        }
        break;
      }
      default:
        break;
    }
  }

  onStream(payload) {
    const sessionId = String(payload?.agent?.id ?? "");
    const run = this.runs.get(sessionId);
    if (!run) return;
    const frame = payload?.frame;
    if (!frame) return;
    if (frame.type === "start") {
      run.status = "running";
      run.canStop = true;
      run.turn = Number(frame.turn) || run.turn;
      run.step = Number(frame.step) || run.step;
      run.streamingText = "";
      // A turn can contain several model steps (tool loop). Do not clear the
      // previous step's reasoning here: if the next step has no thinking, the
      // drawer should keep showing the last reasoning instead of "暂无".
      this.schedule(run);
      return;
    }
    if (frame.type === "end") {
      this.schedule(run, true);
      return;
    }
    if (frame.type !== "chunk" || !this.config.stream) return;
    const chunk = frame.chunk;
    if (!chunk) return;
    if (chunk.type === "text-delta" && chunk.text) {
      run.streamingText = truncate(`${run.streamingText}${chunk.text}`, this.config.maxAnswerChars + 2_000);
      this.schedule(run);
    } else if (chunk.type === "reasoning-delta" && chunk.text) {
      // Keep the chain for the collapsed panel, but do not re-render the card
      // on every token. One status update per second keeps the height stable.
      run.streamingReasoning = truncate(`${run.streamingReasoning}${chunk.text}`, 4_000);
      this.schedule(run, false, 1_000);
    }
  }

  onStatus(payload) {
    const sessionId = String(payload?.agent?.id ?? "");
    const running = payload?.status === "running";
    this.bridge.setRunning(sessionId, running);
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.canStop = running;
    if (running && run.status === "starting") run.status = "running";
    this.schedule(run);
  }

  onAgentError(payload) {
    const sessionId = String(payload?.agent?.id ?? "");
    const run = this.runs.get(sessionId);
    if (!run) return;
    this.finish(run, "error", errorMessage(payload?.error));
  }

  /** Stop and clear a run card without waiting for DSH turn events. */
  recover(sessionId) {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    if (run.patchTimer) {
      clearTimeout(run.patchTimer);
      run.patchTimer = undefined;
    }
    run.finished = true;
    run.finishedAt = Date.now();
    run.status = "stopped";
    run.canStop = false;
    if (this.postMode) {
      if (run.ackMessageId) {
        void this.sender.recallMessage(run.ackMessageId);
        run.ackMessageId = undefined;
      }
    } else {
      void this.patch(run);
    }
    this.runs.delete(sessionId);
    this.log.info("运行卡片已恢复清理", { sessionId });
    return true;
  }

  async sendParts(run) {
    const parts = run.splitParts ?? [];
    run.splitParts = [];
    const total = parts.length;
    for (let i = 0; i < parts.length; i += 1) {
      const card = answerPartCard({ index: i + 1, total, content: parts[i] });
      let sent = run.messageId
        ? await this.sender.replyCard(run.messageId, card)
        : { ok: false, error: "missing run card" };
      if (!sent.ok && run.chatId) sent = await this.sender.sendCard(run.chatId, card);
      if (!sent.ok) this.log.warn("回答分段卡片发送失败", { sessionId: run.sessionId, index: i + 2, error: sent.error });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async stop(sessionId) {
    const run = this.runs.get(sessionId);
    if (run) {
      run.canStop = false;
      run.status = "stopped";
      this.schedule(run, true);
    }
    await this.bridge.cancel(sessionId);
  }
}
