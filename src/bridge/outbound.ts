/**
 * 运行卡（出站）控制器：把 dsh 的流式事件映射成运行卡状态，并按节流 patch 飞书卡片。
 *
 * 设计要点：
 * - **纯映射 + 可注入端口**：`mapStreamFrame` / `mapSessionEvent` 是纯函数，
 *   `RunCard` 只依赖 `CardPort`（发卡 / 更新卡），因此整条出站路径可脱离 dsh 与飞书单测。
 * - **串行化 patch**：卡片更新是异步的，用一条 promise 链串起来，避免并发更新乱序。
 * - **节流遵守飞书硬限**：官方《流式更新卡片》规定同一卡片实体 ≤10 次/秒更新，
 *   所以默认 700ms 节流（文档依据已写进 `src/feishu/cards.ts` 与 README）。
 * - **体积翻页**：单元素内容有上限（`OutboundConfig.streamMaxElementChars` 默认 30000，
 *   官方《发送消息》限请求体 30KB），超过时封卡并新开一张，保证生成不中断。
 */
import { enforceCardLimits } from "../feishu/card-limits.js";
import { buildRunCard } from "../feishu/cards.js";
import type { RunEvent, RunState } from "./run-state.js";
import { initialRunState, isTerminal, reduceRunState } from "./run-state.js";
import { renderRunMarkdown, runCardTitle, shouldRenderAfter } from "./run-renderer.js";
import type { Logger } from "../types.js";

/**
 * 出站目标。
 *
 * **`replyTo` 不是可选的装饰**：飞书的话题（thread）不是"发到哪里"，而是"回复谁"。
 * 顶层 `send` 出去的卡片会落在主聊天流里 —— 实测就是这样：用户在话题里回复，
 * 机器人的卡片却出现在主聊天流，话题看着像断了。
 *
 * 上游用的是 `im.message.reply`（回复触发消息），SDK 的 `reply()` 会在
 * `threadId` 存在时把回复保持在话题内。所以出站一律带 `replyTo`。
 */
export interface OutboundTarget {
  readonly chatId: string;
  /** 回复哪条消息。有它就留在那条消息所在的话题里。 */
  readonly replyTo?: string;
  readonly threadId?: string;
}

