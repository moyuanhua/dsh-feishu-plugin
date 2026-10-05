/**
 * 卡片内容守卫（纯函数，无 IO，可单测）。
 *
 * 背景（上游线上 BUG 复述）：飞书**单张卡片最多支持 5 个表格组件**（《表格组件》注意事项：
 * 「单张卡片最多支持放置五个表格组件。若卡片配置了多语言，则单个语言最多支持放置五个表格组件。」），
 * 超限时 `im.message.patch` 直接 400 `code=230099`（子错误 "card table number over limit"）。
 * markdown 富文本里渲染出的表格同样计入该额度，因此本模块把超出的 markdown 表格**降级为围栏代码块**
 * （内容一字不丢，只是不再被飞书当成表格）。
 *
 * 一并查证、写进这里免得下游再翻文档的上限：
 * - 组件/元素 ≤ 200（《卡片 JSON 2.0 结构》：「一张卡片最多支持 200 个元素（如 tag 为 plain_text
 *   的文本元素）或组件」；错误码 300305）。
 * - 卡片请求体 ≤ 30KB（《发送消息》：卡片及富文本消息 30KB；错误码 230025）——字节截断见 cards.ts。
 * - 同一张卡片的卡片级/组件级 OpenAPI 更新频率 ≤ 10 次/秒（《流式更新卡片》）。
 *
 * 关键正确性：**围栏代码块内的 `|` 绝不被识别为表格**（见 `computeFenceMask`），
 * 因此降级后（围栏代码块）再处理是幂等的，不会反复降级。
 *
 * 移植来源：opencode-feishu-plugin（MIT，Copyright (c) 2026 moyuanhua）
 * 原文件：src/feishu/card-limits.ts
 * 适配说明：
 * - `degradeExtraTables` 按本仓库契约只返回**降级后的字符串**（上游返回 `{ text, degraded }`）；
 *   需要降级数量时用同样导出的 `degradeExtraTablesDetailed`。
 * - `enforceCardLimits` 按契约直接返回**新卡片对象**（上游返回 `{ card, report }`）；
 *   需要统计上报（日志/埋点）的调用方改用新增的 `enforceCardLimitsWithReport`。
 * - `toCardMarkdown` 的共享额度参数改为可选：`toCardMarkdown(md)` 仍按契约可用（等价于一次性
 *   额度 4），传 `budget` 时沿用上游「整卡多个 markdown 元素共享额度」的语义。
 * - 内容被改动（降级表格 / 丢弃组件）时**追加一行省略说明**（契约要求；上游不追加），
 *   追加时复用 cards.ts 的字节截断，保证正文仍 ≤ `MAX_CARD_BYTES`。
 * - 文档结论与上游实现一致（硬限 5 / 组件 200），未发现需要推翻上游的冲突点。
 */
import { MAX_CARD_BYTES, truncateCardContent } from "./cards.js";

/** 默认单卡最多保留的 markdown 表格数（留 1 个余量给同卡其它表格来源）。 */
export const DEFAULT_CARD_MAX_TABLES = 4;
/** 配置夹取范围：至少 1，飞书硬上限 5（《表格组件》）。 */
export const CARD_MAX_TABLES_MIN = 1;
export const CARD_MAX_TABLES_MAX = 5;
/** 单卡组件数软上限（《卡片 JSON 2.0 结构》硬限 200）；超出则丢弃最旧元素。 */
export const DEFAULT_CARD_MAX_ELEMENTS = 200;

/** markdown 表格块的行区间（0-based，闭区间）。 */
export interface MarkdownTableSpan {
  /** 表头行索引。 */
  readonly start: number;
  /** 最后一个正文行索引（单列表格时等于分隔行）。 */
  readonly end: number;
}

/** 累计表格额度：多个 markdown 元素共用一个 `CardMarkdownBudget`。 */
export interface CardMarkdownBudget {
  readonly max: number;
  remaining: number;
  /** 累计识别到的表格数。 */
  tables: number;
  /** 累计被降级（改为代码块）的表格数。 */
  degraded: number;
}

export interface CardLimitOptions {
  /** 单卡保留的 markdown 表格数上限（夹取到 1–5，缺省 4）。 */
  readonly maxTables?: number;
  /** 单卡组件/元素数上限（缺省 200）。 */
  readonly maxElements?: number;
}

export interface CardLimitReport {
  /** 整卡累计识别到的表格数。 */
  readonly tables: number;
  /** 整卡累计被降级的表格数。 */
  readonly degradedTables: number;
  /** 处理后整卡组件数。 */
  readonly elements: number;
  /** 因超过组件数上限而丢弃的元素数（从最旧开始丢）。 */
  readonly droppedElements: number;
}

export interface CardLimitResult {
  readonly card: object;
  readonly report: CardLimitReport;
}

/** 把配置值夹取到合法范围（1–5），非法值回退默认 4。 */
export function clampMaxTables(value: number | undefined): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_CARD_MAX_TABLES;
  return Math.min(CARD_MAX_TABLES_MAX, Math.max(CARD_MAX_TABLES_MIN, n));
}

