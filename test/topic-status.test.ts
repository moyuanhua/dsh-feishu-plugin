/**
 * 话题根卡状态规格。
 *
 * 上游对应物是内存状态机 `TopicStatusMachine`；我们把它写成**会话事件的纯函数**，
 * 因此这里可以逐事件、逐档位断言。重点是**优先级**：
 * 待审核 > 运行中 > 待回复 > 失败/中断 > 完成。
 */
import { describe, expect, test } from "vitest";
import {
  dominantPhase,
  INITIAL_TOPIC_STATUS,
  reduceTopicStatus,
  topicStatusView,
  type TopicStatusState,
} from "../src/bridge/topic-status.js";

/**
 * **必须用本地时间构造**：`topicStatusView` 用 `getHours()` 渲染"本地时钟"，
 * 若这里写死 `+08:00` 再断言 `14:03`，在 UTC 的 CI 上会变成 `06:03`
 * （本地是 Asia/Shanghai 所以一直没暴露）。
 */
const NOW = new Date(2026, 9, 5, 14, 3, 0).getTime();

/** 把若干事件折叠成状态。 */
function fold(events: readonly unknown[], from: TopicStatusState = INITIAL_TOPIC_STATUS): TopicStatusState {
  return events.reduce<TopicStatusState>(
    (state, event) => reduceTopicStatus(state, event as never),
    from,
  );
}

describe("reduceTopicStatus", () => {
  test("turn/start → 运行中", () => {
    expect(fold([{ type: "turn/start" }]).running).toBe(true);
  });

  test("turn/end 各种 reason → 正确的终态", () => {
    const cases: readonly [string, TopicStatusState["lastTerminal"]][] = [
      ["completed", "done"],
      ["max-tokens", "done"],
      ["error", "failed"],
      ["blocked", "failed"],
      ["aborted", "interrupted"],
      ["interrupted", "interrupted"],
      ["forked", "interrupted"],
    ];
    for (const [kind, expected] of cases) {
      const state = fold([{ type: "turn/start" }, { type: "turn/end", data: { reason: { kind } } }]);
      expect(state.running, kind).toBe(false);
      expect(state.lastTerminal, kind).toBe(expected);
    }
  });

  test("未知 reason 当作完成（不把根卡永远卡在失败）", () => {
    expect(fold([{ type: "turn/end", data: { reason: { kind: "brand-new" } } }]).lastTerminal).toBe("done");
    expect(fold([{ type: "turn/end" }]).lastTerminal).toBe("done");
  });

  test("approval/asked 记录工具名，approval/decided 清空", () => {
    const asked = fold([{ type: "approval/asked", data: { toolName: "shell" } }]);
    expect(asked.review).toBe("shell");
    expect(fold([{ type: "approval/decided" }], asked).review).toBeUndefined();
  });

  test("没有待批时 approval/decided 不改状态（返回原引用）", () => {
    const state = fold([{ type: "turn/start" }]);
    expect(reduceTopicStatus(state, { type: "approval/decided" })).toBe(state);
  });

  test("approval/asked 缺工具名也成立（页脚显示不带名字的「待审核」）", () => {
    expect(fold([{ type: "approval/asked" }]).review).toBe("");
  });

  test("inbox 插入累加排队数，领取/删除递减，且不为负", () => {
    const one = fold([{ type: "agent/inbox/spliced", data: { inserted: [{}] } }]);
    expect(one.queued).toBe(1);
    const three = fold([{ type: "agent/inbox/spliced", data: { inserted: [{}, {}] } }], one);
    expect(three.queued).toBe(3);
    const claimed = fold([{ type: "agent/inbox/spliced", data: { removedCount: 1 } }], three);
    expect(claimed.queued).toBe(2);
    const over = fold([{ type: "agent/inbox/spliced", data: { removedCount: 99 } }], three);
    expect(over.queued).toBe(0);
  });

  test("outcome=canceled 的 splice 只递减", () => {
    const two = fold([{ type: "agent/inbox/spliced", data: { inserted: [{}, {}] } }]);
    const canceled = reduceTopicStatus(two, {
      type: "agent/inbox/spliced",
      data: { inserted: [{}, {}], removedCount: 1, outcome: "canceled" },
    } as never);
    expect(canceled.queued).toBe(1);
  });

  test("未知事件原样返回", () => {
    const state = fold([{ type: "turn/start" }]);
    expect(reduceTopicStatus(state, { type: "tool/call" })).toBe(state);
    expect(reduceTopicStatus(state, {})).toBe(state);
  });
});

describe("dominantPhase（优先级）", () => {
  const running = { running: true, queued: 0, lastTerminal: "done" } as const;

  test("待审核 > 运行中", () => {
    expect(dominantPhase({ ...running, review: "shell" })).toBe("review");
  });
  test("运行中 > 待回复", () => {
    expect(dominantPhase({ ...running, queued: 3 })).toBe("running");
  });
  test("待回复 > 失败", () => {
    expect(dominantPhase({ running: false, queued: 1, lastTerminal: "failed" })).toBe("pending");
  });
  test("失败 > 完成", () => {
    expect(dominantPhase({ running: false, queued: 0, lastTerminal: "failed" })).toBe("failed");
  });
  test("空闲且最近完成 → done", () => {
    expect(dominantPhase(INITIAL_TOPIC_STATUS)).toBe("done");
  });
});

describe("topicStatusView", () => {
  const cases: readonly [TopicStatusState, string, string, string][] = [
    [{ running: false, queued: 0, review: "shell" }, "🟡", "orange", "🟡 待审核：shell"],
    [{ running: false, queued: 0, review: "" }, "🟡", "orange", "🟡 待审核"],
    [{ running: true, queued: 0 }, "🧠", "blue", "🧠 运行中 · 14:03"],
    [{ running: false, queued: 2, lastTerminal: "done" }, "⏳", "grey", "⏳ 待回复（排队 2）"],
    [{ running: false, queued: 0, lastTerminal: "failed" }, "🔴", "red", "🔴 失败"],
    [{ running: false, queued: 0, lastTerminal: "interrupted" }, "⏹", "grey", "⏹ 已中断"],
    [{ running: false, queued: 0, lastTerminal: "done" }, "✅", "green", "✅ 完成"],
  ];

  for (const [state, emoji, color, footer] of cases) {
    test(`${footer} 的图标/颜色/页脚`, () => {
      const view = topicStatusView(state as TopicStatusState, NOW);
      expect(view.emoji).toBe(emoji);
      expect(view.color).toBe(color);
      expect(view.footer).toBe(footer);
    });
  }

  test("时钟补零", () => {
    const at = new Date(2026, 9, 5, 9, 5, 0).getTime();
    expect(topicStatusView({ running: true, queued: 0 }, at).footer).toBe("🧠 运行中 · 09:05");
  });
});
