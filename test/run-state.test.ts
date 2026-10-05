import { describe, expect, test } from "vitest";
import {
  initialRunState,
  isTerminal,
  reduceRunState,
  type RunEvent,
  type RunState,
} from "../src/bridge/run-state.js";

const T0 = 1_700_000_000_000;

/** 深冻结：reducer 若改动入参（或入参的数组/元素）会在严格模式下直接抛错。 */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 每次 reduce 前都对入参做快照 + 深冻结，并断言：
 *   · 返回的是**新对象**（不存在"未变化就返回原引用"的分支）；
 *   · 入参本身（含嵌套结构）与快照完全一致。
 */
function reduceFrozen(state: RunState, event: RunEvent, now: number): RunState {
  const snapshot = structuredClone(state);
  const frozen = deepFreeze(structuredClone(state));
  const next = reduceRunState(frozen, event, now);
  expect(next).not.toBe(frozen);
  expect(frozen).toStrictEqual(snapshot);
  return next;
}

/** 依次喂事件（每个事件比前一个晚 10ms），全程带不可变性断言。 */
function applyAll(events: readonly RunEvent[], start: number = T0): RunState {
  let state = initialRunState(start);
  let clock = start;
  for (const event of events) {
    clock += 10;
    state = reduceFrozen(state, event, clock);
  }
  return state;
}

describe("initialRunState", () => {
  test("初始为运行中：正文空、无工具块，startedAt = updatedAt = now", () => {
    const state = initialRunState(T0);
    expect(state).toStrictEqual({
      text: "",
      tools: [],
      status: "running",
      startedAt: T0,
      updatedAt: T0,
    });
    expect(isTerminal(state)).toBe(false);
  });
});

describe("reduceRunState：正文", () => {
  test("text-delta 累加，startedAt 不变、updatedAt 跟随事件时间", () => {
    const s1 = reduceFrozen(initialRunState(T0), { type: "text-delta", text: "你好" }, T0 + 5);
    const s2 = reduceFrozen(s1, { type: "text-delta", text: "，世界" }, T0 + 9);

    expect(s2.text).toBe("你好，世界");
    expect(s2.startedAt).toBe(T0);
    expect(s2.updatedAt).toBe(T0 + 9);
    expect(s1.updatedAt).toBe(T0 + 5);
  });

  test("空 text-delta 只刷新 updatedAt，不制造空字符", () => {
    const s1 = reduceFrozen(initialRunState(T0), { type: "text-delta", text: "abc" }, T0 + 1);
    const s2 = reduceFrozen(s1, { type: "text-delta", text: "" }, T0 + 2);

    expect(s2.text).toBe("abc");
    expect(s2.updatedAt).toBe(T0 + 2);
  });

  test("assistant-message 覆盖流式累加，不与 delta 重复拼接", () => {
    const state = applyAll([
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo " },
      { type: "text-delta", text: "world" },
      { type: "assistant-message", text: "hello world" },
    ]);

    expect(state.text).toBe("hello world");
  });

  test("assistant-message 也能在没有任何 delta 时定稿", () => {
    const state = applyAll([{ type: "assistant-message", text: "一次性全文" }]);
    expect(state.text).toBe("一次性全文");
  });
});

describe("reduceRunState：工具块", () => {
  test("tool-start 按事件顺序追加 running 块", () => {
    const state = applyAll([
      { type: "tool-start", name: "read_file" },
      { type: "tool-start", name: "grep" },
    ]);

    expect(state.tools).toStrictEqual([
      { kind: "tool", name: "read_file", status: "running" },
      { kind: "tool", name: "grep", status: "running" },
    ]);
  });

  test("tool-end 把对应块置为 ok / error 并带上 detail", () => {
    const state = applyAll([
      { type: "tool-start", name: "read_file" },
      { type: "tool-start", name: "grep" },
      { type: "tool-end", name: "read_file", ok: true, detail: "12 行" },
      { type: "tool-end", name: "grep", ok: false, detail: "exit 1" },
    ]);

    expect(state.tools).toStrictEqual([
      { kind: "tool", name: "read_file", status: "ok", detail: "12 行" },
      { kind: "tool", name: "grep", status: "error", detail: "exit 1" },
    ]);
  });

  test("tool-end 不带 detail 时不产生 detail 字段", () => {
    const state = applyAll([
      { type: "tool-start", name: "read_file" },
      { type: "tool-end", name: "read_file", ok: true },
    ]);

    expect(state.tools[0]).toStrictEqual({ kind: "tool", name: "read_file", status: "ok" });
  });

  test("乱序 / 迟到的 tool-end 被忽略，不凭空造块", () => {
    const started = applyAll([{ type: "tool-start", name: "read_file" }]);
    const after = reduceFrozen(started, { type: "tool-end", name: "从未启动", ok: true }, T0 + 99);

    expect(after.tools).toStrictEqual(started.tools);
    expect(after.tools).toHaveLength(1);
    // 忽略事件本身，但仍刷新心跳时间。
    expect(after.updatedAt).toBe(T0 + 99);
  });

  test("同名多次调用各算一块，tool-end 配对到最近一个 running 块", () => {
    const state = applyAll([
      { type: "tool-start", name: "bash" },
      { type: "tool-end", name: "bash", ok: true, detail: "第一次" },
      { type: "tool-start", name: "bash" },
      { type: "tool-end", name: "bash", ok: false, detail: "第二次" },
    ]);

    expect(state.tools).toStrictEqual([
      { kind: "tool", name: "bash", status: "ok", detail: "第一次" },
      { kind: "tool", name: "bash", status: "error", detail: "第二次" },
    ]);
  });

  test("同名并发（两块都在 running）：tool-end 只命中最近的一块", () => {
    const state = applyAll([
      { type: "tool-start", name: "bash" },
      { type: "tool-start", name: "bash" },
      { type: "tool-end", name: "bash", ok: true },
    ]);

    expect(state.tools).toStrictEqual([
      { kind: "tool", name: "bash", status: "running" },
      { kind: "tool", name: "bash", status: "ok" },
    ]);
  });
});

