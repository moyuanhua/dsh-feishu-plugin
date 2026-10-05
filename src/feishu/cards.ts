/**
 * 飞书卡片 JSON 2.0 构建（纯函数，不 import 飞书 SDK，可单测）。
 *
 * 关键约束（用 MCP 文档检索器 `openplatform_developer_document_recall` 逐条查证）：
 * - 《发送消息》（服务端 API/消息/消息管理/发送消息）：「卡片消息、富文本消息请求体最大不能超过
 *   30 KB」，超限报 400 `code=230025`。故这里把 markdown 截断到 28KB（`MAX_CARD_BYTES`），
 *   给 JSON 转义、标题、按钮留 2KB 余量。
 * - 《卡片 JSON 2.0 结构》：「一张卡片最多支持 200 个元素（如 tag 为 plain_text 的文本元素）或
 *   组件」；「卡片 JSON 2.0 结构暂时仅支持共享卡片……即 `update_multi` 参数仅支持设为 `true`」。
 *   对应错误码 300305（组件超限）/ 300302（update_multi=false）。
 * - 《按钮组件》：「卡片 JSON 2.0 结构已不支持交互模块（`"tag": "action"`）相关属性。你可直接将
 *   按钮放置于 `elements` 中」——所以按钮必须是 `body.elements` 的直接子元素，不能包在
 *   `actions`/`action` 容器里（1.0 写法在 2.0 会直接 400）。按钮文本 `content` 最多 100 字符。
 * - 《按钮组件》回调示例：`behaviors[].type = "callback"` 的 `value` 支持 object（「开放平台 SDK
 *   仅支持 object 类型」），点击后原样出现在新版回调 `card.action.trigger` 的
 *   `event.action.value` 里——本插件的「强制停止」按钮就靠它回传 `{ kind: 'stop', token }`。
 * - 《局部更新卡片实体》/《流式更新卡片》：用卡片级 OpenAPI 操作同一张卡片的频率上限为
 *   **10 次/秒**；卡片 `config.update_multi` 为 false 时无法更新（300302）。
 * - 《表格组件》注意事项：「单张卡片最多支持放置五个表格组件」——markdown 富文本里渲染出的表格
 *   同样计入该额度，表格守卫见 `src/feishu/card-limits.ts`。
 *
 * 移植来源：opencode-feishu-plugin（MIT，Copyright (c) 2026 moyuanhua）
 * 原文件：src/feishu/cards.ts
 * 适配说明：
 * - 只搬运与运行卡/通知卡/帮助卡有关的最小集（`buildRunCard`、`buildNoticeCard`、`buildHelpCard`、
 *   `truncateCardContent`、`MAX_CARD_BYTES`）；上游的审批卡/结果卡/管理台卡等与 opencode 宿主
 *   语义耦合的卡片未搬运。
 * - 上游的 `CardTemplate` 含 purple，本仓库按交付契约收窄为 blue/grey/green/red/orange。
 * - 上游把按钮构造 `cardButton` 作为公开导出；本仓库契约未要求，改为模块私有。
 * - 截断时额外丢弃被切断的半个多字节字符（U+FFFD 替换符），上游注释里承认该字符会残留。
 * - 上限小到连「已截断」脚注都放不下时返回空串（保证结果严格 ≤ 上限）；上游会返回超限的脚注。
 * - 正文与页脚共享 `MAX_CARD_BYTES` 预算（上游两个字段各自截断，合计可能逼近/突破 30KB）。
 */

/** 卡片正文的 UTF-8 字节上限：飞书请求体硬上限 30KB，留 2KB 给 JSON 结构与转义。 */
export const MAX_CARD_BYTES = 28 * 1024;

