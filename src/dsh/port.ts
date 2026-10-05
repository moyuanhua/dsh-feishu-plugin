/**
 * 真实宿主接缝：把 dsh 的服务适配成本插件的 `DeliveryPort`。
 *
 * 这里**故意集中**所有对 `@deepseek-ai/dsh-*` 的 import（含运行时 import
 * `createUserMessage`），其它模块只依赖 `src/types.ts` 的结构类型：
 * - 内核（决策/策略/卡片）可以脱离 dsh 运行时单测；
 * - 宿主 API 变化时只需要改这一个文件。
 *
 * 已知事实（已核对 0.2.0-rc.2 的 d.ts）：
 * - `ctx.agents.create({ sessionId, meta: { cwd } })` → `AgentHandle`；
 * - `ctx.agents.get(sessionId)` → `Agent | undefined`；`ctx.agents.resume({ resumeSessionId })`；
 * - `agent.followup(message)` / `agent.steer(message)` 返回 void；
 * - `createUserMessage({ content, source })`，source 的 kind 由 `src/dsh/source.ts` 声明。
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { DeliveryPort } from "../bridge/deliver.js";
import type { AgentLike, Logger } from "../types.js";
import { feishuSource } from "./source.js";

/** 可选服务：缺失时静默跳过（避免为了一个显示细节把插件变成强依赖）。 */
interface OptionalServices {
  sessionTitle?: { rename(session: unknown, title: string): void };
}

function toSessionId(value: string): SessionId {
  return value as unknown as SessionId;
}

export function createDshPort(ctx: Context, log: Logger): DeliveryPort {
  return {
    log,

    createUserMessage: ({ text, source }) =>
      createUserMessage({
        content: [{ type: "text", text }],
        source: feishuSource({
          chatId: source.chatId ?? "",
          messageId: source.messageId ?? "",
          ...(source.senderId ? { senderId: source.senderId } : {}),
          ...(source.threadId ? { threadId: source.threadId } : {}),
        }),
      }),

    createSession: async ({ cwd, title }) => {
      const sessionId = `feishu-${randomUUID()}`;
      const handle = await ctx.agents.create({ sessionId: toSessionId(sessionId), meta: { cwd } });
      (ctx as unknown as OptionalServices).sessionTitle?.rename(handle.agent.session, title);
      log.info("已为飞书话题新建会话", { sessionId, cwd, title });
      return sessionId;
    },

    resolveAgent: async (sessionId) => {
      const existing: Agent | undefined = ctx.agents.get(toSessionId(sessionId));
      if (existing) return existing as unknown as AgentLike;
      // dsh 没有 opencode 的 location 回收，但 agent 可能已不在存活注册表里 —— 按需 resume。
      const handle = await ctx.agents.resume({ resumeSessionId: toSessionId(sessionId) });
      log.info("已恢复飞书会话的 agent", { sessionId });
      return handle.agent as unknown as AgentLike;
    },
  };
}