export function createCardMarkdownBudget(max: number = DEFAULT_CARD_MAX_TABLES): CardMarkdownBudget {
  const clamped = clampMaxTables(max);
  return { max: clamped, remaining: clamped, tables: 0, degraded: 0 };
}

/**
 * 识别 markdown 表格块。
 *
 * 规则（与 GFM 对齐的保守实现）：
 * - 一个表格块 = 「含 `|` 的表头行」+「分隔行」+「若干含 `|` 的正文行」；
 * - 分隔行：至少 1 个 `|`，且每个单元格形如 `:?-+:?`；
 * - **忽略围栏代码块（``` / ~~~）内的所有行**——这是「代码块内 `|` 不误判」的关键；
 * - 正文行遇到空行 / 不含 `|` / 新的分隔行即结束。
 */
export function findMarkdownTables(text: string): MarkdownTableSpan[] {
  if (!text || !text.includes("|")) return [];
  const lines = text.split("\n");
  const fence = computeFenceMask(lines);
  const spans: MarkdownTableSpan[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (fence[i] || !isSeparatorRow(line)) {
      i += 1;
      continue;
    }
    // 分隔行必须在表头行之后，且表头行本身含 `|`、不在代码块内、不是分隔行。
    if (i === 0 || fence[i - 1]) {
      i += 1;
      continue;
    }
    const header = lines[i - 1]!;
    if (header.trim() === "" || !header.includes("|") || isSeparatorRow(header)) {
      i += 1;
      continue;
    }
    let end = i;
    let j = i + 1;
    while (j < lines.length && !fence[j]) {
      const body = lines[j]!;
      if (body.trim() === "" || !body.includes("|") || isSeparatorRow(body)) break;
      end = j;
      j += 1;
    }
    spans.push({ start: i - 1, end });
    i = end + 1;
  }
  return spans;
}

/** 统计文本里的 markdown 表格块数量（代码块内的 `|` 不算）。 */
export function countMarkdownTables(text: string): number {
  return findMarkdownTables(text).length;
}

/**
 * 保留前 `max` 个表格，其余**降级为围栏代码块**，返回降级后的文本与被降级的表格数。
 * 未超限时原样返回且 `degraded = 0`；`max` 传 0 表示全部降级（不做 1–5 夹取，尊重显式传入值）。
 */
export function degradeExtraTablesDetailed(
  text: string,
  max: number = DEFAULT_CARD_MAX_TABLES,
): { text: string; degraded: number } {
  const keep = normalizeKeep(max);
  const spans = findMarkdownTables(text);
  if (spans.length <= keep) return { text, degraded: 0 };

  const extras = spans.slice(keep);
  const starts = new Set(extras.map((span) => span.start));
  const ends = new Set(extras.map((span) => span.end));
  // 选一个不会与正文冲突的围栏符号（正文已含 ``` 则用 ~~~）。
  const fence = text.includes("```") ? "~~~" : "```";

  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (starts.has(i)) out.push(fence);
    out.push(lines[i]!);
    if (ends.has(i)) out.push(fence);
  }
  return { text: out.join("\n"), degraded: extras.length };
}

/** 契约入口：只返回降级后的文本（降级数量见 `degradeExtraTablesDetailed`）。 */
export function degradeExtraTables(markdown: string, maxTables: number = DEFAULT_CARD_MAX_TABLES): string {
  return degradeExtraTablesDetailed(markdown, maxTables).text;
}

/**
 * 对单段 markdown 应用**共享额度**：识别到的表格先消耗 `budget.remaining`，超出的部分降级。
 * 返回处理后的文本（传了 `budget` 时**就地更新**它）。不传预算 = 一次性额度 4。
 */
export function toCardMarkdown(
  markdown: string,
  budget: CardMarkdownBudget = createCardMarkdownBudget(),
): string {
  const spans = findMarkdownTables(markdown);
  if (spans.length === 0) return markdown;
  budget.tables += spans.length;
  const keep = Math.max(0, Math.min(spans.length, budget.remaining));
  budget.remaining -= keep;
  if (keep === spans.length) return markdown;
  budget.degraded += spans.length - keep;
  return degradeExtraTablesDetailed(markdown, keep).text;
}

/** 契约入口：返回**新卡片**（不可变），需要统计上报时用 `enforceCardLimitsWithReport`。 */
export function enforceCardLimits(card: object, options: CardLimitOptions = {}): object {
  return enforceCardLimitsWithReport(card, options).card;
}

/**
 * 整卡守卫：对卡片内**所有** markdown 元素按出现顺序累计表格额度（整卡共享），
 * 并把组件数收敛到上限内（超限丢弃最旧元素），最后在内容被改动时追加一行省略说明。
 *
 * 纯函数：返回**新卡片 + 统计报告**（深拷贝后处理），不修改入参。
 */
