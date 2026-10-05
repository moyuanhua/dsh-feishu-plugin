/**
 * 飞书会话命令：解析与纯文本工具（无 IO，可单测）。
 *
 * **逻辑来源**：opencode-feishu-plugin `src/feishu/commands.ts`（MIT，Copyright (c) 2026 moyuanhua），
 * 逐行搬运（仅 import 路径与帮助文案里的产品名）。上游约定：
 *
 * - 命令只在 p2p 文本消息以 `/` 开头时触发；解析失败/未知命令由上层回帮助提示，
 *   **绝不**把命令文本当作 prompt 发给模型；
 * - 命令分两个 scope：**主聊天流（管理台）** 与 **话题内**；话题内有白名单
 *   （`/new` `/sessions` `/use` `/resume` `/dir` `/cancel` `/form` 在话题内被禁，引导回主聊天流）。
 */
/**
 * 命令表里用到的最小会话引用。
 *
 * 旧版这里 import 的是 `SessionEntry`（我们自己镜像的会话清单条目）。
 * 镜像删掉之后，`/use` 的序号/前缀匹配改为直接对 `session-catalog` 产出的行做匹配，
 * 因此只需要 id + 标题这两个字段。
 */
export interface SessionRef {
  readonly sessionID: string;
  readonly title: string;
}

export type CommandName =
  | "new"
  | "sessions"
  | "use"
  | "resume"
  | "current"
  | "stop"
  | "help"
  | "dir"
  | "model"
  | "perm"
  | "cd"
  | "cancel"
  | "form"
  | "steer"
  | "now"
  | "unknown";

export interface ParsedCommand {
  readonly name: CommandName;
  /** 命令后的原始参数（已 trim，可含空格）。 */
  readonly args: string;
  /** 原始命令词（不含前导 `/`），用于帮助与日志。 */
  readonly raw: string;
}

/**
 * 命令规格表 —— **帮助文案与命令路由的单一真源**。
 *
 * 缺陷 6 的根因是"帮助文案"和"真正执行命令的 switch"是两份手写清单，于是
 * `/help` 会一本正经地列出 `/dir` `/model` `/resume` `/now` `/cancel` `/cd`，
 * 而用户敲下去只会得到「尚未移植」——帮助卡本身在误导用户。
 *
 * 现在只有这一张表：`/help` 由它生成，话题内白名单也由它派生。
 * `implemented: false` 的命令**不会出现在帮助里**，但敲了仍会得到明确回报。
 */
export interface CommandSpec {
  readonly name: CommandName;
  /** 展示用法（帮助卡用）。 */
  readonly usage: string;
  readonly summary: string;
  /** 是否已经真正实现；false = 不进帮助（但敲了有明确回报）。 */
  readonly implemented: boolean;
  /** 是否允许在话题内使用；false = 引导回主聊天流。 */
  readonly inThread: boolean;
}

export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: "new",
    usage: "/new [标题]",
    summary: "新建会话（解析模型与工作目录，失败会说明原因）",
    implemented: true,
    inThread: false,
  },
  { name: "form", usage: "/form [标题]", summary: "同上，`/new` 的等价入口", implemented: true, inThread: false },
  {
    name: "sessions",
    usage: "/sessions（别名 /ls）",
    summary: "列出本聊天的会话",
    implemented: true,
    inThread: false,
  },
  {
    name: "use",
    usage: "/use <序号|会话id前缀>",
    summary: "切换当前会话",
    implemented: true,
    inThread: false,
  },
  { name: "current", usage: "/current", summary: "查看当前（话题内为「本话题」）会话", implemented: true, inThread: true },
  { name: "stop", usage: "/stop", summary: "中断正在跑的任务", implemented: true, inThread: true },
  {
    name: "steer",
    usage: "/steer <文本>",
    summary: "立即插队发送一条消息（打断当前步骤）",
    implemented: true,
    inThread: true,
  },
  { name: "perm", usage: "/perm [档位]", summary: "查看 / 修改本会话的权限档位", implemented: true, inThread: true },
  { name: "help", usage: "/help", summary: "显示本帮助", implemented: true, inThread: true },

  // —— 尚未实现：**不进 `/help`**。敲了会得到一条明确说明，绝不假装成功。——
  { name: "model", usage: "/model [关键词]", summary: "查看 / 切换模型", implemented: false, inThread: true },
  { name: "cd", usage: "/cd <绝对路径>", summary: "切换会话工作目录", implemented: false, inThread: true },
  { name: "now", usage: "/now", summary: "把排队消息提升为立即执行", implemented: false, inThread: true },
  { name: "dir", usage: "/dir <绝对路径>", summary: "预填建会话表单的工作目录", implemented: false, inThread: false },
  { name: "cancel", usage: "/cancel", summary: "放弃建会话表单", implemented: false, inThread: false },
  { name: "resume", usage: "/resume [序号]", summary: "续聊历史会话", implemented: false, inThread: false },
];

const SPEC_BY_NAME: ReadonlyMap<CommandName, CommandSpec> = new Map(
  COMMAND_SPECS.map((spec) => [spec.name, spec]),
);

