/**
 * 建会话表单规格（飞书卡片 2.0 原生表单容器）。
 *
 * 这里锁的是**平台契约**（已查证官方文档）：
 * - `form` 只能放在卡片根节点下；
 * - 容器内每个交互组件必须有全局唯一的 `name`，否则**数据发送失败**；
 * - 容器内**必须**至少有一个 `form_action_type: "submit"` 的按钮；
 * - 提交回调把值放在 `action.form_value` 下按 `name` 给出；
 * - `select_static` 回传的是选项的 `value`。
 *
 * 这些一旦写错，用户点了「创建会话」会毫无反应 —— 所以逐条断言。
 */
import { describe, expect, test } from "vitest";
import {
  buildSetupFormCard,
  CUSTOM_DIR_VALUE,
  isSetupSubmit,
  parseSetupSubmit,
  SETUP_FORM_NAME,
  SETUP_SUBMIT_NAME,
  splitModelRef,
  type SetupFormInput,
} from "../src/bridge/setup-form.js";

const BASE: SetupFormInput = {
  title: "修复编译报错",
  defaultDir: "/Users/code/wps",
  allowedRoots: ["/Users/code"],
  dirChoices: ["/Users/code/wps", "/Users/code/app"],
  models: [
    { provider: "opencode-go", model: "deepseek-v4.1-flash", label: "V4.1 Flash" },
    { provider: "deepseek-official", model: "deepseek-chat", label: "DeepSeek Chat" },
  ],
  defaultPerm: "edit",
};

/** 递归收集 name。 */
function names(card: object): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.name === "string") out.push(obj.name);
    for (const value of Object.values(obj)) walk(value);
  };
  walk(card);
  return out;
}

function findTag(card: object, tag: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    const obj = node as Record<string, unknown>;
    if (obj.tag === tag) out.push(obj);
    for (const value of Object.values(obj)) walk(value);
  };
  walk(card);
  return out;
}

describe("卡片结构契约", () => {
  test("form 直接挂在 body.elements 下（不能嵌套）", () => {
    const card = buildSetupFormCard(BASE) as { body: { elements: { tag?: string }[] } };
    const forms = card.body.elements.filter((e) => e.tag === "form");
    expect(forms).toHaveLength(1);
  });

  test("表单容器有全局唯一的 name", () => {
    expect(names(buildSetupFormCard(BASE))).toContain(SETUP_FORM_NAME);
  });

  test("必须有且只有一个 submit 按钮（否则提交事件不触发）", () => {
    const submits = findTag(buildSetupFormCard(BASE), "button").filter(
      (b) => b.form_action_type === "submit",
    );
    expect(submits).toHaveLength(1);
    expect(submits[0]?.name).toBe(SETUP_SUBMIT_NAME);
  });

  test("容器内所有交互组件都有唯一 name（重复会让数据发送失败）", () => {
    const all = names(buildSetupFormCard(BASE));
    expect(new Set(all).size).toBe(all.length);
  });

  test("三个字段都是可选（留空即用默认，用户能直接点创建）", () => {
    for (const tag of ["input", "select_static"]) {
      for (const field of findTag(buildSetupFormCard(BASE), tag)) {
        expect(field.required, String(field.name)).toBe(false);
      }
    }
  });
});

