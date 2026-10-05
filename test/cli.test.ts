/**
 * 安装准备 CLI 的纯逻辑规格。
 *
 * 场景来自真实部署：dsh 初始化 profile 时只写占位符
 * `allowBuilds: { protobufjs: set this to true or false }`，不表态会让
 * `dsh plugin add` 以 ERR_PNPM_IGNORED_BUILDS 失败，从而**组合包不会被选中**。
 */
import { describe, expect, test } from "vitest";
import { patchProfilePolicy } from "../src/cli.js";

const BASE = ["packages:", "  - .", "", "nodeLinker: hoisted", "autoInstallPeers: false", ""].join("\n");

describe("patchProfilePolicy", () => {
  test("占位符 → false，且保留其余行", () => {
    const yaml = `${BASE}allowBuilds:\n  protobufjs: set this to true or false\n`;
    const out = patchProfilePolicy(yaml);
    expect(out).toContain("allowBuilds:\n  protobufjs: false");
    expect(out).not.toContain("set this to true or false");
    expect(out).toContain("nodeLinker: hoisted");
  });

  test("幂等：已是 false 时不再改动", () => {
    const yaml = `${BASE}allowBuilds:\n  protobufjs: false\n`;
    expect(patchProfilePolicy(yaml)).toBe(yaml);
    expect(patchProfilePolicy(patchProfilePolicy(yaml))).toBe(patchProfilePolicy(yaml));
  });

  test("显式 true 会被改成 false（统一策略）", () => {
    const yaml = `${BASE}allowBuilds:\n  protobufjs: true\n`;
    expect(patchProfilePolicy(yaml)).toContain("protobufjs: false");
  });

  test("缺失 allowBuilds 时补写；allowBuilds 为空块时补项", () => {
    expect(patchProfilePolicy(BASE)).toContain("allowBuilds:\n  protobufjs: false");
    expect(patchProfilePolicy(`${BASE}allowBuilds:\n`)).toContain("allowBuilds:\n  protobufjs: false");
  });

  test("allowBuilds 位于中部时，缺失项补在该块末尾（不污染后面的块）", () => {
    const yaml = `packages:\n  - .\nallowBuilds:\nnodeLinker: hoisted\n`;
    const out = patchProfilePolicy(yaml);
    expect(out).toBe(`packages:\n  - .\nallowBuilds:\n  protobufjs: false\nnodeLinker: hoisted\n`);
  });

  test("保留 allowBuilds 里的其它条目", () => {
    const yaml = `${BASE}allowBuilds:\n  protobufjs: set this to true or false\n  esbuild: true\n`;
    const out = patchProfilePolicy(yaml);
    expect(out).toContain("protobufjs: false");
    expect(out).toContain("esbuild: true");
  });
});
