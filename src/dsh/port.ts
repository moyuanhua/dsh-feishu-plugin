/**
 * 真实宿主接缝：把 dsh 的服务适配成本插件的 `DeliveryPort`。
 *
 * 这里**故意集中**所有对 `@deepseek-ai/dsh-*` 的 import（含运行时 import
 * `createUserMessage`），其它模块只依赖 `src/types.ts` 的结构类型：
 * - 内核（决策/策略/卡片）可以脱离 dsh 运行时单测；
 * - 宿主 API 变化时只需要改这一个文件。
 *
 * 已核对 0.2.0-rc.2 的 d.ts + 在真实宿主里探针实测：
 * - `ctx.agents.create({ sessionId, meta: { cwd } })` → `AgentHandle`；
 * - `ctx.agents.get(sessionId)` → `Agent | undefined`；`ctx.agents.resume({ resumeSessionId })`；
 * - `agent.followup(message)` / `agent.steer(message)` 返回 void；
 * - `createUserMessage({ content, source })`，source 的 kind 由 `src/dsh/source.ts` 声明；
 * - **可选服务只能用 `ctx.inject([...], sub => …)`**：`ctx.get('sessionTitle')` 实测返回 undefined，
 *   而 `ctx.sessionTitle` 属性访问会抛 `cannot get property "sessionTitle" without inject`
 *   （M3a 首次真实投递就是栽在这里）。官方 `service.zh.md:95` 写的 `ctx.get()` 可选用法在本机不成立。
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { DeliveryPort } from "../bridge/deliver.js";
import { errorMessage } from "../logger.js";
import type { AgentLike, AttachmentStorePort, Logger } from "../types.js";
import { feishuSource } from "./source.js";

function toSessionId(value: string): SessionId {
  return value as unknown as SessionId;
}

export function createDshPort(ctx: Context, log: Logger): DeliveryPort {
  let renameTitle: ((session: unknown, title: string) => void) | undefined;

  // 可选服务：缺失或稍后可用都不影响投递（cordis 在服务就绪后才执行回调）。
  // 注意 `sessionTitle` 的类型声明合并来自 `@deepseek-ai/dsh-session-title` 包，本插件不直接依赖它，
  // 因此这里把子 ctx 收窄成本地结构类型（运行时靠服务名匹配，仍然是标准 cordis 用法）。
  ctx.inject(["sessionTitle"], (sub) => {
    const service = (sub as unknown as { sessionTitle?: { rename(session: unknown, title: string): void } })
      .sessionTitle;
    if (!service) return;
    renameTitle = (session, title) => {
      try {
        service.rename(session, title);
      } catch (error) {
        log.debug("会话改名失败（不影响投递）", { reason: errorMessage(error) });
      }
    };
  });

  return {
    log,

    // 附件入库：图片走 admitPromptContent（换成持久引用），文件走 saveFile。
    attachments: {
      admitImage: async ({ data, mediaType, name }) => {
        const admitted = await ctx.attachments.admitPromptContent([
          { type: "image", mediaType: mediaType as never, data: Buffer.from(data).toString("base64"), ...(name ? { name } : {}) },
        ]);
        return admitted[0];
      },
      saveFile: ({ data, name }) => ctx.attachments.saveFile({ data, ...(name ? { name } : {}) }),
    } satisfies AttachmentStorePort,

    createUserMessage: ({ text, source, parts }) =>
      createUserMessage({
        content: [{ type: "text", text }, ...((parts ?? []) as never[])],
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
      // 标题失败绝不能让投递失败（M3a 的教训）。
      try {
        renameTitle?.(handle.agent.session, title);
      } catch (error) {
        log.debug("会话改名失败（不影响投递）", { reason: errorMessage(error) });
      }
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
