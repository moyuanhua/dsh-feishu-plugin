/**
 * 主聊天流「AI 会话管理」的意图识别与字段解析 —— **纯逻辑，零 IO**。
 *
 * 逻辑来源：opencode-feishu-plugin `src/session/quick-new.ts`（MIT，Copyright (c) 2026 moyuanhua）。
 * 提示词与防幻觉规则**逐条沿用**（那是踩出来的），但按 DSH 的接缝做了三处重设计：
 *
 * 1. **删除"必须已有会话"的前置**：上游把识别请求挂在一个已有会话上（需要 routing session），
 *    因此全新安装、零会话时引导完全不可用。我们直接问 `ctx.llm`，不需要任何会话。
 * 2. **模型未命中时回退默认值**：上游"没匹配上"就什么都不预填；改为落回默认模型并**告知用户**，
 *    因为"用户说了个名字但我们没有"是最常见的失望点，静默忽略比说清楚更糟。
 * 3. **目录校验注入**：上游把 `validateDirectory` 直接 import 进来；这里接受一个谓词，
 *    因此本模块完全可单测，也不依赖文件系统。
 */

/** 建会话权限档位（与 `PermissionPreset` 一致；此处独立声明避免层间耦合）。 */
export const INTENT_PERMS = ["readonly", "edit", "askHigh", "trust"] as const;
export type IntentPerm = (typeof INTENT_PERMS)[number];

/** 目录来源：用户指定 / 命中候选 / AI 新建。 */
export const INTENT_DIR_SOURCES = ["given", "existing", "new"] as const;
export type IntentDirSource = (typeof INTENT_DIR_SOURCES)[number];

/** 三种意图。 */
export type IntentKind = "create" | "list" | "chat";

/** 候选工作目录（`label` 为会话标题，辅助语义匹配）。 */
export interface IntentCandidateDir {
  readonly path: string;
  readonly label?: string;
}

/** 可选模型。 */
export interface IntentModelOption {
  readonly provider: string;
  readonly model: string;
  /** 展示名（用于按名字匹配）。 */
  readonly label?: string;
}

/** 模型输出（意图 + 建会话字段）。 */
export interface IntentDecision {
  readonly intent: IntentKind;
  readonly directory?: string;
  readonly dirSource?: IntentDirSource;
  readonly title?: string;
  readonly perm?: IntentPerm;
  readonly model?: string;
  readonly reason?: string;
}

export const INTENT_INSTRUCTION = [
  "你是飞书 AI 助手「管理台」的意图识别器。用户在管理台（还没有会话）发来一条消息。",
  "判断意图并尽量解析建会话字段。只输出一个 JSON 对象，不要任何其他文字：",
  '{"intent":"create|list|chat","dir":"<绝对路径>","dir_source":"given|existing|new","title":"<不超过20字的会话标题>","perm":"readonly|edit|askHigh|trust|空","model":"<providerID/modelID 或空>","reason":"<一句话理由>"}',
  "规则：",
  "- 列出/查看会话 → intent=list，其余字段留空。",
  "- 需要新建会话执行的开发/操作任务 → intent=create；闲聊、问候、询问用法 → chat。",
  "- **目录规则（create 时 dir 绝不允许为空，按优先级）：**",
  "  候选目录包括：允许根目录的一级子目录、历史会话目录（可能带标题线索）。",
  '  ① 用户消息里明确给了路径 → dir=该路径，dir_source="given"；',
  '  ② 否则先看候选里有没有语义匹配的现成目录 → dir=该候选路径原文，dir_source="existing"；',
  '  ③ 都不匹配才新建：dir=<允许根目录下、英文小写短横线的主题目录>（如 /Users/code/stock-research），dir_source="new"；',
  '  ④ 实在难以命名 → dir=<第一个允许根目录>，dir_source="new"。',
  "- perm 依据用户表述（只读→readonly、可编辑→edit、高风险→askHigh、完全信任→trust）；用户没说就留空。",
  "- model 只能从候选模型中精确复制 providerID/modelID；用户没说就留空。",
].join("\n");

