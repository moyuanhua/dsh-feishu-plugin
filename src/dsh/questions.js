/** Answers DSH user-questions waterfalls through Feishu cards or plain replies. */
import { createSigner } from "../security.js";
import { describeError, truncate, uniqueId } from "../utils.js";
import { questionAnsweredCard, questionCard } from "../cards.js";

export class FeishuQuestions {
  constructor({ ctx, bridge, sender, state, config, log, isAllowed }) {
    this.ctx = ctx;
    this.bridge = bridge;
    this.sender = sender;
    this.state = state;
    this.config = config;
    this.log = log;
    this.isAllowed = isAllowed;
    this.signer = createSigner(config.signSecret);
    this.pending = new Map();
    // Same precedence problem as approvals: claim Feishu-bound sessions
    // before the Web UI answerer, delegate everything else.
    this.dispose = ctx.on(
      "user-questions/request",
      async (request, next) => {
        try {
          return await this.handleRequest(request, next);
        } catch (error) {
          this.log.warn("提问卡片处理失败", { error: describeError(error) });
          return next();
        }
      },
      { prepend: true },
    );
  }

  close() {
    try {
      this.dispose?.();
    } catch {
      /* ignore */
    }
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.resolve?.({ answers: [] });
    }
    this.pending.clear();
  }

  async handleRequest(request, next) {
    const sessionId = String(request?.agent?.id ?? "");
    if (!sessionId) return next();
    const link = this.state.linkForSession(sessionId);
    if (!link?.anchorMessageId) return next();

    const questions = Array.isArray(request.questions) ? request.questions : [];
    if (questions.length === 0) return next();

    const key = uniqueId("q_");
    const token = this.signer.sign({ kind: "question", key });
    const card = questionCard({ questions, token });
    const sent = await this.sender.replyCard(link.anchorMessageId, card);
    if (!sent.ok) return next();

    const answer = await new Promise((resolve) => {
      const item = {
        key,
        sessionId,
        questions,
        answers: new Map(),
        messageId: sent.messageId,
        anchorMessageId: link.anchorMessageId,
        resolve,
        timer: undefined,
        signal: request.signal,
        onAbort: undefined,
        settled: false,
      };
      this.pending.set(key, item);
      item.timer = setTimeout(() => {
        this.settle(key, [], "⏰ 问题超时，按跳过回答").catch(() => undefined);
      }, this.config.questionTtlMs);
      item.timer.unref?.();
      if (request.signal) {
        item.onAbort = () => this.settle(key, [], "已取消").catch(() => undefined);
        if (request.signal.aborted) item.onAbort();
        else request.signal.addEventListener("abort", item.onAbort, { once: true });
      }
    });

    return { answers: answer };
  }

  async settle(key, answers, note, patch = true) {
    const item = this.pending.get(key);
    if (!item || item.settled) return false;
    item.settled = true;
    this.pending.delete(key);
    clearTimeout(item.timer);
    if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
    item.resolve?.(answers);
    const summary = answers.length
      ? answers
          .map((entry) => {
            const question = item.questions.find((q) => q.id === entry.id);
            const text = entry.selected?.length ? entry.selected.join(", ") : entry.custom ?? "(跳过)";
            return `- ${question?.question ?? entry.id}: **${truncate(text, 300)}**`;
          })
          .join("\n")
      : "已跳过/超时。";
    if (patch) await this.sender.patchCard(item.messageId, questionAnsweredCard({ summary }));
    if (note) this.log.info("提问结束", { sessionId: item.sessionId, note });
    return summary;
  }

  /** Resolve a question with one selected option label. */
  async handleAction(action) {
    const value = action.value ?? {};
    const payload = this.signer.verify(value.t);
    if (!payload || payload.kind !== "question") {
      return { toast: { type: "error", content: "凭证无效或已过期" } };
    }
    if (!this.isAllowed(action.operatorOpenId)) {
      return { toast: { type: "error", content: "你不在允许名单内" } };
    }
    const item = this.pending.get(payload.key);
    if (!item) return { toast: { type: "error", content: "问题已回答或已过期" } };

    const questionId = String(value.q ?? "");
    const selected = String(value.s ?? "");
    const question = item.questions.find((entry) => entry.id === questionId);
    if (!question) return { toast: { type: "error", content: "未知问题" } };

    const answers = [{ id: questionId, selected: [selected] }];
    const remaining = item.questions.filter((entry) => entry.id !== questionId && !item.answers.has(entry.id));
    if (remaining.length > 0) {
      item.answers.set(questionId, answers[0]);
      return { toast: { type: "info", content: "已记录，请继续回答其他问题" } };
    }
    for (const [id, answer] of item.answers) if (id !== questionId) answers.push(answer);
    const summary = answers
      .map((entry) => {
        const question = item.questions.find((q) => q.id === entry.id);
        const text = entry.selected?.length ? entry.selected.join(", ") : entry.custom ?? "(跳过)";
        return `- ${question?.question ?? entry.id}: **${truncate(text, 300)}**`;
      })
      .join("\n");
    await this.settle(payload.key, answers, undefined, false);
    const card = questionAnsweredCard({ summary });
    return { card: { type: "raw", data: card }, toast: { type: "info", content: "已回答" } };
  }

  /**
   * Consume a plain reply in the topic as the answer. Returns true when the
   * text was used (and must not also be sent to the model).
   */
  async tryAnswerText(sessionId, text) {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return false;
    const item = [...this.pending.values()].find((entry) => entry.sessionId === sessionId && !entry.settled);
    if (!item) return false;
    if (item.questions.length > 1) {
      await this.sender.replyText(item.anchorMessageId, "这是一组问题：请点卡片上的选项；如需自由作答，请逐个问题用按钮选择。");
      return true;
    }
    const question = item.questions[0];
    const labels = (question.options ?? []).map((option) => option.label);
    const matched = labels.find((label) => label === trimmed);
    const answer = matched
      ? { id: question.id, selected: [matched] }
      : { id: question.id, selected: [], custom: trimmed };
    await this.settle(item.key, [answer]);
    return true;
  }
}
