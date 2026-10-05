#!/usr/bin/env node
/**
 * 安装准备 CLI。
 *
 * 为什么需要它：pnpm ≥10 默认**拒绝运行依赖的构建脚本**，而 dsh 初始化 profile 时只在
 * `pnpm-workspace.yaml` 里写一个占位符：
 *
 * ```yaml
 * allowBuilds:
 *   protobufjs: set this to true or false
 * ```
 *
 * 不表态时 `dsh plugin --profile <name> add dsh-feishu-plugin` 会以
 * `ERR_PNPM_IGNORED_BUILDS` 非零退出 —— 于是**组合包不会被追加进 `dsh.profile.bundles`**，
 * 插件看起来"装了但没生效"。本 CLI 幂等地把该项写成 `false`（protobufjs 的 postinstall
 * 只打印一行提示，跳过即可），然后让用户重跑 add。
 *
 * 用法：
 * ```sh
 * dsh-feishu-plugin prepare --profile <name>   # 默认 $DSH_HOME/profiles/<name>
 * ```
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把 `pnpm-workspace.yaml` 里的 `allowBuilds` 占位符/缺失项补成 `protobufjs: false`。
 *
 * 幂等：已经是 `false` 时逐字节返回原文本（包括结尾换行）。
 */
export function patchProfilePolicy(yaml: string): string {
  const endsWithNewline = yaml.endsWith("\n");
  const lines = yaml.split("\n");
  // split 会在结尾换行处留一个空元素；先摘掉，最后再补回，避免补写项落到空行之后。
  if (endsWithNewline) lines.pop();

  const out: string[] = [];
  let inAllowBuilds = false;
  let sawProtobufjs = false;
  let sawAllowBuilds = false;

  for (const line of lines) {
    const isTopLevel = /^[A-Za-z_][\w-]*:/.test(line);
    if (isTopLevel) {
      // 离开上一个 allowBuilds 块时补写缺失项。
      if (inAllowBuilds && !sawProtobufjs) out.push("  protobufjs: false");
      inAllowBuilds = line.trimEnd() === "allowBuilds:";
      if (inAllowBuilds) {
        sawAllowBuilds = true;
        sawProtobufjs = false;
      }
      out.push(line);
      continue;
    }
    if (inAllowBuilds && /^\s+protobufjs\s*:/.test(line)) {
      sawProtobufjs = true;
      // 覆盖占位符或任意已有值 → 统一为 false（幂等）。
      out.push("  protobufjs: false");
      continue;
    }
    out.push(line);
  }
  if (inAllowBuilds && !sawProtobufjs) out.push("  protobufjs: false");
  if (!sawAllowBuilds) {
    if (out.length > 0) out.push("");
    out.push("allowBuilds:", "  protobufjs: false");
  }
  return out.join("\n") + (endsWithNewline ? "\n" : "");
}

function profileDir(name: string): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(home, "profiles", name);
}

export function prepareProfile(name: string): { readonly path: string; readonly changed: boolean } {
  const dir = profileDir(name);
  const file = join(dir, "pnpm-workspace.yaml");
  if (!existsSync(file)) {
    throw new Error(`profile "${name}" 尚未初始化（找不到 ${file}）：先跑一次 dsh plugin --profile ${name} add <包>`);
  }
  const before = readFileSync(file, "utf8");
  const after = patchProfilePolicy(before);
  const changed = before !== after;
  if (changed) writeFileSync(file, after, "utf8");
  return { path: file, changed };
}

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command !== "prepare") {
    process.stderr.write(
      [
        "用法：dsh-feishu-plugin prepare --profile <name>",
        "",
        "作用：把 profile 的 pnpm-workspace.yaml 里 allowBuilds.protobufjs 写成 false，",
        "      避免 pnpm ≥10 因「忽略构建脚本」而让 dsh plugin add 失败（导致组合包未被选中）。",
        "",
      ].join("\n"),
    );
    return command === undefined || command === "--help" || command === "-h" ? 0 : 1;
  }
  const index = rest.indexOf("--profile");
  const name = index >= 0 ? rest[index + 1] : undefined;
  if (!name) {
    process.stderr.write("缺少 --profile <name>\n");
    return 1;
  }
  try {
    const result = prepareProfile(name);
    process.stdout.write(
      `${result.changed ? "已写入" : "无需修改"}：${result.path}\n` +
        `下一步：dsh plugin --profile ${name} add dsh-feishu-plugin\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * 仅在作为可执行入口时运行 main（被 import 时不触发）。
 *
 * 注意必须比 **realpath**：包管理器把 bin 装成符号链接（`node_modules/.bin/x -> ../pkg/lib/cli.js`），
 * 此时 `process.argv[1]` 是链接路径，而 ESM 的 `import.meta.url` 已被解析成真实路径 ——
 * 直接字符串比较会判定"不是入口"，脚本静默退出（实测踩到过）。
 */
function isMainEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  process.exitCode = main(process.argv.slice(2));
}
