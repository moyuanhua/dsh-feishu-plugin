/**
 * 会话卡片规格：列表卡 / 根卡 / 不存在卡 / 按钮解析。
 *
 * 重点是**回调值与按钮文案**：列表卡的 `open`/`list`/`new` 三个动作必须能原样回传，
 * 否则用户点了没反应（上游就踩过"表单提交检测过宽"的坑）。
 */
import { describe, expect, test } from "vitest";
import {
  buildSessionListCard,
  buildSessionMissingCard,
  buildSessionRootCard,
  parseSessionListAction,
  type SessionListAction,
} from "../src/feishu/session-cards.js";
import { paginate, type CatalogInput } from "../src/bridge/session-catalog.js";
import { topicStatusView } from "../src/bridge/topic-status.js";
import type { SessionRootCardBase } from "../src/types.js";

const NOW = 1_700_000_000_000;

function items(n: number): CatalogInput[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ses_${String(i).padStart(4, "0")}abcdef`,
    createdAt: NOW - i * 60_000,
    activityAt: NOW - i * 60_000,
    title: `会话 ${i}`,
    cwd: `/Users/code/p${i}`,
  }));
}

/** 卡片里所有按钮的 value。 */
function buttons(card: object): SessionListAction[] {
  const out: SessionListAction[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    const obj = node as Record<string, unknown>;
    if (obj.tag === "button") {
      // cardButton 把回调值放在 behaviors[].value（卡片 2.0 的写法）。
      const behaviors = obj.behaviors;
      if (Array.isArray(behaviors)) {
        for (const b of behaviors) {
          const value = (b as { value?: unknown } | undefined)?.value;
          if (value) out.push(value as SessionListAction);
        }
      }
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(card);
  return out;
}

describe("buildSessionListCard", () => {
  test("每行一个 open 按钮，值是 {cmd:open,s,c}", () => {
    const page = paginate(items(3), 0, 8, NOW);
    const card = buildSessionListCard({ page, chatId: "oc_1" });
    const opens = buttons(card).filter((b) => b.cmd === "open");
    expect(opens).toHaveLength(3);
    expect(opens[0]).toEqual({ cmd: "open", s: "ses_0000abcdef", c: "oc_1" });
  });

  test("已绑话题 → 「再开」；未绑 → 「进入」", () => {
    const bound = paginate([{ ...items(1)[0]!, bound: true }], 0, 8, NOW);
    const unbound = paginate([items(1)[0]!], 0, 8, NOW);
    expect(JSON.stringify(buildSessionListCard({ page: bound, chatId: "c" }))).toContain("再开");
    expect(JSON.stringify(buildSessionListCard({ page: unbound, chatId: "c" }))).toContain("进入");
  });

  test("当前会话的按钮用 primary", () => {
    const page = paginate([{ ...items(1)[0]!, active: true }], 0, 8, NOW);
    const card = JSON.stringify(buildSessionListCard({ page, chatId: "c" }));
    expect(card).toContain('"primary"');
  });

  test("首页：没有上一页，有下一页与新建", () => {
    const cmds = buttons(buildSessionListCard({ page: paginate(items(20), 0, 8, NOW), chatId: "c" })).map((b) => b.cmd);
    expect(cmds).toContain("list");
    expect(cmds).toContain("new");
    expect(JSON.stringify(buildSessionListCard({ page: paginate(items(20), 0, 8, NOW), chatId: "c" }))).not.toContain("上一页");
  });

  test("中间页：上下页都有", () => {
    const card = JSON.stringify(buildSessionListCard({ page: paginate(items(20), 1, 8, NOW), chatId: "c" }));
    expect(card).toContain("上一页");
    expect(card).toContain("下一页");
  });

  test("末页：没有下一页", () => {
    const card = JSON.stringify(buildSessionListCard({ page: paginate(items(10), 1, 8, NOW), chatId: "c" }));
    expect(card).toContain("上一页");
    expect(card).not.toContain("下一页");
  });

  test("注记行显示页码与总数", () => {
    const card = JSON.stringify(buildSessionListCard({ page: paginate(items(21), 0, 8, NOW), chatId: "c" }));
    expect(card).toContain("第 1/3 页 · 共 21 个会话");
  });

  test("空列表：给引导文案与「新建会话」，且没有注记行", () => {
    const card = JSON.stringify(buildSessionListCard({ page: paginate([], 0, 8, NOW), chatId: "c" }));
    expect(card).toContain("还没有会话");
    expect(card).toContain("➕ 新建会话");
    expect(card).not.toContain("共 0 个会话");
  });
});

describe("parseSessionListAction（精确判定，避免误触）", () => {
  test("三个动作都能解析", () => {
    expect(parseSessionListAction({ cmd: "new" })).toEqual({ cmd: "new" });
    expect(parseSessionListAction({ cmd: "list", p: 2 })).toEqual({ cmd: "list", p: 2 });
    expect(parseSessionListAction({ cmd: "open", s: "x", c: "y" })).toEqual({ cmd: "open", s: "x", c: "y" });
  });

  test("list 页码缺省/非法 → 0", () => {
    expect(parseSessionListAction({ cmd: "list" })).toEqual({ cmd: "list", p: 0 });
    expect(parseSessionListAction({ cmd: "list", p: "3" })).toEqual({ cmd: "list", p: 3 });
    expect(parseSessionListAction({ cmd: "list", p: "abc" })).toEqual({ cmd: "list", p: 0 });
  });

  test("open 缺字段 → undefined（宁可不响应，也不要跳到错的会话）", () => {
    expect(parseSessionListAction({ cmd: "open", s: "x" })).toBeUndefined();
    expect(parseSessionListAction({ cmd: "open", c: "y" })).toBeUndefined();
  });

  test("其它形状（审批 / 强停 / 表单）一律不认领", () => {
    expect(parseSessionListAction({ kind: "stop", token: "t" })).toBeUndefined();
    expect(parseSessionListAction({ f: "form", k: "dir", v: "/a" })).toBeUndefined();
    expect(parseSessionListAction({ t: "tok", d: "once" })).toBeUndefined();
    expect(parseSessionListAction(undefined)).toBeUndefined();
    expect(parseSessionListAction(null)).toBeUndefined();
    expect(parseSessionListAction("string")).toBeUndefined();
  });
});

describe("buildSessionRootCard", () => {
  const base: SessionRootCardBase = {
    style: "created",
    sessionID: "ses_1",
    title: "修复编译报错",
    dir: "/Users/code/wps",
    model: "opencode-go/deepseek-v4.1-flash",
    perm: "edit",
  };

  test("标题只在 header（不重复进正文）", () => {
    const card = buildSessionRootCard(base, topicStatusView({ running: true, queued: 0 }, NOW));
    const text = JSON.stringify(card);
    const header = (card as { header: { title: { content: string } } }).header.title.content;
    expect(header).toBe("✅ 已创建 · 修复编译报错");
    expect(text.split("修复编译报错").length - 1).toBe(2); // header + 正文各一次
  });

  test("resumed 风格用 🔄 前缀", () => {
    const card = buildSessionRootCard(
      { ...base, style: "resumed" },
      topicStatusView({ running: false, queued: 0 }, NOW),
    );
    expect((card as { header: { title: { content: string } } }).header.title.content).toBe("🔄 修复编译报错");
  });

  test("状态决定 header 颜色与页脚", () => {
    const running = buildSessionRootCard(base, topicStatusView({ running: true, queued: 0 }, NOW)) as {
      header: { template: string };
    };
    expect(running.header.template).toBe("blue");
    const reviewing = buildSessionRootCard(
      base,
      topicStatusView({ running: false, queued: 0, review: "shell" }, NOW),
    ) as { header: { template: string } };
    expect(reviewing.header.template).toBe("orange");
  });

  test("带摘要时渲染摘要标题", () => {
    const text = JSON.stringify(
      buildSessionRootCard(
        { ...base, summary: "目标：修编译", summaryLabel: "会话摘要" },
        topicStatusView({ running: false, queued: 0 }, NOW),
      ),
    );
    expect(text).toContain("会话摘要");
    expect(text).toContain("目标：修编译");
  });

  test("摘要未就绪时给占位，不显示空标题", () => {
    const text = JSON.stringify(
      buildSessionRootCard(
        { ...base, summaryPending: true },
        topicStatusView({ running: false, queued: 0 }, NOW),
      ),
    );
    expect(text).toContain("正在整理摘要");
  });

  test("未确认开好话题时提示「回复本条消息」（更稳）", () => {
    const text = JSON.stringify(
      buildSessionRootCard(base, topicStatusView({ running: false, queued: 0 }, NOW)),
    );
    expect(text).toContain("回复本条消息");
  });

  test("确认开好话题时提示「在本话题内直接发消息」", () => {
    const text = JSON.stringify(
      buildSessionRootCard(
        { ...base, openedTopic: true },
        topicStatusView({ running: false, queued: 0 }, NOW),
      ),
    );
    expect(text).toContain("在本话题内直接发消息");
  });
});

describe("buildSessionMissingCard", () => {
  test("头是橙色的「会话不存在」，带 id 与重试指引", () => {
    const card = buildSessionMissingCard("ses_gone") as {
      header: { title: { content: string }; template: string };
    };
    expect(card.header.title.content).toBe("⚠️ 会话不存在");
    expect(card.header.template).toBe("orange");
    const text = JSON.stringify(card);
    expect(text).toContain("ses_gone");
    expect(text).toContain("/sessions");
  });

  test("可附原因", () => {
    expect(JSON.stringify(buildSessionMissingCard("x", "网络超时"))).toContain("网络超时");
  });
});
