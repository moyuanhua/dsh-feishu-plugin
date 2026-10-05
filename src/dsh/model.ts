/**
 * 模型解析 —— **dsh 原生**，不再自己发明"默认模型"的概念。
 *
 * 背景（旧实现的缺陷 1）：建会话时没有传模型，于是 dsh 在第一次模型请求时抛
 * `agent "…" has no provider/model: set AgentOptions.provider and AgentOptions.model
 * or supply both via the agent/request waterfall` —— 会话建出来了，但**永远跑不了**，
 * 而且错误被后来的映射吞成了 ✅。根因是：opencode 那边 model 是建会话的隐式参数，
 * 逐层搬运时被丢掉了；而 dsh 要求显式给出 `agentOptions`。
 *
 * dsh 的原生答案是 `@deepseek-ai/dsh-agent-default-model` 暴露的 `agentDefaultModel` 服务：
 * 它回答"新建的 agent 该用哪个模型？"（`currentSelection()` 返回 `{provider, model,
 * reasoningEffort?}`）。因此本插件的职责只有三件事：
 *   1. 配置显式覆盖（同一个 profile 想给飞书单独指定模型时）；
 *   2. 否则**问 dsh**；
 *   3. 都拿不到就**拒绝建会话**并把话说明白 —— 绝不创建"注定跑不起来"的会话。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Logger } from "../types.js";

/** 传给 `ctx.agents.create({ agentOptions })` 的路由选择。 */
export interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export type ModelResolution =
  | { readonly ok: true; readonly selection: ModelSelection; readonly source: "config" | "agent-default-model" }
  | { readonly ok: false; readonly message: string };

/** 配置里显式给出的模型覆盖。 */
export interface ModelOverride {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** 拿不到模型时给用户看的提示（可操作，不责备用户）。 */
export const NO_MODEL_MESSAGE = [
  "**没有可用的模型，已拒绝创建会话。**",
  "建一个跑不起来的会话没有意义，所以这里直接停下。",
  "",
  "两种解决办法（任选其一）：",
  "1. 在 DSH 的**设置 → 模型**里选择一个默认模型（推荐，之后所有会话都用它）；",
  "2. 在本插件的配置里显式指定 `provider` / `model` 两个字段。",
].join("\n");

/** 校验一个选择是否完整（provider 与 model 都必须是非空字符串）。 */
export function isValidSelection(selection: Partial<ModelSelection> | undefined): selection is ModelSelection {
  return Boolean(selection?.provider?.trim() && selection?.model?.trim());
}

/**
 * 纯函数部分：配置覆盖优先，其次宿主默认值。便于单测（不需要 cordis）。
 */
export function pickModel(
  override: ModelOverride,
  hostDefault: Partial<ModelSelection> | undefined,
): ModelResolution {
  const provider = override.provider?.trim();
  const model = override.model?.trim();

  // 配置里只写了一半是**配置错误**，必须响亮失败 —— 静默用宿主默认值补另一半
  // 会让用户以为自己配的生效了。
  if (Boolean(provider) !== Boolean(model)) {
    return {
      ok: false,
      message: [
        "**插件配置里的 `provider` 与 `model` 必须同时提供。**",
        `当前只配置了：${provider ? `provider=\`${provider}\`` : `model=\`${model}\``}。`,
        "补齐另一个字段，或两个都删掉以使用 DSH 的默认模型。",
      ].join("\n"),
    };
  }

  if (provider && model) {
    const effort = override.reasoningEffort?.trim();
    return {
      ok: true,
      source: "config",
      selection: { provider, model, ...(effort ? { reasoningEffort: effort } : {}) },
    };
  }

  if (isValidSelection(hostDefault)) {
    const effort = hostDefault.reasoningEffort?.trim();
    return {
      ok: true,
      source: "agent-default-model",
      selection: {
        provider: hostDefault.provider.trim(),
        model: hostDefault.model.trim(),
        ...(effort ? { reasoningEffort: effort } : {}),
      },
    };
  }

  return { ok: false, message: NO_MODEL_MESSAGE };
}

/** `agentDefaultModel` 服务的最小结构面（真实类型在 `dsh-agent-default-model` 里）。 */
export interface AgentDefaultModelLike {
  currentSelection(): Partial<ModelSelection> | undefined;
}

/**
 * 把宿主默认模型接进来。
 *
 * `agentDefaultModel` 是**可选服务**：profile 没挂载那个包时它不存在，此时只能靠配置覆盖，
 * 否则拒绝建会话。按 cordis 的既有约定（见 `dsh/port.ts` 的说明）用 `ctx.inject` 订阅：
 * 服务就绪后回调才执行，因此不必假设加载顺序。
 */
export function attachAgentDefaultModel(ctx: Context, log: Logger): () => AgentDefaultModelLike | undefined {
  let service: AgentDefaultModelLike | undefined;

  ctx.inject(["agentDefaultModel"], (sub) => {
    const candidate = (sub as unknown as { agentDefaultModel?: AgentDefaultModelLike }).agentDefaultModel;
    if (!candidate || typeof candidate.currentSelection !== "function") {
      log.debug("agentDefaultModel 服务形状不符合预期，忽略");
      return;
    }
    service = candidate;
    log.debug("已接入 agentDefaultModel 服务");
  });

  return () => service;
}

/** 解析本次建会话要用的模型。 */
export function resolveModel(
  getHostDefault: () => AgentDefaultModelLike | undefined,
  override: ModelOverride,
  log: Logger,
): ModelResolution {
  let hostDefault: Partial<ModelSelection> | undefined;
  try {
    hostDefault = getHostDefault()?.currentSelection();
  } catch (error) {
    log.warn("读取宿主默认模型失败", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return pickModel(override, hostDefault);
}