/** 截断脚注（含闭合围栏的换行）。 */
const TRUNCATION_SUFFIX = "\n\n*（内容过长，已截断）*";
/** 闭合未结束代码围栏时补的内容。 */
const CODE_FENCE = "\n```";
/** 页脚最多占用的字节数（正文优先，但页脚是模型/耗时/状态，不能被整段吃掉）。 */
const FOOTER_MAX_BYTES = 1024;
/** 按钮文本上限（《按钮组件》：content 最多 100 字符）。 */
const BUTTON_TEXT_MAX_CHARS = 100;
/** 强制停止按钮的默认文案。 */
const STOP_BUTTON_TEXT = "⏹ 强制停止";
/** 正文为空的兜底文案（飞书允许空 markdown，但空元素容易让用户以为是卡死）。 */
const EMPTY_MARKDOWN = "（暂无内容）";
const NOTICE_DEFAULT_TITLE = "提示";
const HELP_DEFAULT_TITLE = "命令帮助";

/**
 * 卡片标题主题色（`header.template`）。
 * 文档枚举为 blue|wathet|turquoise|green|yellow|orange|red|carmine|violet|purple|indigo|grey|default，
 * 本仓库按交付契约只用其中 5 个。
 */
export type CardTemplate = "blue" | "grey" | "green" | "red" | "orange" | "purple";

/** 运行状态 → 标题主题色：running 蓝 / done 绿 / failed 红 / stopped 灰。 */
const RUN_TEMPLATE: Record<RunCardInput["status"], CardTemplate> = {
  running: "blue",
  done: "green",
  failed: "red",
  stopped: "grey",
};

export interface RunCardInput {
  /** 会话/话题标题。 */
  readonly title: string;
  /** 正文（markdown）。 */
  readonly markdown: string;
  readonly status: "running" | "done" | "failed" | "stopped";
  /** 页脚（模型/耗时/状态）。 */
  readonly footer?: string;
  /** 「强制停止」按钮；缺省 = 不渲染按钮。`token` 是 security/token.ts 自签的停止凭证。 */
  readonly stop?: { readonly token: string; readonly label?: string };
}

export interface NoticeCardInput {
  /** markdown 正文。 */
  readonly text: string;
  /** 卡片标题；缺省用「提示」（飞书卡片只有 header 能显示主题色，所以标题恒存在）。 */
  readonly title?: string;
  /** 卡片主题色；缺省 blue。 */
  readonly template?: "blue" | "grey" | "green" | "red" | "orange";
}

export interface HelpCommand {
  readonly name: string;
  readonly description: string;
}

/** 运行卡：流式/最终状态都复用同一张卡，靠 `status` 换主题色、靠 `stop` 决定是否带按钮。 */
export function buildRunCard(input: RunCardInput): object {
  const elements: object[] = bodyContents(input.markdown, input.footer).map((content) => ({
    tag: "markdown",
    content,
  }));
  if (input.stop) {
    // value 是对象（SDK 只支持 object），点击后从 event.action.value 原样取回。
    elements.push(cardButton(stopLabel(input.stop.label), "danger", { kind: "stop", token: input.stop.token }));
  }
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: input.title },
      template: RUN_TEMPLATE[input.status],
    },
    body: { elements },
  };
}

/** 通知卡：一次性提示（不进会话），无按钮。 */
export function buildNoticeCard(input: NoticeCardInput): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: input.title ?? NOTICE_DEFAULT_TITLE },
      template: input.template ?? "blue",
    },
    body: {
      elements: [{ tag: "markdown", content: truncateCardContent(input.text) }],
    },
  };
}

/** 帮助卡：所有命令一行一条，渲染为 `- \`/name\` — description`。 */
export function buildHelpCard(commands: readonly HelpCommand[], options: { readonly title?: string } = {}): object {
  const lines =
    commands.length > 0
      ? commands.map((command) => `- \`${escapeInline(command.name)}\` — ${command.description}`)
      : ["（暂无可用命令）"];
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: options.title ?? HELP_DEFAULT_TITLE },
      template: "blue",
    },
    body: {
      elements: [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }],
    },
  };
}

/**
 * 飞书卡片 JSON 2.0 按钮。
 *
 * 2.0 **不再支持** 1.0 的 `tag:"action"` / `actions` 容器（会直接 400，
 * 见错误码 200861「cards of schema V2 no longer support this capability」），
 * 按钮必须直接放进 `body.elements`；回调数据用 `behaviors:[{type:"callback", value}]`，
 * 且 `value` 必须是**对象**（事件里从 `action.value` 原样带回）。
 */
