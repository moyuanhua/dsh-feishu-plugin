/** Answers DSH user-questions waterfalls through Feishu forms or plain replies. */
import { createSigner } from "../security.js";
import { describeError, truncate, uniqueId } from "../utils.js";
import { questionAnsweredCard, questionCard } from "../cards.js";

function textOf(value) {
  return typeof value === "string" ? value.trim() : "";
}

function labelsOf(question) {
  return Array.isArray(question?.options)
    ? question.options.map((option) => textOf(option?.label)).filter(Boolean)
    : [];
}

function matchChoice(question, raw) {
  const token = textOf(raw).replace(/^[-*•\s]+/, "");
  if (!token) return undefined;
  const labels = labelsOf(question);
  const numeric = /^\d+$/.test(token) ? Number.parseInt(token, 10) : undefined;
  if (numeric && numeric >= 1 && numeric <= labels.length) return labels[numeric - 1];
  const lower = token.toLowerCase();
  return labels.find((label) => label.toLowerCase() === lower);
}

function summaryText(questions, answers) {
  if (!answers.length) return "已跳过/超时。";
  return answers
    .map((entry) => {
      const question = questions.find((item) => item.id === entry.id);
      const selected = entry.selected?.filter(Boolean) ?? [];
      const custom = textOf(entry.custom);
      const text = [selected.join("、"), custom ? `其它：${custom}` : ""].filter(Boolean).join("；") || "(跳过)";
      return `- ${question?.question ?? entry.id}: **${truncate(text, 300)}**`;
    })
    .join("\n");
}

function questionText(question, index, total) {
  const lines = [`❓ 需要你的决定（${index + 1}/${total}）`];
  if (question?.header) lines.push(`**${question.header}**`);
  lines.push(question?.question ?? "");
  if (question?.detail) lines.push("", truncate(question.detail, 1_000));
  const labels = labelsOf(question);
  if (labels.length) {
    lines.push("", question.multiSelect ? "可多选，回复选项（多个用逗号分隔）：" : "请回复选项：");
    labels.forEach((label, i) => lines.push(`${i + 1}. ${label}`));
  } else {
    lines.push("", "直接回复文字作答。");
  }
  return lines.join("\n");
}

