/**
 * 宿主适配层：模型解析 与 辅助调用。
 *
 * 这两个文件是"插件唯一接触 dsh 的地方"里最容易被误删的接缝，因此即使需要伪造 `ctx`
 * 也要覆盖 —— 它们各自承担一条**缺陷回归**：
 * - `model.ts`：拿不到模型必须**拒绝**，绝不建一个跑不起来的会话（缺陷 1）；
 * - `intent.ts`：辅助调用**任何失败都降级**，不能让用户卡在"正在识别"（缺陷 U1）。
 */
import { describe, expect, test, vi } from "vitest";
import { attachAgentDefaultModel, isValidSelection, pickModel, resolveModel } from "../src/dsh/model.js";
import { createIntentGenerator } from "../src/dsh/intent.js";
import type { Logger } from "../src/types.js";

const LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 与 `session-query.test.ts` 同款的极简 ctx。 */
function fakeCtx(services: Record<string, unknown>): never {
  return {
    inject: (names: readonly string[], fn: (s: unknown) => void) => {
      const sub: Record<string, unknown> = {};
      let any = false;
      for (const name of names) {
        if (services[name] !== undefined) {
          sub[name] = services[name];
          any = true;
        }
      }
      if (any) fn(sub);
    },
    get: (name: string) => services[name],
  } as never;
}

describe("attachAgentDefaultModel", () => {
  test("服务存在 → 读得到 selection", () => {
    const service = { currentSelection: () => ({ provider: "p", model: "m" }) };
    const get = attachAgentDefaultModel(fakeCtx({ agentDefaultModel: service }), LOG);
    expect(get()?.currentSelection()).toEqual({ provider: "p", model: "m" });
  });

  test("服务缺失 → 返回 undefined 而不是抛", () => {
    const get = attachAgentDefaultModel(fakeCtx({}), LOG);
    expect(get()).toBeUndefined();
  });

  test("服务形状不对（没有 currentSelection）→ 忽略", () => {
    const get = attachAgentDefaultModel(fakeCtx({ agentDefaultModel: { nope: 1 } }), LOG);
    expect(get()).toBeUndefined();
  });
});

