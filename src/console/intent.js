/**
 * Main-chat intent recognition for session management.
 *
 * Pure prompt building, tolerant JSON parsing, and allowlist-based resolution.
 * The model only proposes an intent + fields; every path/model/session is
 * re-matched against real DSH candidates here before anything runs.
 */
import { isAbsolute, normalize } from "node:path";
import { str, truncate } from "../utils.js";

export const INTENTS = ["create", "list", "enter", "chat", "clarify"];

export const INTENT_SYSTEM = [
  "你是飞书 DSH 管理台的意图识别器。用户在管理台（尚未进入任何会话）发来一条消息。",
  "只输出一个 JSON 对象，不要 markdown 代码块，不要解释。",
  '{"intent":"create|list|enter|chat|clarify","dir":"<绝对路径>","dir_source":"given|existing|new|default","title":"<不超过30字>","model":"<provider/model 或空>","perm":"<权限值 或空>","target":"<要进入的会话：序号/标题关键词/id 前缀>","question":"<需要向用户确认的一句话>","reason":"<一句话理由>"}',
  "规则：",
  "- 看会话列表、有哪些会话 → intent=list。",
  "- 继续/进入/切换已有会话（打开第N个、继续上次那个、进入 xxx）→ intent=enter，target 填序号、标题关键词或 id 前缀；无法确定 → intent=clarify。",
  "- 要新建一个会话去做开发/操作/聊天任务 → intent=create。",
  "- 闲聊、问候、问用法、无法归类 → intent=chat。",
  "- 建会话时必须尽量自己决定目录，不要让用户手输路径：",
  "  ① 用户明确给了路径 → dir=该路径，dir_source=given；",
  "  ② 用户提到项目/目录/仓库名，能匹配候选目录 → dir=候选原文，dir_source=existing；",
  "  ③ 没提到目录但存在默认目录 → dir=默认目录，dir_source=default；",
  "  ④ 能在允许根目录下为任务起一个合理的英文小写短横线目录名 → dir=<允许根目录>/<slug>，dir_source=new；",
  "  ⑤ 只有候选互相冲突、或完全无法判断用哪个目录时 → intent=clarify，并在 question 里给出 2-3 个候选。",
  "- dir 必须是绝对路径；不要编造候选/允许根目录之外的既有路径。",
  "- model 只能从候选模型里精确复制 provider/model；用户没说就留空。",
  "- perm 只能从候选权限里选；用户没说就留空。",
  "- 会话标题尽量从任务里提炼，30 字以内，不要用“新会话”这种占位词。",
].join("\n");

function bullet(items) {
  if (typeof items === "string") return items || "（无）";
  return items.length ? items.join("\n") : "（无）";
}