export function enforceCardLimitsWithReport(card: object, options: CardLimitOptions = {}): CardLimitResult {
  const maxTables = clampMaxTables(options.maxTables);
  const maxElements = normalizeMaxElements(options.maxElements);

  const clone = deepClone(card);
  const budget = createCardMarkdownBudget(maxTables);
  visitMarkdown(clone, (content) => toCardMarkdown(content, budget));

  const body = (clone as { body?: { elements?: unknown[] } }).body;
  let elements = countElements(clone);
  let dropped = 0;
  if (elements > maxElements && body && Array.isArray(body.elements)) {
    // 从最旧开始丢，保留最新的内容（越新的内容越接近用户当下关心的状态）。
    while (elements > maxElements && body.elements.length > 1) {
      body.elements.shift();
      dropped += 1;
      elements = countElements(clone);
    }
  }

  if (budget.degraded > 0 || dropped > 0) {
    const note = buildOmissionNote(budget.degraded, dropped);
    if (!appendOmissionNote(clone, note) && body && Array.isArray(body.elements) && elements < maxElements) {
      // 卡片里没有 markdown 元素（例如全是按钮）：还有额度就新加一个说明元素。
      body.elements.push({ tag: "markdown", content: note.trim() });
      elements += 1;
    }
  }

  return {
    card: clone,
    report: { tables: budget.tables, degradedTables: budget.degraded, elements, droppedElements: dropped },
  };
}

/** 「省略说明」脚注：内容被自动收敛时告诉用户「少的那部分去哪了」，避免被当成卡死。 */
function buildOmissionNote(degradedTables: number, droppedElements: number): string {
  const parts: string[] = [];
  if (degradedTables > 0) parts.push(`${degradedTables} 个表格超出单卡 5 个表格上限，已降级为代码块`);
  if (droppedElements > 0) parts.push(`已从最早的组件起省略 ${droppedElements} 个组件以满足 200 组件上限`);
  return `\n\n*（部分内容超出飞书卡片上限：${parts.join("；")}）*`;
}

/** 把脚注贴到最新的 markdown 元素末尾（复用 cards.ts 的字节截断，保证不超过 28KB）。 */
function appendOmissionNote(card: object, note: string): boolean {
  const target = findLastMarkdown(card);
  if (!target || typeof target.content !== "string") return false;
  const budget = Math.max(0, MAX_CARD_BYTES - Buffer.byteLength(note, "utf8"));
  target.content = `${truncateCardContent(target.content, budget)}${note}`;
  return true;
}

/** 深度优先找**最后一个** markdown 元素（即视觉上最靠下的那个）。 */
function findLastMarkdown(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    let found: Record<string, unknown> | undefined;
    for (const item of node) {
      const hit = findLastMarkdown(item);
      if (hit) found = hit;
    }
    return found;
  }
  const rec = node as Record<string, unknown>;
  let found: Record<string, unknown> | undefined =
    rec.tag === "markdown" && typeof rec.content === "string" ? rec : undefined;
  for (const value of Object.values(rec)) {
    const hit = findLastMarkdown(value);
    if (hit) found = hit;
  }
  return found;
}

/** 遍历卡片内所有 `{tag:"markdown", content}` 节点，就地替换 `content`。 */
function visitMarkdown(node: unknown, fn: (content: string) => string): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) visitMarkdown(item, fn);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (rec.tag === "markdown" && typeof rec.content === "string") {
    rec.content = fn(rec.content);
  }
  for (const value of Object.values(rec)) visitMarkdown(value, fn);
}

/**
 * 统计卡片内带 `tag` 的组件/元素数。
 * 飞书的计数口径是「元素（如 tag 为 plain_text 的文本元素）或组件」之和，所以这里的递归
 * 会把 `text: {tag:"plain_text"}` 这类嵌套元素也算进去——与文档口径一致（宁严不宽）。
 */
function countElements(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    let total = 0;
    for (const item of node) total += countElements(item);
    return total;
  }
  const rec = node as Record<string, unknown>;
  let total = typeof rec.tag === "string" ? 1 : 0;
  for (const value of Object.values(rec)) total += countElements(value);
  return total;
}

/** 逐行标记是否处于围栏代码块内（``` / ~~~，允许最多 3 空格缩进）。 */
function computeFenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = [];
  let fenceChar: "`" | "~" | undefined;
  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const marker = match?.[1];
    const char = marker?.[0] as "`" | "~" | undefined;
    if (char && (!fenceChar || fenceChar === char)) {
      // 开启或关闭围栏：该行本身视为「代码块内」，避免把围栏行当表格。
      fenceChar = fenceChar ? undefined : char;
      mask.push(true);
      continue;
    }
    mask.push(fenceChar !== undefined);
  }
  return mask;
}

/**
 * 单独一行是否是 markdown 表格分隔行：
 * 至少含 1 个 `|`，且去掉首尾 `|` 后每个单元格都形如 `:?-+:?`。
 */
function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = inner.split("|").map((cell) => cell.trim());
  if (cells.length < 1) return false;
  return cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** 组件数上限：非法值回退 200，至少 1。 */
function normalizeMaxElements(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : DEFAULT_CARD_MAX_ELEMENTS;
}

/** 保留的表格数：非法值回退默认 4，至少 0（0 = 全部降级）。 */
function normalizeKeep(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_CARD_MAX_TABLES;
}

/** 卡片是纯 JSON（无 Date/Map/函数），JSON 往返克隆即可，避免与入参共享引用。 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