describe("reduceRunState：终态", () => {
  test("turn-end → done / failed / stopped，并携带可选 reason", () => {
    const done = applyAll([{ type: "turn-end", outcome: "done" }]);
    expect(done.status).toBe("done");
    expect(done.reason).toBeUndefined();
    expect(isTerminal(done)).toBe(true);

    const failed = applyAll([{ type: "turn-end", outcome: "failed", reason: "构建失败" }]);
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe("构建失败");

    const stopped = applyAll([{ type: "turn-end", outcome: "stopped", reason: "用户强停" }]);
    expect(stopped.status).toBe("stopped");
    expect(stopped.reason).toBe("用户强停");
    expect(isTerminal(stopped)).toBe(true);
  });

  test("幂等：后到的 turn-end 不改状态、不覆盖已有 reason", () => {
    const first = applyAll([{ type: "turn-end", outcome: "failed", reason: "构建失败" }]);
    const second = reduceFrozen(first, { type: "turn-end", outcome: "done", reason: "其实成功了" }, T0 + 99);

    expect(second.status).toBe("failed");
    expect(second.reason).toBe("构建失败");
    expect(second.updatedAt).toBe(T0 + 99);
  });

  test("幂等补漏：原来没有 reason 时，后到的 turn-end 可以补上", () => {
    const first = applyAll([{ type: "turn-end", outcome: "stopped" }]);
    const second = reduceFrozen(first, { type: "turn-end", outcome: "done", reason: "被强停" }, T0 + 99);

    expect(second.status).toBe("stopped");
    expect(second.reason).toBe("被强停");
  });

  test("终态后迟到的正文 / 工具事件不会把状态改回 running", () => {
    const done = applyAll([{ type: "turn-end", outcome: "done" }]);
    const late = reduceFrozen(done, { type: "text-delta", text: "补充" }, T0 + 99);

    expect(late.status).toBe("done");
    expect(late.text).toBe("补充");
    expect(isTerminal(late)).toBe(true);
  });
});

describe("reduceRunState：不可变性", () => {
  test("所有事件都返回新对象，且不改动入参（含 tools 数组）", () => {
    const state = applyAll([
      { type: "text-delta", text: "开始" },
      { type: "tool-start", name: "read_file" },
    ]);
    const snapshot = structuredClone(state);

    const events: readonly RunEvent[] = [
      { type: "text-delta", text: "x" },
      { type: "assistant-message", text: "全文" },
      { type: "tool-start", name: "grep" },
      { type: "tool-end", name: "read_file", ok: true, detail: "ok" },
      { type: "tool-end", name: "不存在", ok: false },
      { type: "turn-end", outcome: "done" },
    ];
    let cursor: RunState = state;
    for (const event of events) cursor = reduceFrozen(cursor, event, T0 + 100);

    expect(state).toStrictEqual(snapshot);
    expect(cursor).not.toBe(state);
  });

  test("tools 数组每次都是新建的（不共享入参数组引用）", () => {
    const state = initialRunState(T0);
    const next = reduceRunState(state, { type: "tool-start", name: "read_file" }, T0 + 1);

    expect(next.tools).not.toBe(state.tools);
    expect(state.tools).toHaveLength(0);
    expect(next.tools).toHaveLength(1);
  });
});
