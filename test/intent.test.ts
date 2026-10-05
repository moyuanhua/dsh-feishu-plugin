/**
 * AI 意图识别规格（纯逻辑）。
 *
 * 这套逻辑的来源是上游 `src/session/quick-new.ts`，但有三处**按产品决策重设计**，
 * 每一条都有对应用例：
 * 1. 模型未命中 → **回退默认并告知**（上游是静默不预填）；
 * 2. 目录校验通过**注入的谓词**完成（因此本模块零 IO、可全量单测）；
 * 3. 目录的六种落点文案逐条可断言。
 */
import { describe, expect, test } from "vitest";
import {
  buildIntentPrompt,
  INTENT_INSTRUCTION,
  INTENT_NOTICE,
  matchCandidateDirectory,
  matchModelOption,
  parseIntentDecision,
  resolveIntentDir,
  resolveIntentModel,
  slugifyTitle,
  type IntentCandidateDir,
  type IntentModelOption,
} from "../src/bridge/intent.js";

const MODELS: IntentModelOption[] = [
  { provider: "opencode-go", model: "deepseek-v4.1-flash", label: "V4.1 Flash" },
  { provider: "deepseek-official", model: "deepseek-chat", label: "DeepSeek Chat" },
];
const DEFAULT_MODEL: IntentModelOption = { provider: "opencode-go", model: "deepseek-v4.1-flash" };

describe("buildIntentPrompt", () => {
  test("包含指令、根目录、候选目录、候选模型与用户消息", () => {
    const prompt = buildIntentPrompt({
      text: "帮我看下 wps 那个仓库",
      candidates: [{ path: "/Users/code/wps", label: "wps 仓库" }],
      models: MODELS,
      allowedRoots: ["/Users/code"],
    });
    expect(prompt).toContain(INTENT_INSTRUCTION);
    expect(prompt).toContain("- /Users/code");
    expect(prompt).toContain("- /Users/code/wps（wps 仓库）");
    expect(prompt).toContain("- opencode-go/deepseek-v4.1-flash（V4.1 Flash）");
    expect(prompt).toContain("帮我看下 wps 那个仓库");
  });

  test("空候选时给出「（无）」而不是空段", () => {
    const prompt = buildIntentPrompt({ text: "hi", candidates: [] });
    expect(prompt).toContain("（无）");
  });

  test("上限：用户消息截断 2000 字、目录 60 条、模型 30 条、根目录 8 条", () => {
    const prompt = buildIntentPrompt({
      text: "x".repeat(3000),
      candidates: Array.from({ length: 100 }, (_, i) => ({ path: `/p${i}` })),
      models: Array.from({ length: 50 }, (_, i) => ({ provider: "p", model: `m${i}` })),
      allowedRoots: Array.from({ length: 20 }, (_, i) => `/r${i}`),
    });
    expect(prompt).not.toContain("x".repeat(2001));
    expect(prompt).toContain("- /p59");
    expect(prompt).not.toContain("- /p60");
    expect(prompt).toContain("- p/m29");
    expect(prompt).not.toContain("- p/m30");
    expect(prompt).toContain("- /r7");
    expect(prompt).not.toContain("- /r8");
  });
});

