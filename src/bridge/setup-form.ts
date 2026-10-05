/**
 * 建会话表单（`/new` / `/form`）—— **飞书卡片 2.0 原生表单容器**。
 *
 * 为什么单独一个模块：上游的建会话表单（`setup-cards.ts` 571 行 + `setup-wizard.ts` +
 * `dirs.ts` + `root-scan.ts`）在旧路线里一直躺在"未移植"清单中，于是 `/new` 退化成
 * "直接建一个默认会话" —— 用户完全无法选目录、模型、权限。这里把它补回来。
 *
 * 结构依据（飞书开放平台《卡片 JSON 2.0 · 表单容器》/《按钮组件》/《下拉选择》，已查证）：
 * - 表单容器 `tag: "form"` **只能放在卡片根节点下**，不能嵌套在其它组件里；
 * - 容器内每个交互组件**必须**有全局唯一的 `name`，否则**数据会发送失败**；
 * - 容器内**必须**至少有一个 `form_action_type: "submit"` 的按钮；
 * - 提交回调里，值在 `action.form_value` 下按组件的 `name` 给出；
 * - `select_static` 回传的是选项的 `value`（字符串）。
 *
 * 这些是**平台契约**，所以本模块是纯函数：卡片 JSON 与回传值解析都能单测，
 * 不需要连飞书。
 */
import { PERMISSION_PRESETS, isPermissionPreset } from "./perm-presets.js";
import type { PermissionPreset } from "../types.js";
import { MAX_CARD_BYTES, truncateCardContent } from "../feishu/cards.js";

/** 表单容器与提交按钮的 name（回调里靠它们识别）。 */
export const SETUP_FORM_NAME = "setup_form";
export const SETUP_SUBMIT_NAME = "setup_submit";

/** 目录下拉里的"手动输入路径"哨兵值（选了它就以输入框为准）。 */
export const CUSTOM_DIR_VALUE = "__custom__";

/** 一个可选的模型路由。 */
export interface SetupModelChoice {
  readonly provider: string;
  readonly model: string;
  readonly label: string;
}

export interface SetupFormInput {
  /** 会话标题（`/new <标题>` 给的；缺省已由调用方生成）。 */
  readonly title: string;
  /** 目录输入框的默认值（= 解析出的默认工作目录）。 */
  readonly defaultDir: string;
  /** 允许的工作目录根（第一项作为"就用这个根目录"选项）。 */
  readonly allowedRoots: readonly string[];
  /** 允许根目录下的一级子目录（可选，扫描失败时不给）。 */
  readonly dirChoices?: readonly string[];
  /** 可选模型；为空则**不渲染**模型下拉（避免空选项挡住提交）。 */
  readonly models?: readonly SetupModelChoice[];
  /** 默认权限档位。 */
  readonly defaultPerm?: PermissionPreset;
  /** 卡片顶部的额外说明（例如上一次提交失败的原因）。 */
  readonly notice?: string;
}

function plainText(content: string): object {
  return { tag: "plain_text", content };
}

function option(label: string, value: string): object {
  return { text: plainText(label), value };
}

/**
 * 渲染建会话表单卡。
 *
 * 三个字段都是**可选**的（`required: false`）：用户什么都不改直接提交，
 * 等价于"用默认值建会话"，这正是 `/new` 最常见的用法。
 */