export function buildIntentPrompt({ text, sessions = [], dirs = [], models = [], perms = [], roots = [], defaults = {}, history = [] }) {
  const sessionLines = sessions
    .slice(0, 30)
    .map((item, index) => `- ${index + 1}. ${truncate(item.title || "(未命名)", 60)} | ${truncate(item.cwd || "", 80)} | ${item.sessionId}`)
    .join("\n");
  const dirLines = dirs
    .slice(0, 60)
    .map((item) => `- ${item.path}${item.label ? `（${item.label}）` : ""}`)
    .join("\n");
  const modelLines = models
    .slice(0, 40)
    .map((item) => `- ${item.provider}/${item.model}${item.name ? `（${item.name}）` : ""}`)
    .join("\n");
  const permLines = perms
    .map((item) => `- ${item.value}${item.name ? `（${item.name}）` : ""}`)
    .join("\n");
  const historyLines = history
    .slice(-8)
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}：${truncate(turn.text, 400)}`)
    .join("\n");

  return [
    "允许根目录（新建目录只能放在这些目录下）：",
    bullet(roots.map((root) => `- ${root}`)),
    "",
    "候选目录：",
    bullet(dirLines),
    "",
    "默认目录：" + (defaults.directory ? defaults.directory : "（无）"),
    "默认模型：" + (defaults.model ? `${defaults.model.provider}/${defaults.model.model}` : "（跟随 DSH 默认）"),
    "默认权限：" + (defaults.perm || "（跟随 DSH 默认）"),
    "",
    "候选会话（序号从 1 开始）：",
    bullet(sessionLines),
    "",
    "候选模型：",
    bullet(modelLines),
    "",
    "候选权限：",
    bullet(permLines),
    ...(historyLines ? ["", "历史对话（用于理解下面这条消息是对上一轮追问的回答）：", historyLines] : []),
    "",
    "用户消息：",
    truncate(text, 2_000),
  ].join("\n");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseIntentDecision(raw) {
  if (!raw || typeof raw !== "string") return undefined;
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const intent = str(parsed.intent);
  if (!INTENTS.includes(intent)) return undefined;
  const pick = (key) => (typeof parsed[key] === "string" ? parsed[key].trim() : "");
  const directory = pick("dir") || pick("directory");
  const dirSource = pick("dir_source") || pick("dirSource");
  return {
    intent,
    ...(directory ? { directory } : {}),
    ...(["given", "existing", "new", "default"].includes(dirSource) ? { dirSource } : {}),
    title: pick("title").slice(0, 30),
    model: pick("model"),
    perm: pick("perm"),
    target: pick("target").slice(0, 200),
    question: pick("question").slice(0, 1_000),
    reason: pick("reason").slice(0, 200),
  };
}

function normalizePath(path) {
  const value = str(path).trim();
  if (!value) return "";
  return normalize(value).replace(/\/+$/, "") || "/";
}

function isWithin(root, path) {
  const base = normalizePath(root);
  const target = normalizePath(path);
  return target === base || target.startsWith(`${base}/`);
}

function withinAnyRoot(roots, path) {
  return roots.some((root) => isWithin(root, path));
}

function matchDirectory(decision, dirs) {
  const target = normalizePath(decision.directory);
  if (!target) return undefined;
  return dirs.find((item) => normalizePath(item.path) === target)?.path;
}

function matchModel(raw, models) {
  const target = str(raw).trim().toLowerCase();
  if (!target) return undefined;
  return (
    models.find((item) => `${item.provider}/${item.model}`.toLowerCase() === target) ??
    models.find((item) => item.model.toLowerCase() === target) ??
    models.find((item) => item.name && item.name.toLowerCase() === target)
  );
}

function matchPerm(raw, perms) {
  const target = str(raw).trim().toLowerCase();
  if (!target) return undefined;
  return perms.find((item) => item.value.toLowerCase() === target) ??
    perms.find((item) => item.name && item.name.toLowerCase() === target);
}

function slugify(text) {
  return str(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function resolveDirectory(decision, { dirs, roots, defaults }) {
  const explicit = matchDirectory(decision, dirs);
  if (explicit) return { directory: explicit, dirSource: "existing" };
  if (decision.directory) {
    const target = normalizePath(decision.directory);
    if (isAbsolute(target) && withinAnyRoot(roots, target)) {
      return { directory: target, dirSource: decision.dirSource === "new" ? "new" : "given" };
    }
    return {
      question: `目录 \`${truncate(decision.directory, 120)}\` 不在允许范围内。要改用哪个目录？可选：${dirs
        .slice(0, 3)
        .map((item) => `\`${item.path}\``)
        .join("、") || "（无候选）"}`,
    };
  }
  if (defaults.directory && withinAnyRoot(roots, defaults.directory)) {
    return { directory: defaults.directory, dirSource: "default" };
  }
  if (dirs.length === 1) return { directory: dirs[0].path, dirSource: "existing" };
  const candidate = roots[0] && slugify(decision.title || "");
  if (candidate) return { directory: `${normalizePath(roots[0])}/${candidate}`, dirSource: "new" };
  return { question: "要建在哪个目录？请发一个目录，或告诉我项目名。" };
}

function resolveEnter(decision, sessions) {
  const target = str(decision.target).trim();
  if (!target) {
    if (sessions.length === 1) return { sessionId: sessions[0].sessionId };
    return { question: `要进入哪个会话？请发序号或标题：${sessions.slice(0, 5).map((item, index) => `${index + 1}. ${truncate(item.title, 30)}`).join("；")}` };
  }
  if (/^\d+$/.test(target)) {
    const item = sessions[Number(target) - 1];
    if (item) return { sessionId: item.sessionId };
    return { question: `序号 ${target} 超出范围，当前共 ${sessions.length} 个会话。要进入哪个？` };
  }
  const lower = target.toLowerCase();
  const byId = sessions.filter((item) => item.sessionId.toLowerCase().startsWith(lower));
  if (byId.length === 1) return { sessionId: byId[0].sessionId };
  const byTitle = sessions.filter((item) => (item.title || "").toLowerCase().includes(lower));
  if (byTitle.length === 1) return { sessionId: byTitle[0].sessionId };
  if (byTitle.length > 1) {
    return { question: `匹配到多个会话：${byTitle.slice(0, 5).map((item) => `「${truncate(item.title, 30)}」`).join("、")}。请说得更具体，或直接发序号。` };
  }
  return { question: `没有找到匹配「${truncate(target, 60)}」的会话。要新建一个，还是从 /sessions 列表里选？` };
}

/**
 * Deterministic fallback used only when the model call fails. It keeps the
 * common "help me do X" path usable: open a prefilled create form with the
 * configured default directory instead of dropping the user at the console.
 */
export function fallbackIntent(text, context = {}) {
  const value = str(text).trim();
  if (!value) return { intent: "chat" };
  if (/(有哪些|列出|所有|查看).{0,6}会话|会话.{0,4}列表/i.test(value)) return { intent: "list" };
  if (/^(继续|进入|打开|切换|回到)/.test(value)) {
    const target = value.replace(/^(继续|进入|打开|切换|回到)\s*/, "").replace(/(会话|话题)$/, "").trim();
    const resolved = resolveIntent({ intent: "enter", target }, context);
    return resolved?.intent === "enter" ? resolved : { intent: "chat" };
  }
  if (/^(你好|您好|hi|hello|在吗|谢谢|多谢)/i.test(value) && value.length < 12) {
    return { intent: "chat" };
  }
  const directory = context.defaults?.directory;
  if (!directory) return { intent: "chat" };
  return {
    intent: "create",
    directory,
    dirSource: "default",
    title: truncate(value.replace(/\s+/g, " "), 30),
    ...(context.defaults?.model ? { model: context.defaults.model } : {}),
    ...(context.defaults?.perm ? { perm: context.defaults.perm } : {}),
  };
}

export function resolveIntent(decision, context) {
  if (!decision) return undefined;
  if (decision.intent === "list") return { intent: "list" };
  if (decision.intent === "chat") return { intent: "chat" };
  if (decision.intent === "clarify") {
    return { intent: "clarify", question: decision.question || "能再说具体一点吗？" };
  }
  if (decision.intent === "enter") {
    const resolved = resolveEnter(decision, context.sessions ?? []);
    return resolved.sessionId
      ? { intent: "enter", sessionId: resolved.sessionId, title: decision.title }
      : { intent: "clarify", question: resolved.question };
  }
  if (decision.intent === "create") {
    const directory = resolveDirectory(decision, context);
    if (!directory.directory) return { intent: "clarify", question: directory.question };
    const model = matchModel(decision.model, context.models ?? []);
    const perm = matchPerm(decision.perm, context.perms ?? []);
    return {
      intent: "create",
      directory: directory.directory,
      dirSource: directory.dirSource,
      title: decision.title || "",
      ...(model ? { model: { provider: model.provider, model: model.model } } : {}),
      ...(perm ? { perm: perm.value } : {}),
    };
  }
  return { intent: "chat" };
}
