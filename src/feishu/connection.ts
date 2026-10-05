/**
 * 长连接 supervisor：世代化 + 有界指数退避 + dispose 收敛。
 *
 * 范式参考官方 `@deepseek-ai/dsh-mcp-client` 的 `src/connection.ts`（官方仓库里
 * 唯一"插件内维持外部长连接并在断开后重连"的成熟写法）：
 *   · 连接生命周期绑在插件的 `ctx.effect` 上（由调用方负责）；
 *   · 每次尝试带**世代号**，过期回调一律丢弃，避免旧尝试把新状态改回去；
 *   · 失败按指数退避重试，达到上限后进入 `failed` 并停止（不静默）；
 *   · `stop()` 先让世代失效、清掉定时器，再等 in-flight 收敛，最后才 disconnect。
 *
 * 注意（dsh 与 opencode 的关键差异）：dsh **没有** location 空闲回收，
 * 插件与宿主进程同寿，因此这里不需要 opencode 那套 keepalive 探针/网关选举。
 */
import type { Logger } from "../types.js";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "backoff"
  | "failed"
  | "stopped";

export interface ConnectionStateDetail {
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly reason?: string;
}

export interface BackoffPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor: number;
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  initialMs: 500,
  maxMs: 30_000,
  factor: 2,
  maxAttempts: 10,
};

export interface TimerHandle {
  cancel(): void;
}

export interface ConnectionDeps {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onState?: (state: ConnectionState, detail?: ConnectionStateDetail) => void;
  log?: Logger;
  backoff?: Partial<BackoffPolicy>;
  /** 可注入定时器，便于单测（默认 setTimeout + unref）。 */
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
}

function defaultSetTimer(callback: () => void, delayMs: number): TimerHandle {
  const timer = setTimeout(callback, delayMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    cancel: () => clearTimeout(timer),
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class ConnectionSupervisor {
  private readonly backoff: BackoffPolicy;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private stateValue: ConnectionState = "idle";
  private generation = 0;
  private running = false;
  private attempts = 0;
  private timer?: TimerHandle;
  private inFlight?: Promise<void>;

  constructor(private readonly deps: ConnectionDeps) {
    this.backoff = { ...DEFAULT_BACKOFF, ...deps.backoff };
    this.setTimer = deps.setTimer ?? defaultSetTimer;
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  /** 当前世代号；每次 start/stop 递增，用于丢弃过期回调。 */
  get currentGeneration(): number {
    return this.generation;
  }

  get attemptCount(): number {
    return this.attempts;
  }

  /** 启动（幂等）。连接失败不会抛错，而是进入退避/失败状态。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    const generation = ++this.generation;
    this.setState("connecting", { attempt: 0 });
    this.inFlight = this.attempt(generation);
  }

  /** 停止：让世代失效 → 清定时器 → 等 in-flight → 断开连接。 */
  async stop(): Promise<void> {
    if (!this.running && this.stateValue === "stopped") return;
    this.running = false;
    this.generation += 1;
    this.timer?.cancel();
    this.timer = undefined;
    const pending = this.inFlight;
    this.setState("stopped");
    if (pending) {
      try {
        await pending;
      } catch {
        /* attempt 内部已自行收敛，不向上抛 */
      }
    }
    try {
      await this.deps.disconnect();
    } catch (error) {
      this.deps.log?.warn("断开飞书长连接失败", { reason: messageOf(error) });
    }
  }

  /** SDK 报"正在重连"（WS 断开、SDK 自行恢复中）。 */
  noteReconnecting(): void {
    if (!this.running) return;
    this.setState("reconnecting");
  }

  /** SDK 报"已重连"：重置退避预算并标记连接可用。 */
  noteReconnected(): void {
    if (!this.running) return;
    this.attempts = 0;
    this.setState("connected");
  }

  private async attempt(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    try {
      await this.deps.connect();
      if (generation !== this.generation) return;
      this.attempts = 0;
      this.setState("connected");
      this.deps.log?.info("飞书长连接已建立");
    } catch (error) {
      if (generation !== this.generation) return;
      this.scheduleRetry(generation, messageOf(error));
    }
  }

  private scheduleRetry(generation: number, reason: string): void {
    if (this.attempts >= this.backoff.maxAttempts) {
      this.running = false;
      this.setState("failed", { attempt: this.attempts, reason });
      this.deps.log?.error("飞书长连接重试预算耗尽，已放弃", { attempts: this.attempts, reason });
      return;
    }
    const delayMs = Math.min(this.backoff.initialMs * this.backoff.factor ** this.attempts, this.backoff.maxMs);
    this.attempts += 1;
    this.setState("backoff", { attempt: this.attempts, delayMs, reason });
    this.deps.log?.warn("飞书长连接失败，稍后重试", { attempt: this.attempts, delayMs, reason });
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (generation !== this.generation) return;
      this.setState("connecting", { attempt: this.attempts });
      this.inFlight = this.attempt(generation);
    }, delayMs);
  }

  private setState(state: ConnectionState, detail?: ConnectionStateDetail): void {
    this.stateValue = state;
    this.deps.onState?.(state, detail);
  }
}
