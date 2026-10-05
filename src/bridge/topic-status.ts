/**
 * 话题根卡状态（**纯状态机 + 渲染**）。
 *
 * 一个飞书话题 = 一个 dsh 会话；话题根卡要反映"这个会话现在在干什么"。
 * 表达方式沿用上游（`src/session/topic-status.ts`）：**默认不改标题**（避免侧栏话题名抖动），
 * 只用 header 颜色 + 页脚一行。
 *
 * 与上游的关键差异：上游用一个内存 `TopicStatusMachine`，**重启即丢**；
 * 我们把它写成"会话事件的纯函数"，由 `sessionProjections` 注册成单元 ——
 * 于是持久化和冷读重建都由框架负责（`session-projection-cache` 已挂载）。
 *
 * 状态不存"当前档位"，而存**若干事实**，档位由优先级推导：
 * 待审核 > 运行中 > 待回复 > 失败/中断 > 完成。
 * "待审核"压过"运行中"，是为了先把用户拉去点审批。
 */

/** 话题工作状态档位。 */
export type TopicPhase = "review" | "running" | "pending" | "failed" | "interrupted" | "done";

/** 状态里的事实（由事件折叠而来）。 */
export interface TopicStatusState {
  /** 有未结束的轮次。 */
  readonly running: boolean;
  /** 有未答复的审批请求；值是工具名（用于页脚「待审核：shell」）。 */
  readonly review?: string;
  /** 待投递的排队消息数。 */
  readonly queued: number;
  /** 最近一次终态（没有运行中的轮次时显示）。 */
  readonly lastTerminal?: "failed" | "interrupted" | "done";
}

export const INITIAL_TOPIC_STATUS: TopicStatusState = {
  running: false,
  queued: 0,
  lastTerminal: "done",
};

/** 折叠用的最小事件形状（结构类型，便于单测直接构造）。 */
export interface TopicStatusEventLike {
  readonly type?: string;
  readonly data?: {
    readonly reason?: {
      readonly kind?: string;
      readonly error?: { readonly message?: string };
    };
    readonly toolName?: string;
    readonly id?: unknown;
    readonly inserted?: readonly unknown[];
    readonly removedCount?: number;
    readonly outcome?: string;
  };
}

/** 由 `TurnEndReason.kind` 决定终态（与运行卡口径一致）。 */
function terminalOf(kind: string | undefined): "failed" | "interrupted" | "done" {
  switch (kind) {
    case "error":
    case "blocked":
      return "failed";
    case "aborted":
    case "interrupted":
    case "forked":
      return "interrupted";
    default:
      return "done";
  }
}

/**
 * 一个会话事件 → 下一个状态。**纯函数**，未知事件原样返回。
 *
 * 注意：这里只关心"根卡怎么显示"，因此不区分 `completed` 与 `max-tokens`
 * （两者都是"跑完了"）；细节由运行卡承担。
 */
export function reduceTopicStatus(
  state: TopicStatusState,
  event: TopicStatusEventLike,
): TopicStatusState {
  switch (event.type) {
    case "turn/start":
      return { ...state, running: true };

    case "turn/end": {
      const terminal = terminalOf(event.data?.reason?.kind);
      return { ...state, running: false, lastTerminal: terminal };
    }

    case "approval/asked": {
      const tool = event.data?.toolName;
      return { ...state, review: typeof tool === "string" && tool ? tool : "" };
    }

    case "approval/decided":
      if (state.review === undefined) return state;
      return { ...state, review: undefined };

    case "agent/inbox/spliced": {
      const added = Array.isArray(event.data?.inserted) ? event.data!.inserted!.length : 0;
      const removed = typeof event.data?.removedCount === "number" ? event.data.removedCount : 0;
      // 取消的插入不排队（outcome: 'canceled' 表示这批是撤回，不是新增待办）。
      const delta = event.data?.outcome === "canceled" ? -removed : added - removed;
      const queued = Math.max(0, state.queued + delta);
      return queued === state.queued ? state : { ...state, queued };
    }

    default:
      return state;
  }
}

/** 按优先级把事实折算成档位。 */
export function dominantPhase(state: TopicStatusState): TopicPhase {
  if (state.review !== undefined) return "review";
  if (state.running) return "running";
  if (state.queued > 0) return "pending";
  return state.lastTerminal ?? "done";
}

export interface TopicStatusView {
  readonly phase: TopicPhase;
  readonly emoji: string;
  /** 卡片 header 主题色。 */
  readonly color: "blue" | "orange" | "grey" | "red" | "green";
  readonly label: string;
  /** 页脚一行（`review` 时带工具名，`pending` 时带排队数）。 */
  readonly footer: string;
}

const PALETTE: Record<TopicPhase, { emoji: string; color: TopicStatusView["color"]; label: string }> = {
  review: { emoji: "🟡", color: "orange", label: "待审核" },
  running: { emoji: "🧠", color: "blue", label: "运行中" },
  pending: { emoji: "⏳", color: "grey", label: "待回复" },
  failed: { emoji: "🔴", color: "red", label: "失败" },
  interrupted: { emoji: "⏹", color: "grey", label: "已中断" },
  done: { emoji: "✅", color: "green", label: "完成" },
};

function clock(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 渲染档位 → emoji / 颜色 / 页脚。时间由调用方注入，保证可断言。 */
export function topicStatusView(state: TopicStatusState, now: number): TopicStatusView {
  const phase = dominantPhase(state);
  const base = PALETTE[phase];
  switch (phase) {
    case "review":
      return { ...base, phase, footer: state.review ? `🟡 待审核：${state.review}` : "🟡 待审核" };
    case "running":
      return { ...base, phase, footer: `🧠 运行中 · ${clock(now)}` };
    case "pending":
      return { ...base, phase, footer: `⏳ 待回复（排队 ${state.queued}）` };
    case "failed":
      return { ...base, phase, footer: "🔴 失败" };
    case "interrupted":
      return { ...base, phase, footer: "⏹ 已中断" };
    default:
      return { ...base, phase, footer: "✅ 完成" };
  }
}
