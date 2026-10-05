/**
 * 提问桥规格。
 *
 * 语义来自上游 `FormRelay` + `forms.ts`（opencode-feishu-plugin，MIT）：卡片渲染、按钮作答、
 * **聊天里直接发文字作答**（consumeText）、逐字段累积、答完提交、取消/超时收敛。
 * 形状按 dsh 的 `user-questions/request` waterfall 重写（await 作答 → 返回结构化答案）。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AskUserQuestionAnswer, AskUserQuestionItem } from "@deepseek-ai/dsh-user-questions";
import { fieldOf, formOf, QuestionBridge } from "../src/bridge/questions.js";
import type { Logger, SessionLink } from "../src/types.js";

const LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const ITEMS: AskUserQuestionItem[] = [
  {
    id: "q0",
    question: "继续找的方向",
    header: "方向",
    detail: "选一个继续",
    options: [{ label: "新开一轮" }, { label: "深挖 Top5" }],
  },
];

const TWO_ITEMS: AskUserQuestionItem[] = [
  { id: "q0", question: "第一个", options: [{ label: "A" }, { label: "B" }] },
  { id: "q1", question: "第二个", options: [{ label: "C" }, { label: "D" }] },
];

interface Harness {
  bridge: QuestionBridge;
  sent: Array<{ chatId: string; card: unknown }>;
  patched: Array<{ messageId: string; card: unknown }>;
  nextCalls: () => number;
  next: () => Promise<AskUserQuestionAnswer>;
}

function harness(options: { link?: SessionLink | undefined } = {}): Harness {
  const sent: Array<{ chatId: string; card: unknown }> = [];
  const patched: Array<{ messageId: string; card: unknown }> = [];
  let nextCalls = 0;
  const link = "link" in options ? options.link : { chatId: "oc_1", openId: "ou_owner" };

  const bridge = new QuestionBridge({
    log: LOG,
    cardPort: {
      sendCard: async (chatId, card) => {
        sent.push({ chatId, card });
        return "om_form";
      },
      patchCard: async (messageId, card) => {
        patched.push({ messageId, card });
      },
    },
    getLink: async () => link,
    isAllowed: (openId) => openId === "ou_owner",
    timeoutMs: 60_000,
    now: () => 1_700_000_000_000,
    newFormId: () => "fq_test",
  });

  return {
    bridge,
    sent,
    patched,
    nextCalls: () => nextCalls,
    next: async () => {
      nextCalls += 1;
      return { answers: [] };
    },
  };
}

function click(operator: string, value: unknown) {
  return { operator: { openId: operator }, action: { value } };
}

function request(items: readonly AskUserQuestionItem[] = ITEMS, signal?: AbortSignal) {
  return { questions: [...items], ...(signal ? { signal } : {}) };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("fieldOf / formOf（dsh 问题项 → 上游表单）", () => {
  test("header 作标题、question+detail 作说明、选项按 label 回传、总是允许自填", () => {
    const field = fieldOf(ITEMS[0]!);
    expect(field.key).toBe("q0");
    expect(field.title).toBe("方向");
    expect(field.description).toContain("继续找的方向");
    expect(field.description).toContain("选一个继续");
    expect(field.options).toEqual([{ value: "新开一轮", label: "新开一轮" }, { value: "深挖 Top5", label: "深挖 Top5" }]);
    expect(field.custom).toBe(true);
    expect(field.type).toBe("string");
  });

  test("multiSelect → multiselect；无 header 时用 question 作标题", () => {
    const field = fieldOf({ id: "q", question: "多选", multiSelect: true });
    expect(field.type).toBe("multiselect");
    expect(field.title).toBe("多选");
    expect(field.options).toBeUndefined();
  });

  test("formOf 带 question 元信息（表头显示「提问」）", () => {
    const form = formOf("f1", "ses_1", ITEMS);
    expect(form.metadata).toEqual({ kind: "question" });
    expect(form.fields).toHaveLength(1);
  });
});

describe("QuestionBridge.handle（认领与委托）", () => {
  test("无飞书映射 → 交回宿主", async () => {
    const h = harness({ link: undefined });
    expect(await h.bridge.handle("ses_1", request(), h.next)).toEqual({ answers: [] });
    expect(h.nextCalls()).toBe(1);
    expect(h.sent).toHaveLength(0);
  });

  test("无 questions / 无 sessionId → 交回宿主", async () => {
    const h = harness();
    expect(await h.bridge.handle("ses_1", request([]), h.next)).toEqual({ answers: [] });
    expect(await h.bridge.handle(undefined, request(), h.next)).toEqual({ answers: [] });
    expect(h.nextCalls()).toBe(2);
  });

  test("单选题：发卡 → 点选项 → 返回 selected=[label] 且卡片变已提交", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", request(), h.next);
    await flush();
    expect(h.sent).toHaveLength(1);
    // 卡片含两个选项按钮 + 一个自由文本按钮
    const card = h.sent[0]?.card as { body: { elements: Array<{ tag?: string; behaviors?: Array<{ value: unknown }> }> } };
    const buttons = card.body.elements.filter((el) => el.tag === "button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.behaviors?.[0]?.value).toEqual({ f: "fq_test", k: "q0", v: "新开一轮" });

    const toast = await h.bridge.handleCardAction(click("ou_owner", { f: "fq_test", k: "q0", v: "新开一轮" }));
    expect(JSON.stringify(toast)).toContain("已记录");
    expect(await promise).toEqual({ answers: [{ id: "q0", selected: ["新开一轮"] }] });
    expect(JSON.stringify(h.patched.at(-1)?.card)).toContain("已提交");
    expect(h.nextCalls()).toBe(0);
  });

  test("多字段：先答一个刷新卡片，答完提交（答案齐全）", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", request(TWO_ITEMS), h.next);
    await flush();
    await h.bridge.handleCardAction(click("ou_owner", { f: "fq_test", k: "q0", v: "A" }));
    expect(h.bridge.pendingCount).toBe(1);
    expect(JSON.stringify(h.patched.at(-1)?.card)).toContain("还需回答");
    await h.bridge.handleCardAction(click("ou_owner", { f: "fq_test", k: "q1", v: "D" }));
    expect(await promise).toEqual({
      answers: [
        { id: "q0", selected: ["A"] },
        { id: "q1", selected: ["D"] },
      ],
    });
  });

  test("自由文本：点「✍️ 直接回复答案」后再在聊天里发文字 → custom 答案", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", request(), h.next);
    await flush();
    await h.bridge.handleCardAction(click("ou_owner", { f: "fq_test", k: "q0", free: true }));
    expect(JSON.stringify(h.patched.at(-1)?.card)).toContain("直接在聊天里回复");

    expect(h.bridge.consumeText("ses_1", "我自己的答案")).toBe(true);
    expect(await promise).toEqual({ answers: [{ id: "q0", selected: [], custom: "我自己的答案" }] });
  });

  test("只剩一个待答字段时，聊天文本直接作为答案（无需先点自由文本按钮）", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", request(), h.next);
    await flush();
    expect(h.bridge.consumeText("ses_1", "直接给答案")).toBe(true);
    expect(await promise).toEqual({ answers: [{ id: "q0", selected: [], custom: "直接给答案" }] });
  });

  test("多字段且未点自由文本时，聊天文本不被消费（避免误吞 prompt）", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", request(TWO_ITEMS), h.next);
    await flush();
    expect(h.bridge.consumeText("ses_1", "这是给模型的任务")).toBe(false);
    await h.bridge.handleCardAction(click("ou_owner", { f: "fq_test", k: "q0", v: "A" }));
    await h.bridge.handleCardAction(click("ou_owner", { f: "fq_test", k: "q1", v: "C" }));
    expect(await promise).toHaveProperty("answers");
  });

  test("非白名单用户点击 → 无权作答且仍待答", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", request(), h.next);
    await flush();
    const toast = await h.bridge.handleCardAction(click("ou_stranger", { f: "fq_test", k: "q0", v: "新开一轮" }));
    expect(JSON.stringify(toast)).toContain("无权作答");
    expect(h.bridge.pendingCount).toBe(1);
    void promise;
  });

  test("过期按钮（表单已结束）→ 提示已结束；非表单按钮 → undefined", async () => {
    const h = harness();
    expect(await h.bridge.handleCardAction(click("ou_owner", { f: "missing", k: "q0", v: "A" }))).toMatchObject({
      toast: { content: "该问题已结束" },
    });
    expect(await h.bridge.handleCardAction(click("ou_owner", { cmd: "x" }))).toBeUndefined();
  });

  test("TTL 到期 → patch 取消卡并交回宿主", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", request(), h.next);
    await flush();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await promise).toEqual({ answers: [] }); // next() 的返回值
    expect(h.nextCalls()).toBe(1);
    expect(JSON.stringify(h.patched.at(-1)?.card)).toContain("已取消");
    expect(h.bridge.pendingCount).toBe(0);
  });

  test("AbortSignal 取消 → patch 取消卡并交回宿主", async () => {
    const h = harness();
    const controller = new AbortController();
    const promise = h.bridge.handle("ses_1", request(ITEMS, controller.signal), h.next);
    await flush();
    controller.abort();
    expect(await promise).toEqual({ answers: [] });
    expect(h.nextCalls()).toBe(1);
    expect(h.bridge.pendingCount).toBe(0);
  });

  test("signal 已取消时直接交回宿主（不发卡）", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    expect(await h.bridge.handle("ses_1", request(ITEMS, controller.signal), h.next)).toEqual({ answers: [] });
    expect(h.sent).toHaveLength(0);
  });

  test("hasPendingFor：待答期间该会话被视为「合法等待」", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", request(), h.next);
    await flush();
    expect(h.bridge.hasPendingFor("ses_1")).toBe(true);
    expect(h.bridge.hasPendingFor("ses_2")).toBe(false);
    await h.bridge.handleCardAction(click("ou_owner", { f: "fq_test", k: "q0", v: "新开一轮" }));
    await promise;
    expect(h.bridge.hasPendingFor("ses_1")).toBe(false);
  });

  test("dispose 收敛待答并交回宿主", async () => {
    const h = harness();
    const promise = h.bridge.handle("ses_1", request(), h.next);
    await flush();
    h.bridge.dispose();
    expect(await promise).toEqual({ answers: [] });
    expect(h.bridge.pendingCount).toBe(0);
  });

  test("卡片发送失败 → 交回宿主（不让轮次空等）", async () => {
    const h = harness();
    const broken = new QuestionBridge({
      log: LOG,
      cardPort: {
        sendCard: async () => {
          throw new Error("飞书 500");
        },
        patchCard: async () => {},
      },
      getLink: async () => ({ chatId: "oc_1", openId: "ou_owner" }),
      isAllowed: () => true,
      timeoutMs: 60_000,
    });
    expect(await broken.handle("ses_1", request(), h.next)).toEqual({ answers: [] });
    expect(h.nextCalls()).toBe(1);
  });
});
