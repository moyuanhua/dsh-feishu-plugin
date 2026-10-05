/**
 * 辅助模型调用：**主聊天流的意图识别**。
 *
 * 这是"插件自己发一次小模型调用"的场景，官方范式是 `dsh-session-title-llm` 的
 * `generateSessionTitleWithLlm`（同款做法：`messages` + `system` + `maxTokens` +
 * 一次性 deadline 信号）。上游对应物是 `quick-generate.ts` 的**三条通道**
 * （临时会话 / `ctx.generate.text` / 本地 HTTP）——在 DSH 里都不需要，压成一条。
 *
 * 三条硬约束：
 * - **严格超时**：识别只是锦上添花，绝不能把用户的等待拖长；
 * - **任何失败都返回 undefined**（不抛）：调用方据此降级为"给空表单"；
 * - **绝不 `searchSessions`**：`dsh-base` 的 sqlite 是 `openAt: never`，搜索会失败。
 */
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { errorMessage } from "../logger.js";
import type { Logger } from "../types.js";

/** 一次辅助调用的结果。 */
export interface IntentGenerationRequest {
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
  readonly signal: AbortSignal;
}

export type IntentGenerator = (request: IntentGenerationRequest) => Promise<string | undefined>;

/** 辅助调用的消息来源 kind（模块增强；官方明说没有通用 `plugin` kind）。 */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "feishu-intent": { readonly kind: "feishu-intent" };
  }
}

interface LlmLike {
  stream?: (options: unknown) => AsyncIterable<unknown>;
}

/** 从流里累加 text-delta；其它 chunk 一律忽略。 */
async function collectText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = "";
  for await (const raw of stream) {
    const chunk = raw as { type?: unknown; text?: unknown } | undefined;
    if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
  }
  return text;
}

/**
 * 创建意图生成器。
 *
 * `llm` 服务缺失或没有 `stream` 时返回一个恒为 `undefined` 的实现 ——
 * 这样调用方不用到处判空，行为也一致（降级为空表单）。
 */
export function createIntentGenerator(
  ctx: Context,
  log: Logger,
  timeoutMs: number,
): IntentGenerator {
  let service: LlmLike | undefined;

  ctx.inject(["llm"], (sub) => {
    const candidate = (sub as unknown as { llm?: LlmLike }).llm;
    if (candidate && typeof candidate.stream === "function") service = candidate;
  });

  return async (request) => {
    // 调用方已经取消（例如用户又发了一条）就别再花一次模型调用。
    if (request.signal.aborted) return undefined;

    const llm = service ?? ((ctx.get("llm") as LlmLike | undefined) ?? undefined);
    if (!llm || typeof llm.stream !== "function") {
      log.warn("llm 服务不可用，跳过意图识别（降级为空表单）");
      return undefined;
    }

    // 严格超时：用 AbortSignal.any 把调用方的取消和本地 deadline 合起来。
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([request.signal, deadline]);

    try {
      const stream = llm.stream({
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        messages: [
          createUserMessage({
            content: [{ type: "text", text: request.prompt }],
            source: { kind: "feishu-intent" },
          }),
        ],
        maxTokens: 512,
        purpose: "feishu-intent",
        signal,
      });
      const text = await collectText(stream);
      return text.trim() || undefined;
    } catch (error) {
      // 超时 / 网络 / 路由错误都只是一个 warn：识别失败不该让用户看到报错。
      log.warn("意图识别调用失败，降级为空表单", {
        reason: errorMessage(error),
        timedOut: deadline.aborted,
      });
      return undefined;
    }
  };
}