/** 卡片按钮（上游同名导出；按钮必须直挂 `body.elements` 且用 `behaviors` 回传 value）。 */
export function cardButton(text: string, type: "primary" | "default" | "danger", value: Record<string, unknown>): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text.slice(0, BUTTON_TEXT_MAX_CHARS) },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

/** 正文 + 页脚共享 28KB 预算：页脚优先（最多 1KB），其余留给正文。 */
function bodyContents(markdown: string, footer?: string): string[] {
  const main = markdown || EMPTY_MARKDOWN;
  if (!footer) return [truncateCardContent(main)];
  const footerBudget = Math.min(Buffer.byteLength(footer, "utf8"), FOOTER_MAX_BYTES);
  const safeFooter = truncateCardContent(footer, footerBudget);
  const mainBudget = Math.max(0, MAX_CARD_BYTES - Buffer.byteLength(safeFooter, "utf8"));
  return [truncateCardContent(main, mainBudget), safeFooter];
}

function stopLabel(label: string | undefined): string {
  return label && label.trim() !== "" ? label : STOP_BUTTON_TEXT;
}

/** 转义 markdown 行内代码里的反引号与换行，避免把渲染搞坏（命令名/参数里可能出现）。 */
function escapeInline(text: string): string {
  return text.replace(/`/g, "\\`").replace(/\n/g, " ");
}

/**
 * 按 UTF-8 字节截断到飞书上限内：不切断多字节字符，并闭合未结束的 ``` 围栏。
 *
 * - 未超限：原样返回（仅在围栏为奇数个时补一个闭合围栏）；
 * - 超限：截到 `limit - 脚注字节`，丢弃被切开的半个字符，尽量切在最后一个换行处，再补脚注。
 *
 * 注意：`limit` 小到放不下脚注时返回空串——宁可少显示，也不返回超过上限的内容（超限会被
 * 飞书以 400 `code=230025` 拒绝发送）。
 */
export function truncateCardContent(text: string, maxBytes: number = MAX_CARD_BYTES): string {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : MAX_CARD_BYTES;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return closeCodeFences(text);

  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8") + Buffer.byteLength(CODE_FENCE, "utf8");
  const effective = limit - suffixBytes;
  if (effective <= 0) return "";

  let truncated = bytes.subarray(0, effective).toString("utf8");
  // 切开多字节字符时 Buffer 解码会留下 U+FFFD，直接丢掉这个残字。
  if (truncated.endsWith("\ufffd")) truncated = truncated.slice(0, -1);
  // 尽量在换行处收尾，避免截出半行；只有换行足够靠后时才这么做。
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > truncated.length * 0.8) truncated = truncated.slice(0, lastNewline);
  return `${closeCodeFences(truncated)}${TRUNCATION_SUFFIX}`;
}

