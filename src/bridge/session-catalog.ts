/**
 * 会话目录 —— **纯函数**：把宿主会话 + 标题 + 绑定关系合成"会话列表卡"要的行。
 *
 * 上游对应物是 `src/feishu/session-list.ts` + `src/feishu/session-cards.ts` 的一半，
 * 但它要处理三种来源、四套字段别名、七种时间格式（因为 opencode 各版本返回的形状不同）。
 * 我们只有一个来源（`ctx.sessionQuery`），所以这里只做**三件真事**：
 *
 * 1. **过滤**：子 agent 会话不进列表（`origin === 'subagent'` 或有 `parentSession`）；
 * 2. **排序**：按"最后活动"降序 —— dsh 没有这个字段，`lastActivityAt` 由我们从
 *    `session/event` 自建（见 `SessionLink.lastActivityAt`）；没有记录的（纯 GUI 会话）
 *    回退 `createdAt`；
 * 3. **分页与行渲染**：序号跨页连续，行内标记与上游一致（便于对照）。
 *
 * 时间、绑定查询都从参数注入，因此本模块零 IO、可完整单测。
 */

/** 参与排序与渲染的一条会话。 */
export interface CatalogInput {
  readonly id: string;
  readonly createdAt: number;
  /** 由 `lastActivityAt` 或 `createdAt` 得来（调用方决定）。 */
  readonly activityAt: number;
  readonly title?: string;
  readonly cwd?: string;
  /** 是否已绑定飞书话题。 */
  readonly bound?: boolean;
  /** 是否是该聊天当前的会话。 */
  readonly active?: boolean;
}

/** 渲染就绪的一行。 */
export interface CatalogRow {
  /** 1-based，**跨页连续**（与上游一致）。 */
  readonly index: number;
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly relativeTime: string;
  readonly bound: boolean;
  readonly active: boolean;
  /** 目录尾段（用于 `📍` 标记）。 */
  readonly directoryTail?: string;
}

export interface CatalogPage {
  readonly rows: readonly CatalogRow[];
  /** 0-based，已夹取到合法范围。 */
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
}

/** 会话 id 的短展示形式（卡片空间有限）。 */
export function shortSessionId(sessionID: string): string {
  return sessionID.length <= 12 ? sessionID : `${sessionID.slice(0, 12)}…`;
}

/** 目录尾段：`/Users/code/wps` → `wps`。 */
export function directoryTail(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const parts = dir.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

/** 相对时间。`0` 视为未知（与上游一致）。 */
export function relativeTime(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return "时间未知";
  const delta = now - at;
  if (delta < 60_000) return "刚刚";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 排序：活动时间降序；同一时刻用 id 兜底，保证**同一输入永远同一顺序**
 * （分页要稳定，否则翻页会看到重复/遗漏）。
 */
export function sortByActivityDesc(items: readonly CatalogInput[]): CatalogInput[] {
  return [...items].sort((a, b) => {
    if (b.activityAt !== a.activityAt) return b.activityAt - a.activityAt;
    return a.id.localeCompare(b.id);
  });
}

/** 渲染一行（与上游 `sessionRowLine` 同形）。 */
export function sessionRowLine(row: CatalogRow): string {
  const marks = [row.relativeTime];
  if (row.bound) marks.push("💬 已绑话题");
  if (row.directoryTail) marks.push(`📍 ${row.directoryTail}`);
  if (row.active) marks.push("← 当前");
  const title = row.title.trim() || "(未命名)";
  return `${row.index}. ${title}（\`${row.shortId}\`）· ${marks.join(" · ")}`;
}

/** 分页：把整个目录切成某一页（页码越界会夹取，不抛）。 */
export function paginate(
  items: readonly CatalogInput[],
  page: number,
  pageSize: number,
  now: number,
): CatalogPage {
  const size = Math.max(1, Math.floor(pageSize));
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const slice = items.slice(safePage * size, safePage * size + size);

  const rows: CatalogRow[] = slice.map((item, offset) => ({
    index: safePage * size + offset + 1,
    id: item.id,
    shortId: shortSessionId(item.id),
    title: item.title ?? "",
    relativeTime: relativeTime(item.activityAt, now),
    bound: item.bound === true,
    active: item.active === true,
    ...(directoryTail(item.cwd) ? { directoryTail: directoryTail(item.cwd) } : {}),
  }));

  return { rows, page: safePage, pageCount, total };
}
