/**
 * 运行卡片渲染（**纯字符串函数**，无 IO、无时钟、可单测）。
 *
 * 本文件只负责「宿主无关的折叠与截断策略」，产出 markdown 文本；
 * **卡片 JSON（header / collapsible_panel / button 等）由调用方拼**，因此这里不 import 任何卡片构建模块。
 *
 * 渲染顺序（稳定、可断言，不含时间戳/随机内容）：
 *
 *   ⏳ **<title>**            ← 状态图标 + 标题
 *   ⚠️ <reason>              ← 仅有 reason 时
 *   <正文，按 maxTextChars 截断>
 *   <工具行 / 折叠摘要行>
 *   <footer>
 *   ⏹ 强制停止（token: …）    ← 仅运行中且给了 stop 时
 *
 * 折叠策略（对齐上游 run-renderer 的意图，但去掉卡片体积兜底）：
 * - 工具块超过 `maxToolBlocks` 时，**最旧**的若干块折叠成一行 `…另有 N 个工具调用`；
 * - 连续工具块数量 ≥ `collapseToolThreshold` 时合并为一行 `🔧 <name> ×N`（`<name>` 取该组最后一次调用的名字）；
 * - 终态时不再保留「最新一块的展开」：只要 ≥2 个工具就折叠为一行；单个工具没有可折叠的语义，仍单独成行；
 * - 正文超过 `maxTextChars` 时截断并追加 `…(已截断)`。
 *
 * 移植来源：opencode-feishu-plugin（MIT，Copyright (c) 2026 moyuanhua）
 * 原文件：src/feishu/run-renderer.ts
 * 适配说明：上游 `renderRunCard` 直接产出飞书卡片 JSON 2.0（collapsible_panel、表格数守卫
 * `enforceCardLimits`、30KB 体积兜底 `enforceSize`、强停按钮 stopValue），与本仓库即将引入的
 * 卡片构建层强耦合。这里只搬运其中**与宿主无关的策略**，并做如下简化：
 *   · 输出 markdown 字符串而不是卡片 JSON，面板/按钮/图标等结构交给调用方；
 *   · 去掉 `enforceSize` / `enforceCardLimits` / 表格降级 / 内联输入输出正文（上游 toolBody）——
 *     本仓库的 `detail` 已经是一句话摘要，无需再做代码块渲染；
 *   · 上游按 `ToolEntry.input` 的多字段启发式生成标题（command/file_path/query…），
 *     这里由事件生产方直接把摘要放进 `detail`（映射层职责，见 `src/bridge/run-state.ts`）。
 */
import { isTerminal, type RunState, type RunStatus } from "./run-state.js";

const DEFAULT_MAX_TEXT_CHARS = 2_048;
const DEFAULT_MAX_TOOL_BLOCKS = 12;
const DEFAULT_COLLAPSE_TOOL_THRESHOLD = 3;
/** 工具 detail 摘要的单行上限（对齐上游 TOOL_OUTPUT_MAX 的量级，避免整卡被长输出撑爆）。 */
const TOOL_DETAIL_MAX = 200;
/** 失败/停止原因的单行上限。 */
const REASON_MAX = 200;
const TRUNCATED_SUFFIX = "…(已截断)";

/** 运行状态图标（必现于首行，便于断言与扫读）。 */
const STATUS_ICON: Record<RunStatus, string> = {
  running: "⏳",
  done: "✅",
  failed: "❌",
  stopped: "⏹",
};

/** 单个工具块的图标（与运行状态图标区分：运行中的工具用 🔧）。 */
const TOOL_ICON: Record<"running" | "ok" | "error", string> = {
  running: "🔧",
  ok: "✅",
  error: "❌",
};

export interface RunRenderOptions {
  readonly title: string;
  readonly footer?: string;
  /** 运行中才渲染强停按钮（终态时忽略）。 */
  readonly stop?: { readonly token: string };
  /** 正文截断上限，默认 2048。 */
  readonly maxTextChars?: number;
  /** 最多单独渲染的工具块数，默认 12；更旧的折叠成一行摘要。 */
  readonly maxToolBlocks?: number;
  /** 连续工具块合并阈值，默认 3。 */
  readonly collapseToolThreshold?: number;
}

