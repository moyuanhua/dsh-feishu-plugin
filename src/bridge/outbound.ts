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
import { renderRunMarkdown, shouldRenderAfter } from "./run-renderer.js";
import type { Logger } from "../types.js";

/** 出站端口：由飞书通道实现（`channel.send({card})` / `channel.updateCard`）。 */
export interface CardPort {
  /** 发一张新卡片，返回 messageId。 */
  sendCard(chatId: string, card: object): Promise<string>;
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
    readonly error?: { readonly reason?: string };
    readonly message?: {
      readonly isError?: boolean;
      readonly content?: readonly { readonly type?: string; readonly text?: string }[];
    };
    readonly stream?: readonly { readonly chunk?: { readonly type?: string; readonly text?: string } }[];
    readonly reason?: { readonly kind?: string };
  };
  // —— 平铺兼容（单测/未来版本） ——
  readonly name?: string;
  readonly error?: { readonly reason?: string };
  readonly message?: {
    readonly isError?: boolean;
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  };
  readonly stream?: readonly { readonly chunk?: { readonly type?: string; readonly text?: string } }[];
  readonly reason?: { readonly kind?: string };
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
    case "turn/end":
      return { type: "turn-end", outcome: mapTurnOutcome(payload.reason?.kind) };
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

function mapTurnOutcome(kind: string | undefined): "done" | "failed" | "stopped" {
  switch (kind) {
    case "aborted":
      return "stopped";
    case "blocked":
      return "failed";
    default:
      return "done";
  }
}

/* ------------------------------------------------------------------ *
 * 运行卡控制器
 * ------------------------------------------------------------------ */

export interface RunCardOptions {
  readonly chatId: string;
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
      this.messageId = await this.port.sendCard(this.options.chatId, this.buildCard());
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
      title: this.options.title,
      ...(this.options.footer ? { footer: this.options.footer } : {}),
      ...(this.options.maxTextChars !== undefined ? { maxTextChars: this.options.maxTextChars } : {}),
      ...(this.options.maxToolBlocks !== undefined ? { maxToolBlocks: this.options.maxToolBlocks } : {}),
    });
    const card = buildRunCard({
      title: this.options.title,
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
    return renderRunMarkdown(this.state, { title: this.options.title }).length >= limit;
  }
}