/** 围栏数为奇数（未闭合）时补一个 ``` 收尾。 */
function closeCodeFences(text: string): string {
  const fences = text.match(/```/g);
  if (fences && fences.length % 2 !== 0) return `${text}${CODE_FENCE}`;
  return text;
}

/* ------------------------------------------------------------------ *
 * 审批卡
 *
 * 逻辑来源：opencode-feishu-plugin `src/feishu/cards.ts`（MIT，Copyright (c) 2026 moyuanhua），
 * `buildApprovalCard` / `buildResolvedCard` / `buildSessionAllowResolvedCard` 逐行搬运
 * （仅把标题里的产品名改为本插件、复用本文件已有的 `cardButton`/`escapeInline`/`truncateCardContent`）。
 *
 * 按钮 value 形状（点击回调在 `card.action.trigger` 的 `event.action.value` 原样回传）：
 * - 允许一次 / 始终允许 / 拒绝：`{ t: <自签 token>, d: "once"|"always"|"reject" }`
 * - 本会话内允许该工具：`{ cmd: "allow_session", a: <action>, t: <自签 token> }`
 * ------------------------------------------------------------------ */

/** 审批人 id 在卡片上只显示前 8 位。 */
function maskApprover(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

export interface ApprovalCardInput {
  readonly requestID: string;
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly message?: string;
  /** true = 该请求可持久化「始终允许」。 */
  readonly canPersistAlways: boolean;
  /** 按钮 value 里的自签 token。 */
  readonly token: string;
  /**
   * 「✅ 本会话内允许该工具」按钮的自签 token。
   * 缺省 = 不渲染该按钮（配置关闭或运行时未装配签名）。
   */
  readonly allowSessionToken?: string;
  readonly maxResourcesShown: number;
}

export interface ApprovalOutcome {
  readonly reply: "once" | "always" | "reject";
  readonly operatorOpenId: string;
  readonly at: number;
}

/** 审批卡片（通过一次 / 始终允许 / 本会话内允许 / 拒绝）。 */
export function buildApprovalCard(input: ApprovalCardInput): object {
  const resources = input.resources.length > 0 ? input.resources : ["（未提供资源）"];
  const shown = resources.slice(0, input.maxResourcesShown);
  const hidden = resources.length - shown.length;
  const resourceLines = shown.map((r) => `- \`${escapeInline(r)}\``).join("\n");
  const overflow = hidden > 0 ? `\n…另有 ${hidden} 项` : "";

  const lines = [`**操作**：\`${escapeInline(input.action)}\``, "", "**资源**：", `${resourceLines}${overflow}`];
  if (input.message) lines.push("", `**说明**：${input.message}`);

  const rejectHint = "⚠️ 拒绝会同时驳回本会话其他待批请求。";
  lines.push("", rejectHint);
  if (!input.canPersistAlways) {
    lines.push("ℹ️ 本请求未携带保存项，「始终允许」等价于「允许一次」。");
  }

  const alwaysLabel = input.canPersistAlways ? "🔓 始终允许" : "🔓 始终允许（同一次）";

  const buttons: object[] = [
    cardButton("✅ 允许一次", "primary", { t: input.token, d: "once" }),
    cardButton(alwaysLabel, "default", { t: input.token, d: "always" }),
  ];
  // 会话粒度的中间档位：仅当配置开启且装配了签名时出现。
  if (input.allowSessionToken) {
    buttons.push(
      cardButton("✅ 本会话内允许该工具", "default", {
        cmd: "allow_session",
        a: input.action,
        t: input.allowSessionToken,
      }),
    );
  }
  buttons.push(cardButton("❌ 拒绝", "danger", { t: input.token, d: "reject" }));

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: "🔐 飞书权限请求" },
      template: "orange",
    },
    body: {
      elements: [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }, ...buttons],
    },
  };
}

export interface SessionAllowOutcome {
  readonly action: string;
  readonly operatorOpenId: string;
  readonly at: number;
}

/** 「本会话内允许」点击后的结果卡（无按钮）。 */
export function buildSessionAllowResolvedCard(input: ApprovalCardInput, outcome: SessionAllowOutcome): object {
  const when = new Date(outcome.at).toISOString();
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: `✅ 已允许本会话内 ${outcome.action}` },
      template: "green",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: truncateCardContent(
            [
              `**操作**：\`${escapeInline(input.action)}\``,
              "",
              "本会话内后续调用该工具将**不再询问**（其它会话不受影响）。",
              "",
              `**处理人**：\`${escapeInline(maskApprover(outcome.operatorOpenId))}\``,
              `**时间**：${when}`,
            ].join("\n"),
          ),
        },
      ],
    },
  };
}

/** 审批完成后的结果卡片（无按钮）。 */
export function buildResolvedCard(input: ApprovalCardInput, outcome: ApprovalOutcome): object {
  const label =
    outcome.reply === "reject" ? "❌ 已拒绝" : outcome.reply === "always" ? "🔓 已始终允许" : "✅ 已允许一次";
  const template: CardTemplate = outcome.reply === "reject" ? "red" : "green";
  const when = new Date(outcome.at).toISOString();

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: label }, template },
    body: {
      elements: [
        {
          tag: "markdown",
          content: truncateCardContent(
            `**操作**：\`${escapeInline(input.action)}\`\n\n**处理人**：\`${escapeInline(maskApprover(outcome.operatorOpenId))}\`\n\n**时间**：${when}`,
          ),
        },
      ],
    },
  };
}