/** 正文截断：超限时截断并追加 `…(已截断)`（`max` 为 0 时只留后缀）。 */
function truncateText(text: string, max: number): string {
  const limit = Math.max(0, Math.floor(max));
  return text.length > limit ? `${text.slice(0, limit)}${TRUNCATED_SUFFIX}` : text;
}

/** 单行化 + 截断（折叠换行，避免工具摘要把卡片撑成多段）。 */
function truncateSingleLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 工具行渲染。本状态机里工具块不与正文交错（`RunState.tools` 是单一有序列表），
 * 因此「连续工具块」就是整段列表；若将来恢复交错块列表，只需在这里改成按段落分组。
 */
function renderToolLines(
  tools: RunState["tools"],
  options: { readonly maxToolBlocks: number; readonly collapseToolThreshold: number },
  terminal: boolean,
): string[] {
  const lines: string[] = [];
  const maxBlocks = Math.max(0, Math.floor(options.maxToolBlocks));
  const omitted = Math.max(0, tools.length - maxBlocks);
  if (omitted > 0) lines.push(`…另有 ${omitted} 个工具调用`);
  const kept = omitted > 0 ? tools.slice(omitted) : [...tools];
  if (kept.length === 0) return lines;

  const threshold = Math.max(1, Math.floor(options.collapseToolThreshold));
  const folded = terminal ? kept.length >= 2 : kept.length >= threshold;
  if (folded) {
    const last = kept[kept.length - 1]!;
    lines.push(`🔧 ${last.name} ×${kept.length}`);
    return lines;
  }
  for (const tool of kept) {
    const detail = tool.detail === undefined ? "" : truncateSingleLine(tool.detail, TOOL_DETAIL_MAX);
    lines.push(`${TOOL_ICON[tool.status]} ${tool.name}${detail ? ` — ${detail}` : ""}`);
  }
  return lines;
}

/**
 * 渲染整张运行卡的 markdown 正文。
 * 纯函数：同一 (state, options) 永远得到同一个字符串。
 */
export function renderRunMarkdown(state: RunState, options: RunRenderOptions): string {
  const terminal = isTerminal(state);
  const parts: string[] = [`${STATUS_ICON[state.status]} **${options.title}**`];

  if (state.reason) parts.push(`⚠️ ${truncateSingleLine(state.reason, REASON_MAX)}`);

  const text = truncateText(state.text, options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
  if (text) parts.push(text);

  const toolLines = renderToolLines(
    state.tools,
    {
      maxToolBlocks: options.maxToolBlocks ?? DEFAULT_MAX_TOOL_BLOCKS,
      collapseToolThreshold: options.collapseToolThreshold ?? DEFAULT_COLLAPSE_TOOL_THRESHOLD,
    },
    terminal,
  );
  if (toolLines.length > 0) parts.push(toolLines.join("\n"));

  if (options.footer) parts.push(options.footer);

  // 强停按钮：只占位成一行 markdown（含仍需回传的 token），由调用方替换为真实卡片按钮元素。
  if (options.stop && !terminal) parts.push(`⏹ 强制停止（token: ${options.stop.token}）`);

  return parts.join("\n\n");
}

/**
 * 是否值得再 patch 一次卡片：终态强制渲染（收尾必须落地），
 * 否则距上次渲染达到 `throttleMs` 才渲染（飞书单条消息更新频控 5 QPS）。
 * 纯函数，时间由调用方传入，便于单测与节流器共用同一套判定。
 */
export function shouldRenderAfter(
  state: RunState,
  lastRenderedAt: number,
  throttleMs: number,
  now: number,
): boolean {
  if (isTerminal(state)) return true;
  return now - lastRenderedAt >= Math.max(0, throttleMs);
}