/** 命令词 → 规范名。**由规格表派生**，另加三个历史别名。 */
const ALIASES: Readonly<Record<string, CommandName>> = {
  ...Object.fromEntries(COMMAND_SPECS.map((spec) => [spec.name, spec.name])),
  ls: "sessions",
  permission: "perm",
  permissions: "perm",
};

/** 是否是命令（以 `/` 开头）。 */
export function isCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/**
 * 解析命令。非命令返回 undefined；`/` 或空命令词视为 `help`；
 * 未登记的命令词返回 `unknown`（上层回帮助提示）。
 */
export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const body = trimmed.slice(1).trim();
  if (!body) return { name: "help", args: "", raw: "" };
  const wsIndex = body.search(/\s/);
  const raw = wsIndex < 0 ? body : body.slice(0, wsIndex);
  const args = wsIndex < 0 ? "" : body.slice(wsIndex + 1).trim();
  return { name: ALIASES[raw.toLowerCase()] ?? "unknown", args, raw };
}

/** `/new` 缺省标题（时间戳）。 */
export function defaultSessionTitle(now: number): string {
  return `飞书会话 ${new Date(now).toISOString()}`;
}

/** 会话 id 的短展示形式（卡片空间有限）。 */
export function shortSessionId(sessionID: string): string {
  return sessionID.length <= 12 ? sessionID : `${sessionID.slice(0, 12)}…`;
}

export type SessionMatch =
  | { readonly ok: true; readonly entry: SessionRef }
  | { readonly ok: false; readonly reason: "empty" | "not_found" | "ambiguous" };

/**
 * 把 `/use` 参数解析为目标会话：
 * - 纯数字 → 1-based 序号
 * - 其它 → 会话 id 前缀匹配（唯一才算命中）
 */
export function matchSession(arg: string, sessions: readonly SessionRef[]): SessionMatch {
  const query = arg.trim();
  if (!query) return { ok: false, reason: "empty" };
  if (/^\d+$/.test(query)) {
    const index = Number.parseInt(query, 10) - 1;
    const entry = sessions[index];
    return entry ? { ok: true, entry } : { ok: false, reason: "not_found" };
  }
  const matches = sessions.filter((s) => s.sessionID.toLowerCase().startsWith(query.toLowerCase()));
  if (matches.length === 1) return { ok: true, entry: matches[0]! };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: false, reason: "not_found" };
}

/** 单行会话展示：`1. 标题（短id） ← 当前`。 */
export function sessionLine(entry: SessionRef, index: number, activeID?: string): string {
  const mark = activeID && entry.sessionID === activeID ? " ← 当前" : "";
  const title = entry.title.trim() || "(未命名)";
  return `${index + 1}. ${title}（\`${shortSessionId(entry.sessionID)}\`）${mark}`;
}

/** `/use` 失败时的提示文案。 */
export function useErrorText(reason: "empty" | "not_found" | "ambiguous"): string {
  switch (reason) {
    case "empty":
      return "用法：/use <序号|会话id前缀>，例如 `/use 2` 或 `/use ses_abc`。";
    case "ambiguous":
      return "该前缀匹配到多个会话，请输入更长的会话 id 前缀。";
    case "not_found":
    default:
      return "未找到匹配的会话，先用 /sessions 查看列表。";
  }
}

/**
 * `/help` 文案 —— **由 `COMMAND_SPECS` 生成**，不再手写。
 *
 * 因此它不可能再列出未实现的命令：只要 `implemented` 是 false 就不出现。
 * `scope` 决定显示哪些（话题内只显示 `inThread` 为真的）。
 */
export function helpText(scope: "main" | "thread" = "main"): string {
  const visible = COMMAND_SPECS.filter(
    (spec) => spec.implemented && (scope === "main" || spec.inThread),
  );
  const header = scope === "thread" ? "**飞书话题命令**" : "**飞书会话命令**";
  const lines = visible.map((spec) => `\`${spec.usage}\` — ${spec.summary}`);
  const tail =
    scope === "thread"
      ? ["", "建会话与会话管理（`/new`、`/form`、`/sessions`、`/use`）请回到**主聊天流**操作。"]
      : ["", "_未列出的命令尚未实现；敲了会得到明确说明。_"];
  return [header, ...lines, ...tail].join("\n");
}

/**
 * 话题内允许的命令白名单 —— 同样**由规格表派生**（`inThread`）。
 *
 * `unknown` 特意放行：用户敲了个不存在的命令词时，应该收到「未知命令」，
 * 而不是被误导成「话题内不支持」。
 */
export function isCommandAllowedInThread(name: CommandName): boolean {
  if (name === "unknown") return true;
  return SPEC_BY_NAME.get(name)?.inThread ?? true;
}

/** 话题内敲了被禁命令时的提示文案（引导去主聊天流）。 */
export function threadForbiddenText(raw: string): string {
  const name = raw ? `\`/${raw}\`` : "该命令";
  return `话题内不支持 ${name}。\n\n建会话/会话管理请回到**主聊天流**操作（\`/new\`、\`/form\`、\`/sessions\`、\`/use\`、\`/resume\`、\`/dir\`、\`/cancel\`）。`;
}

/** 话题会话标题：取首条消息摘要，如 `话题: 帮我看看这个 bug`。 */
export function topicTitle(text: string, max = 20): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const summary = oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  return summary ? `话题: ${summary}` : "话题会话";
}
