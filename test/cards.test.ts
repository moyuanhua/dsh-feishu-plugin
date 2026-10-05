/**
 * 卡片构建（cards.ts）单测。
 *
 * 移植来源：opencode-feishu-plugin（MIT，Copyright (c) 2026 moyuanhua）
 * 原文件：test/cards.test.ts
 * 适配说明：上游测的是审批卡/结果卡/管理台卡（本仓库未搬运），这里按交付契约重写为
 * 运行卡 / 通知卡 / 帮助卡 / 字节截断四组用例，体积断言用 `Buffer.byteLength`。
 */
import { describe, expect, test } from "vitest";
import {
  buildHelpCard,
  buildNoticeCard,
  buildRunCard,
  MAX_CARD_BYTES,
  truncateCardContent,
  type RunCardInput,
} from "../src/feishu/cards.js";

/** 断言用的卡片形状（只声明本测试要读的字段）。 */
interface CardShape {
  schema?: string;
  config?: { update_multi?: boolean };
  header?: { title?: { tag?: string; content?: string }; template?: string };
  body?: { elements?: Array<Record<string, unknown>> };
}

const RUN_STATUSES: ReadonlyArray<[RunCardInput["status"], string]> = [
  ["running", "blue"],
  ["done", "green"],
  ["failed", "red"],
  ["stopped", "grey"],
];

/** 取某个 markdown 元素的文本内容。 */
const markdownOf = (element: Record<string, unknown>): string => element.content as string;

const isButton = (element: Record<string, unknown>): boolean => element.tag === "button";

