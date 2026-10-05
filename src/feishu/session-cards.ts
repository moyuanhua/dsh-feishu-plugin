/**
 * 会话列表卡（`/sessions`、AI 的 `intent=list`、列表翻页共用）。
 *
 * 形状对齐上游 `session-cards.ts:83-155`，便于两版对照：
 * 头 `🧩 飞书会话（全部）`、每行「序号 + 标题 + 短 id + 相对时间 + 标记」+ 右侧一个按钮、
 * 页脚三个按钮、末尾一行注记 `第 X/Y 页 · 共 N 个会话`。
 *
 * 与上游的差异：
 * - 数据来自 `ctx.sessionQuery`（我们不再维护镜像），所以"行"由 `session-catalog.ts` 算出；
 * - 空列表时不再提示"直接在话题里发消息自动创建"，而是直接给「新建会话」按钮
 *   （下游动作更明确，少一步困惑）。
 */
import { cardButton, MAX_CARD_BYTES, truncateCardContent } from "./cards.js";
import { sessionRowLine, type CatalogPage } from "../bridge/session-catalog.js";
import type { TopicStatusView } from "../bridge/topic-status.js";
import type { SessionRootCardBase } from "../types.js";

/** 列表卡上的按钮回调值。 */
export interface SessionListAction {
  readonly cmd: "open" | "list" | "new";
  /** `open` 用：目标会话 id。 */
  readonly s?: string;
  /** `open` 用：所属聊天。 */
  readonly c?: string;
  /** `list` 用：目标页（0-based）。 */
  readonly p?: number;
}

export interface SessionListCardInput {
  readonly page: CatalogPage;
  readonly chatId: string;
}

const EMPTY_TEXT = "还没有会话。点下方「➕ 新建会话」创建。";

/** 渲染一页会话列表。 */
export function buildSessionListCard(input: SessionListCardInput): object {
  const { page, chatId } = input;
  const elements: object[] = [];

  if (page.rows.length === 0) {
    elements.push({ tag: "markdown", content: EMPTY_TEXT });
  } else {
    page.rows.forEach((row, i) => {
      if (i > 0) elements.push({ tag: "hr" });
      elements.push({
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "8px",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 5,
            vertical_align: "center",
            elements: [{ tag: "markdown", content: truncateCardContent(sessionRowLine(row)) }],
          },
          {
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [
              cardButton(
                row.bound ? "▶️ 再开" : "▶️ 进入",
                row.active ? "primary" : "default",
                { cmd: "open", s: row.id, c: chatId } satisfies SessionListAction,
              ),
            ],
          },
        ],
      });
    });
  }

  const footer: object[] = [];
  if (page.page > 0) {
    footer.push(
      cardButton("⬅️ 上一页", "default", { cmd: "list", p: page.page - 1 } satisfies SessionListAction),
    );
  }
  if (page.page + 1 < page.pageCount) {
    footer.push(
      cardButton("➡️ 下一页", "default", { cmd: "list", p: page.page + 1 } satisfies SessionListAction),
    );
  }
  footer.push(cardButton("➕ 新建会话", "primary", { cmd: "new" } satisfies SessionListAction));
  elements.push({ tag: "column_set", flex_mode: "flow", columns: footer.map(footerColumn) });

  if (page.total > 0) {
    elements.push({
      tag: "markdown",
      text_size: "notation",
      content: `第 ${page.page + 1}/${page.pageCount} 页 · 共 ${page.total} 个会话`,
    });
  }

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "🧩 飞书会话（全部）" }, template: "blue" },
    body: { elements: elements.slice(0, 200) },
  };
}

function footerColumn(button: object): object {
  return {
    tag: "column",
    width: "auto",
    vertical_align: "center",
    elements: [button],
  };
}

/**
 * 话题根卡。
 *
 * 根卡是"话题挂在哪条消息上"的那条消息，所以它的内容要能反复重渲而不丢信息 ——
 * 基线（title/dir/model/权限/摘要）来自 `SessionLink.rootCard`，状态来自当前档位。
 *
 * 与上游一致：**默认不改标题**，状态只用 header 颜色 + 页脚一行表达，
 * 避免侧栏话题名随状态抖动。
 */
export function buildSessionRootCard(
  base: SessionRootCardBase,
  status: TopicStatusView,
): object {
  const title = base.title.trim() || "(未命名会话)";
  const headerText = base.style === "resumed" ? `🔄 ${title}` : `✅ 已创建 · ${title}`;
  const lines: string[] = [`会话「${title}」：\`${base.sessionID}\``];
  if (base.dir) lines.push(`- 目录：\`${base.dir}\``);
  if (base.model) lines.push(`- 模型：\`${base.model}\``);
  if (base.perm) lines.push(`- 权限：${base.perm}`);
  if (base.summary) {
    lines.push("", `**${base.summaryLabel ?? "会话摘要"}**`, base.summary);
  } else if (base.summaryPending) {
    lines.push("", "_正在整理摘要…_");
  }
  if (base.note) lines.push("", base.note);

  // `openedTopic` 只在"确实开好了话题"时为 true；缺省按"回复即进入"提示更稳妥。
  const opened = base.openedTopic === true;
  lines.push(
    "",
    opened
      ? "**在本话题内直接发消息**，会话就在那里干活。"
      : "**回复本条消息**即可继续这个会话（回复即进入它的话题）。",
    "",
    `话题内可用：\`/current\` \`/stop\` \`/steer\` \`/perm\` \`/help\`。`,
    "会话管理（`/new` `/sessions` `/use`）请回到主聊天流。",
  );

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: headerText }, template: status.color },
    body: {
      elements: [
        { tag: "markdown", content: truncateCardContent(lines.join("\n"), MAX_CARD_BYTES) },
        // 状态单独一行 notation（与上游的根卡状态行一致）。
        { tag: "markdown", text_size: "notation", content: status.footer },
      ],
    },
  };
}

/**
 * 会话列表卡的按钮回调值。
 *
 * 与上游的差异（缺陷修复）：上游是「任何带 `formValue` 的动作都当成建会话提交」，
 * 这里要求 `cmd` 精确命中，因此不会误触。
 */
export function parseSessionListAction(raw: unknown): SessionListAction | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const cmd = value.cmd;
  if (cmd === "new") return { cmd: "new" };
  if (cmd === "list") {
    const page = typeof value.p === "number" ? value.p : Number(value.p);
    return { cmd: "list", p: Number.isFinite(page) ? page : 0 };
  }
  if (cmd === "open") {
    const sessionId = typeof value.s === "string" ? value.s : undefined;
    const chatId = typeof value.c === "string" ? value.c : undefined;
    if (!sessionId || !chatId) return undefined;
    return { cmd: "open", s: sessionId, c: chatId };
  }
  return undefined;
}

/** 会话已不存在（点击进入时探活失败）。 */export function buildSessionMissingCard(sessionID: string, reason?: string): object {
  const body = [
    `会话 \`${sessionID}\` 不存在或不可用（可能已被删除，或不属于本机可见范围）。`,
    "",
    "发送 `/sessions` 重新获取列表。",
  ];
  if (reason) body.push("", `原因：${reason}`);
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "⚠️ 会话不存在" }, template: "orange" },
    body: { elements: [{ tag: "markdown", content: truncateCardContent(body.join("\n"), MAX_CARD_BYTES) }] },
  };
}
