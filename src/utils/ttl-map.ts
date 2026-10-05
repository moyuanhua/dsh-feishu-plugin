/**
 * 带 TTL 的 Map，用于去重 / 回调 token 防重放 / 待批请求跟踪。
 *
 * 不依赖定时器即可工作（惰性过期），定时器仅用于主动清理。`now` 可注入，方便单测。
 *
 * 移植来源：opencode-feishu-plugin（MIT，Copyright (c) 2026 moyuanhua）
 * 原文件：src/utils/ttl-map.ts（逐行搬运，未改逻辑）
 */
export class TtlMap<V> {
  private readonly data = new Map<string, { value: V; expiresAt: number }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly defaultTtlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): V | undefined {
    const hit = this.data.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    return hit.value;
  }

  has(key: string): boolean {
    const hit = this.data.get(key);
    if (!hit) return false;
    if (hit.expiresAt <= this.now()) {
      this.delete(key);
      return false;
    }
    return true;
  }

  set(key: string, value: V, ttlMs?: number): void {
    this.delete(key);
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.data.set(key, { value, expiresAt: this.now() + ttl });
    const timer = setTimeout(() => {
      this.data.delete(key);
      this.timers.delete(key);
    }, ttl);
    // 不要让定时器阻止进程退出。
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(key, timer);
  }

  /** 首次 set 返回 true（此前不存在或已过期）；已存在且未过期返回 false。 */
  setIfAbsent(key: string, value: V, ttlMs?: number): boolean {
    if (this.has(key)) return false;
    this.set(key, value, ttlMs);
    return true;
  }

  delete(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.data.delete(key);
  }

  /** 遍历未过期条目（惰性清理已过期项；用于按会话反查 pending 状态）。 */
  entries(): Array<[string, V]> {
    const out: Array<[string, V]> = [];
    for (const [key, hit] of this.data) {
      if (hit.expiresAt <= this.now()) {
        this.delete(key);
        continue;
      }
      out.push([key, hit.value]);
    }
    return out;
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.data.clear();
  }

  /**
   * 未过期条目数。
   *
   * 与 `entries()` 用同一套语义（顺便惰性清理）—— 旧实现直接返回底层 Map 的大小，
   * 会把已过期的项算进去，于是"看 size 以为没泄漏"与"get 拿不到"互相矛盾。
   * 这些都是小表，O(n) 可接受。
   */
  get size(): number {
    return this.entries().length;
  }
}
