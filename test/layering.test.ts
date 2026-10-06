/**
 * 分层不变量（**架构测试**）。
 *
 * `docs/REDESIGN.md §5` 与 README 都声明：
 *   `src/bridge/**` 与 `src/feishu/**` **不 import 任何 `@deepseek-ai/dsh-*` 运行时模块**
 *   （类型除外），因此核心逻辑可以在没有 dsh 的环境里单测。
 *
 * 这条约束很容易在后续改动里被无意打破（`import { x } from "@deepseek-ai/dsh-…"`
 * 长得和普通 import 一模一样），所以在这里把它变成一条会失败的测试。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { globSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * 允许直接依赖宿主包的地方：宿主适配层 + 装配层 + **浏览器半侧**。
 *
 * 最后一类是新加的：`src/client/` 是插件的浏览器半侧，它天然要 `import`
 * `@deepseek-ai/dsh-client-*`（slots / locale / configForms 都在那边）。
 * 它不参与 Node 侧单测，所以不受"核心逻辑必须宿主无关"的约束。
 */
const HOST_AWARE = ["src/dsh/", "src/index.ts", "src/client/"];
/** 这些目录/文件必须保持宿主无关。 */
const MUST_STAY_PURE = ["src/bridge/", "src/feishu/", "src/security/", "src/utils/", "src/config.ts", "src/types.ts"];

/** 匹配一条 import 语句（允许跨行的 `import type { … } from "…"`）。 */
const IMPORT_RE = /import\s+(type\s+)?([^;]*?)from\s*["']([^"']+)["']/g;
/** 副作用 import（`import "@x"`）没有 type 逃逸，一律算运行时依赖。 */
const BARE_IMPORT_RE = /import\s+["']([^"']+)["']/g;

interface RuntimeDependency {
  readonly file: string;
  readonly specifier: string;
}

function sourceFiles(): string[] {
  return globSync("src/**/*.ts", { cwd: ROOT }).map((p) => p.replace(/\\/g, "/"));
}

/** 收集所有**运行时**（非 `import type`）的第三方依赖。 */
function runtimeDependencies(file: string): RuntimeDependency[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const found: RuntimeDependency[] = [];

  for (const match of source.matchAll(IMPORT_RE)) {
    const [, typeKeyword, , specifier] = match;
    if (!specifier) continue;
    if (typeKeyword) continue; // `import type` 编译后被抹掉，不算运行时依赖
    found.push({ file, specifier });
  }
  for (const match of source.matchAll(BARE_IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) found.push({ file, specifier });
  }
  return found;
}

function isHostPackage(specifier: string): boolean {
  return specifier.startsWith("@deepseek-ai/dsh");
}

describe("分层不变量：宿主无关层不得依赖 dsh 运行时", () => {
  test("src/bridge、src/feishu、src/security、src/utils、config.ts、types.ts 都没有 dsh 运行时 import", () => {
    const violations = sourceFiles()
      .filter((file) => MUST_STAY_PURE.some((prefix) => file.startsWith(prefix)))
      .flatMap((file) => runtimeDependencies(file))
      .filter((dep) => isHostPackage(dep.specifier));

    expect(
      violations.map((v) => `${v.file} → ${v.specifier}`),
      "这些 import 会让核心逻辑无法在没有 dsh 的环境里单测；" +
        "要么改成 `import type`，要么把宿主适配挪到 src/dsh/",
    ).toEqual([]);
  });

  test("类型 import 是允许的（它们是这条规则的逃生通道）", () => {
    // 现成的例子：questions.ts 只从 dsh-user-questions 借用类型
    const questions = runtimeDependencies("src/bridge/questions.ts");
    expect(questions.filter((d) => isHostPackage(d.specifier))).toEqual([]);
    expect(readFileSync(join(ROOT, "src/bridge/questions.ts"), "utf8")).toContain(
      'import type {',
    );
  });

  test("浏览器半侧只依赖客户端包，不碰宿主的 Node 侧包", () => {
    // `src/client/**` 是浏览器半侧，打出来的 bundle 由宿主的客户端模块系统加载。
    // 一旦 import 了宿主 Node 侧包（dsh-agent / dsh-llm / dsh-session …），
    // 浏览器里加载会直接失败 —— 而这类错误在 Node 侧单测里看不出来。
    const CLIENT_ALLOWED = /^@deepseek-ai\/dsh-client-/;
    const violations = globSync("src/client/**/*.ts", { cwd: ROOT })
      .map((p) => p.replace(/\\/g, "/"))
      .flatMap((file) => runtimeDependencies(file))
      .filter((dep) => isHostPackage(dep.specifier) && !CLIENT_ALLOWED.test(dep.specifier));

    expect(
      violations.map((v) => `${v.file} → ${v.specifier}`),
      "浏览器半侧只能依赖 @deepseek-ai/dsh-client-*（以及 react）；宿主 Node 侧包在浏览器里不存在",
    ).toEqual([]);
  });

  test("宿主依赖确实只集中在 src/dsh 与装配层（正向确认规则不是空转）", () => {
    const owners = new Set(
      sourceFiles()
        .flatMap((file) => runtimeDependencies(file))
        .filter((dep) => isHostPackage(dep.specifier))
        .map((dep) => dep.file)
        // 归一化到"归属层"，便于断言
        .map((file) => HOST_AWARE.find((p) => file.startsWith(p)) ?? file),
    );

    // 说明：src/dsh/source.ts 里的 dsh 依赖只有类型，所以这里可能只出现 index.ts 与 src/dsh/
    for (const owner of owners) {
      expect(HOST_AWARE, `${owner} 不在允许的宿主感知层里`).toContain(owner);
    }
    expect(owners.size).toBeGreaterThan(0);
  });

  test("扫描本身有效：能识别出一个已知的运行时 import", () => {
    const deps = runtimeDependencies("src/dsh/port.ts");
    expect(deps.some((d) => d.specifier === "@deepseek-ai/dsh-llm")).toBe(true);
    // 且相对路径 import 不算第三方依赖
    expect(deps.some((d) => d.specifier.startsWith("."))).toBe(true);
  });
});