/** 拼装发给模型的 prompt（各项都有上限，避免把上下文撑爆）。 */
export function buildIntentPrompt(input: {
  readonly text: string;
  readonly candidates: readonly IntentCandidateDir[];
  readonly models?: readonly IntentModelOption[];
  readonly allowedRoots?: readonly string[];
}): string {
  const roots = (input.allowedRoots ?? []).slice(0, 8).map((r) => `- ${r}`).join("\n");
  const dirs = input.candidates
    .slice(0, 60)
    .map((c) => `- ${c.path}${c.label ? `（${c.label}）` : ""}`)
    .join("\n");
  const models = (input.models ?? [])
    .slice(0, 30)
    .map((m) => `- ${m.provider}/${m.model}${m.label ? `（${m.label}）` : ""}`)
    .join("\n");
  return [
    INTENT_INSTRUCTION,
    "",
    "允许根目录（新建目录时只能放在这些目录之下）：",
    roots || "（无）",
    "",
    "候选目录：",
    dirs || "（无）",
    "",
    "候选模型：",
    models || "（无）",
    "",
    "用户消息：",
    input.text.slice(0, 2000),
  ].join("\n");
}

function isPerm(value: unknown): value is IntentPerm {
  return typeof value === "string" && (INTENT_PERMS as readonly string[]).includes(value);
}

function isDirSource(value: unknown): value is IntentDirSource {
  return typeof value === "string" && (INTENT_DIR_SOURCES as readonly string[]).includes(value);
}

/**
 * 解析模型输出（容忍 ```json 围栏与前后杂讯）。无法识别时返回 undefined。
 *
 * `intent=create` 但目录/权限留空是**合法结果** —— 调用方按"未解析"处理，交给表单补全。
 */
