/**
 * 本插件跨模块共享的类型。
 *
 * 刻意不 import 任何 `@deepseek-ai/dsh-*` 包：宿主接缝用**结构类型**描述，
 * 这样内核（配置 / 安全 / 决策）可以在没有 dsh 运行时的环境里单测，
 * 也避免在接缝尚未稳定时被上游类型绑死（真实类型引用集中在 src/dsh/ 一处）。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** 最小持久化视图：与 dsh `ctx.storageDomain` / 存储表单对接时由适配层实现。 */
export interface StorageLike {
  get(key: string): Promise<unknown> | unknown;
  set(key: string, value: unknown): Promise<void> | void;
  remove?(key: string): Promise<void> | void;
}

export interface MemoryStorageOptions {
  readonly initial?: Record<string, unknown>;
}

/** 内存实现：单测与"没有 storage 服务"的降级路径使用。 */
export class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, unknown>();

  constructor(options: MemoryStorageOptions = {}) {
    for (const [key, value] of Object.entries(options.initial ?? {})) this.data.set(key, value);
  }

  get(key: string): unknown {
    return this.data.get(key);
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  remove(key: string): void {
    this.data.delete(key);
  }
}

/** agent 面：只声明本插件用到的方法（M3 起接真实 `ctx.agents` 句柄）。 */
export interface AgentLike {
  followup(message: unknown): unknown;
  steer(message: unknown): unknown;
  inject(message: unknown): unknown;
  cancel(cause: unknown, options?: unknown): unknown;
}

/**
 * 桥接所需的宿主端口。由 `src/dsh/port.ts` 用真实 ctx 实现；
 * 单测用假实现，因此决策逻辑不需要 dsh 运行时。
 */
export interface HostPort {
  readonly log: Logger;
  /** 构造一条 `role: 'user'` 消息（真实实现 = `@deepseek-ai/dsh-llm` 的 createUserMessage）。 */
  createUserMessage(input: { readonly text: string; readonly source: MessageSource }): unknown;
  /** 按 sessionId 取回（必要时恢复）agent。 */
  resolveAgent(sessionId: string): Promise<AgentLike | undefined> | AgentLike | undefined;
}

/** 消息来源标记：桥声明自己的 kind，便于会话历史里区分来源。 */
export interface MessageSource {
  readonly kind: "feishu";
  /** 发送者 open_id（日志里只留前 8 位）。 */
  readonly senderId?: string;
  /** 飞书 chat id。 */
  readonly chatId?: string;
  /** 飞书 message id。 */
  readonly messageId?: string;
}

/** cordis ctx 的最小结构视图：只列本插件真正会用到的成员。 */
export interface DshContext {
  logger(name: string): Logger;
  /** 注册随插件卸载自动清理的资源。 */
  effect(callback: () => void | (() => void | Promise<void>)): () => void;
  /** 订阅宿主事件（返回取消订阅函数）。 */
  on(event: string, listener: (...args: never[]) => unknown): () => void;
  /** 取宿主服务；缺失时返回 undefined（可选依赖用）。 */
  get?(name: string): unknown;
}
