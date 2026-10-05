/**
 * 斜杠命令的解析与命令表（纯函数）。
 *
 * 与上游的差异：上游把命令分发、卡片回调、会话上下文揉在一个 `session-commands.ts` 门面里
 * （214 行，依赖 opencode 会话 API）；这里只保留**解析与表**这部分纯逻辑，
 * 执行交给 `src/index.ts`（它才持有 agent / 通道 / 映射表）。
 *
 * 为什么不接 `ctx.commands`：dsh 的 `ctx.commands` 面向"agent 侧的命令行"，
 * 而飞书桥的斜杠命令发生在**飞书消息层**（还没进入会话），因此桥自己做一层薄分发更直接；
 * 等 M4 需要与 GUI 共享命令语义时再桥接 `ctx.commands.execute`。
 */

export interface CommandSpec {
  /** 带斜杠的命令名，例如 `/status`。 */
  readonly name: string;
  readonly description: string;
  /** 是否允许在群话题里使用（预留群开关）。 */
  readonly allowInGroup?: boolean;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "/help", description: "显示可用命令" },
  { name: "/status", description: "查看长连接与已绑定会话状态" },
  { name: "/stop", description: "中断当前会话正在执行的回合" },
];

export interface ParsedCommand {
  /** 规范化后的命令名（小写、带斜杠）。 */
  readonly name: string;
  /** 命令名之后的所有字节（含空白），未 trim。 */
  readonly rawInput: string;
}

/** 判断一行文本是否是命令：必须以 `/` + 小写字母开头（与上游一致）。 */
export function isCommandLine(text: string): boolean {
  return /^\/[a-z]/.test(text.trim());
}

/**
 * 解析命令行；不是命令或命令名为空时返回 undefined。
 *
 * 语法：`/` + 小写名（字母/数字/`-`/`_`），名后所有字节（含空白）都是 `rawInput`。
 */
export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const match = /^\/([a-z][a-z0-9_-]*)([\s\S]*)$/.exec(trimmed);
  if (!match) return undefined;
  const [, name = "", rawInput = ""] = match;
  return { name: `/${name}`, rawInput };
}

/** 命令是否在命令表里（大小写不敏感；未知命令由调用方回帮助卡）。 */
export function findCommand(name: string): CommandSpec | undefined {
  const normalized = name.trim().toLowerCase();
  return COMMANDS.find((command) => command.name === normalized);
}