export function buildSetupFormCard(input: SetupFormInput): object {
  const formElements: object[] = [];

  // —— 工作目录 ——
  formElements.push({ tag: "markdown", content: "**工作目录**\n目录需为绝对路径且落在允许范围内；留空则用默认值。" });
  formElements.push({
    tag: "input",
    name: "dir",
    required: false,
    width: "fill",
    placeholder: plainText("工作目录（绝对路径，可留空 = 用默认值）"),
    default_value: input.defaultDir,
  });

  const root = input.allowedRoots[0];
  const dirOptions: object[] = [];
  if (root) dirOptions.push(option(`🏠 ${root}（就用这个根目录）`, root));
  else dirOptions.push(option("✍️ 手动输入路径", CUSTOM_DIR_VALUE));
  for (const dir of input.dirChoices ?? []) {
    if (dir === root) continue;
    dirOptions.push(option(`📁 ${dir}`, dir));
  }
  if (dirOptions.length > 0) {
    formElements.push({
      tag: "select_static",
      name: "dir_select",
      required: false,
      type: "default",
      width: "fill",
      placeholder: plainText("或从允许范围内选一个目录"),
      options: dirOptions.slice(0, 30),
    });
  }

  // —— 模型 ——（拿不到模型列表就不渲染，否则空下拉会让用户以为坏了）
  if ((input.models?.length ?? 0) > 0) {
    formElements.push({ tag: "markdown", content: "**模型**\n留空 = 用 DSH 当前默认模型。" });
    formElements.push({
      tag: "select_static",
      name: "model",
      required: false,
      type: "default",
      width: "fill",
      placeholder: plainText("选择模型（可选）"),
      options: input.models!.slice(0, 30).map((m) => option(m.label, `${m.provider}/${m.model}`)),
    });
  }

  // —— 权限档位 ——
  formElements.push({ tag: "markdown", content: "**权限档位**\n决定这个会话里工具调用要怎样审批。" });
  formElements.push({
    tag: "select_static",
    name: "perm",
    required: false,
    type: "default",
    width: "fill",
    placeholder: plainText("选择权限档位（默认：可编辑）"),
    options: PERMISSION_PRESETS.map((p) => option(`${p.icon} ${p.label}：${p.description}`, p.id)),
  });

  // 表单容器内**必须**有一个 submit 按钮，否则提交事件根本不会触发。
  formElements.push({
    tag: "button",
    name: SETUP_SUBMIT_NAME,
    type: "primary_filled",
    width: "fill",
    text: plainText("✅ 创建会话"),
    form_action_type: "submit",
  });

  const intro = [
    `**${input.title}**`,
    "",
    "一次填好，点「创建会话」即可。全部留空 = 用默认值。",
    `允许的根目录：${input.allowedRoots.map((r) => `\`${r}\``).join("、")}`,
  ];
  if (input.notice) intro.push("", input.notice);

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: plainText("📝 新建会话"), template: "blue" },
    body: {
      elements: [
        { tag: "markdown", content: truncateCardContent(intro.join("\n"), MAX_CARD_BYTES) },
        { tag: "form", name: SETUP_FORM_NAME, elements: formElements },
      ],
    },
  };
}

/** 表单提交回传的原始值（`action.form_value`）。 */
export type SetupFormValues = Readonly<Record<string, unknown>>;

/** 这次卡片操作是不是本表单的提交。 */
export function isSetupSubmit(actionName: string | undefined): boolean {
  return actionName === SETUP_SUBMIT_NAME;
}

export interface SetupSubmit {
  /** 用户填/选的目录（原始值，未校验）。 */
  readonly dir?: string;
  /** `provider/model`；没选则 undefined。 */
  readonly model?: string;
  /** 权限档位 id；没选则不合法值会被过滤掉。 */
  readonly perm?: PermissionPreset;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 解析提交值。
 *
 * 目录优先级：下拉选的具体路径 → 输入框 → （都没有则 undefined，交给默认值）。
 * 「手动输入路径」哨兵不算选择，落到输入框。
 */
export function parseSetupSubmit(formValue: SetupFormValues | undefined): SetupSubmit {
  if (!formValue) return {};

  const selected = asNonEmptyString(formValue.dir_select);
  const typed = asNonEmptyString(formValue.dir);
  const dir = selected && selected !== CUSTOM_DIR_VALUE ? selected : typed;

  const model = asNonEmptyString(formValue.model);

  const rawPerm = asNonEmptyString(formValue.perm);
  const perm = isPermissionPreset(rawPerm) ? rawPerm : undefined;

  return {
    ...(dir ? { dir } : {}),
    ...(model ? { model } : {}),
    ...(perm ? { perm } : {}),
  };
}

/** 把 `provider/model` 拆开；缺任一截则视为未选。 */
export function splitModelRef(ref: string | undefined): { provider: string; model: string } | undefined {
  if (!ref) return undefined;
  const index = ref.indexOf("/");
  if (index <= 0 || index === ref.length - 1) return undefined;
  const provider = ref.slice(0, index).trim();
  const model = ref.slice(index + 1).trim();
  return provider && model ? { provider, model } : undefined;
}