describe("resolveModel（缺陷 1 回归：拿不到就拒绝）", () => {
  test("宿主有默认 → 用它，且标记来源", () => {
    const result = resolveModel(
      () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
      {},
      LOG,
    );
    expect(result).toEqual({ ok: true, source: "agent-default-model", selection: { provider: "p", model: "m" } });
  });

  test("配置覆盖优先于宿主默认", () => {
    const result = resolveModel(
      () => ({ currentSelection: () => ({ provider: "host", model: "host-m" }) }),
      { provider: "cfg", model: "cfg-m" },
      LOG,
    );
    expect(result.ok && result.source).toBe("config");
    expect(result.ok && result.selection.provider).toBe("cfg");
  });

  test("两边都没有 → 拒绝，且文案可操作（不建废会话）", () => {
    const result = resolveModel(() => undefined, {}, LOG);
    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toContain("设置");
  });

  test("宿主读取抛异常 → 降级为「没有默认」，仍拒绝而不是抛", () => {
    const warn = vi.fn();
    const result = resolveModel(
      () => ({
        currentSelection: () => {
          throw new Error("boom");
        },
      }),
      {},
      { ...LOG, warn },
    );
    expect(result.ok).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  test("宿主返回不完整（只有 provider）→ 等同于没有", () => {
    const result = resolveModel(() => ({ currentSelection: () => ({ provider: "p" }) }), {}, LOG);
    expect(result.ok).toBe(false);
  });
});

describe("pickModel 边界", () => {
  test("isValidSelection", () => {
    expect(isValidSelection({ provider: "p", model: "m" })).toBe(true);
    expect(isValidSelection({ provider: "p" })).toBe(false);
    expect(isValidSelection({ provider: " ", model: "m" })).toBe(false);
    expect(isValidSelection(undefined)).toBe(false);
  });

  test("配置只写一半 → 响亮失败（不静默补另一半）", () => {
    expect(pickModel({ provider: "p" }, { provider: "h", model: "hm" }).ok).toBe(false);
    expect(pickModel({ model: "m" }, { provider: "h", model: "hm" }).ok).toBe(false);
  });

  test("配置完整时渲染强度一并带上", () => {
    const result = pickModel({ provider: "p", model: "m", reasoningEffort: "max" }, undefined);
    expect(result.ok && result.selection).toEqual({ provider: "p", model: "m", reasoningEffort: "max" });
  });
});

describe("createIntentGenerator", () => {
  /** 造一个把给定 chunk 依次吐出来的假 llm。 */
  function fakeLlm(chunks: readonly unknown[], onCall?: (options: unknown) => void) {
    return {
      stream: (options: unknown) => {
        onCall?.(options);
        return (async function* () {
          for (const chunk of chunks) yield chunk;
        })();
      },
    };
  }

  const request = {
    prompt: "hi",
    provider: "p",
    model: "m",
    signal: new AbortController().signal,
  };

  test("累加 text-delta 并返回", async () => {
    const gen = createIntentGenerator(
      fakeCtx({ llm: fakeLlm([{ type: "text-delta", text: '{"intent"' }, { type: "text-delta", text: ':1}' }]) }),
      LOG,
      1_000,
    );
    expect(await gen(request)).toBe('{"intent":1}');
  });

  test("忽略非文本 chunk 与非字符串 text", async () => {
    const gen = createIntentGenerator(
      fakeCtx({
        llm: fakeLlm([
          { type: "block-start" },
          { type: "text-delta", text: 42 },
          { type: "reasoning-delta", text: "想" },
          { type: "text-delta", text: "ok" },
        ]),
      }),
      LOG,
      1_000,
    );
    expect(await gen(request)).toBe("ok");
  });

  test("只有空白 → undefined（调用方据此降级）", async () => {
    const gen = createIntentGenerator(fakeCtx({ llm: fakeLlm([{ type: "text-delta", text: "   " }]) }), LOG, 1_000);
    expect(await gen(request)).toBeUndefined();
  });

  test("调用参数带上 provider/model 与超时信号，并且不带 sessionId（零会话也能识别）", async () => {
    let captured: Record<string, unknown> | undefined;
    const gen = createIntentGenerator(
      fakeCtx({ llm: fakeLlm([{ type: "text-delta", text: "x" }], (o) => (captured = o as never)) }),
      LOG,
      1_000,
    );
    await gen(request);
    expect(captured?.provider).toBe("p");
    expect(captured?.model).toBe("m");
    expect(captured?.sessionId).toBeUndefined();
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    expect(captured?.purpose).toBe("feishu-intent");
  });

  test("推理强度可选地透传", async () => {
    let captured: Record<string, unknown> | undefined;
    const gen = createIntentGenerator(
      fakeCtx({ llm: fakeLlm([{ type: "text-delta", text: "x" }], (o) => (captured = o as never)) }),
      LOG,
      1_000,
    );
    await gen({ ...request, reasoningEffort: "max" });
    expect(captured?.reasoningEffort).toBe("max");
  });

  test("服务缺失 → undefined + warn（不抛）", async () => {
    const warn = vi.fn();
    const gen = createIntentGenerator(fakeCtx({}), { ...LOG, warn }, 1_000);
    expect(await gen(request)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  test("服务没有 stream 方法 → undefined", async () => {
    const gen = createIntentGenerator(fakeCtx({ llm: {} }), LOG, 1_000);
    expect(await gen(request)).toBeUndefined();
  });

  test("stream 抛异常 → undefined + warn（识别失败不该让用户看到报错）", async () => {
    const warn = vi.fn();
    const gen = createIntentGenerator(
      fakeCtx({
        llm: {
          stream: () => {
            throw new Error("provider down");
          },
        },
      }),
      { ...LOG, warn },
      1_000,
    );
    expect(await gen(request)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  test("迭代中途抛异常也降级", async () => {
    const gen = createIntentGenerator(
      fakeCtx({
        llm: {
          stream: () =>
            (async function* () {
              yield { type: "text-delta", text: "部分" };
              throw new Error("断了");
            })(),
        },
      }),
      LOG,
      1_000,
    );
    expect(await gen(request)).toBeUndefined();
  });

  test("调用方已经取消时立即返回 undefined，不发起调用", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const gen = createIntentGenerator(
      fakeCtx({ llm: fakeLlm([{ type: "text-delta", text: "x" }], () => (called = true)) }),
      LOG,
      1_000,
    );
    expect(await gen({ ...request, signal: controller.signal })).toBeUndefined();
    expect(called).toBe(false);
  });
});