export function parseIntentDecision(raw: string | undefined): IntentDecision | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;

  const intent =
    obj.intent === "create" || obj.intent === "list" || obj.intent === "chat" ? obj.intent : undefined;
  if (!intent) return undefined;

  const dir =
    typeof obj.dir === "string" ? obj.dir.trim() : typeof obj.directory === "string" ? obj.directory.trim() : "";
  const dirSource = isDirSource(obj.dir_source)
    ? obj.dir_source
    : isDirSource(obj.dirSource)
      ? obj.dirSource
      : undefined;
  const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 30) : "";
  const perm = isPerm(obj.perm) ? obj.perm : undefined;
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 200) : "";

  return {
    intent,
    ...(dir ? { directory: dir } : {}),
    ...(dirSource ? { dirSource } : {}),
    ...(title ? { title } : {}),
    ...(perm ? { perm } : {}),
    ...(model ? { model } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * 标题 → ASCII 目录 slug（小写、非字母数字转 `-`、截断 40）。
 * 中文标题（无 ASCII 字符）返回空串，由调用方改用允许根目录兜底。
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** 在候选清单里匹配模型给的路径（容忍尾斜杠差异）。命中返回候选的规范路径。 */
export function matchCandidateDirectory(
  directory: string | undefined,
  candidates: readonly IntentCandidateDir[],
): string | undefined {
  if (!directory) return undefined;
  const normalize = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  const target = normalize(directory);
  return candidates.find((c) => normalize(c.path) === target)?.path;
}

/** 在候选模型里匹配模型给的引用：`provider/model` → `model` → 展示名。未命中 undefined。 */
export function matchModelOption(
  model: string | undefined,
  models: readonly IntentModelOption[],
): IntentModelOption | undefined {
  if (!model) return undefined;
  const norm = (s: string): string => s.trim().toLowerCase();
  const target = norm(model);
  return (
    models.find((m) => norm(`${m.provider}/${m.model}`) === target) ??
    models.find((m) => norm(m.model) === target) ??
    models.find((m) => m.label !== undefined && norm(m.label) === target)
  );
}

/** 模型选择的结果：选中的路由 + 给用户看的一句说明。 */
export interface IntentModelResolution {
  readonly model?: IntentModelOption;
  /** 需要告知用户时的文案（例如"你说的模型不在列表里"）。 */
  readonly notice?: string;
}

/**
 * 决定建会话用哪个模型。
 *
 * 规则（产品决策）：**用户点名了就用他说的那个；说了一个我们没有的，回退默认并明确告知**。
 * 上游在这里是"没匹配上就什么都不预填"，用户会以为自己的话被忽略了。
 */
export function resolveIntentModel(
  decision: IntentDecision | undefined,
  models: readonly IntentModelOption[],
  defaultModel?: IntentModelOption,
): IntentModelResolution {
  const requested = decision?.model?.trim();
  if (requested) {
    const matched = matchModelOption(requested, models);
    if (matched) return { model: matched };
    return defaultModel
      ? { model: defaultModel, notice: `⚠️ 你提到的模型 \`${requested}\` 不在可用列表里，已改用默认模型。` }
      : { notice: `⚠️ 你提到的模型 \`${requested}\` 不在可用列表里，且没有默认模型，请在表单里选择。` };
  }
  return defaultModel ? { model: defaultModel } : {};
}

/** 目录落点。 */
export interface IntentDirResolution {
  readonly dir?: string;
  /** 表单顶部展示的一句说明（对齐上游的六种文案）。 */
  readonly notice: string;
}

/** 目录校验谓词：返回 `{ ok: true, path }` 或 `{ ok: false, message }`。 */
export type ValidateDirFn = (dir: string) =>
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

export const INTENT_NOTICE = {
  given: "✍️ 目录由**你指定**（可在下方修改）",
  existing: "✓ 已匹配**历史 / 最近目录**（可在下方修改）",
  newDir: "➕ **AI 新建目录**（不存在时会在创建时自动创建；可在下方修改）",
  root: "🏠 使用**允许根目录**（可在下方修改）",
  noRoot: "⚠️ 未配置允许的根目录，请在下方填写目录。",
} as const;

/**
 * 决定建会话的目录，并给出一句说明。
 *
 * 顺序（对齐上游）：given → 命中候选 → AI 提出的路径 → slug 兜底 → 允许根目录。
 * **`given` 校验失败时不预填目录**，但也会把原因说出来 —— 静默丢掉用户的路径最糟。
 */
export function resolveIntentDir(input: {
  readonly decision: IntentDecision | undefined;
  readonly candidates: readonly IntentCandidateDir[];
  readonly allowedRoots: readonly string[];
  readonly title: string;
  readonly validateDir: ValidateDirFn;
}): IntentDirResolution {
  const root = input.allowedRoots[0];
  if (!root) return { notice: INTENT_NOTICE.noRoot };

  const wanted = input.decision?.directory?.trim();

  if (input.decision?.dirSource === "given" && wanted) {
    const check = input.validateDir(wanted);
    if (check.ok) return { dir: check.path, notice: INTENT_NOTICE.given };
    return { notice: `⚠️ 你指定的目录 \`${wanted}\` 不可用：${check.message}` };
  }

  if (wanted) {
    const matched = matchCandidateDirectory(wanted, input.candidates);
    if (matched) return { dir: matched, notice: INTENT_NOTICE.existing };
    const check = input.validateDir(wanted);
    if (check.ok) return { dir: check.path, notice: INTENT_NOTICE.newDir };
  }

  const slug = slugifyTitle(input.decision?.title ?? input.title);
  if (slug) {
    const slugPath = `${root.replace(/\/+$/, "")}/${slug}`;
    const check = input.validateDir(slugPath);
    if (check.ok) return { dir: check.path, notice: INTENT_NOTICE.newDir };
  }

  return { dir: root, notice: INTENT_NOTICE.root };
}