export class FeishuQuestions {
  constructor({ ctx, bridge, sender, state, config, log, isAllowed, onAnswered }) {
    this.ctx = ctx;
    this.bridge = bridge;
    this.sender = sender;
    this.state = state;
    this.config = config;
    this.log = log;
    this.isAllowed = isAllowed;
    this.onAnswered = onAnswered;
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
      item.resolve?.([]);
    }
    this.pending.clear();
  }

  async handleRequest(request, next) {
    const sessionId = String(request?.agent?.id ?? "");
    if (!sessionId) return next();
    const link = this.state.linkForSession(sessionId);
    if (!link?.anchorMessageId) return next();

    const questions = Array.isArray(request.questions) ? request.questions.filter((q) => q?.id) : [];
    if (questions.length === 0) return next();

    const key = uniqueId("q_");
    const token = this.signer.sign({ kind: "question", key });
    const item = {
      key,
      sessionId,
      questions,
      answers: new Map(),
      selections: new Map(),
      index: 0,
      messageId: undefined,
      isCard: false,
      anchorMessageId: link.anchorMessageId,
      chatId: link.chatId,
      threadId: this.state.threadForSession?.(sessionId),
      agent: request.agent,
      callId: request.wait?.callId ? String(request.wait.callId) : undefined,
      expired: false,
      resolve: undefined,
      timer: undefined,
      signal: request.signal,
      onAbort: undefined,
      settled: false,
    };

    const card = questionCard({
      question: questions[0],
      index: 0,
      total: questions.length,
      token,
      selected: [],
    });
    const sent = await this.sender.replyCard(link.anchorMessageId, card);
    if (sent.ok) {
      item.messageId = sent.messageId;
      item.isCard = true;
    } else {
      // A malformed/oversized card must not leave the question unanswered. Fall
      // back to a text prompt; the same pending item still accepts text replies.
      this.log.warn("提问卡片发送失败，回退为文字提问", { sessionId, error: sent.error });
      const fallback = await this.sender.replyText(link.anchorMessageId, questionText(questions[0], 0, questions.length));
      if (!fallback.ok) return next();
      item.messageId = fallback.messageId;
    }

    this.pending.set(key, item);
    const answer = await new Promise((resolve) => {
      item.resolve = resolve;
      item.timer = setTimeout(() => {
        this.markExpired(key).catch(() => undefined);
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

  answersInOrder(item) {
    return item.questions.map((q) => item.answers.get(q.id)).filter(Boolean);
  }

  patchSoon(item, card, fallback = false) {
    if (!item.messageId) return;
    const timer = setTimeout(() => {
      this.sender.patchCard(item.messageId, card).then(async (res) => {
        if (res.ok) return;
        this.log.debug("提问卡片更新失败", { error: res.error });
        // The card can be locked while its callback is still settling. Send a
        // fresh card rather than leaving the user stuck on the old question.
        if (!fallback) return;
        const fresh = await this.sender.replyCard(item.anchorMessageId, card);
        if (fresh.ok) item.messageId = fresh.messageId;
      });
    }, 350);
    timer.unref?.();
  }

  /** Keep a timed-out question answerable for a grace period. DSH's timed
   * ask_user_question returns `pending` and stays answerable via
   * ctx.userQuestions.answer(agent, callId, batch), so deleting the card state
   * here was what made late replies get stuck. */
  async markExpired(key) {
    const item = this.pending.get(key);
    if (!item || item.settled || item.expired) return;
    item.expired = true;
    const question = item.questions[item.index];
    const token = this.signer.sign({ kind: "question", key: item.key });
    const notice = "⏰ 已超时，仍可继续回答；提交后会作为延迟答案。";
    if (item.isCard) {
      this.patchSoon(
        item,
        questionCard({
          question,
          index: item.index,
          total: item.questions.length,
          token,
          selected: item.selections.get(question.id) ?? [],
          notice,
        }),
        true,
      );
    } else {
      void this.sender.replyText(item.anchorMessageId, notice);
    }
    item.timer = setTimeout(() => {
      this.settle(key, [], "⏰ 问题已过期").catch(() => undefined);
    }, 30 * 60_000);
    item.timer.unref?.();
    this.log.info("提问超时，等待延迟回答", { sessionId: item.sessionId, callId: item.callId });
  }

  async deliverLate(item, answers) {
    if (!item.callId || !item.agent) return false;
    const service = this.ctx.get?.("userQuestions") ?? this.ctx.userQuestions;
    if (!service?.answer) return false;
    try {
      const accepted = service.answer(item.agent, item.callId, { answers });
      if (accepted) this.log.info("延迟回答已送入 DSH", { sessionId: item.sessionId, callId: item.callId });
      return accepted === true;
    } catch (error) {
      this.log.warn("延迟回答送入失败", { sessionId: item.sessionId, error: describeError(error) });
      return false;
    }
  }

  async settle(key, answers, note, options = {}) {
    const item = this.pending.get(key);
    if (!item || item.settled) return false;
    item.settled = true;
    this.pending.delete(key);
    clearTimeout(item.timer);
    if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
    // Rotate before resolving: the model may start streaming as soon as the
    // tool result settles, and those events must land on the new card.
    if (options.rotate && answers.length > 0 && this.onAnswered) {
      try {
        await this.onAnswered({
          sessionId: item.sessionId,
          anchorMessageId: options.anchorMessageId || item.messageId,
          chatId: item.chatId,
          threadId: options.threadId || item.threadId,
        });
      } catch (error) {
        this.log.warn("切换继续处理卡片失败", { error: describeError(error) });
      }
    }
    item.resolve?.(answers);
    const summary = summaryText(item.questions, answers);
    if (item.isCard) {
      this.patchSoon(item, questionAnsweredCard({ summary }));
    } else if (item.messageId) {
      void this.sender.replyText(item.anchorMessageId, summary);
    }
    if (note) this.log.info("提问结束", { sessionId: item.sessionId, note });
    return true;
  }

  /** Record one answer and either show the next question or settle. */
  async recordAnswer(item, answer, options = {}) {
    const question = item.questions[item.index];
    item.answers.set(question.id, answer);
    item.selections.delete(question.id);
    const next = item.index + 1;
    if (next < item.questions.length) {
      item.index = next;
      const nextQuestion = item.questions[next];
      if (item.isCard) {
        const token = this.signer.sign({ kind: "question", key: item.key });
        this.patchSoon(
          item,
          questionCard({
            question: nextQuestion,
            index: next,
            total: item.questions.length,
            token,
            selected: [],
          }),
          true,
        );
      } else {
        void this.sender.replyText(
          item.anchorMessageId,
          questionText(nextQuestion, next, item.questions.length),
        );
      }
      return { done: false, remaining: item.questions.length - next };
    }
    const answers = this.answersInOrder(item);
    await this.deliverLate(item, answers);
    await this.settle(item.key, answers, undefined, {
      rotate: true,
      anchorMessageId: options.anchorMessageId || item.messageId,
      threadId: options.threadId,
    });
    return { done: true, remaining: 0 };
  }

  async handlePick(action, value) {
    const payload = this.signer.verify(value.t);
    if (!payload || payload.kind !== "question") {
      return { toast: { type: "error", content: "凭证无效或已过期" } };
    }
    const item = this.pending.get(payload.key);
    if (!item) return { toast: { type: "error", content: "问题已回答或已过期" } };
    if (Number(value.i) !== item.index) {
      return { toast: { type: "error", content: "请回答当前显示的问题" } };
    }
    const question = item.questions[item.index];
    const label = textOf(value.s);
    const known = labelsOf(question);
    if (!known.includes(label)) return { toast: { type: "error", content: "未知选项" } };

    if (!question.multiSelect) {
      const result = await this.recordAnswer(item, { id: question.id, selected: [label] });
      return {
        toast: {
          type: "success",
          content: result.done ? "已提交" : `已记录，还剩 ${result.remaining} 个问题`,
        },
      };
    }

    const picked = new Set(item.selections.get(question.id) ?? []);
    if (picked.has(label)) picked.delete(label);
    else picked.add(label);
    item.selections.set(question.id, [...picked]);
    const token = this.signer.sign({ kind: "question", key: item.key });
    this.patchSoon(
      item,
      questionCard({
        question,
        index: item.index,
        total: item.questions.length,
        token,
        selected: [...picked],
      }),
      true,
    );
    return { toast: { type: "info", content: picked.has(label) ? "已选择" : "已取消" } };
  }

  async handleMultiSubmit(action, value) {
    const payload = this.signer.verify(value.t);
    if (!payload || payload.kind !== "question") {
      return { toast: { type: "error", content: "凭证无效或已过期" } };
    }
    const item = this.pending.get(payload.key);
    if (!item) return { toast: { type: "error", content: "问题已回答或已过期" } };
    if (Number(value.i) !== item.index) {
      return { toast: { type: "error", content: "请回答当前显示的问题" } };
    }
    const question = item.questions[item.index];
    const selected = [...(item.selections.get(question.id) ?? [])].filter((label) => labelsOf(question).includes(label));
    if (selected.length === 0) {
      return { toast: { type: "error", content: "请先至少选择一个选项" } };
    }
    const result = await this.recordAnswer(item, { id: question.id, selected });
    return {
      toast: {
        type: "success",
        content: result.done ? "已提交" : `已记录，还剩 ${result.remaining} 个问题`,
      },
    };
  }

  async handleTextSubmit(action, value) {
    const payload = this.signer.verify(value.t);
    if (!payload || payload.kind !== "question") {
      return { toast: { type: "error", content: "凭证无效或已过期" } };
    }
    const item = this.pending.get(payload.key);
    if (!item) return { toast: { type: "error", content: "问题已回答或已过期" } };
    if (Number(value.i) !== item.index) {
      return { toast: { type: "error", content: "请回答当前显示的问题" } };
    }
    const question = item.questions[item.index];
    const custom = textOf(action.formValue?.custom);
    if (!custom) return { toast: { type: "error", content: "请先输入文字答案" } };
    const existing = [...(item.selections.get(question.id) ?? [])].filter((label) => labelsOf(question).includes(label));
    const result = await this.recordAnswer(item, {
      id: question.id,
      selected: question.multiSelect ? existing : [],
      custom,
    });
    return {
      toast: {
        type: "success",
        content: result.done ? "已提交" : `已记录，还剩 ${result.remaining} 个问题`,
      },
    };
  }

  handleTextPrompt(value) {
    const payload = this.signer.verify(value.t);
    if (!payload || payload.kind !== "question") {
      return { toast: { type: "error", content: "凭证无效或已过期" } };
    }
    const item = this.pending.get(payload.key);
    if (!item) return { toast: { type: "error", content: "问题已回答或已过期" } };
    const question = item.questions[item.index];
    const token = this.signer.sign({ kind: "question", key: item.key });
    this.patchSoon(
      item,
      questionCard({
        question,
        index: item.index,
        total: item.questions.length,
        token,
        selected: item.selections.get(question.id) ?? [],
        notice: "✍️ 请直接在本话题发送文字，作为当前题答案。",
      }),
    );
    return { toast: { type: "info", content: "请直接发送文字作答" } };
  }

  /** Resolve a question with one selected option label (legacy button cards). */
  async handleAction(action) {
    const value = action.value ?? {};
    const payload = this.signer.verify(value.t);
    if (!payload || payload.kind !== "question") {
      return { toast: { type: "error", content: "凭证无效或已过期" } };
    }
    if (!this.isAllowed(action.operatorOpenId)) {
      return { toast: { type: "error", content: "你不在允许名单内" } };
    }
    if (value.a === "qsubmit") return this.handleMultiSubmit(action, value);
    if (value.a === "qpick") return this.handlePick(action, value);
    if (value.a === "qtextsubmit") return this.handleTextSubmit(action, value);
    if (value.a === "qtext") return this.handleTextPrompt(action.value ?? {});

    const item = this.pending.get(payload.key);
    if (!item) return { toast: { type: "error", content: "问题已回答或已过期" } };
    const questionId = String(value.q ?? "");
    const questionIndex = item.questions.findIndex((entry) => entry.id === questionId);
    if (questionIndex < 0 || questionIndex !== item.index) {
      return { toast: { type: "error", content: "请回答当前显示的问题" } };
    }
    const selected = textOf(value.s);
    if (!selected) return { toast: { type: "error", content: "缺少选项" } };
    const result = await this.recordAnswer(item, { id: questionId, selected: [selected] });
    return {
      toast: {
        type: "success",
        content: result.done ? "已回答" : `已记录，还剩 ${result.remaining} 个问题`,
      },
    };
  }

  textAnswer(question, text, existing = []) {
    const trimmed = textOf(text);
    if (!trimmed) return undefined;
    const labels = labelsOf(question);
    if (question.multiSelect && labels.length) {
      const parts = trimmed.split(/[、,，;；\n]+/).map((part) => part.trim()).filter(Boolean);
      const selected = new Set(existing.filter((label) => labels.includes(label)));
      const leftover = [];
      for (const part of parts) {
        const matched = matchChoice(question, part);
        if (matched) selected.add(matched);
        else leftover.push(part);
      }
      if (selected.size) {
        return {
          id: question.id,
          selected: [...selected],
          ...(leftover.length ? { custom: leftover.join(" ") } : {}),
        };
      }
      return { id: question.id, selected: [], custom: trimmed };
    }
    const matched = labels.length ? matchChoice(question, trimmed) : undefined;
    return matched
      ? { id: question.id, selected: [matched] }
      : { id: question.id, selected: [], custom: trimmed };
  }

  /** Drop every pending question for a session and recall stale cards. */
  async recover(sessionId) {
    let count = 0;
    for (const [key, item] of [...this.pending.entries()]) {
      if (item.sessionId !== sessionId) continue;
      item.settled = true;
      this.pending.delete(key);
      clearTimeout(item.timer);
      if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
      item.resolve?.([]);
      const recalled = await this.sender.recallMessage(item.messageId);
      if (!recalled.ok) {
        await this.sender.patchCard(
          item.messageId,
          questionAnsweredCard({ summary: "♻️ 会话已恢复，本次提问已取消。" }),
        );
      }
      count += 1;
    }
    if (count) this.log.info("提问已恢复清理", { sessionId, count });
    return count;
  }

  /**
   * Consume a plain reply in the topic as the answer to the current question.
   * Returns true when the text was used (and must not also be sent to the model).
   */
  async tryAnswerText(sessionId, text, anchorMessageId, threadId) {
    const trimmed = textOf(text);
    if (!trimmed) return false;
    const item = [...this.pending.values()].find((entry) => entry.sessionId === sessionId && !entry.settled);
    if (!item) return false;
    const question = item.questions[item.index];
    const answer = this.textAnswer(question, trimmed, item.selections.get(question.id) ?? []);
    if (!answer) return false;
    await this.recordAnswer(item, answer, {
      anchorMessageId: anchorMessageId || item.messageId,
      threadId,
    });
    return true;
  }
}