describe("parseIntentDecision", () => {
  test("完整 JSON", () => {
    expect(
      parseIntentDecision(
        '{"intent":"create","dir":"/a/b","dir_source":"given","title":"标题","perm":"edit","model":"p/m","reason":"因为"}',
      ),
    ).toEqual({
      intent: "create",
      directory: "/a/b",
      dirSource: "given",
      title: "标题",
      perm: "edit",
      model: "p/m",
      reason: "因为",
    });
  });

  test("容忍 ```json 围栏与前后杂讯", () => {
    const raw = '好的，这是结果：\n```json\n{"intent":"list"}\n```\n以上。';
    expect(parseIntentDecision(raw)).toEqual({ intent: "list" });
  });

  test("intent 非法 / 缺失 / 非 JSON → undefined", () => {
    expect(parseIntentDecision('{"intent":"nope"}')).toBeUndefined();
    expect(parseIntentDecision('{"dir":"/a"}')).toBeUndefined();
    expect(parseIntentDecision("完全不是 JSON")).toBeUndefined();
    expect(parseIntentDecision("")).toBeUndefined();
    expect(parseIntentDecision(undefined)).toBeUndefined();
    expect(parseIntentDecision('["array"]')).toBeUndefined();
  });

  test("别名：directory / dirSource 都认", () => {
    expect(parseIntentDecision('{"intent":"create","directory":"/x","dirSource":"new"}')).toEqual({
      intent: "create",
      directory: "/x",
      dirSource: "new",
    });
  });

  test("非法枚举值被丢弃而不是透传", () => {
    const decision = parseIntentDecision('{"intent":"create","perm":"god-mode","dir_source":"whatever"}');
    expect(decision).toEqual({ intent: "create" });
  });

  test("title 截断 30、reason 截断 200", () => {
    const decision = parseIntentDecision(
      JSON.stringify({ intent: "create", title: "t".repeat(50), reason: "r".repeat(500) }),
    );
    expect(decision?.title).toHaveLength(30);
    expect(decision?.reason).toHaveLength(200);
  });
});

