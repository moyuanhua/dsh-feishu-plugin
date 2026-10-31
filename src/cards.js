/** Feishu interactive-card builders (JSON 2.0). Pure functions only. */
import { formatDuration, relativeTime, truncate, truncateMiddle } from "./utils.js";

function card({ title, template = "blue", elements = [] }) {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: truncate(title, 80) }, template },
    body: { elements: elements.slice(0, 190) },
  };
}

function md(content) {
  return { tag: "markdown", content: truncate(content, 24_000) };
}

function note(content) {
  return { tag: "markdown", content: truncate(content, 2_000), text_size: "notation" };
}

function hr() {
  return { tag: "hr" };
}

function button(text, type, value, extra = {}) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: truncate(text, 60) },
    type,
    behaviors: [{ type: "callback", value }],
    ...extra,
  };
}

function columns(text, buttons) {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "small",
    columns: [
      { tag: "column", width: "weighted", weight: 5, vertical_align: "center", elements: [md(text)] },
      { tag: "column", width: "auto", vertical_align: "center", elements: buttons },
    ],
  };
}

export function modelLabel(model) {
  if (!model) return "(默认)";
  return `${model.provider}/${model.model}`;
}

export function sessionLine(view, index, now = Date.now()) {
  const marks = [relativeTime(view.updatedAt, now)];
  if (view.running) marks.unshift("⚡ 运行中");
  if (view.cwd) marks.push(`📍 ${truncateMiddle(view.cwd, 36)}`);
  if (view.perm) marks.push(`🔐 ${view.perm}`);
  const title = truncate((view.title || "(未命名会话)").trim(), 50);
  return `${index}. **${title}** · ${marks.join(" · ")}`;
}

export function helpCard() {
  return card({
    title: "🧭 DSH 飞书桥接",
    template: "turquoise",
    elements: [
      md(
        [
          "**主聊天流**（管理台）",
          "`/new [标题]` 新建会话（表单：目录 / 模型 / 权限）",
          "`/sessions` 会话列表（可翻页、进入会话的话题）",
          "`/open <序号>`、`/resume <序号>` 推荐进入列表中的会话",
          "`/help` 本帮助",
          "",
          "**话题内**（一条话题 = 一个 DSH 会话）",
          "直接发消息即对话；`/stop` 停止当前回合；`/current` 查看会话",
          "`/model [关键词]` 切换模型；`/perm [档位]` 切换权限预设",
          "`/cd <绝对路径>` 迁移工作目录；`/rename <标题>` 重命名",
          "`/steer <文本>` 立即插队；`/queue <文本>` 排队",
          "",
          "**审批与提问**",
          "DSH 的审批请求会变成飞书卡片：只支持「允许一次 / 拒绝」（DSH 的审批是一次性授权）。",
          "模型反问会变成混合卡：选项用按钮单选/多选，文字答案用卡片内输入框提交；也可以直接在话题里回复文字。",
        ].join("\n"),
      ),
      note("全程 WebSocket 长连接：不监听端口，也不需要公网地址。"),
    ],
  });
}

export function mainHintCard({ pendingKey, pendingText }) {
  const elements = [
    md(
      pendingText
        ? `收到一条任务：\n> ${truncate(pendingText.replace(/\n/g, " "), 300)}\n\n主聊天流不做对话。可以把它带进一个新会话：`
        : "主聊天流只做管理。直接发消息不会进入任何会话；请新建会话，或进入已有会话的话题。",
    ),
  ];
  if (pendingKey) {
    elements.push(button("🚀 用这条消息新建会话", "primary", { a: "quicknew", k: pendingKey }));
  }
  elements.push(button("📝 新建会话", "default", { a: "new" }));
  elements.push(button("🧩 会话列表", "default", { a: "list", p: 0 }));
  elements.push(button("❓ 帮助", "default", { a: "help" }));
  return card({ title: "🧭 管理台", template: "blue", elements });
}

export function thinkingCard(text = "⏳ 正在理解你的意图…") {
  return card({ title: "🧭 管理台", template: "blue", elements: [md(text)] });
}

export function createdHintCard(title, lines) {
  return card({
    title,
    template: "green",
    elements: [md(lines.join("\n") || "(无)")],
  });
}

