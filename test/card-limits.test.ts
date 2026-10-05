/**
 * 卡片内容守卫（card-limits.ts）单测。
 *
 * 移植来源：opencode-feishu-plugin（MIT，Copyright (c) 2026 moyuanhua）
 * 原文件：test/card-limits.test.ts
 * 适配说明：上游用例覆盖「运行卡/恢复卡整卡表格收敛 + 发送层兜底」，那些模块本仓库还没搬运，
 * 因此这里按交付契约重写为：表格识别/降级、共享额度、enforceCardLimits 的不可变性与组件上限、
 * 以及与 buildRunCard 的联调。上游 `degradeExtraTables` 返回 `{text,degraded}`，本仓库契约
 * 只返回字符串，故降级数量改用 `degradeExtraTablesDetailed` 断言。
 */
import { describe, expect, test } from "vitest";
import {
  CARD_MAX_TABLES_MAX,
  DEFAULT_CARD_MAX_ELEMENTS,
  DEFAULT_CARD_MAX_TABLES,
  clampMaxTables,
  countMarkdownTables,
  createCardMarkdownBudget,
  degradeExtraTables,
  degradeExtraTablesDetailed,
  enforceCardLimits,
  enforceCardLimitsWithReport,
  findMarkdownTables,
  toCardMarkdown,
} from "../src/feishu/card-limits.js";
import { buildRunCard } from "../src/feishu/cards.js";

/** 生成一个 markdown 表格（列内容用 tag 区分，便于断言内容未丢）。 */
const table = (tag: string): string => [`| ${tag} | 值 |`, "| --- | --- |", `| ${tag}-1 | ${tag}-2 |`].join("\n");

/** 生成 n 个表格，用空行隔开（GFM 里表格块之间必须断开）。 */
const tables = (n: number, prefix = "T"): string =>
  Array.from({ length: n }, (_, i) => table(`${prefix}${i + 1}`)).join("\n\n");

/** 遍历卡片内所有 markdown 元素，累计表格数。 */
function cardTables(card: object): number {
  let total = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (rec.tag === "markdown" && typeof rec.content === "string") total += countMarkdownTables(rec.content);
    for (const value of Object.values(rec)) walk(value);
  };
  walk(card);
  return total;
}

/** 遍历卡片，统计带 `tag` 的组件/元素数（与 card-limits 内部口径一致）。 */
function cardElements(card: object): number {
  const walk = (node: unknown): number => {
    if (Array.isArray(node)) return node.reduce<number>((sum, item) => sum + walk(item), 0);
    if (!node || typeof node !== "object") return 0;
    const rec = node as Record<string, unknown>;
    const self = typeof rec.tag === "string" ? 1 : 0;
    return self + Object.values(rec).reduce<number>((sum, value) => sum + walk(value), 0);
  };
  return walk(card);
}