/** 出站端口：由飞书通道实现（`channel.send` 顶层发 / `channel.reply` 回复进入话题）。 */
export interface CardPort {
  /** 发一张卡片，返回 messageId。带 `replyTo` 时回复该消息（从而留在话题内）。 */
  sendCard(target: OutboundTarget, card: object): Promise<string>;
  /** 覆盖更新一张已发出的卡片。 */
  patchCard(messageId: string, card: object): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * 事件映射（纯函数）
 * ------------------------------------------------------------------ */

/** dsh `agent/assistant-stream` 的 frame（只声明我们用到的字段）。 */
export interface AssistantStreamFrameLike {
  readonly type: "start" | "chunk" | "end";
  readonly chunk?: { readonly type: string; readonly text?: string };
}

/** chunk 型 frame → 文本增量；其它一律忽略。 */
export function mapStreamFrame(frame: AssistantStreamFrameLike): RunEvent | undefined {
  if (frame.type !== "chunk") return undefined;
  const chunk = frame.chunk;
  if (!chunk || chunk.type !== "text-delta") return undefined;
  return { type: "text-delta", text: chunk.text ?? "" };
}

/**
 * dsh `session/event` 的最小形状。
 *
 * 实测（0.2.0-rc.2 的 d.ts）：事件是**信封**结构 `{ type, seq, time, data: {...} }`，
 * 业务字段在 `data` 里；这里同时兼容平铺形状（便于单测直接构造）。
 */
export interface SessionEventLike {
  readonly type: string;
  readonly data?: {
    readonly name?: string;
    readonly callId?: unknown;
    readonly error?: ToolResultErrorLike;
    readonly message?: {
      readonly isError?: boolean;
      readonly toolCallId?: unknown;
      readonly content?: readonly { readonly type?: string; readonly text?: string }[];
    };
    readonly stream?: readonly { readonly chunk?: { readonly type?: string; readonly text?: string } }[];
    readonly reason?: TurnEndReasonLike;
  };
  // —— 平铺兼容（单测/未来版本） ——
  readonly name?: string;
  readonly error?: ToolResultErrorLike;
  readonly message?: {
    readonly isError?: boolean;
    readonly toolCallId?: unknown;
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  };
  readonly stream?: readonly { readonly chunk?: { readonly type?: string; readonly text?: string } }[];
  readonly reason?: TurnEndReasonLike;
}

/**
 * `tool/result` 的 `error`（仅 `message.isError === true` 时允许存在）。
 * 形状取自 `dsh-session` 的 `SessionEventMap['tool/result']`。
 */
export interface ToolResultErrorLike {
  readonly name?: string;
  readonly code?: string;
  readonly reason?: string;
}

/**
 * `turn/end` 的 `reason`（dsh 的 `TurnEndReason`，`dsh-session/lib/types/types.d.ts:165`）。
 *
 * 这是**与宿主版本强耦合**的词汇表：dsh 明确声明它是 merge-extensible sum type，
 * 插件可合并新变体。因此映射必须**穷尽已知分支**，并对未知分支**响亮失败**
 * ——绝不能像旧实现那样用 `default → done` 把失败吞成成功（那正是"显示 ✅ 其实报错"
 * 的根因）。
 */
export interface TurnEndReasonLike {
  readonly kind?: string;
  /** `aborted` 分支：取消原因 `TurnEndCancelCause`。 */
  readonly reason?: { readonly kind?: string; readonly reason?: string };
  /** `error` 分支：结构化失败事实 `LlmFailure`（`dsh-llm/lib/types/types.d.ts:26`）。 */
  readonly error?: {
    readonly message?: string;
    readonly code?: string;
    readonly status?: number;
  };
}

/** 取事件业务字段：信封优先，平铺兜底。 */
function payloadOf(event: SessionEventLike): NonNullable<SessionEventLike["data"]> & SessionEventLike {
  return (event.data ?? event) as NonNullable<SessionEventLike["data"]> & SessionEventLike;
}

/** 从 assistant/message 事件里取模型正文（content 块或紧凑 stream 两条路都兼容）。 */
export function extractAssistantText(event: SessionEventLike): string {
  const payload = payloadOf(event);
  const blocks = payload.message?.content;
  if (Array.isArray(blocks)) {
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("");
    if (text) return text;
  }
  const stream = payload.stream;
  if (Array.isArray(stream)) {
    return stream
      .filter((record) => record?.chunk?.type === "text-delta" && typeof record.chunk.text === "string")
      .map((record) => record.chunk?.text as string)
      .join("");
  }
  return "";
}

/**
 * `session/event` → RunEvent。
 *
 * 覆盖四类持久事件（官方 ACP 桥也是用这四个做状态）：
 * `tool/call` / `tool/result` / `assistant/message` / `turn/end`。
 */
export function mapSessionEvent(event: SessionEventLike): RunEvent | undefined {
  const payload = payloadOf(event);
  switch (event.type) {
    case "tool/call":
      return payload.name ? { type: "tool-start", name: payload.name } : undefined;
    case "tool/result": {
      const name = toolNameOf(payload);
      if (!name) return undefined;
      const ok = payload.message?.isError !== true;
      const detail = payload.error?.reason;
      return { type: "tool-end", name, ok, ...(detail ? { detail } : {}) };
    }
    case "assistant/message": {
      const text = extractAssistantText(event);
      return text ? { type: "assistant-message", text } : undefined;
    }
    case "turn/end": {
      const { outcome, reason } = describeTurnEnd(payload.reason);
      return { type: "turn-end", outcome, ...(reason ? { reason } : {}) };
    }
    default:
      return undefined;
  }
}

/**
 * `tool/result` 不带工具名（只有 callId 与调用配对），所以调用方会用 `tool/call` 记住的
 * callId→name 回填（见 `src/index.ts`），回填后从平铺字段读；拿不到就返回 undefined 由调用方忽略。
 */
function toolNameOf(payload: { readonly name?: string }): string | undefined {
  return payload.name;
}

/**
 * `TurnEndReason` → 运行卡终态。**穷尽 dsh 的 7 个分支**（见 `TurnEndReasonMap`）。
 *
 * 设计约定：
 * - 已知分支逐条给出**用户看得懂的中文原因**，而不是把 `kind` 直接抛给用户；
 * - `max-tokens` 是**局部成功**：轮次正常结束，但输出可能被截断，所以状态仍是 `done`，
 *   只附一条警告 —— 这是 7 个分支里唯一"完成但有话要说"的情况；
 * - `blocked` 与 `error` 都是失败，但原因不同（策略拦截 vs 模型/传输失败），文案分开；
 * - **未知分支一律判失败**：宁可误报一次失败，也不能把失败显示成 ✅。
 *   dsh 的词汇表是 merge-extensible 的，未来加分支时这里会立刻暴露成 ❌ + 未知原因，
 *   而不是静默变绿。
 */
export function describeTurnEnd(reason: TurnEndReasonLike | undefined): {
  readonly outcome: "done" | "failed" | "stopped";
  readonly reason?: string;
} {
  switch (reason?.kind) {
    case "completed":
      return { outcome: "done" };

    case "max-tokens":
      return { outcome: "done", reason: "输出达到模型上限，内容可能被截断" };

    case "aborted":
      return { outcome: "stopped", reason: describeCancelCause(reason.reason) };

    case "interrupted":
      return { outcome: "stopped", reason: "上一轮未正常结束（进程中断后恢复）" };

    case "blocked":
      return { outcome: "failed", reason: "本轮被策略拦截，未执行" };

    case "error": {
      const message = reason.error?.message?.trim() || "模型请求失败（未提供原因）";
      const code = reason.error?.code?.trim();
      return { outcome: "failed", reason: code ? `${message}（${code}）` : message };
    }

    // fork 种子构造时关闭的轮次，只会出现在 fork 出来的会话里，实时不会产生。
    case "forked":
      return { outcome: "stopped", reason: "该轮在 fork 边界被关闭" };

    default: {
      const kind = reason?.kind;
      return {
        outcome: "failed",
        reason: kind ? `未知的结束原因：${kind}` : "轮次结束但未提供原因",
      };
    }
  }
}

/** `aborted` 分支的取消原因 → 用户可读文案。 */
function describeCancelCause(cause: { readonly kind?: string; readonly reason?: string } | undefined): string {
  switch (cause?.kind) {
    case "user":
      return "已按你的请求中断";
    case "parent":
      return "已被父任务中断";
    case "hook":
      return cause.reason?.trim() ? `已被钩子中断：${cause.reason.trim()}` : "已被钩子中断";
    case "disposed":
      return "执行环境已释放";
    case "legacy":
      return "已中断";
    default:
      return "已中断";
  }
}

/* ------------------------------------------------------------------ *
 * 运行卡控制器
 * ------------------------------------------------------------------ */

export interface RunCardOptions {
  /** 出站目标（chatId + 可选 replyTo/threadId）。 */
  readonly target: OutboundTarget;
  /** 卡片标题（会话标题）。 */
  readonly title: string;
  /** 强停按钮的签名 token；缺省则不渲染按钮。 */
  readonly stopToken?: string;
  readonly footer?: string;
  /** 卡片更新节流（ms），默认 700（飞书限 10 次/秒）。 */
  readonly throttleMs?: number;
  readonly maxTextChars?: number;
  readonly maxToolBlocks?: number;
  /** 单卡正文上限（字符），超过则封卡翻页，默认 30000（官方元素上限）。 */
  readonly maxCardChars?: number;
  readonly now?: () => number;
}

const DEFAULT_THROTTLE_MS = 700;
const DEFAULT_MAX_CARD_CHARS = 30_000;

export class RunCard {
  private state: RunState;
  private messageId: string | undefined;
  /** 首卡的发送 Promise：所有 patch 都排在它之后，避免与 start 竞态。 */
  private startPromise: Promise<void> | undefined;
  private lastRenderedAt = Number.NEGATIVE_INFINITY;
  /** patch 串行链：保证卡片更新按事件顺序落地。 */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly port: CardPort,
    private readonly log: Logger,
    private readonly options: RunCardOptions,
  ) {
    this.state = initialRunState(this.now());
  }

