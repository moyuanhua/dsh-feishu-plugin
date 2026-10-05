/**
 * 模型解析规格。
 *
 * 缺陷 1 的回归：旧实现建会话时**完全不传模型**，会话建出来就注定跑不起来
 * （第一次模型请求报 `has no provider/model`），而错误又被映射吞成 ✅。
 * 现在模型解析是建会话的**前置步骤**，拿不到就拒绝建会话。
 */
import { describe, expect, test } from "vitest";
import {
  isValidSelection,
  NO_MODEL_MESSAGE,
  pickModel,
  type AgentDefaultModelLike,
  type ModelSelection,
} from "../src/dsh/model.js";

describe("isValidSelection", () => {
  test("provider 与 model 都必须非空", () => {
    expect(isValidSelection({ provider: "p", model: "m" })).toBe(true);
    expect(isValidSelection({ provider: "p" })).toBe(false);
    expect(isValidSelection({ model: "m" })).toBe(false);
    expect(isValidSelection({ provider: "  ", model: "m" })).toBe(false);
    expect(isValidSelection(undefined)).toBe(false);
  });
});

describe("pickModel：配置覆盖优先", () => {
  const host: ModelSelection = { provider: "deepseek", model: "deepseek-chat" };

  test("配置完整时用配置，并标记来源", () => {
    expect(pickModel({ provider: "opencode-go", model: "deepseek-v4.1-flash" }, host)).toEqual({
      ok: true,
      source: "config",
      selection: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
    });
  });

  test("配置带推理强度时一并带上", () => {
    const result = pickModel({ provider: "p", model: "m", reasoningEffort: "max" }, host);
    expect(result.ok && result.selection.reasoningEffort).toBe("max");
  });

  test("配置只写了一半 → 响亮失败（不静默用宿主默认值补另一半）", () => {
    const onlyProvider = pickModel({ provider: "p" }, host);
    expect(onlyProvider.ok).toBe(false);
    expect(onlyProvider.ok || onlyProvider.message).toContain("同时提供");
    expect(pickModel({ model: "m" }, host).ok).toBe(false);
  });

  test("没有配置时用宿主默认模型，并标记来源", () => {
    expect(pickModel({}, host)).toEqual({ ok: true, source: "agent-default-model", selection: host });
  });

  test("配置与宿主默认都没有 → 拒绝，且提示可操作", () => {
    const result = pickModel({}, undefined);
    expect(result.ok).toBe(false);
    expect(result.ok || result.message).toBe(NO_MODEL_MESSAGE);
    expect(NO_MODEL_MESSAGE).toContain("设置");
    expect(NO_MODEL_MESSAGE).toContain("provider");
  });

  test("宿主默认值不完整时等同于没有", () => {
    expect(pickModel({}, { provider: "p" }).ok).toBe(false);
    expect(pickModel({}, {}).ok).toBe(false);
  });

  test("空白字符串不算配置", () => {
    expect(pickModel({ provider: "  ", model: "  " }, host)).toEqual({
      ok: true,
      source: "agent-default-model",
      selection: host,
    });
  });
});

describe("AgentDefaultModelLike 契约", () => {
  test("currentSelection() 的返回形状与 dsh 服务一致（provider/model/reasoningEffort?）", () => {
    const service: AgentDefaultModelLike = {
      currentSelection: () => ({ provider: "opencode-go", model: "deepseek-v4.1-flash" }),
    };
    expect(pickModel({}, service.currentSelection())).toEqual({
      ok: true,
      source: "agent-default-model",
      selection: { provider: "opencode-go", model: "deepseek-v4.1-flash" },
    });
  });
});
