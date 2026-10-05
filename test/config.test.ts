/**
 * 配置解析规格。
 *
 * 两处是**缺陷驱动**的，必须有回归：
 * - `cwd` **不再回落 `process.cwd()`**（旧实现让会话目录取决于宿主从哪启动，
 *   实测变成了 `/private/tmp`）；
 * - `provider` / `model` 只写一半时**不能让解析静默补另一半** ——
 *   那是运行时才炸的配置错误，`resolveConfig` 保留原文，由 `pickModel` 响亮失败。
 */
import { describe, expect, test } from "vitest";
import { deriveSignSecret, resolveConfig } from "../src/config.js";
import { homedir } from "node:os";

describe("凭据与启用", () => {
  test("有 appId + appSecret → enabled", () => {
    expect(resolveConfig({ appId: "cli_x", appSecret: "s" }).enabled).toBe(true);
  });

  test("只有 appSecretRef 也算有凭据", () => {
    expect(resolveConfig({ appId: "cli_x", appSecretRef: "FEISHU_SECRET" }).enabled).toBe(true);
  });

  test("缺任一 → 禁用（插件保持不连飞书，而不是抛）", () => {
    expect(resolveConfig({ appSecret: "s" }).enabled).toBe(false);
    expect(resolveConfig({ appId: "cli_x" }).enabled).toBe(false);
    expect(resolveConfig({}).enabled).toBe(false);
  });

  test("空白字符串不算值", () => {
    const config = resolveConfig({ appId: "  ", appSecret: "  " });
    expect(config.appId).toBeUndefined();
    expect(config.appSecret).toBeUndefined();
    expect(config.enabled).toBe(false);
  });

  test("签名密钥由 appSecret 派生；没有 appSecret 时为空串", () => {
    expect(resolveConfig({ appSecret: "s" }).signSecret).toBe(deriveSignSecret("s"));
    expect(resolveConfig({}).signSecret).toBe("");
  });

  test("派生是确定性的且不同 secret 不同", () => {
    expect(deriveSignSecret("a")).toBe(deriveSignSecret("a"));
    expect(deriveSignSecret("a")).not.toBe(deriveSignSecret("b"));
  });
});

describe("工作目录（缺陷 2 回归）", () => {
  test("缺省 = allowedRoots 第一项，**不是** process.cwd()", () => {
    const config = resolveConfig({ allowedRoots: ["/tmp/explicit-root"] });
    expect(config.cwd).toBe("/tmp/explicit-root");
    expect(config.cwd).not.toBe(process.cwd());
  });

  test("allowedRoots 为空时回落用户家目录（仍是显式默认，不是 cwd）", () => {
    const config = resolveConfig({});
    expect(config.cwd).toBe(homedir());
    expect(config.allowedRoots).toEqual([homedir()]);
    expect(config.cwd).not.toBe(process.cwd());
  });

  test("显式 cwd 优先", () => {
    expect(resolveConfig({ cwd: "/work/x", allowedRoots: ["/other"] }).cwd).toBe("/work/x");
  });

  test("allowedRoots 去重并去除空白", () => {
    expect(resolveConfig({ allowedRoots: [" /a ", "/a", "", "  ", "/b"] }).allowedRoots).toEqual(["/a", "/b"]);
  });
});

describe("模型覆盖", () => {
  test("原样保留，不做「补一半」", () => {
    const config = resolveConfig({ provider: "p" });
    expect(config.provider).toBe("p");
    expect(config.model).toBeUndefined();
  });

  test("三者都能透传", () => {
    const config = resolveConfig({ provider: "p", model: "m", reasoningEffort: "max" });
    expect(config.provider).toBe("p");
    expect(config.model).toBe("m");
    expect(config.reasoningEffort).toBe("max");
  });

  test("空白被归一化为 undefined", () => {
    const config = resolveConfig({ provider: "  ", model: "", reasoningEffort: " " });
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(config.reasoningEffort).toBeUndefined();
  });
});

describe("枚举与默认值", () => {
  test("permissionGate 默认 gate", () => {
    expect(resolveConfig({}).permissionGate).toBe("gate");
  });

  test("busyDelivery 默认 steer；显式 queue 生效", () => {
    expect(resolveConfig({}).busyDelivery).toBe("steer");
    expect(resolveConfig({ busyDelivery: "queue" }).busyDelivery).toBe("queue");
  });

  test("threadRouting 默认 true；显式 false 生效", () => {
    expect(resolveConfig({}).threadRouting).toBe(true);
    expect(resolveConfig({ threadRouting: false }).threadRouting).toBe(false);
  });

  test("groupEnabled 默认 false（最小权限：不开群）", () => {
    expect(resolveConfig({}).groupEnabled).toBe(false);
    expect(resolveConfig({ groupEnabled: true }).groupEnabled).toBe(true);
  });

  test("stream 默认 true，显式 false 生效", () => {
    expect(resolveConfig({}).stream).toBe(true);
    expect(resolveConfig({ stream: false }).stream).toBe(false);
  });

  test("意图识别默认开启，可关", () => {
    expect(resolveConfig({}).intentRouting).toBe(true);
    expect(resolveConfig({ intentRouting: false }).intentRouting).toBe(false);
  });

  test("超时与分页默认值", () => {
    const config = resolveConfig({});
    expect(config.staleExecutionMs).toBe(300_000);
    expect(config.approvalTtlMs).toBe(600_000);
    expect(config.questionTtlMs).toBe(600_000);
    expect(config.sessionPageSize).toBe(8);
    expect(config.intentTimeoutMs).toBe(15_000);
    expect(config.cardThrottleMs).toBe(700);
    expect(config.topicTitleMaxChars).toBe(20);
  });

  test("允许工具白名单有默认值；显式给空数组表示不放过任何工具", () => {
    expect(resolveConfig({}).allowTools.length).toBeGreaterThan(0);
    expect(resolveConfig({ allowTools: [] }).allowTools).toEqual([]);
  });

  test("domain 去掉尾部斜杠并补默认", () => {
    expect(resolveConfig({}).domain).toBe("https://open.feishu.cn");
    expect(resolveConfig({ domain: "https://open.larksuite.com/" }).domain).toBe("https://open.larksuite.com");
  });
});
