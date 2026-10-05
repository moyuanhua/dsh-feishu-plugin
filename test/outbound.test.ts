import { describe, expect, test } from "vitest";
import {
  extractAssistantText,
  mapSessionEvent,
  mapStreamFrame,
  RunCard,
  type CardPort,
} from "../src/bridge/outbound.js";
import type { Logger } from "../src/types.js";

const LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("mapStreamFrame", () => {
  test("chunk + text-delta → 文本增量", () => {
    expect(mapStreamFrame({ type: "chunk", chunk: { type: "text-delta", text: "你好" } })).toEqual({
      type: "text-delta",
      text: "你好",
    });
  });

  test("start/end frame 与其它 chunk 类型一律忽略", () => {
    expect(mapStreamFrame({ type: "start" })).toBeUndefined();
    expect(mapStreamFrame({ type: "end" })).toBeUndefined();
    expect(mapStreamFrame({ type: "chunk", chunk: { type: "reasoning-delta", text: "想" } })).toBeUndefined();
    expect(mapStreamFrame({ type: "chunk" })).toBeUndefined();
  });

  test("缺 text 字段时退化为空串（不抛）", () => {
    expect(mapStreamFrame({ type: "chunk", chunk: { type: "text-delta" } })).toEqual({ type: "text-delta", text: "" });
  });
});

describe("extractAssistantText", () => {
  test("优先取 content 文本块", () => {
    expect(
      extractAssistantText({
        type: "assistant/message",
        message: { content: [{ type: "text", text: "答" }, { type: "image" }, { type: "text", text: "案" }] },
      }),
    ).toBe("答案");
  });

  test("content 无文本时回退到紧凑 stream 的 text-delta", () => {
    expect(
      extractAssistantText({
        type: "assistant/message",
        data: { stream: [{ chunk: { type: "text-delta", text: "来" } }, { chunk: { type: "text-delta", text: "了" } }] },
      }),
    ).toBe("来了");
  });

  test("两者都没有时返回空串", () => {
    expect(extractAssistantText({ type: "assistant/message" })).toBe("");
  });
});

describe("mapSessionEvent（信封结构）", () => {
  test("tool/call → tool-start（字段在 data 下）", () => {
    expect(mapSessionEvent({ type: "tool/call", data: { name: "read", callId: "c1" } })).toEqual({
      type: "tool-start",
      name: "read",
    });
    expect(mapSessionEvent({ type: "tool/call", data: { callId: "c1" } })).toBeUndefined();
  });

  test("tool/result → tool-end（名字由调用方回填，错误原因进 detail）", () => {
    expect(
      mapSessionEvent({
        type: "tool/result",
        data: { name: "bash", message: { isError: false }, error: { reason: "无关" } },
      }),
    ).toEqual({ type: "tool-end", name: "bash", ok: true, detail: "无关" });
    expect(mapSessionEvent({ type: "tool/result", data: { name: "bash", message: { isError: true } } })).toEqual({
      type: "tool-end",
      name: "bash",
      ok: false,
    });
    // 名字缺失 → 忽略（不凭空造块）
    expect(mapSessionEvent({ type: "tool/result", data: { message: { isError: true } } })).toBeUndefined();
  });

  test("assistant/message → assistant-message；空文本忽略", () => {
    expect(
      mapSessionEvent({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "结果" }] } } }),
    ).toEqual({ type: "assistant-message", text: "结果" });
    expect(mapSessionEvent({ type: "assistant/message", data: {} })).toBeUndefined();
  });

  test("turn/end → 按 reason.kind 映射三态", () => {
    expect(mapSessionEvent({ type: "turn/end", data: { reason: { kind: "completed" } } })).toEqual({
      type: "turn-end",
      outcome: "done",
    });
    expect(mapSessionEvent({ type: "turn/end", data: { reason: { kind: "aborted" } } })).toEqual({
      type: "turn-end",
      outcome: "stopped",
    });
    expect(mapSessionEvent({ type: "turn/end", data: { reason: { kind: "blocked" } } })).toEqual({
      type: "turn-end",
      outcome: "failed",
    });
    // 缺 reason 时按正常完成处理
    expect(mapSessionEvent({ type: "turn/end" })).toEqual({ type: "turn-end", outcome: "done" });
  });

  test("未覆盖的事件类型返回 undefined；平铺形状仍兼容", () => {
    expect(mapSessionEvent({ type: "step/start" })).toBeUndefined();
    expect(mapSessionEvent({ type: "tool/call", name: "grep" })).toEqual({ type: "tool-start", name: "grep" });
  });
});

interface Harness {
  card: RunCard;
  sends: Array<{ chatId: string; card: unknown }>;
  patches: Array<{ messageId: string; card: unknown }>;
  setNow: (value: number) => void;
  failPatch: (fail: boolean) => void;
}