  get currentState(): RunState {
    return this.state;
  }

  get currentMessageId(): string | undefined {
    return this.messageId;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** 发出首张运行卡。 */
  async start(): Promise<void> {
    this.startPromise ??= (async () => {
      this.messageId = await this.port.sendCard(this.options.target, this.buildCard());
      this.lastRenderedAt = this.now();
      this.log.debug("运行卡已发出", { messageId: this.messageId });
    })();
    await this.startPromise;
  }

  /**
   * 推进状态并按节流刷新卡片。
   *
   * 故意 fire-and-forget：调用方（事件监听）不应被飞书 API 阻塞；
   * 出错只记日志，不抛出（否则会污染宿主的事件分发）。
   *
   * 终态语义：进入终态即**关闭**（不再接受事件）并立刻刷新一次；
   * 随后的 `finish()` 只等这次刷新落地，不会重复 patch（飞书对卡更新有 10 次/秒限制）。
   */
  handle(event: RunEvent): void {
    if (this.closed) return;
    this.state = reduceRunState(this.state, event, this.now());
    if (isTerminal(this.state)) {
      this.closed = true;
      void this.flush();
      return;
    }
    if (!shouldRenderAfter(this.state, this.lastRenderedAt, this.throttleMs(), this.now())) return;
    void this.flush();
  }

  /** 终态强制刷新（幂等：已经因终态关闭时只等挂起的刷新落地）。 */
  async finish(): Promise<void> {
    if (this.closed) {
      await this.chain;
      return;
    }
    this.closed = true;
    await this.flush();
  }

  /** 等待所有排队中的 patch 落地（测试与卸载清理用）。 */
  async drain(): Promise<void> {
    await this.chain;
  }

  private throttleMs(): number {
    return this.options.throttleMs ?? DEFAULT_THROTTLE_MS;
  }

  /**
   * 排队一次卡片刷新。
   *
   * 关键：patch **必须**排在 `start()` 之后，且渲染发生在队列真正执行时 ——
   * 否则 start 尚未返回时 `messageId` 还是 undefined，会误判为"没发出去"而**补发第二张卡**
   * （M3b 首次真实联调的双卡 bug：一张 ⏳ 卡住、一张 ✅ 正常）。
   */
  private flush(): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        if (this.startPromise) await this.startPromise;
        const target = this.messageId;
        if (target === undefined) return; // 首卡都没发出去（start 失败），不补发
        await this.port.patchCard(target, this.buildCard());
        this.lastRenderedAt = this.now();
      })
      .catch((error: unknown) => {
        this.log.warn("运行卡更新失败（不影响会话执行）", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    return this.chain;
  }

  private buildCard(): object {
    const markdown = renderRunMarkdown(this.state, {
      ...(this.options.footer ? { footer: this.options.footer } : {}),
      ...(this.options.maxTextChars !== undefined ? { maxTextChars: this.options.maxTextChars } : {}),
      ...(this.options.maxToolBlocks !== undefined ? { maxToolBlocks: this.options.maxToolBlocks } : {}),
    });
    const card = buildRunCard({
      // 标题（含状态图标）只出现在 header；正文不再重复（见 run-renderer 的说明）。
      title: runCardTitle(this.options.title, this.state.status),
      markdown,
      status: this.state.status,
      ...(this.options.footer ? { footer: this.options.footer } : {}),
      // 终态不再渲染强停按钮（点了也没有意义）。
      ...(this.options.stopToken && this.state.status === "running"
        ? { stop: { token: this.options.stopToken } }
        : {}),
    });
    return enforceCardLimits(card);
  }

  /** 单卡正文是否已逼近元素上限（调用方据此决定是否封卡翻页）。 */
  isNearElementLimit(): boolean {
    const limit = this.options.maxCardChars ?? DEFAULT_MAX_CARD_CHARS;
    return renderRunMarkdown(this.state, {}).length >= limit;
  }
}
