/**
 * 提问桥：把 dsh 的 `user-questions/request` waterfall 接到飞书卡片。
 *
 * **逻辑来源**：opencode-feishu-plugin `src/feishu/form-relay.ts` + `forms.ts`（MIT，Copyright (c) 2026 moyuanhua）：
 * 待答表单的卡片渲染、按钮点击作答、**聊天里直接发文字作答**（`consumeText`）、逐字段累积、
 * 答完提交、取消/超时收敛 —— 文案与交互语义沿用上游；卡片构建直接复用本仓库搬运的 `forms.ts`。
 *
 * **形状差异（宿主接缝不同）**：上游监听 `form.created` 事件并用 `session.form.reply` 提交答案；
 * dsh 的 `user-questions/request` 是 **waterfall**，桥直接 await 作答后返回
 * `AskUserQuestionAnswer`，无法作答时 `next()` 交回宿主（例如超时或会话无飞书映射）。
 *
 * 映射（dsh 问题项 → 上游表单字段）：
 * | dsh | FormField |
 * |---|---|
 * | `id` | `key` |
 * | `header ?? question` | `title` |
 * | `question` + `detail` | `description` |
 * | `options[].label`（选项按 label 回传） | `options[{value:label,label}]` |
 * | `multiSelect` | `type: "multiselect"` |
 * | 总是允许自填 | `custom: true`（因此每题都有「✍️ 直接回复答案」按钮） |
 */
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from "@deepseek-ai/dsh-user-questions";
import {
  buildFormCard,
  buildFormResolvedCard,
  isComplete,
  parseFormAction,
  type FormField,
  type FormLike,
  type FormValue,
} from "./forms.js";
import type { Logger, SessionLink } from "../types.js";

export interface QuestionCardPort {
  sendCard(chatId: string, card: object): Promise<string>;
  patchCard(messageId: string, card: object): Promise<void>;
}

export interface QuestionDeps {
  readonly log: Logger;
  readonly cardPort: QuestionCardPort;
  /** sessionId → 飞书投递目标（无映射 = 不接管）。 */
  readonly getLink: (sessionId: string) => Promise<SessionLink | undefined>;
  readonly isAllowed: (openId: string) => boolean;
  /** 提问卡有效期（ms）；到期后交回宿主。 */
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly newFormId?: () => string;
}

interface PendingQuestion {
  readonly form: FormLike;
  readonly sessionId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly answers: Record<string, FormValue>;
  /** 用户点了「✍️ 直接回复答案」的字段（等待聊天里发来的文本）。 */
  awaitingFreeText?: string;
  readonly resolve: (answer: AskUserQuestionAnswer | undefined) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onAbort?: () => void;
}

