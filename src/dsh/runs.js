/** Turns DSH session events into one live Feishu card per turn. */
import { errorMessage, formatDuration, truncate, toolPreview } from "../utils.js";
import { runCard } from "../cards.js";

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
    const card = runCard({ run, maxAnswerChars: this.config.maxAnswerChars });
    const sent = anchorMessageId
      ? await this.sender.replyCard(anchorMessageId, card)
      : await this.sender.sendCard(chatId, card);
    if (sent.ok) run.messageId = sent.messageId;
    else run.error = sent.error ?? "无法发送运行卡片";
    this.schedule(run, true);
    return run;
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
    void this.patch(old);

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
    const card = runCard({ run, maxAnswerChars: this.config.maxAnswerChars });
    let sent = anchorMessageId
      ? await this.sender.replyCard(anchorMessageId, card)
      : { ok: false, error: "missing anchor" };
    if (!sent.ok && (chatId || run.chatId)) {
      sent = await this.sender.sendCard(chatId || run.chatId, card);
    }
    if (sent.ok) run.messageId = sent.messageId;
    else run.error = sent.error ?? "无法发送继续处理卡片";
    this.schedule(run, true);
    return run;
  }

  schedule(run, immediate = false, delayOverride) {
    if (run.finished && !immediate) return;
    if (run.patchTimer) return;
    const delay = immediate ? 0 : (delayOverride ?? this.config.streamThrottleMs);
    run.patchTimer = setTimeout(() => {
      run.patchTimer = undefined;
      void this.patch(run);
    }, delay);
    run.patchTimer.unref?.();
  }

  async patch(run) {
    if (!run.messageId) return;
    const card = runCard({ run, maxAnswerChars: this.config.maxAnswerChars });
    const result = await this.sender.patchCard(run.messageId, card);
    if (!result.ok) this.log.debug("运行卡片更新失败", { sessionId: run.sessionId, error: result.error });
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
    void this.patch(run);
    this.log.info("回合结束", {
      sessionId: run.sessionId,
      status,
      ms: run.finishedAt - run.startedAt,
      tools: run.tools.length,
      error,
    });
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
