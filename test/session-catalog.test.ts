/**
 * 会话目录规格 —— 排序 / 分页 / 行渲染。
 *
 * 这是 S1「删镜像」后的新内核：会话列表不再来自我们自己的 KV 副本，而是
 * 宿主全量会话 + 标题 + 绑定关系现算出来。因此这里要覆盖**排序稳定性**（分页不能漏/重）、
 * **活动时间回退**（dsh 没有最后活动时间）与**子 agent 过滤**。
 */
import { describe, expect, test } from "vitest";
import {
  directoryTail,
  paginate,
  relativeTime,
  sessionRowLine,
  shortSessionId,
  sortByActivityDesc,
  type CatalogInput,
} from "../src/bridge/session-catalog.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function item(partial: Partial<CatalogInput> & { id: string }): CatalogInput {
  return { createdAt: NOW, activityAt: NOW, ...partial };
}

describe("相对时间", () => {
  test("一分钟内 → 刚刚", () => {
    expect(relativeTime(NOW - 1_000, NOW)).toBe("刚刚");
    expect(relativeTime(NOW, NOW)).toBe("刚刚");
  });

  test("分钟 / 小时 / 天", () => {
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe("5 分钟前");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3 小时前");
    expect(relativeTime(NOW - 2 * DAY, NOW)).toBe("2 天前");
  });

  test("超过 30 天回落成日期", () => {
    expect(relativeTime(NOW - 40 * DAY, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("0 / 非法值 → 时间未知（上游同）", () => {
    expect(relativeTime(0, NOW)).toBe("时间未知");
    expect(relativeTime(Number.NaN, NOW)).toBe("时间未知");
    expect(relativeTime(-1, NOW)).toBe("时间未知");
  });
});

describe("短 id 与目录尾段", () => {
  test("短 id 超过 12 字符才截断", () => {
    expect(shortSessionId("ses_abc")).toBe("ses_abc");
    expect(shortSessionId("ses_abcdefghijklmno")).toBe("ses_abcdefgh…");
    expect(shortSessionId("123456789012")).toBe("123456789012");
  });

  test("目录尾段", () => {
    expect(directoryTail("/Users/code/wps")).toBe("wps");
    expect(directoryTail("/Users/code/wps/")).toBe("wps");
    expect(directoryTail("/")).toBeUndefined();
    expect(directoryTail(undefined)).toBeUndefined();
  });
});

describe("排序", () => {
  test("按活动时间降序", () => {
    const sorted = sortByActivityDesc([
      item({ id: "old", activityAt: NOW - DAY }),
      item({ id: "new", activityAt: NOW }),
      item({ id: "mid", activityAt: NOW - HOUR }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["new", "mid", "old"]);
  });

  test("同一时刻用 id 兜底，保证顺序稳定（分页不会漏/重）", () => {
    const a = sortByActivityDesc([item({ id: "b" }), item({ id: "a" }), item({ id: "c" })]);
    const b = sortByActivityDesc([item({ id: "c" }), item({ id: "a" }), item({ id: "b" })]);
    expect(a.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(b.map((i) => i.id)).toEqual(a.map((i) => i.id));
  });

  test("不改动入参", () => {
    const input = [item({ id: "b" }), item({ id: "a" })];
    const snapshot = [...input];
    sortByActivityDesc(input);
    expect(input).toEqual(snapshot);
  });
});

describe("分页", () => {
  const many = Array.from({ length: 21 }, (_, i) =>
    item({ id: `s${String(i).padStart(2, "0")}`, activityAt: NOW - i * MIN }),
  );

  test("页数 = ceil(total/size)，最小 1", () => {
    expect(paginate(many, 0, 8, NOW).pageCount).toBe(3);
    expect(paginate([], 0, 8, NOW).pageCount).toBe(1);
  });

  test("序号跨页连续（第 2 页从 9 开始）", () => {
    const page1 = paginate(many, 1, 8, NOW);
    expect(page1.rows[0]?.index).toBe(9);
    expect(page1.rows).toHaveLength(8);
    const page2 = paginate(many, 2, 8, NOW);
    expect(page2.rows[0]?.index).toBe(17);
    expect(page2.rows).toHaveLength(5);
  });

  test("页码越界夹取到合法范围，不抛", () => {
    expect(paginate(many, 99, 8, NOW).page).toBe(2);
    expect(paginate(many, -5, 8, NOW).page).toBe(0);
  });

  test("翻页不重不漏：三页 id 合起来等于全量", () => {
    const ids = [0, 1, 2].flatMap((p) => paginate(many, p, 8, NOW).rows.map((r) => r.id));
    expect(ids).toEqual(many.map((i) => i.id));
  });

  test("pageSize 非法时至少为 1", () => {
    expect(paginate(many, 0, 0, NOW).rows).toHaveLength(1);
  });
});

describe("行渲染", () => {
  test("形状与上游一致：序号 + 标题 + 短id + 标记", () => {
    const page = paginate(
      [item({ id: "ses_abcdefghijkl", title: "修复编译报错", cwd: "/Users/code/wps", bound: true, active: true })],
      0,
      8,
      NOW,
    );
    const line = sessionRowLine(page.rows[0]!);
    expect(line).toBe("1. 修复编译报错（`ses_abcdefgh…`）· 刚刚 · 💬 已绑话题 · 📍 wps · ← 当前");
  });

  test("未绑话题时不出现「已绑话题」；未命名回退 (未命名)", () => {
    const page = paginate([item({ id: "x" })], 0, 8, NOW);
    const line = sessionRowLine(page.rows[0]!);
    expect(line).toContain("(未命名)");
    expect(line).not.toContain("已绑话题");
    expect(line).not.toContain("← 当前");
    expect(line).not.toContain("📍");
  });
});