export function sessionListCard({ sessions, page, pageSize, currentSessionId, now, title = "🧩 DSH 会话", intro }) {
  const elements = [];
  if (intro) elements.push(md(intro));
  const pageCount = Math.max(1, Math.ceil(sessions.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const rows = sessions.slice(safePage * pageSize, safePage * pageSize + pageSize);
  if (sessions.length === 0) {
    elements.push(md("还没有会话。点下方「新建会话」创建；创建后会自动开一个飞书话题。"));
  } else {
    rows.forEach((view, index) => {
      if (index > 0) elements.push(hr());
      elements.push(
        columns(sessionLine(view, safePage * pageSize + index + 1, now), [
          button(view.running ? "⚡ 查看" : "▶️ 进入", view.sessionId === currentSessionId ? "primary" : "default", {
            a: "open",
            s: view.sessionId,
          }),
        ]),
      );
    });
  }
  const controls = [];
  if (safePage > 0) controls.push(button("⬅️ 上一页", "default", { a: "list", p: safePage - 1 }));
  if (safePage + 1 < pageCount) controls.push(button("➡️ 下一页", "default", { a: "list", p: safePage + 1 }));
  controls.push(button("➕ 新建会话", "primary", { a: "new" }));
  elements.push(hr());
  elements.push({ tag: "column_set", flex_mode: "none", columns: controls.map((b) => ({ tag: "column", width: "auto", elements: [b] })) });
  elements.push(note(`第 ${safePage + 1}/${pageCount} 页 · 共 ${sessions.length} 个会话。进入会新开一个话题并绑定该会话。`));
  return card({ title, template: "blue", elements });
}

export function newSessionFormCard({ values = {}, error, models = [], perms = [], dirs = [], roots = [], defaultModel }) {
  const elements = [];
  if (error) elements.push(md(`⚠️ **提交失败**：${error}`));

  elements.push(
    md(
      [
        "一次填好，点「创建会话」后机器人会自动开一个话题。",
        `目录留空 = \`${roots[0] ?? process.cwd()}\`；目录不存在会自动创建。`,
        roots.length ? `目录必须位于允许范围：${roots.map((r) => `\`${r}\``).join("、")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );

  const form = [];
  form.push({
    tag: "input",
    name: "title",
    required: false,
    width: "fill",
    placeholder: { tag: "plain_text", content: "会话标题（可留空，第一条消息会自动生成）" },
    default_value: values.title ?? "",
  });
  form.push({
    tag: "input",
    name: "dir",
    required: false,
    width: "fill",
    placeholder: { tag: "plain_text", content: "工作目录绝对路径（可留空）" },
    default_value: values.dir ?? "",
  });
  if (dirs.length) {
    form.push({
      tag: "select_static",
      name: "dir_select",
      type: "default",
      width: "fill",
      placeholder: { tag: "plain_text", content: "或从允许根目录的一级子目录中选择" },
      options: [
        { text: { tag: "plain_text", content: "✍️ 手动输入路径（以上面的输入框为准）" }, value: "__custom__" },
        ...dirs.map((entry) => ({
          text: { tag: "plain_text", content: truncate(`${entry.isRepo ? "📦 " : "📁 "}${entry.name}`, 60) },
          value: entry.path,
        })),
      ],
      initial_option: "__custom__",
    });
  }
  if (models.length) {
    const selected = values.model
      ? `${values.model.provider}/${values.model.model}`
      : defaultModel
        ? `${defaultModel.provider}/${defaultModel.model}`
        : undefined;
    form.push({
      tag: "select_static",
      name: "model",
      type: "default",
      width: "fill",
      placeholder: { tag: "plain_text", content: "选择模型（可留空 = DSH 默认）" },
      options: models.slice(0, 40).map((model) => ({
        text: { tag: "plain_text", content: truncate(`${model.providerName ? `${model.providerName} / ` : ""}${model.name}`, 70) },
        value: `${model.provider}::${model.model}`,
      })),
      ...(selected && models.some((m) => `${m.provider}::${m.model}` === selected)
        ? { initial_option: selected }
        : {}),
    });
  }
  if (perms.length) {
    form.push({
      tag: "select_static",
      name: "perm",
      type: "default",
      width: "fill",
      placeholder: { tag: "plain_text", content: "选择权限预设" },
      options: perms.map((perm) => ({
        text: { tag: "plain_text", content: truncate(`${perm.name}${perm.description ? `：${perm.description}` : ""}`, 80) },
        value: perm.value,
      })),
      ...(values.perm && perms.some((p) => p.value === values.perm) ? { initial_option: values.perm } : {}),
    });
  }
  form.push({
    tag: "button",
    name: "submit",
    type: "primary",
    text: { tag: "plain_text", content: "✅ 创建会话" },
    behaviors: [{ type: "callback", value: { a: "create" } }],
    form_action_type: "submit",
  });
  elements.push({ tag: "form", name: "dsh_new_session", elements: form });
  return card({ title: "📝 新建 DSH 会话", template: "blue", elements });
}

export function openedSessionCard({ view, style = "resumed", brief }) {
  // The Feishu topic name follows this card's header title, so show the real
  // session title instead of a generic "已进入话题" status.
  const headerTitle = truncate(view.title || "(未命名会话)", 60);
  const lines = [];
  if (style === "created") {
    lines.push("会话已创建。直接在这个话题里发消息即可开始。");
  } else if (style === "entered") {
    const entered = [];
    if (view.sessionId) entered.push(`**会话 ID**：\`${view.sessionId}\``);
    entered.push("", "已为这个会话打开新的飞书话题，请到话题里继续。");
    return card({
      title: headerTitle,
      template: "green",
      elements: [md(entered.join("\n"))],
    });
  } else {
    lines.push("已在这个话题里接入选中的 DSH 会话。直接发消息即可继续。");
  }
  lines.push("");
  if (view.sessionId) lines.push(`**会话 ID**：\`${view.sessionId}\``);
  if (view.cwd) lines.push(`**目录**：\`${truncateMiddle(view.cwd, 80)}\``);
  lines.push(`**模型**：${view.model ? `${view.model.provider}/${view.model.model}` : "(DSH 默认)"}`);
  if (view.perm) lines.push(`**权限**：${view.perm}`);
  if (view.updatedAt) lines.push(`**最近活动**：${relativeTime(view.updatedAt)}`);
  if (brief && style !== "created") {
    const excerpts = [];
    if (brief.summary) excerpts.push(`**历史摘要**\n> ${truncate(brief.summary.replace(/\n/g, "\n> "), 900)}`);
    if (brief.lastUser) excerpts.push(`**你的上一条**\n> ${truncate(brief.lastUser.replace(/\n/g, "\n> "), 400)}`);
    if (brief.lastAssistant) excerpts.push(`**上次回复**\n> ${truncate(brief.lastAssistant.replace(/\n/g, "\n> "), 600)}`);
    if (excerpts.length) lines.push("", "—", ...excerpts);
  }
  return card({
    title: headerTitle,
    template: "green",
    elements: [md(lines.join("\n"))],
  });
}

export function modelCard({ sid, current, models, page = 0, pageSize = 8 }) {
  const elements = [];
  if (current) elements.push(md(`当前模型：**${current.provider}/${current.model}**`));
  const pageCount = Math.max(1, Math.ceil(models.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const slice = models.slice(safePage * pageSize, safePage * pageSize + pageSize);
  for (const model of slice) {
    const selected = current && current.provider === model.provider && current.model === model.model;
    elements.push(
      button(
        `${selected ? "✅ " : "🧠 "}${model.name}`,
        selected ? "primary" : "default",
        { a: "model", s: sid, p: model.provider, m: model.model },
      ),
    );
  }
  if (models.length === 0) elements.push(md("当前没有可路由的模型。请先在 DSH 设置里配置模型。"));
  if (safePage > 0) elements.push(button("⬅️ 上一页", "default", { a: "modelpage", s: sid, p: safePage - 1 }));
  if (safePage + 1 < pageCount) {
    elements.push(button("➡️ 下一页", "default", { a: "modelpage", s: sid, p: safePage + 1 }));
  }
  elements.push(note("切换只影响后续回复。也可以发 `/model <关键词>`。"));
  return card({ title: "🧠 选择模型", template: "blue", elements });
}

export function permissionCard({ sid, current, perms }) {
  const elements = [];
  elements.push(md(current ? `当前权限预设：**${current}**` : "当前权限预设：未知"));
  for (const perm of perms) {
    elements.push(
      button(
        `${perm.value === current ? "✅ " : "🔐 "}${perm.name}${perm.description ? ` — ${perm.description}` : ""}`,
        perm.value === current ? "primary" : "default",
        { a: "perm", s: sid, v: perm.value },
      ),
    );
  }
  if (perms.length === 0) elements.push(md("当前部署没有配置权限预设。"));
  elements.push(note("权限预设同时设置沙箱模式与审批策略。切换后只影响后续工具调用。"));
  return card({ title: "🔐 选择权限预设", template: "orange", elements });
}

export function approvalCard({ toolName, reason, sessionTitle, ttlMinutes, approveToken, rejectToken }) {
  const lines = [`**工具**：\`${truncate(toolName, 80)}\``];
  if (reason) lines.push(`**原因**：${truncate(reason, 500)}`);
  if (sessionTitle) lines.push(`**会话**：${truncate(sessionTitle, 80)}`);
  lines.push("", `DSH 审批仅对本次调用生效（${ttlMinutes} 分钟内有效）。`);
  return card({
    title: "🔐 需要审批",
    template: "orange",
    elements: [
      md(lines.join("\n")),
      {
        tag: "column_set",
        flex_mode: "none",
        columns: [
          { tag: "column", width: "auto", elements: [button("✅ 允许一次", "primary", { a: "approve", t: approveToken })] },
          { tag: "column", width: "auto", elements: [button("❌ 拒绝", "danger", { a: "reject", t: rejectToken })] },
        ],
      },
      note("需要长期放行请在 Web 端切换权限预设；DSH 不提供「始终允许」。"),
    ],
  });
}

export function approvalResultCard({ approved, toolName }) {
  return card({
    title: approved ? "✅ 已允许本次调用" : "❌ 已拒绝本次调用",
    template: approved ? "green" : "red",
    elements: [md(`工具：\`${truncate(toolName, 100)}\``)],
  });
}

export function questionCard({ question, index = 0, total = 1, token, selected = [], notice }) {
  const elements = [];
  const head = question.header ? `**${question.header}**\n` : "";
  elements.push(md(`${head}${question.question}`));
  if (question.detail) elements.push(md(truncate(question.detail, 4_000)));

  const options = Array.isArray(question.options)
    ? question.options.filter((option) => option && option.label)
    : [];
  const picked = new Set(Array.isArray(selected) ? selected : []);

  if (options.length > 0) {
    for (const option of options.slice(0, 10)) {
      const label = truncate(option.label, 60);
      elements.push(
        button(`${picked.has(option.label) ? "✅ " : ""}${label}`, picked.has(option.label) ? "primary" : "default", {
          a: "qpick",
          t: token,
          i: index,
          s: option.label,
        }),
      );
    }
    if (options.length > 10) {
      elements.push(note(`选项较多，仅展示前 10 个；其余请直接回复文字。`));
    }
    if (question.multiSelect) {
      elements.push(
        button(`✅ 提交${picked.size ? `（${picked.size}）` : ""}`, picked.size ? "primary" : "default", {
          a: "qsubmit",
          t: token,
          i: index,
        }),
      );
      elements.push(note("可多选：点选项切换选中，最后点「提交」；也可以直接回复文字，多个用逗号分隔。"));
    } else {
      elements.push(note("点选项即提交；也可以直接回复文字作为自定义答案。"));
    }
  } else {
    elements.push(note("直接在本话题回复文字作答。"));
  }
  elements.push(md("**其它答案 / 文字回答**"));
  elements.push({
    tag: "form",
    name: "q_text_form",
    elements: [
      {
        tag: "input",
        name: "custom",
        width: "fill",
        required: false,
        placeholder: { tag: "plain_text", content: "在这里输入文字答案，或直接在本话题回复" },
      },
      {
        tag: "button",
        name: "submit",
        type: "primary",
        form_action_type: "submit",
        text: { tag: "plain_text", content: "✅ 提交文字" },
        behaviors: [{ type: "callback", value: { a: "qtextsubmit", t: token, i: index } }],
      },
    ],
  });
  if (notice) elements.push(note(notice));

  return card({
    title: `❓ 需要你的决定 (${index + 1}/${total})`,
    template: "orange",
    elements,
  });
}

export function questionAnsweredCard({ summary }) {
  return card({
    title: "✅ 已回答",
    template: "green",
    elements: [md(truncate(summary, 2_000))],
  });
}

function panelHeader(titleMd) {
  return {
    title: { tag: "markdown", content: titleMd },
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
    icon_position: "follow_text",
    icon_expanded_angle: -180,
  };
}

function collapsiblePanel({ title, expanded, border = "grey", body }) {
  return {
    tag: "collapsible_panel",
    expanded,
    header: panelHeader(title),
    border: { color: border, corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: body, text_size: "notation" }],
  };
}

function toolHeader(tool) {
  const icon = tool.status === "error" ? "❌" : tool.status === "done" ? "✅" : "🔧";
  const preview = truncate(tool.preview ?? "", 80);
  return preview ? `${icon} **${truncate(tool.name, 40)}** — ${preview}` : `${icon} **${truncate(tool.name, 40)}**`;
}

function toolLine(tool) {
  return `- ${toolHeader(tool)}`;
}

export function runCard({ run, maxAnswerChars }) {
  const status = run.status;
  const title =
    status === "continued"
      ? "➡️ 回答已提交"
      : status === "done"
        ? "✅ 回合完成"
        : status === "error"
          ? "❌ 回合出错"
          : status === "stopped"
            ? "⏹ 已停止"
            : status === "starting"
              ? run.continued
                ? "🤖 继续处理"
                : "⏳ 正在开始"
              : "🤖 处理中";
  const template =
    status === "done" ? "green" : status === "error" ? "red" : status === "stopped" || status === "continued" ? "grey" : "blue";

  const finished = status === "done" || status === "error" || status === "stopped" || status === "continued";
  const answer =
    status === "continued" ? "" : ((finished ? run.text || run.streamingText : run.streamingText || run.text) || "").trim();
  const reasoning = (run.streamingReasoning || "").trim();
  const elapsed = run.startedAt ? Date.now() - run.startedAt : 0;

  const meta = [];
  if (run.model) meta.push(`🧠 ${run.model}`);
  if (run.perm) meta.push(`🔐 ${run.perm}`);
  meta.push(`⏱ ${formatDuration(elapsed)}`);
  if (run.turn) meta.push(`第 ${run.turn} 轮`);
  if (run.error) meta.push(`⚠️ ${truncate(run.error, 1_000)}`);

  // Fixed skeleton: status / thinking / tools / answer / stop. Sections never
  // swap places, so streaming does not collapse the card height.
  const runningTool = [...(run.tools ?? [])].reverse().find((tool) => tool.status === "running");
  const statusLine =
    status === "continued"
      ? "✅ 回答已提交，后续输出见下方新卡片"
      : status === "done"
        ? "✅ 完成"
        : status === "error"
          ? "❌ 出错"
          : status === "stopped"
            ? "⏹ 已停止"
            : answer
              ? "✍️ 正在生成回答…"
              : runningTool
                ? `🔧 正在调用 ${truncate(runningTool.name, 30)}…`
                : run.continued
                  ? "💭 继续处理…"
                  : "💭 正在思考…";

  const elements = [];
  elements.push(md(`${meta.join(" · ")}\n${statusLine}`));

  const active = status === "starting" || status === "running";
  const tools = run.tools ?? [];
  const totalTools = run.toolTotal ?? tools.length;
  const thinkingTitle = active
    ? "💭 思考过程（思考中…）"
    : reasoning
      ? "💭 思考过程"
      : "💭 思考过程（暂无）";
  elements.push(
    collapsiblePanel({
      title: thinkingTitle,
      expanded: false,
      border: "grey",
      body: reasoning ? truncate(reasoning, 1_500) : "_暂无思考内容_",
    }),
  );

  const toolTitle = totalTools
    ? `🔧 ${totalTools} 次工具调用${active ? "（进行中）" : ""}`
    : "🔧 工具调用（暂无）";
  const toolBody = tools.length
    ? [
        ...tools.map((tool) => toolLine(tool)),
        ...(totalTools > tools.length ? [`- …已省略前 ${totalTools - tools.length} 次`] : []),
      ].join("\n")
    : "_暂无工具调用_";
  elements.push(
    collapsiblePanel({
      title: toolTitle,
      expanded: false,
      border: "blue",
      body: toolBody,
    }),
  );

  if (answer) {
    elements.push(hr());
    elements.push(md(truncate(answer, maxAnswerChars)));
    if (answer.length > maxAnswerChars) {
      elements.push(note("回答过长，卡片已截断；完整内容可在 DSH Web 会话里查看。"));
    }
  }

  if (run.canStop) {
    elements.push(button("⏹ 强制停止", "danger", { a: "stop", s: run.sessionId }));
  }
  return card({ title, template, elements });
}

export function stoppedCard() {
  return card({ title: "⏹ 已请求停止", template: "grey", elements: [md("已向 DSH 发送取消请求。")] });
}

export function errorCard(title, message) {
  return card({
    title: `❌ ${title}`,
    template: "red",
    elements: [md(truncate(message, 4_000))],
  });
}

export function compactResultCard({ title, lines, template = "grey" }) {
  return card({ title, template, elements: [md(lines.join("\n") || "(无)")] });
}
