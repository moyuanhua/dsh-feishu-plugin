/**
 * 机器人自定义菜单（`application.bot.menu_v6`）—— **纯解析**，无 IO。
 *
 * 上游 opencode 版实现了这个事件：菜单里的 `new` / `sessions` 两个 key 被**合成为等价命令**，
 * 走和普通文本完全相同的管线（白名单 → 去重 → 命令矩阵）。dsh 版此前漏了，
 * 于是用户点的菜单按钮**毫无反应**（日志里只有 `no application.bot.menu_v6 handle`）。
 *
 * 实现方式：`@larksuite/channel` 的 `EventMap` 是封闭的，没有菜单事件，
 * 所以走它的 `onRawEvent` 逃生通道。代价是**原始事件不过安全管线**，
 * 因此白名单检查必须在这里的调用方补回来（见 `src/index.ts`）。
 *
 * 上游的取舍原样保留：
 * - 未知 key → **静默忽略**（不报错，也不提示）；
 * - 非白名单用户 → 静默忽略；
 * - 从没见过该用户的消息（不知道 chat id）→ 什么也不做（用户需要先发一条消息）。
 */
import { isCommand, parseCommand } from "./commands.js";

/** 菜单 key → 等价命令文本。key 与命令词两种写法都容忍（上游同）。 */
const MENU_COMMAND: Readonly<Record<string, string>> = {
  new: "/new",
  "/new": "/new",
  sessions: "/sessions",
  "/sessions": "/sessions",
  ls: "/sessions",
  "/ls": "/sessions",
};

export interface BotMenuEvent {
  /** 点击者的 open_id（白名单校验对象）。 */
  readonly openId: string;
  /** 原始菜单 key，仅用于日志。 */
  readonly eventKey: string;
  /** 合成出的等价命令文本（形如 `/new`）。 */
  readonly command: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * 解析菜单事件。
 *
 * 返回 `undefined` 表示"这条菜单事件不该产生任何动作"（形状不对、未知 key、
 * 或合出来的文本不是命令），调用方据此静默忽略。
 */
export function parseBotMenuEvent(payload: unknown): BotMenuEvent | undefined {
  const root = asRecord(payload);
  // 平台事件是 `{ header, event }` 信封；部分场景下 `event` 就是顶层。
  const event = asRecord(root?.event) ?? root;
  if (!event) return undefined;

  const rawKey = event.event_key ?? event.eventKey;
  const eventKey = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!eventKey) return undefined;

  const command = MENU_COMMAND[eventKey.toLowerCase()];
  // 未知 key：静默忽略（上游行为）。注意这里**不是**错误路径，不打 error 日志。
  if (!command || !isCommand(command)) return undefined;

  const operator = asRecord(event.operator);
  const operatorId = asRecord(operator?.operator_id) ?? asRecord(operator?.operatorId);
  const openId = operatorId?.open_id ?? operatorId?.openId;
  if (typeof openId !== "string" || !openId.trim()) return undefined;

  return { openId: openId.trim(), eventKey, command };
}

/** 菜单事件对应的平台事件名。 */
export const BOT_MENU_EVENT = "application.bot.menu_v6";

/**
 * 菜单命令是否被本文本命令体系认识（防御性检查：菜单 key 表与命令表可能不同步）。
 * 目前 `new` / `sessions` 都是已实现命令，这个函数只是把"不同步"变成一条可断言的事实。
 */
export function isKnownMenuCommand(command: string): boolean {
  return parseCommand(command)?.name !== "unknown";
}
