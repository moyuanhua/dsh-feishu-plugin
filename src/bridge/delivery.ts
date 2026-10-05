/**
 * 投递决策与执行态跟踪（纯逻辑，可单测）。
 *
 * **逻辑来源**：opencode-feishu-plugin `src/feishu/delivery.ts`（MIT，Copyright (c) 2026 moyuanhua），
 * 逐行搬运判定语义。上游的 `delivery` 词表是 `steer | queue`，含义：
 * - `steer`：立即投递（会打断/插入当前执行）；
 * - `queue`：排到当前执行之后。
 *
 * dsh 侧映射（由 `src/bridge/inbound.ts` 的 `applyDelivery` 完成）：
 * - `steer` → `agent.steer(message)`（提交到最近 step，空闲则起一轮）
 * - `queue` → `agent.followup(message)`（排队到下一轮并唤醒驱动器）
 *
 * 是否排队只看「该 session 是否有正在跑的 execution」。上游的权威来源有两类
 * （durable `session.execution.*` + 瞬时 `session.status`）；dsh 对应
 * `agent/status` 与 `agent/inbox/{inserted,claimed,discarded}`、`agent/turn-stopping`，
 * 由调用方（`src/index.ts`）维护后喂给本模块的 `ExecutionTracker`。
 */

export type Delivery = "steer" | "queue";

/**
 * 排队决策：空闲 → `steer`（直接执行）；忙时按 `busyDelivery` 偏好：
 * - `busyDelivery="steer"`（默认）：新消息**立即插队**，打断当前步骤优先执行；
 * - `busyDelivery="queue"`：原生排队，等当前步骤结束后处理（更温和，适合长命令场景）。
 */
export function decideDelivery(running: boolean, busyDelivery: Delivery = "queue"): Delivery {
  return running ? busyDelivery : "steer";
}

export class ExecutionTracker {
  /** sessionID → 最近一次活动时间戳（ms）。 */
  private readonly running = new Map<string, number>();

  markStarted(sessionID: string, now: number = Date.now()): void {
    if (sessionID) this.running.set(sessionID, now);
  }

  /** 收到该 session 的任意事件时刷新活动时间，避免看门狗误杀长任务。 */
  touch(sessionID: string, now: number = Date.now()): void {
    if (sessionID && this.running.has(sessionID)) this.running.set(sessionID, now);
  }

  markEnded(sessionID: string): void {
    this.running.delete(sessionID);
  }

  isRunning(sessionID: string): boolean {
    return this.running.has(sessionID);
  }

  /**
   * 返回「正在跑但超过 maxIdleMs 无任何活动」的 sessionID，并将其从运行态移除。
   * 用于看门狗：事件丢失或交互工具（question/permission）永久挂起时兜底放开排队。
   *
   * `shouldSkip` 返回 true 的会话视为**合法等待**（如待答表单 / 未决审批）：
   * 既不返回、也不移出运行态（避免在等待期被误杀，也避免丢追踪导致后续排队判定失真）。
   */
  stale(maxIdleMs: number, now: number = Date.now(), shouldSkip?: (sessionID: string) => boolean): string[] {
    const out: string[] = [];
    for (const [sessionID, at] of this.running) {
      if (now - at < maxIdleMs) continue;
      if (shouldSkip?.(sessionID)) continue;
      this.running.delete(sessionID);
      out.push(sessionID);
    }
    return out;
  }

  clear(): void {
    this.running.clear();
  }
}

/**
 * 子会话 → 父会话映射（看门狗判活用）。
 *
 * 上游背景（issue #1）：`task` 子代理跑在**子会话**里，其事件只带子会话 ID；
 * 父会话（飞书绑定会话）在子会话整个运行期间收不到任何活动 → 超过
 * `staleExecutionMs` 会被看门狗误判为卡死并强杀（子代理工作一并作废）。
 * 修复：从 `session.created` 的 `parentID` 维护链路，任意事件触达某个会话时，
 * 沿父链逐级刷新活动时间（`walk` + `ExecutionTracker.touch`）。
 *
 * dsh 侧对应：`agent/created` 的父子关系（`ctx.agents.isOwnedBy` / 会话 `parentSession`）。
 */
export class SessionParentLinks {
  private readonly parents = new Map<string, string>();

  constructor(private readonly maxEntries = 2000) {}

  /** 登记/清理某会话的父链接（无 parentID = 顶级会话，清掉旧链接）。 */
  remember(sessionID: string, parentID: string | undefined): void {
    if (!sessionID) return;
    if (!parentID) {
      this.parents.delete(sessionID);
      return;
    }
    // 重新插入以刷新 LRU 顺序；超上限时淘汰最旧条目（防长期运行泄漏）。
    this.parents.delete(sessionID);
    this.parents.set(sessionID, parentID);
    while (this.parents.size > this.maxEntries) {
      const oldest = this.parents.keys().next().value;
      if (oldest === undefined) break;
      this.parents.delete(oldest);
    }
  }

  parentOf(sessionID: string): string | undefined {
    return this.parents.get(sessionID);
  }

  /** 沿父链逐级回调（含自身；防环 + 深度上限）。 */
  walk(sessionID: string, visit: (id: string) => void): void {
    let current: string | undefined = sessionID;
    const seen = new Set<string>();
    for (let depth = 0; current && depth < 16 && !seen.has(current); depth += 1) {
      seen.add(current);
      visit(current);
      current = this.parents.get(current);
    }
  }
}