describe("buildRunCard", () => {
  test("schema 2.0 + config.update_multi=true + 主题色随 status 变化", () => {
    for (const [status, template] of RUN_STATUSES) {
      const card = buildRunCard({ title: "会话标题", markdown: "正文", status }) as CardShape;
      expect(card.schema).toBe("2.0");
      expect(card.config?.update_multi).toBe(true);
      expect(card.header?.title?.content).toBe("会话标题");
      expect(card.header?.template).toBe(template);
    }
  });

  test("无 stop：不渲染任何按钮", () => {
    const card = buildRunCard({ title: "t", markdown: "m", status: "done" }) as CardShape;
    const elements = card.body?.elements ?? [];
    expect(elements.filter(isButton)).toHaveLength(0);
    expect(JSON.stringify(card)).not.toContain('"tag":"button"');
  });

  test("有 stop：按钮是 body.elements 的直接子元素，value 形状为 { kind: 'stop', token }", () => {
    const card = buildRunCard({
      title: "t",
      markdown: "m",
      status: "running",
      stop: { token: "tok-1" },
    }) as CardShape;
    const elements = card.body?.elements ?? [];
    const buttons = elements.filter(isButton);
    expect(buttons).toHaveLength(1);
    // 直接子元素：不能包在 actions/action 容器里（JSON 2.0 会 400）。
    expect(elements.at(-1)?.tag).toBe("button");
    expect(JSON.stringify(card)).not.toContain('"tag":"action"');
    expect(buttons[0]!.behaviors).toEqual([{ type: "callback", value: { kind: "stop", token: "tok-1" } }]);
    expect((buttons[0]!.text as { content: string }).content).toBe("⏹ 强制停止");
  });

  test("stop.label 覆盖默认按钮文案，空串回退默认文案", () => {
    const custom = buildRunCard({
      title: "t",
      markdown: "m",
      status: "running",
      stop: { token: "tok", label: "停一下" },
    }) as CardShape;
    const button = (custom.body?.elements ?? []).find(isButton)!;
    expect((button.text as { content: string }).content).toBe("停一下");

    const blank = buildRunCard({
      title: "t",
      markdown: "m",
      status: "running",
      stop: { token: "tok", label: "   " },
    }) as CardShape;
    const fallback = (blank.body?.elements ?? []).find(isButton)!;
    expect((fallback.text as { content: string }).content).toBe("⏹ 强制停止");
  });

  test("footer 单独成元素；空 markdown 有兜底文案", () => {
    const card = buildRunCard({
      title: "t",
      markdown: "",
      status: "done",
      footer: "deepseek-v3 · 1.2s · done",
    }) as CardShape;
    const elements = card.body?.elements ?? [];
    expect(elements).toHaveLength(2);
    expect(markdownOf(elements[0]!)).toContain("暂无内容");
    expect(markdownOf(elements[1]!)).toBe("deepseek-v3 · 1.2s · done");
  });

  test("超长正文被截断：各 markdown 元素 ≤ 28KB，整卡 JSON < 30KB（飞书请求体上限）", () => {
    const card = buildRunCard({
      title: "大会话",
      markdown: "```\n" + "a".repeat(200_000),
      status: "running",
      footer: "模型：x",
    }) as CardShape;
    const elements = card.body?.elements ?? [];
    for (const element of elements) {
      if (element.tag !== "markdown") continue;
      expect(Buffer.byteLength(markdownOf(element), "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
    }
    expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThan(30 * 1024);
    // 围栏被闭合：不留下奇数个 ```。
    const fences = JSON.stringify(card).match(/```/g) ?? [];
    expect(fences.length % 2).toBe(0);
  });
});

describe("buildNoticeCard", () => {
  test("默认标题「提示」+ 默认主题 blue，正文渲染且可更新", () => {
    const card = buildNoticeCard({ text: "**已停止**" }) as CardShape;
    expect(card.schema).toBe("2.0");
    expect(card.config?.update_multi).toBe(true);
    expect(card.header?.title?.content).toBe("提示");
    expect(card.header?.template).toBe("blue");
    expect(card.body?.elements).toHaveLength(1);
    expect(markdownOf(card.body!.elements![0]!)).toBe("**已停止**");
  });

  test("title/template 可覆盖，无按钮", () => {
    const card = buildNoticeCard({ text: "内容", title: "⚠️ 注意", template: "orange" }) as CardShape;
    expect(card.header?.title?.content).toBe("⚠️ 注意");
    expect(card.header?.template).toBe("orange");
    expect(JSON.stringify(card)).not.toContain('"tag":"button"');
  });

  test("超长正文被截断到上限内", () => {
    const card = buildNoticeCard({ text: "中".repeat(50_000) }) as CardShape;
    const content = markdownOf(card.body!.elements![0]!);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(content).toContain("已截断");
  });
});

describe("buildHelpCard", () => {
  test("渲染所有命令（名字 + 描述）", () => {
    const card = buildHelpCard([
      { name: "/new", description: "新建会话" },
      { name: "/sessions", description: "查看/切换会话" },
      { name: "/help", description: "查看全部命令" },
    ]) as CardShape;
    const content = markdownOf(card.body!.elements![0]!);
    expect(content).toContain("`/new` — 新建会话");
    expect(content).toContain("`/sessions` — 查看/切换会话");
    expect(content).toContain("`/help` — 查看全部命令");
    expect(card.header?.title?.content).toBe("命令帮助");
    expect(card.config?.update_multi).toBe(true);
  });

  test("空命令列表有占位文案", () => {
    const card = buildHelpCard([]) as CardShape;
    expect(markdownOf(card.body!.elements![0]!)).toContain("暂无可用命令");
  });

  test("自定义标题 + 转义命令名里的反引号", () => {
    const card = buildHelpCard([{ name: "/a`b", description: "d" }], { title: "可用命令" }) as CardShape;
    expect(card.header?.title?.content).toBe("可用命令");
    expect(markdownOf(card.body!.elements![0]!)).toContain("\\`");
  });
});

describe("truncateCardContent", () => {
  test("短内容原样返回（无围栏则不补围栏）", () => {
    expect(truncateCardContent("hello")).toBe("hello");
    expect(truncateCardContent("")).toBe("");
  });

  test("刚好等于上限：原样返回，不追加脚注", () => {
    const exact = "a".repeat(MAX_CARD_BYTES);
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_CARD_BYTES);
    expect(truncateCardContent(exact)).toBe(exact);
  });

  test("超限 1 字节：截断到上限内并追加脚注", () => {
    const out = truncateCardContent("a".repeat(MAX_CARD_BYTES + 1));
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(out).toContain("已截断");
    expect(out.startsWith("a")).toBe(true);
  });

  test("无围栏：截断后仍无围栏", () => {
    const out = truncateCardContent("b".repeat(100_000));
    expect(out.match(/```/g) ?? []).toHaveLength(0);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
  });

  test("未闭合围栏：截断后闭合为偶数个", () => {
    const out = truncateCardContent("```\n" + "c".repeat(100_000));
    const fences = out.match(/```/g) ?? [];
    expect(fences.length % 2).toBe(0);
    expect(fences.length).toBeGreaterThanOrEqual(2);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
  });

  test("已闭合围栏：短内容原样返回，超限后仍为偶数个", () => {
    const closed = "```\ncode\n```";
    expect(truncateCardContent(closed)).toBe(closed);
    const out = truncateCardContent("```\nd\n```\n" + "e".repeat(100_000));
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
  });

  test("不切断多字节字符（不残留 U+FFFD 替换符）", () => {
    const out = truncateCardContent("中".repeat(20_000));
    expect(out).not.toContain("\ufffd");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
  });

  test("自定义上限生效；上限小到放不下脚注时返回空串", () => {
    const out = truncateCardContent("x".repeat(500), 100);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(100);
    expect(out).toContain("已截断");
    // 上限 8 字节连脚注都放不下 → 返回空串（宁可少显示也不超限）。
    expect(truncateCardContent("x".repeat(50), 8)).toBe("");
  });
});
