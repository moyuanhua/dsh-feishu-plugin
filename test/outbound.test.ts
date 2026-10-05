import { describe, expect, test } from "vitest";
import {
  describeTurnEnd,
  extractAssistantText,
  mapSessionEvent,
  mapStreamFrame,
  RunCard,
  type CardPort,
  type OutboundTarget,
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

  test("turn/end → 按 reason.kind 映射（reason 必须透传，否则卡片永远看不到原因）", () => {
    expect(mapSessionEvent({ type: "turn/end", data: { reason: { kind: "completed" } } })).toEqual({
      type: "turn-end",
      outcome: "done",
    });
    expect(mapSessionEvent({ type: "turn/end", data: { reason: { kind: "aborted" } } })).toEqual({
      type: "turn-end",
      outcome: "stopped",
      reason: "已中断",
    });
    expect(mapSessionEvent({ type: "turn/end", data: { reason: { kind: "blocked" } } })).toEqual({
      type: "turn-end",
      outcome: "failed",
      reason: "本轮被策略拦截，未执行",
    });
    // 缺 reason 时**不能**按"正常完成"处理（那正是假成功的根因）。
    expect(mapSessionEvent({ type: "turn/end" })).toEqual({
      type: "turn-end",
      outcome: "failed",
      reason: "轮次结束但未提供原因",
    });
  });

  test("未覆盖的事件类型返回 undefined；平铺形状仍兼容", () => {
    expect(mapSessionEvent({ type: "step/start" })).toBeUndefined();
    expect(mapSessionEvent({ type: "tool/call", name: "grep" })).toEqual({ type: "tool-start", name: "grep" });
  });
});

/**
 * 缺陷回归：旧 `mapTurnOutcome` 只有 `aborted`/`blocked` 两个分支，
 * `error` 落进 `default → "done"` —— 模型报错却显示 ✅（线上那张假成功截图）。
 */
describe("describeTurnEnd：终态映射必须穷尽且失败可见", () => {
  test("error → ❌ 并把 LlmFailure 的 message 与 code 透出来", () => {
    expect(
      describeTurnEnd({
        kind: "error",
        error: { message: 'agent "feishu-x" has no provider/model', code: "NO_ADAPTER" },
      }),
    ).toEqual({
      outcome: "failed",
      reason: 'agent "feishu-x" has no provider/model（NO_ADAPTER）',
    });
  });

  test("error 缺 message 时给出兜底文案，绝不判成功", () => {
    expect(describeTurnEnd({ kind: "error", error: {} }).outcome).toBe("failed");
    expect(describeTurnEnd({ kind: "error" })).toEqual({
      outcome: "failed",
      reason: "模型请求失败（未提供原因）",
    });
  });

  test("aborted → ⏹ 并区分取消原因", () => {
    expect(describeTurnEnd({ kind: "aborted", reason: { kind: "user" } })).toEqual({
      outcome: "stopped",
      reason: "已按你的请求中断",
    });
    expect(describeTurnEnd({ kind: "aborted", reason: { kind: "hook", reason: "看门狗超时" } })).toEqual({
      outcome: "stopped",
      reason: "已被钩子中断：看门狗超时",
    });
    expect(describeTurnEnd({ kind: "aborted", reason: { kind: "parent" } }).outcome).toBe("stopped");
    expect(describeTurnEnd({ kind: "aborted" }).outcome).toBe("stopped");
  });

  test("max-tokens → 仍是 done，但必须带截断警告", () => {
    expect(describeTurnEnd({ kind: "max-tokens" })).toEqual({
      outcome: "done",
      reason: "输出达到模型上限，内容可能被截断",
    });
  });

  test("interrupted / forked → ⏹", () => {
    expect(describeTurnEnd({ kind: "interrupted" }).outcome).toBe("stopped");
    expect(describeTurnEnd({ kind: "forked" }).outcome).toBe("stopped");
  });

  test("未知分支、缺 reason → 一律判失败（宁可误报失败，也不能把失败显示成 ✅）", () => {
    expect(describeTurnEnd({ kind: "some-future-kind" })).toEqual({
      outcome: "failed",
      reason: "未知的结束原因：some-future-kind",
    });
    expect(describeTurnEnd(undefined)).toEqual({
      outcome: "failed",
      reason: "轮次结束但未提供原因",
    });
  });
});

interface Harness {
  card: RunCard;
  sends: Array<{ target: OutboundTarget; card: unknown }>;
  patches: Array<{ messageId: string; card: unknown }>;
  setNow: (value: number) => void;
  failPatch: (fail: boolean) => void;
}

function harness(
  options: { stopToken?: string; throttleMs?: number; target?: OutboundTarget } = {},
): Harness {
  const sends: Array<{ target: OutboundTarget; card: unknown }> = [];
  const patches: Array<{ messageId: string; card: unknown }> = [];
  let now = 1_000;
  let shouldFail = false;
  let counter = 0;
  const port: CardPort = {
    sendCard: async (target, card) => {
      sends.push({ target, card });
      counter += 1;
      return `om_${counter}`;
    },
    patchCard: async (messageId, card) => {
      if (shouldFail) throw new Error("飞书 500");
      patches.push({ messageId, card });
    },
  };
  const card = new RunCard(port, LOG, {
    target: options.target ?? { chatId: "oc_1" },
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
    expect(h.sends[0]?.target.chatId).toBe("oc_1");
    expect(h.card.currentMessageId).toBe("om_1");
    expect(stopValueOf(h.sends[0]?.card)).toEqual({ kind: "stop", token: "tok_1" });
  });

  /**
   * 缺陷回归（实测踩到）：话题里回复机器人，机器人的运行卡却出现在**主聊天流**。
   *
   * 原因：出站一直是顶层 `send`，从来没有调用过 `channel.reply`。飞书的"话题"是
   * **回复关系**，不是发送目标 —— 不回复触发消息，卡片就落在话题外。
   * 所以出站目标必须把 `replyTo` 带下去，由通道层换成 `reply`。
   */
  test("话题内触发时必须带 replyTo（否则卡片会掉出话题）", async () => {
    const h = harness({
      target: { chatId: "oc_1", replyTo: "om_user_msg", threadId: "omt_1" },
    });
    await h.card.start();

    expect(h.sends[0]?.target).toEqual({
      chatId: "oc_1",
      replyTo: "om_user_msg",
      threadId: "omt_1",
    });
  });

  test("主聊天流触发时不带 replyTo（否则飞书会凭空开一个话题）", async () => {
    const h = harness({ target: { chatId: "oc_1" } });
    await h.card.start();

    expect(h.sends[0]?.target.replyTo).toBeUndefined();
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

  test("start 未完成时到达的事件不会补发第二张卡（双卡回归）", async () => {
    let releaseSend: (() => void) | undefined;
    const sends: string[] = [];
    const patches: string[] = [];
    const port: CardPort = {
      sendCard: async () => {
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
        sends.push("om_1");
        return "om_1";
      },
      patchCard: async (messageId) => {
        patches.push(messageId);
      },
    };
    const card = new RunCard(port, LOG, { target: { chatId: "oc_1" }, title: "t", throttleMs: 0, now: () => 1 });

    const starting = card.start(); // 故意不 await：模拟首卡还在路上
    card.handle({ type: "text-delta", text: "早到的事件" });
    releaseSend?.();
    await starting;
    await card.drain();

    expect(sends).toHaveLength(1); // 关键：只发一张卡
    expect(patches).toEqual(["om_1"]); // 事件落成对同一张卡的 patch
    expect(card.currentState.text).toBe("早到的事件");
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