describe("字段内容", () => {
  test("目录输入框预填默认目录", () => {
    const input = findTag(buildSetupFormCard(BASE), "input")[0]!;
    expect(input.name).toBe("dir");
    expect(input.default_value).toBe("/Users/code/wps");
  });

  test("目录下拉包含「就用这个根目录」与子目录，值是完整路径", () => {
    const select = findTag(buildSetupFormCard(BASE), "select_static").find((s) => s.name === "dir_select")!;
    const values = (select.options as { value: string }[]).map((o) => o.value);
    expect(values).toContain("/Users/code");
    expect(values).toContain("/Users/code/wps");
    expect(values).toContain("/Users/code/app");
  });

  test("没有允许根目录时给「手动输入路径」哨兵", () => {
    const card = buildSetupFormCard({ ...BASE, allowedRoots: [] });
    const select = findTag(card, "select_static").find((s) => s.name === "dir_select")!;
    expect((select.options as { value: string }[]).map((o) => o.value)).toContain(CUSTOM_DIR_VALUE);
  });

  test("模型下拉的值是 provider/model", () => {
    const select = findTag(buildSetupFormCard(BASE), "select_static").find((s) => s.name === "model")!;
    const values = (select.options as { value: string }[]).map((o) => o.value);
    expect(values).toEqual(["opencode-go/deepseek-v4.1-flash", "deepseek-official/deepseek-chat"]);
  });

  test("拿不到模型列表时**不渲染**模型下拉（空下拉会让人以为坏了）", () => {
    const card = buildSetupFormCard({ ...BASE, models: [] });
    expect(findTag(card, "select_static").some((s) => s.name === "model")).toBe(false);
  });

  test("权限下拉是四档", () => {
    const select = findTag(buildSetupFormCard(BASE), "select_static").find((s) => s.name === "perm")!;
    const values = (select.options as { value: string }[]).map((o) => o.value);
    expect(values).toEqual(["readonly", "edit", "askHigh", "trust"]);
  });

  test("notice 出现在卡片里（AI 的目录/模型说明靠它传达）", () => {
    const text = JSON.stringify(buildSetupFormCard({ ...BASE, notice: "✍️ 目录由**你指定**" }));
    expect(text).toContain("目录由");
  });
});

describe("提交判定与解析", () => {
  test("只有精确的 submit name 才算提交（上游是任何 formValue 都算，这里不）", () => {
    expect(isSetupSubmit(SETUP_SUBMIT_NAME)).toBe(true);
    expect(isSetupSubmit("some_other_button")).toBe(false);
    expect(isSetupSubmit(undefined)).toBe(false);
  });

  test("下拉选的具体路径优先于输入框", () => {
    expect(parseSetupSubmit({ dir_select: "/a/b", dir: "/x/y" })).toEqual({ dir: "/a/b" });
  });

  test("选「手动输入路径」时以输入框为准", () => {
    expect(parseSetupSubmit({ dir_select: CUSTOM_DIR_VALUE, dir: "/x/y" })).toEqual({ dir: "/x/y" });
  });

  test("都没给 → 不产生 dir（交给默认值）", () => {
    expect(parseSetupSubmit({})).toEqual({});
    expect(parseSetupSubmit(undefined)).toEqual({});
    expect(parseSetupSubmit({ dir: "   ", dir_select: "  " })).toEqual({});
  });

  test("模型与权限原样解析；非法权限被丢弃", () => {
    expect(parseSetupSubmit({ model: "p/m", perm: "trust" })).toEqual({ model: "p/m", perm: "trust" });
    expect(parseSetupSubmit({ perm: "god-mode" })).toEqual({});
  });

  test("空白字符串不算填写", () => {
    expect(parseSetupSubmit({ dir: "  ", model: "  ", perm: "  " })).toEqual({});
  });
});

describe("splitModelRef", () => {
  test("正常拆分", () => {
    expect(splitModelRef("opencode-go/deepseek-v4.1-flash")).toEqual({
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
    });
  });
  test("缺一边 / 缺斜杠 → undefined（宁可用默认，也不要造一个空路由）", () => {
    expect(splitModelRef("/m")).toBeUndefined();
    expect(splitModelRef("p/")).toBeUndefined();
    expect(splitModelRef("no-slash")).toBeUndefined();
    expect(splitModelRef(undefined)).toBeUndefined();
    expect(splitModelRef("")).toBeUndefined();
  });
  test("模型名里含斜杠时只按第一个斜杠拆", () => {
    expect(splitModelRef("p/a/b")).toEqual({ provider: "p", model: "a/b" });
  });
});
