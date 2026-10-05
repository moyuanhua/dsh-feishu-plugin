/**
 * 会话管理命令的**纯规划器**。
 *
 * 上游把 `/current` `/sessions` `/use` `/model` `/perm` `/cd` `/steer` `/now` 等做成了一个
 * 依赖宿主 API 的门面（`src/session/session-commands.ts` + `session-ops.ts` + `session-list.ts`，约 900 行）。
 * dsh 侧把这些命令拆成两部分，便于在真实宿主之外单测：
 *
 *   纯规划器（本文件）：给定「命令 + 会话列表 + 当前会话 + 话题会话」→ 产出**动作计划**
 *   薄执行器（`src/index.ts`）：把计划翻译成 SessionMap / 投递 / 卡片调用
 *
 * 复用的纯逻辑全部来自已搬运的上游模块：`matchSession` / `sessionLine` / `useErrorText`（commands.ts）、
 * `isPermissionPreset` / `presetLabel`（perm-presets.ts）。
 */
import { matchSession, useErrorText, type ParsedCommand, type SessionRef } from "./commands.js";
import { isPermissionPreset, presetLabel } from "./perm-presets.js";

import type { PermissionPreset, SessionLink } from "../types.js";

export type SessionCommandPlan =
  /** 回一张提示卡（问卷/列表/错误）。 */
  | { readonly kind: "notice"; readonly text: string; readonly template: "blue" | "grey" | "green" | "red" | "orange" }
  /** 会话列表卡（由执行器渲染成卡片，不再是一段文本）。 */
  | { readonly kind: "session-list" }
  /** 切换当前会话。 */
  | { readonly kind: "set-active"; readonly sessionId: string; readonly note: string }
  /** 设置会话权限档位（影响审批门）。 */
  | { readonly kind: "set-perm"; readonly sessionId: string; readonly perm: PermissionPreset; readonly note: string }
  /** 以「强制插队」投递一段文本（`/steer`）。 */
  | { readonly kind: "steer"; readonly sessionId: string; readonly text: string }
  /** 该命令尚未实现（明确回报，不假装成功）。 */
  | { readonly kind: "unsupported"; readonly raw: string; readonly reason: string };

export interface SessionCommandInput {
  readonly parsed: ParsedCommand;
  /** 话题内 = thread（话题会话优先），否则主聊天流（当前会话）。 */
  readonly scope: "main" | "thread";
  /** 会话目录（由 `session-catalog` 排序后的行；`/use` 的序号与前缀匹配都基于它）。 */
  readonly sessions: readonly SessionRef[];
  readonly activeId?: string;
  /** 话题对应的会话 id（scope=thread 时有值）。 */
  readonly threadSessionId?: string;
  /** 话题会话的 link（取权限档位用）。 */
  readonly link?: SessionLink;
}

/** 目标会话 id：话题内用话题会话，主聊天流用当前会话。 */
function targetSessionId(input: SessionCommandInput): string | undefined {
  return input.scope === "thread" ? input.threadSessionId : input.activeId;
}

/** 渲染当前会话（`/current`）。 */
export function renderCurrent(entry: SessionRef | undefined, link: SessionLink | undefined): string {
  if (!entry) return "当前没有会话。用 `/new [标题]` 建一个。";
  const perm = link?.perm ? presetLabel(link.perm) : "（未设置，跟随全局审批门）";
  return [
    "**当前会话**",
    `- 标题：${entry.title.trim() || "(未命名)"}`,
    `- 会话：\`${entry.sessionID}\``,
    `- 权限档位：${perm}`,
    link?.dir ? `- 工作目录：\`${link.dir}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 产出一条会话命令的动作计划（纯函数，可在真实宿主之外完整单测）。 */
export function planSessionCommand(input: SessionCommandInput): SessionCommandPlan {
  const { parsed } = input;
  const sessionId = targetSessionId(input);

  switch (parsed.name) {
    case "current":
      return { kind: "notice", text: renderCurrent(currentEntry(input), input.link), template: "blue" };

    case "sessions":
      return { kind: "session-list" };

    case "use": {
      if (input.scope === "thread") {
        return { kind: "unsupported", raw: parsed.raw, reason: "话题内不支持切换会话" };
      }
      const matched = matchSession(parsed.args, input.sessions);
      if (!matched.ok) return { kind: "notice", text: useErrorText(matched.reason), template: "orange" };
      return {
        kind: "set-active",
        sessionId: matched.entry.sessionID,
        note: `已切换到 \`${matched.entry.sessionID}\`（${matched.entry.title.trim() || "未命名"}）。`,
      };
    }

    case "perm": {
      if (!sessionId) {
        return { kind: "notice", text: "当前没有会话，无法设置权限档位。", template: "grey" };
      }
      const arg = parsed.args.trim();
      if (!arg) {
        const current = input.link?.perm ? presetLabel(input.link.perm) : "（未设置，跟随全局审批门）";
        return {
          kind: "notice",
          text: `本会话权限档位：${current}\n\n可选：\`readonly\` / \`edit\` / \`askHigh\` / \`trust\`。`,
          template: "blue",
        };
      }
      if (!isPermissionPreset(arg)) {
        return {
          kind: "notice",
          text: `未知档位 \`${arg}\`。可选：\`readonly\` / \`edit\` / \`askHigh\` / \`trust\`。`,
          template: "orange",
        };
      }
      return {
        kind: "set-perm",
        sessionId,
        perm: arg,
        note: `本会话权限档位已设为 ${presetLabel(arg)}（后续工具审批按该档位判定）。`,
      };
    }

    case "steer": {
      if (!sessionId) {
        return { kind: "notice", text: "当前没有会话，无法插队投递。", template: "grey" };
      }
      const text = parsed.args.trim();
      if (!text) return { kind: "notice", text: "用法：`/steer <文本>`。", template: "orange" };
      return { kind: "steer", sessionId, text };
    }

    // 依赖 dsh 侧尚无等价接缝的命令：明确回报，绝不假装成功。
    case "model":
      return { kind: "unsupported", raw: parsed.raw, reason: "dsh 侧的模型选择接缝尚未接入" };
    case "cd":
      return { kind: "unsupported", raw: parsed.raw, reason: "dsh 会话的工作目录创建后不可变更" };
    case "now":
      return { kind: "unsupported", raw: parsed.raw, reason: "dsh 没有 opencode 的 park 队列提升接口" };
    case "new":
    case "form":
      return { kind: "unsupported", raw: parsed.raw, reason: "建会话表单卡尚未移植（当前用最小 /new）" };
    case "dir":
    case "cancel":
    case "resume":
      return { kind: "unsupported", raw: parsed.raw, reason: "依赖建会话表单 / 会话列表卡（尚未移植）" };
    default:
      return { kind: "unsupported", raw: parsed.raw, reason: "未知命令" };
  }
}

function currentEntry(input: SessionCommandInput): SessionRef | undefined {
  const id = targetSessionId(input);
  if (!id) return undefined;
  return input.sessions.find((entry) => entry.sessionID === id);
}
