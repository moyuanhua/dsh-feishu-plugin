/**
 * 打包 `lib/` 的两个入口。
 *
 * **为什么需要打包**（而不是继续用裸 `tsc`）：插件运行时要依赖 `@larksuite/channel`，
 * 它会带进 `protobufjs` —— 而 pnpm ≥10 **默认拦下依赖的构建脚本**，
 * 于是每个新用户在 `dsh plugin add` 时都会先撞一次
 * `ERR_PNPM_IGNORED_BUILDS`，还要手动处理 allowBuilds。
 *
 * 打成自包含 bundle 之后 `dependencies` 为空，安装一次成功。
 * 上游 `opencode-feishu-plugin` 用同样的做法（`dist/index.js` 自包含，
 * "运行时无需手动 npm install"）。
 *
 * 外部化策略：
 * - `node:*`：`platform: 'node'` 自动外部化（还有 bun 的 `bun:*`，这里用不到）；
 * - `@deepseek-ai/*`：**必须外部化** —— 这些是宿主提供的服务与 Config schema，
 *   打进自己的副本会导致 `Config` 不是宿主 Loader 认得的那个实例。
 *   它们已经在 `peerDependencies` 里声明。
 * - 其余（`@larksuite/channel`、`zod`）打进 bundle。
 */
import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { spawnSync } from "node:child_process";

const ENTRIES = ["src/index.ts", "src/cli.ts"];

await build({
  entryPoints: ENTRIES,
  outdir: "lib",
  bundle: true,
  platform: "node",
  format: "esm",
  // 与 engines.node 的下限对齐（^22.19.0）。
  target: "node22",
  external: ["@deepseek-ai/*"],
  sourcemap: true,
  // 只把真正用到的部分打进来，别把 dev 分支和类型断言带进去。
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  banner: {
    /**
     * **createRequire 这条不能删。**
     *
     * 打进 bundle 的 CJS 依赖（如 `form-data` → `combined-stream`）会在**模块初始化时**
     * 直接调 `require("util")`。esbuild 把它转成自己的 `__require` 垫片，而该垫片是
     * `typeof require !== "undefined" ? require : 抛错`，在 ESM 里 `require` 未定义，
     * 于是加载即失败：
     *
     *     Error: Dynamic require of "util" is not supported
     *
     * 在没有 `require` 的运行时里给模块作用域造一个真的 `require`，垫片就会走正常分支。
     * 这条 banner 必须排在 esbuild 生成的垫片**之前**（banner 就是这么生效的）。
     */
    js: [
      'import { createRequire as __dshCreateRequire } from "node:module";',
      'import { fileURLToPath as __dshFileURLToPath } from "node:url";',
      'import { dirname as __dshDirname } from "node:path";',
      "const require = __dshCreateRequire(import.meta.url);",
      "// 打进 bundle 的 CJS 依赖还会用 __dirname/__filename（例如飞书 SDK 用它读自己的 package.json）。",
      "// 在 ESM 里这两个全局不存在，必须补上，否则同样是「能打包、加载即炸」。",
      "const __filename = __dshFileURLToPath(import.meta.url);",
      "const __dirname = __dshDirname(__filename);",
      "// Bundled by scripts/bundle.mjs — 源码见 https://github.com/moyuanhua/dsh-feishu-plugin",
    ].join("\n"),
  },
});

// esbuild 会保留入口的 shebang，但不会带上可执行位。
chmodSync("lib/cli.js", 0o755);

// 自检：bundle 里不允许再出现第三方运行时依赖。
//
// 判定用 Node 自己的内置模块清单 —— 别用正则猜：打进 bundle 的代码里有
// `from "fs"` / `from "http"` 这种**不带 `node:` 前缀**的写法（Node 一样解析），
// 只认 `node:` 前缀会把它们误判成漏打包的依赖。
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const IMPORT_RE = /^\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/gm;

let failed = false;
for (const entry of ["lib/index.js", "lib/cli.js"]) {
  const source = readFileSync(entry, "utf8");
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier.startsWith(".") || specifier.startsWith("@deepseek-ai/")) continue;
    if (BUILTINS.has(specifier)) continue;
    console.error(`✗ ${entry} 仍然 import 了未打包的依赖："${specifier}"`);
    failed = true;
  }
}
if (failed) {
  console.error("打包不完整 —— 否则装到用户机器上会因为缺依赖加载失败。");
  process.exit(1);
}

for (const entry of ["lib/index.js", "lib/cli.js"]) {
  const bytes = readFileSync(entry).byteLength;
  console.log(`  ${entry}  ${(bytes / 1024).toFixed(0)} kB`);
}

/**
 * 冒烟测试：**真的 import 一次**。
 *
 * 光看静态 import 是不够的 —— 上面那个 `__require` 问题在静态检查里完全看不出来，
 * 只有在模块初始化真正执行到那段 CJS 代码时才炸。这里用子进程跑，
 * 保证击穿 bundle 的完整初始化路径。
 *
 * 注意：`@deepseek-ai/*` 由宿主提供，本仓库的 node_modules 里有同名包可以解析，
 * 所以这里能跑通；换成别的环境可能解析失败，那属于环境问题而非打包问题。
 */
const smoke = spawnSync(process.execPath, ["-e", "await import('./lib/index.js')"], {
  cwd: process.cwd(),
  encoding: "utf8",
});
if (smoke.status !== 0) {
  console.error("✗ bundle 无法加载（静态检查通过但初始化失败）：");
  console.error((smoke.stderr || smoke.stdout || "").split("\n").slice(0, 12).join("\n"));
  process.exit(1);
}
console.log(`✓ bundle 完成：${ENTRIES.join(" / ")} → lib/（无第三方运行时依赖）`);