const bodyOf = (card: object): Array<Record<string, unknown>> =>
  (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;

describe("上限常量", () => {
  test("默认 4 / 硬限 5 / 组件 200（源自飞书文档）", () => {
    expect(DEFAULT_CARD_MAX_TABLES).toBe(4);
    expect(CARD_MAX_TABLES_MAX).toBe(5);
    expect(DEFAULT_CARD_MAX_ELEMENTS).toBe(200);
    expect(clampMaxTables(undefined)).toBe(4);
    expect(clampMaxTables(0)).toBe(1);
    expect(clampMaxTables(99)).toBe(5);
    expect(clampMaxTables(3)).toBe(3);
  });
});

describe("findMarkdownTables / countMarkdownTables", () => {
  test("标准表格 / 多表格 / 无表格", () => {
    expect(countMarkdownTables(table("A"))).toBe(1);
    expect(countMarkdownTables(tables(3))).toBe(3);
    expect(countMarkdownTables("普通文本，没有表格")).toBe(0);
    expect(countMarkdownTables("a | b\nc | d")).toBe(0); // 没有分隔行，不算表格
  });

  test("支持无首尾竖线 / 对齐分隔行", () => {
    expect(countMarkdownTables("a | b\n:--- | ---:\n1 | 2")).toBe(1);
    expect(countMarkdownTables("| a | b |\n|---:|:---|\n| 1 | 2 |")).toBe(1);
  });

  test("代码块内的 `|` 不被误判为表格（``` 与 ~~~）", () => {
    const fenced = ["```text", "| not | a | table |", "| --- | --- |", "| 1 | 2 |", "```"].join("\n");
    expect(countMarkdownTables(fenced)).toBe(0);
    const tilde = ["~~~", "| x | y |", "| --- | --- |", "~~~"].join("\n");
    expect(countMarkdownTables(tilde)).toBe(0);
    expect(countMarkdownTables(`${fenced}\n\n${table("real")}`)).toBe(1);
  });

  test("findMarkdownTables 返回表头到正文的行区间", () => {
    const spans = findMarkdownTables(["前言", table("A"), "结尾"].join("\n"));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(1);
    expect(spans[0]!.end).toBe(3);
  });
});

describe("degradeExtraTables", () => {
  test("4 个表格、上限 4：原样返回", () => {
    const four = tables(4);
    expect(degradeExtraTables(four, 4)).toBe(four);
    expect(countMarkdownTables(degradeExtraTables(four, 4))).toBe(4);
  });

  test("5 个表格、上限 4：保留前 4、降级 1，内容一字不丢", () => {
    const five = tables(5);
    const out = degradeExtraTables(five, 4);
    expect(out).not.toBe(five);
    expect(countMarkdownTables(out)).toBe(4);
    expect(degradeExtraTablesDetailed(five, 4).degraded).toBe(1);
    for (let i = 1; i <= 5; i += 1) {
      expect(out).toContain(`T${i}-1`); // 被降级的表格内容仍在
      expect(out).toContain(`T${i}-2`);
    }
    expect(out).toContain("```"); // 降级形态：围栏代码块
  });

  test("6 个表格、上限 4：保留前 4、降级 2", () => {
    const six = tables(6);
    const out = degradeExtraTables(six, 4);
    expect(countMarkdownTables(out)).toBe(4);
    expect(degradeExtraTablesDetailed(six, 4).degraded).toBe(2);
    expect(out.endsWith("```")).toBe(true); // 最后一个表格被围栏包住
  });

  test("再次降级是幂等的（代码块内不再被识别为表格）", () => {
    const once = degradeExtraTables(tables(6), 4);
    expect(degradeExtraTables(once, 4)).toBe(once);
    expect(degradeExtraTablesDetailed(once, 4).degraded).toBe(0);
  });

  test("上限 0：全部降级；正文已含 ``` 时改用 ~~~ 围栏", () => {
    expect(countMarkdownTables(degradeExtraTables(tables(3), 0))).toBe(0);
    const withFence = `\`\`\`txt\nplain\n\`\`\`\n\n${tables(3)}`;
    const out = degradeExtraTables(withFence, 0);
    expect(out).toContain("~~~");
    expect(countMarkdownTables(out)).toBe(0);
  });
});

describe("toCardMarkdown（共享额度）", () => {
  test("单参调用按默认额度 4 收敛", () => {
    expect(countMarkdownTables(toCardMarkdown(tables(6)))).toBe(4);
    expect(toCardMarkdown("没有表格")).toBe("没有表格");
  });

  test("多个元素累计消耗同一额度", () => {
    const budget = createCardMarkdownBudget(4);
    const a = toCardMarkdown(tables(3, "A"), budget); // 用掉 3
    const b = toCardMarkdown(tables(3, "B"), budget); // 只剩 1，降级 2
    expect(countMarkdownTables(a)).toBe(3);
    expect(countMarkdownTables(b)).toBe(1);
    expect(budget.tables).toBe(6);
    expect(budget.degraded).toBe(2);
    expect(budget.remaining).toBe(0);
  });
});

describe("enforceCardLimits", () => {
  test("整卡累计：两个元素各 3 个表 → 共 6 个，保留 4 降级 2；且不修改入参", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: tables(3, "A") },
          { tag: "markdown", content: tables(3, "B") },
        ],
      },
    };
    const before = JSON.stringify(card);
    const out = enforceCardLimits(card, { maxTables: 4 });
    expect(out).not.toBe(card);
    expect(cardTables(out)).toBe(4);
    expect(JSON.stringify(card)).toBe(before); // 纯函数：入参深拷贝后处理
    expect(cardTables(card)).toBe(6);
  });

  test("降级时追加省略说明（内容被改动才追加）", () => {
    const card = { body: { elements: [{ tag: "markdown", content: tables(6) }] } };
    const out = enforceCardLimits(card);
    const text = JSON.stringify(out);
    expect(text).toContain("降级为代码块");
    expect(text).toContain("超出飞书卡片上限");
    // 未改动时不应出现说明。
    const clean = { body: { elements: [{ tag: "markdown", content: "hello" }] } };
    expect(JSON.stringify(enforceCardLimits(clean))).not.toContain("超出飞书卡片上限");
    expect(enforceCardLimits(clean)).toEqual(clean);
  });

  test("组件数超限：从最旧开始丢弃，保留最新，并给出省略说明", () => {
    const elements = Array.from({ length: 250 }, (_, i) => ({ tag: "markdown", content: `m${i}` }));
    const out = enforceCardLimits({ body: { elements } });
    const outElements = bodyOf(out);
    expect(cardElements(out)).toBeLessThanOrEqual(DEFAULT_CARD_MAX_ELEMENTS);
    expect(cardElements(out)).toBe(DEFAULT_CARD_MAX_ELEMENTS);
    expect(outElements.at(-1)!.content).toContain("m249"); // 最新保留
    expect(outElements[0]!.content).toBe("m50"); // 最旧 50 个被丢
    expect(outElements.at(-1)!.content).toContain("省略 50 个组件");
    // 入参未被改动。
    expect((elements[0] as { content: string }).content).toBe("m0");
    expect(elements).toHaveLength(250);
  });

  test("maxElements 选项生效", () => {
    const elements = Array.from({ length: 10 }, (_, i) => ({ tag: "markdown", content: `m${i}` }));
    const out = enforceCardLimits({ body: { elements } }, { maxElements: 5 });
    expect(bodyOf(out)).toHaveLength(5);
    expect(bodyOf(out)[0]!.content).toBe("m5");
    expect(bodyOf(out).at(-1)!.content).toContain("m9");
  });

  test("报告可用于日志上报（enforceCardLimitsWithReport）", () => {
    const card = {
      body: {
        elements: [
          { tag: "markdown", content: tables(3, "A") },
          { tag: "markdown", content: tables(3, "B") },
        ],
      },
    };
    const { card: out, report } = enforceCardLimitsWithReport(card, { maxTables: 4, maxElements: 200 });
    expect(report).toMatchObject({ tables: 6, degradedTables: 2, droppedElements: 0 });
    expect(report.elements).toBe(cardElements(out));
    expect(cardTables(out)).toBe(4);
  });

  test("联调 buildRunCard：6 个表格的运行卡收敛到 ≤ 4", () => {
    const card = buildRunCard({ title: "会话", markdown: tables(6), status: "running", footer: "状态：running" });
    expect(cardTables(card)).toBe(6);
    const guarded = enforceCardLimits(card, { maxTables: DEFAULT_CARD_MAX_TABLES });
    expect(cardTables(guarded)).toBeLessThanOrEqual(DEFAULT_CARD_MAX_TABLES);
    expect(JSON.stringify(guarded)).toContain("T6-2"); // 降级不丢内容
  });
});