describe("slugifyTitle", () => {
  test("英文标题 → 小写短横线", () => {
    expect(slugifyTitle("Fix Build Errors")).toBe("fix-build-errors");
  });
  test("中文标题 → 空串（由调用方兜底到根目录）", () => {
    expect(slugifyTitle("修复编译报错")).toBe("");
  });
  test("截断 40 且不留尾部短横线", () => {
    const slug = slugifyTitle("a".repeat(60));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("matchCandidateDirectory（防幻觉）", () => {
  const candidates: IntentCandidateDir[] = [{ path: "/Users/code/wps" }, { path: "/Users/code/app" }];

  test("精确命中返回候选的规范路径", () => {
    expect(matchCandidateDirectory("/Users/code/wps", candidates)).toBe("/Users/code/wps");
  });
  test("容忍尾斜杠差异", () => {
    expect(matchCandidateDirectory("/Users/code/wps/", candidates)).toBe("/Users/code/wps");
  });
  test("编造的路径不予通过", () => {
    expect(matchCandidateDirectory("/etc/passwd", candidates)).toBeUndefined();
    expect(matchCandidateDirectory(undefined, candidates)).toBeUndefined();
  });
});

describe("matchModelOption（三级匹配）", () => {
  test("provider/model 精确匹配", () => {
    expect(matchModelOption("opencode-go/deepseek-v4.1-flash", MODELS)?.provider).toBe("opencode-go");
  });
  test("裸 model 名匹配", () => {
    expect(matchModelOption("deepseek-chat", MODELS)?.provider).toBe("deepseek-official");
  });
  test("展示名匹配（大小写不敏感）", () => {
    expect(matchModelOption("v4.1 flash", MODELS)?.model).toBe("deepseek-v4.1-flash");
  });
  test("都没命中 → undefined", () => {
    expect(matchModelOption("gpt-5", MODELS)).toBeUndefined();
    expect(matchModelOption(undefined, MODELS)).toBeUndefined();
  });
});

describe("resolveIntentModel（产品决策：未命中回退默认）", () => {
  test("用户点名且可用 → 用他说的", () => {
    const result = resolveIntentModel({ intent: "create", model: "deepseek-chat" }, MODELS, DEFAULT_MODEL);
    expect(result.model?.model).toBe("deepseek-chat");
    expect(result.notice).toBeUndefined();
  });

  test("用户点名但不可用 → 回退默认 + 明确告知（上游是静默忽略）", () => {
    const result = resolveIntentModel({ intent: "create", model: "gpt-5" }, MODELS, DEFAULT_MODEL);
    expect(result.model).toEqual(DEFAULT_MODEL);
    expect(result.notice).toContain("gpt-5");
    expect(result.notice).toContain("默认模型");
  });

  test("用户没说 → 用默认且不打扰", () => {
    const result = resolveIntentModel({ intent: "create" }, MODELS, DEFAULT_MODEL);
    expect(result.model).toEqual(DEFAULT_MODEL);
    expect(result.notice).toBeUndefined();
  });

  test("点名不可用且没有默认 → 告知去表单里选", () => {
    const result = resolveIntentModel({ intent: "create", model: "gpt-5" }, MODELS, undefined);
    expect(result.model).toBeUndefined();
    expect(result.notice).toContain("请在表单里选择");
  });

  test("没有默认也没有点名 → 什么都不给", () => {
    expect(resolveIntentModel({ intent: "create" }, MODELS, undefined)).toEqual({});
  });
});

describe("resolveIntentDir（六种落点）", () => {
  const ok = (path: string) => ({ ok: true, path }) as const;
  const bad = (message: string) => ({ ok: false, message }) as const;
  const base = {
    candidates: [{ path: "/Users/code/wps" }],
    allowedRoots: ["/Users/code"],
    title: "修复编译报错",
  };

  test("given 且校验通过 → 用用户给的路径（realpath）", () => {
    const result = resolveIntentDir({
      ...base,
      decision: { intent: "create", directory: "/Users/code/x", dirSource: "given" },
      validateDir: ok,
    });
    expect(result).toEqual({ dir: "/Users/code/x", notice: INTENT_NOTICE.given });
  });

  test("given 但校验失败 → 不预填目录，并把原因说出来", () => {
    const result = resolveIntentDir({
      ...base,
      decision: { intent: "create", directory: "/etc", dirSource: "given" },
      validateDir: () => bad("系统目录不可作为工作目录。"),
    });
    expect(result.dir).toBeUndefined();
    expect(result.notice).toContain("/etc");
    expect(result.notice).toContain("系统目录");
  });

  test("命中候选 → 用候选的规范路径", () => {
    const result = resolveIntentDir({
      ...base,
      decision: { intent: "create", directory: "/Users/code/wps/", dirSource: "existing" },
      validateDir: ok,
    });
    expect(result).toEqual({ dir: "/Users/code/wps", notice: INTENT_NOTICE.existing });
  });

  test("AI 提出的新路径校验通过 → 新建目录", () => {
    const result = resolveIntentDir({
      ...base,
      decision: { intent: "create", directory: "/Users/code/new-proj", dirSource: "new" },
      validateDir: ok,
    });
    expect(result).toEqual({ dir: "/Users/code/new-proj", notice: INTENT_NOTICE.newDir });
  });

  test("没有路径 → 用 title 的 slug 兜底", () => {
    const result = resolveIntentDir({
      ...base,
      decision: { intent: "create", title: "fix build" },
      validateDir: ok,
    });
    expect(result).toEqual({ dir: "/Users/code/fix-build", notice: INTENT_NOTICE.newDir });
  });

  test("中文标题 slug 为空 / slug 校验不过 → 退回允许根目录", () => {
    const result = resolveIntentDir({
      ...base,
      decision: { intent: "create", title: "修复编译报错" },
      validateDir: ok,
    });
    expect(result).toEqual({ dir: "/Users/code", notice: INTENT_NOTICE.root });
  });

  test("slug 路径校验失败也退回根目录", () => {
    const result = resolveIntentDir({
      ...base,
      decision: { intent: "create", title: "fix build" },
      validateDir: (path) => (path === "/Users/code" ? ok(path) : bad("越界")),
    });
    expect(result.dir).toBe("/Users/code");
    expect(result.notice).toBe(INTENT_NOTICE.root);
  });

  test("没有允许根目录 → 明确提示", () => {
    const result = resolveIntentDir({
      ...base,
      allowedRoots: [],
      decision: { intent: "create" },
      validateDir: ok,
    });
    expect(result).toEqual({ notice: INTENT_NOTICE.noRoot });
  });
});