function harness(options: { stopToken?: string; throttleMs?: number } = {}): Harness {
  const sends: Array<{ chatId: string; card: unknown }> = [];
  const patches: Array<{ messageId: string; card: unknown }> = [];
  let now = 1_000;
  let shouldFail = false;
  let counter = 0;
  const port: CardPort = {
    sendCard: async (chatId, card) => {
      sends.push({ chatId, card });
      counter += 1;
      return `om_${counter}`;
    },
    patchCard: async (messageId, card) => {
      if (shouldFail) throw new Error("飞书 500");
      patches.push({ messageId, card });
    },
  };
  const card = new RunCard(port, LOG, {
    chatId: "oc_1",
    title: "测试会话",
    ...(options.stopToken ? { stopToken: options.stopToken } : {}),
    throttleMs: options.throttleMs ?? 700,
    now: () => now,
  });
  return {
    card,
    sends,
    patches,
    setNow: (value) => {
      now = value;
    },
    failPatch: (fail) => {
      shouldFail = fail;
    },
  };
}

/** 从卡片 JSON 里找出按钮 value（没有按钮返回 undefined）。 */
function stopValueOf(card: unknown): unknown {
  const body = (card as { body?: { elements?: Array<{ behaviors?: Array<{ value?: unknown }> }> } }).body;
  for (const element of body?.elements ?? []) {
    const value = element.behaviors?.[0]?.value;
    if (value) return value;
  }
  return undefined;
}

describe("RunCard", () => {
  test("start 发出首卡并记住 messageId；运行中渲染强停按钮", async () => {
    const h = harness({ stopToken: "tok_1" });
    await h.card.start();
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.chatId).toBe("oc_1");
    expect(h.card.currentMessageId).toBe("om_1");
    expect(stopValueOf(h.sends[0]?.card)).toEqual({ kind: "stop", token: "tok_1" });
  });

  test("文本增量按节流 patch；终态立即刷新并去掉按钮", async () => {
    const h = harness({ stopToken: "tok_1", throttleMs: 700 });
    await h.card.start();
    expect(h.card.currentState.text).toBe("");

    // 首卡刚发出时处于节流窗口内 → 增量先只进状态、不 patch
    h.card.handle({ type: "text-delta", text: "第一段" });
    await h.card.drain();
    expect(h.patches).toHaveLength(0);
    expect(h.card.currentState.text).toBe("第一段");

    // 超过节流窗口 → patch（渲染出累积正文）
    h.setNow(1_800);
    h.card.handle({ type: "text-delta", text: "，第二段" });
    await h.card.drain();
    expect(h.patches).toHaveLength(1);
    expect(JSON.stringify(h.patches[0]?.card)).toContain("第一段，第二段");

    // 仍在窗口内 → 不 patch
    h.setNow(2_000);
    h.card.handle({ type: "text-delta", text: "第三段" });
    await h.card.drain();
    expect(h.patches).toHaveLength(1);

    // 终态：立即刷新 + 按钮消失
    h.card.handle({ type: "turn-end", outcome: "done" });
    await h.card.finish();
    expect(h.patches).toHaveLength(2);
    expect(stopValueOf(h.patches.at(-1)?.card)).toBeUndefined();
    expect(h.card.currentState.status).toBe("done");
  });

  test("finish 之后的 handle 被忽略（closed）", async () => {
    const h = harness();
    await h.card.start();
    await h.card.finish();
    const before = h.patches.length;
    h.card.handle({ type: "text-delta", text: "迟到" });
    await h.card.drain();
    expect(h.patches).toHaveLength(before);
    expect(h.card.currentState.text).toBe("");
  });

  test("patch 失败只告警、不抛出（不影响会话执行）", async () => {
    const h = harness();
    await h.card.start();
    h.failPatch(true);
    h.card.handle({ type: "text-delta", text: "x" });
    await expect(h.card.drain()).resolves.toBeUndefined();
    await expect(h.card.finish()).resolves.toBeUndefined();
    expect(h.patches).toHaveLength(0);
  });

  test("patch 串行化：连发多个事件后按事件顺序落地", async () => {
    const h = harness({ throttleMs: 0 });
    await h.card.start();
    h.card.handle({ type: "text-delta", text: "a" });
    h.card.handle({ type: "text-delta", text: "b" });
    h.card.handle({ type: "text-delta", text: "c" });
    await h.card.drain();
    const last = h.patches.at(-1)?.card as { body?: { elements?: Array<{ content?: string }> } };
    expect(JSON.stringify(last)).toContain("abc");
    expect(h.patches.length).toBeGreaterThanOrEqual(1);
  });

  test("工具块与失败终态都能渲染进卡片", async () => {
    const h = harness({ throttleMs: 0 });
    await h.card.start();
    h.card.handle({ type: "tool-start", name: "bash" });
    h.card.handle({ type: "tool-end", name: "bash", ok: false, detail: "退出码 1" });
    h.card.handle({ type: "turn-end", outcome: "failed", reason: "模型报错" });
    await h.card.finish();
    const card = h.patches.at(-1)?.card;
    expect(JSON.stringify(card)).toContain("bash");
    expect(h.card.currentState.status).toBe("failed");
  });
});