/** dsh 问题项 → 上游表单字段。 */
export function fieldOf(item: AskUserQuestionItem): FormField {
  const description = [item.header ? item.question : "", item.detail ?? ""].filter(Boolean).join("\n");
  return {
    key: item.id,
    type: item.multiSelect === true ? "multiselect" : "string",
    title: item.header ?? item.question,
    ...(description ? { description } : {}),
    ...(item.options && item.options.length > 0
      ? {
          options: item.options.map((option) => ({
            value: option.label,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
        }
      : {}),
    // 上游语义：点按钮或在话题里直接发文字都能作答。
    custom: true,
  };
}

/** dsh 问题项数组 → 上游 `FormLike`（formId 由 `wait.callId` 或生成器给出）。 */
export function formOf(
  formId: string,
  sessionId: string,
  questions: readonly AskUserQuestionItem[],
  title = "需要你的确认",
): FormLike {
  return {
    id: formId,
    sessionID: sessionId,
    title,
    metadata: { kind: "question" },
    fields: questions.map(fieldOf),
  };
}

export class QuestionBridge {
  private readonly pending = new Map<string, PendingQuestion>();
  private disposed = false;
  private counter = 0;

  constructor(private readonly deps: QuestionDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private nextFormId(): string {
    if (this.deps.newFormId) return this.deps.newFormId();
    this.counter += 1;
    return `fq_${this.counter}_${this.now()}`;
  }

  /**
   * 处理一次提问请求。
   *
   * 返回结构化答案即"认领"该请求；无法作答（无映射 / 超时 / 取消 / 已卸载）则 `next()` 交回宿主。
   */
  async handle(
    sessionId: string | undefined,
    request: AskUserQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    if (this.disposed) return next();
    const questions = request.questions ?? [];
    if (!sessionId || questions.length === 0) return next();
    const link = await this.deps.getLink(sessionId);
    if (!link) return next();
    // 已经取消的请求不必再发卡（否则会留下一张永远等不到答案的卡）。
    if (request.signal?.aborted) return next();

    const answer = await this.ask(sessionId, link, questions, request);
    return answer ?? next();
  }

  private async ask(
    sessionId: string,
    link: SessionLink,
    questions: readonly AskUserQuestionItem[],
    request: AskUserQuestionRequest,
  ): Promise<AskUserQuestionAnswer | undefined> {
    const formId = request.wait?.callId ? String(request.wait.callId) : this.nextFormId();
    const form = formOf(formId, sessionId, questions);
    const answers: Record<string, FormValue> = {};

    let messageId: string;
    try {
      messageId = await this.deps.cardPort.sendCard(link.chatId, buildFormCard(form, answers));
    } catch (error) {
      this.deps.log.error("提问卡发送失败，交回宿主", {
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    return new Promise<AskUserQuestionAnswer | undefined>((resolve) => {
      const settle = (answer: AskUserQuestionAnswer | undefined): void => {
        const entry = this.pending.get(formId);
        if (!entry) return;
        this.pending.delete(formId);
        clearTimeout(entry.timer);
        entry.onAbort?.();
        resolve(answer);
      };

      const timer = setTimeout(() => {
        this.deps.log.warn("提问超时，交回宿主", { sessionId, formId });
        void this.patchResolved(formId, form, answers, "cancelled");
        settle(undefined);
      }, this.deps.timeoutMs);

      const signal = request.signal;
      const onAbort = signal
        ? () => {
            signal.removeEventListener("abort", abortHandler);
          }
        : undefined;
      const abortHandler = (): void => {
        this.deps.log.info("提问被取消，交回宿主", { sessionId, formId });
        void this.patchResolved(formId, form, answers, "cancelled");
        settle(undefined);
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          return resolve(undefined);
        }
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      this.pending.set(formId, {
        form,
        sessionId,
        chatId: link.chatId,
        messageId,
        answers,
        resolve: settle,
        timer,
        ...(onAbort ? { onAbort } : {}),
      });
      this.deps.log.info("已发提问卡，等待作答", { sessionId, formId, messageId, questions: questions.length });
    });
  }

  /**
   * 消费一条普通聊天文本作为答案（上游 `FormRelay.consumeText`）。
   *
   * 规则：优先填「点了 ✍️ 直接回复答案」的字段；否则当该会话只剩一个待答字段时，把文本给它。
   * 返回 true = 已消费（调用方不再把它当 prompt 投递）。
   */
  consumeText(sessionId: string, text: string): boolean {
    if (this.disposed) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    for (const entry of this.pending.values()) {
      if (entry.sessionId !== sessionId) continue;
      // 优先填「点了 ✍️ 直接回复答案」的字段；否则仅当只剩一个待答字段时才认领这条文本。
      const key = entry.awaitingFreeText ?? onlyMissing(entry.form, entry.answers);
      if (!key) continue;
      entry.answers[key] = trimmed;
      entry.awaitingFreeText = undefined;
      this.deps.log.info("聊天文本已作为答案消费", { sessionId, formId: entry.form.id, field: key });
      void this.afterAnswer(entry);
      return true;
    }
    return false;
  }

  /** 处理卡片按钮点击；非本桥的按钮返回 undefined。 */
  async handleCardAction(event: {
    readonly operator: { readonly openId: string };
    readonly action: { readonly value: unknown };
  }): Promise<unknown> {
    const parsed = parseFormAction(event.action.value);
    if (!parsed) return undefined;
    const entry = this.pending.get(parsed.f);
    if (!entry) return { toast: { type: "warning", content: "该问题已结束" } };
    if (!this.deps.isAllowed(event.operator.openId)) {
      return { toast: { type: "error", content: "无权作答" } };
    }

    if (parsed.free === true) {
      entry.awaitingFreeText = parsed.k;
      await this.patchCard(entry, { notice: "请直接在聊天里回复你的答案。" });
      return { toast: { type: "info", content: "请直接回复文字答案" } };
    }

    entry.answers[parsed.k] = parsed.v as FormValue;
    entry.awaitingFreeText = undefined;
    await this.afterAnswer(entry, true);
    return { toast: { type: "success", content: "已记录" } };
  }

  /** 记录答案后的推进：答完则提交，否则刷新卡片。 */
  private async afterAnswer(entry: PendingQuestion, refresh = false): Promise<void> {
    if (isComplete(entry.form, entry.answers)) {
      await this.patchResolved(entry.form.id, entry.form, entry.answers, "answered");
      entry.resolve(this.answerOf(entry.form, entry.answers));
      return;
    }
    if (refresh) await this.patchCard(entry, {});
  }

  private async patchCard(entry: PendingQuestion, opts: { notice?: string }): Promise<void> {
    try {
      await this.deps.cardPort.patchCard(entry.messageId, buildFormCard(entry.form, entry.answers, opts));
    } catch (error) {
      this.deps.log.warn("提问卡更新失败", { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private async patchResolved(
    formId: string,
    form: FormLike,
    answers: Record<string, FormValue>,
    outcome: "answered" | "cancelled" | "error",
  ): Promise<void> {
    const entry = this.pending.get(formId);
    if (entry) {
      try {
        await this.deps.cardPort.patchCard(entry.messageId, buildFormResolvedCard(form, answers, outcome));
      } catch (error) {
        this.deps.log.warn("提问结果卡更新失败", { reason: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    void form;
  }

  /** 表单答案 → dsh 的 `AskUserQuestionAnswer`（选项按 label 回传；非选项文本进 `custom`）。 */
  private answerOf(form: FormLike, answers: Readonly<Record<string, FormValue>>): AskUserQuestionAnswer {
    return {
      answers: form.fields.map((field) => {
        const value = answers[field.key];
        if (value === undefined) return { id: field.key, selected: [] };
        if (Array.isArray(value)) return { id: field.key, selected: value };
        if (typeof value === "boolean") return { id: field.key, selected: [value ? "是" : "否"] };
        const isOption = (field.options ?? []).some((option) => option.value === String(value));
        return isOption
          ? { id: field.key, selected: [String(value)] }
          : { id: field.key, selected: [], custom: String(value) };
      }),
    };
  }

  /** 卸载：待答全部收敛为"交回宿主"，避免悬挂 promise。 */
  dispose(): void {
    this.disposed = true;
    for (const [formId, entry] of [...this.pending]) {
      clearTimeout(entry.timer);
      entry.onAbort?.();
      entry.resolve(undefined);
      this.pending.delete(formId);
      this.deps.log.debug("卸载时取消待答提问", { formId });
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** 该会话是否有待答提问（看门狗的「合法等待」判据，与审批同理）。 */
  hasPendingFor(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }
}

/** 该表单是否只剩一个未答字段（此时聊天文本可以唯一对应到它）。 */
function onlyMissing(form: FormLike, answers: Readonly<Record<string, FormValue>>): string | undefined {
  const missing = form.fields.filter((field) => field.hidden !== true && answers[field.key] === undefined);
  return missing.length === 1 ? missing[0]?.key : undefined;
}
