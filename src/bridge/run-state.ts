/**
 * 运行卡片状态机（**纯 reducer**，无 IO、无定时器、可单测）。
 *
 * 一张「运行卡片」对应一条飞书入站消息触发的完整回合：
 *
 *   已收到 → 工具调用块 → 流式正文 → 完成 / 失败 / 被强停
 *
 * 设计要点：
 * - 状态只由事件驱动，`reduceRunState(state, event, now)` 是不可变更新（永远返回新对象，
 *   绝不改入参），因此可以单测、回放，也便于调用方按引用判断是否需要重新渲染；
 * - 正文只有一个 `text` 字段（当前 step 的流式累加）。`assistant-message` 是**持久结算**的
 *   权威全文，直接**覆盖** `text`，所以不会出现「流式累加 + 结算全文」首尾拼接重复；
 * - 工具块按**事件顺序**入列，`tool-end` 只认「最后一个同名且仍在 running 的块」：
 *   同名工具并发调用各算一块、各自配对；没有对应 running 块的 `tool-end`（乱序/迟到/重复）
 *   一律忽略，不凭空造块；
 * - 时间戳只用于页脚耗时，全部由调用方注入 `now`，reducer 本身不读时钟。
 *
 * 移植来源：opencode-feishu-plugin（MIT，Copyright (c) 2026 moyuanhua）
 * 原文件：src/feishu/run-state.ts
 * 适配说明：上游 reducer 直接消费 opencode 的 SSE 事件名
 * （`session.tool.input.started` / `session.text.delta` / `session.execution.*` 等），
 * 状态里存的是**交错的块列表**（text/tool 交替 + 流式标记 + 页脚枚举 + 排队 + 最终正文分离），
 * 并通过 `assistantMessageID` 区分 step。那套形状与本仓库 dsh 侧的事件接缝无关，
 * 因此这里只保留「纯状态机」这一宿主无关内核，事件收敛为中立形状：
 *   · 去掉 `assistantMessageID` 分 step：本仓库一个回合只结算一次，正文用单个 `text` 字段累加；
 *   · 去掉排队（queued）/ 页脚枚举 / `finalSeparated` 等**渲染态**字段，改由渲染器按 status 推导；
 *   · 工具块不再按 opencode 的 tool call id 归并，改为「名称 + 事件顺序」配对（见上）；
 *   · reducer 显式接收 `now`，时间源由调用方掌握。
 */

export type RunStatus = "running" | "done" | "failed" | "stopped";

export type RunBlock =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly status: "running" | "ok" | "error";
      readonly detail?: string;
    };

/** 工具块（`RunBlock` 的工具分支），仅内部使用，结构与对外契约一致。 */
type RunToolBlock = Extract<RunBlock, { kind: "tool" }>;

export interface RunState {
  /** 当前 step 的模型正文（流式累加）。 */
  readonly text: string;
  /** 已完成的工具块（按发生顺序）。 */
  readonly tools: readonly RunToolBlock[];
  readonly status: RunStatus;
  /** 首个事件时间（ms），用于页脚耗时。 */
  readonly startedAt: number;
  /** 最后一次事件时间（ms）。 */
  readonly updatedAt: number;
  /** 失败/停止原因（一句话，可为空）。 */
  readonly reason?: string;
}

/**
 * 中立事件：dsh 侧的事件映射由别的模块负责，这里只定义状态机消费的形状。
 * `assistant-message` 是持久结算（完整文本，权威值），`text-delta` 是流式增量。
 */
export type RunEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "assistant-message"; readonly text: string }
  | { readonly type: "tool-start"; readonly name: string }
  | { readonly type: "tool-end"; readonly name: string; readonly ok: boolean; readonly detail?: string }
  | { readonly type: "turn-end"; readonly outcome: "done" | "failed" | "stopped"; readonly reason?: string };

export function initialRunState(now: number): RunState {
  return { text: "", tools: [], status: "running", startedAt: now, updatedAt: now };
}

/** 终态（done / failed / stopped）后不再有「运行中」语义。 */
export function isTerminal(state: RunState): boolean {
  return state.status !== "running";
}

/** 最后一个「同名且仍在 running」的工具块下标；没有则 -1。 */
function lastRunningToolIndex(tools: readonly RunToolBlock[], name: string): number {
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const tool = tools[i];
    if (tool && tool.name === name && tool.status === "running") return i;
  }
  return -1;
}

/**
 * 纯 reducer：所有分支都返回**新对象**（不存在"未变化就返回原引用"的捷径，
 * 因为任何事件都会刷新 `updatedAt`）。调用方负责按节流决定是否真的 patch 卡片。
 */
export function reduceRunState(state: RunState, event: RunEvent, now: number): RunState {
  switch (event.type) {
    case "text-delta": {
      // 空增量只刷新心跳时间，不制造无意义的字符。
      if (event.text.length === 0) return { ...state, updatedAt: now };
      return { ...state, text: state.text + event.text, updatedAt: now };
    }

    case "assistant-message":
      // 持久结算是权威全文 → 覆盖（追加会与流式累加重复）。
      return { ...state, text: event.text, updatedAt: now };

    case "tool-start": {
      const tool: RunToolBlock = { kind: "tool", name: event.name, status: "running" };
      return { ...state, tools: [...state.tools, tool], updatedAt: now };
    }

    case "tool-end": {
      const index = lastRunningToolIndex(state.tools, event.name);
      // 没有对应 running 块：忽略事件本身，但仍刷新 updatedAt（见文件头说明）。
      if (index < 0) return { ...state, updatedAt: now };
      const tools = state.tools.map((tool, i) =>
        i === index
          ? {
              ...tool,
              status: event.ok ? ("ok" as const) : ("error" as const),
              ...(event.detail === undefined ? {} : { detail: event.detail }),
            }
          : tool,
      );
      return { ...state, tools, updatedAt: now };
    }

    case "turn-end": {
      // 幂等：已是终态时状态与已有 reason 都不被覆盖，只在原来没有 reason 时补一个，
      // 避免迟到的 turn-end 把「被打断」洗成「正常完成」。
      if (isTerminal(state)) {
        if (state.reason === undefined && event.reason !== undefined) {
          return { ...state, reason: event.reason, updatedAt: now };
        }
        return { ...state, updatedAt: now };
      }
      return {
        ...state,
        status: event.outcome,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        updatedAt: now,
      };
    }

    default:
      // 事件是封闭联合，这里只在运行时遇到未知 shape 时兜底；不改变语义。
      return { ...state, updatedAt: now };
  }
}
