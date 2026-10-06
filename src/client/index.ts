/**
 * 飞书桥的**浏览器半侧**：把插件配置表单挂到「插件」页上。
 *
 * 背景：DSH 的插件页只给**官方**插件内置表单，第三方插件要在页面上出现
 * 「配置 {name}」按钮，必须自己注册客户端 UI。插件页声明了三个 slot，
 * 我们注册进 `plugins.row.config`，key 是 `` `${包名}#${行 id}` ``
 * （见官方 `dsh-client-ui-plugin-manager` 的 `rowConfigKey`）。
 *
 * 三件事必须对齐官方实现，任何一条错都表现为"界面上什么都没有"：
 * 1. `inject = ["slots", "locale", "configForms"]`；
 * 2. `ctx.configForms.whileServed([<行 id>], …)` —— 行 id 就是命名空间（我们的行 id 是 `feishu`）；
 * 3. slot 注册的 `key` 必须是 `dsh-feishu-plugin#feishu`。
 *
 * 字段集是**刻意的子集**：`SettingsFormModel` 保存时是逐字段生成补丁（`plan()`），
 * 不是整体替换，所以只放运维常用的旋钮不会清掉配置文件里的其它字段。
 *
 * `appSecret` **不在这里**：它需要 `SettingsFormModel` 的第三个参数
 * （`{ field, write }` 的只写控件），而该形状没有官方导出、无法照抄；
 * 密钥继续由 `cordis.patch.yml` 管理（且已标 `role("secret")`，界面不会回显）。
 */
import { jsx, jsxs } from "react/jsx-runtime";
import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  settingsNumberField,
  settingsTextField,
  type SettingsFieldSpec,
} from "@deepseek-ai/dsh-client-ui-primitives";

/** 配置命名空间 = 本插件在 `cordis.patch.yml` 里的行 id。 */
const CONFIG_NS = "feishu";
/** 本包在 profile 里的包名，与行 id 一起构成 slot key。 */
const BUNDLE_NAME = "dsh-feishu-plugin";
/** 文案字典的命名空间（与配置命名空间无关）。 */
const LOCALE_NS = "settings.feishuBridge";

/** 要在界面上暴露的字段。 */
interface FieldSpec {
  readonly field: string;
  readonly numeric?: boolean;
}

const FIELDS: readonly FieldSpec[] = [
  { field: "appId" },
  { field: "domain" },
  { field: "logLevel" },
  { field: "permissionGate" },
  { field: "busyDelivery" },
  { field: "sessionPageSize", numeric: true },
  { field: "intentTimeoutMs", numeric: true },
  { field: "staleExecutionMs", numeric: true },
  { field: "cardThrottleMs", numeric: true },
];

const FIELD_SPECS: readonly SettingsFieldSpec[] = FIELDS.map((f) =>
  f.numeric ? settingsNumberField(f.field) : settingsTextField(f.field),
);

const zh = {
  title: "飞书桥",
  description: "一个飞书话题 = 一个 dsh 会话；卡内审批与提问，全程长连接、无公网入口。",
  overridden: "已覆盖",
  reset: "恢复默认",
  readOnly: "本部署的设置为只读。",
  unavailable: "该插件当前未加载，暂时无法配置。",
  save: "保存",
  saving: "保存中…",
  saveFailed: "本部署没有接受这些值，已保留供你修改。",
  invalidNumber: "请填数字；留空表示使用默认值。",
  hint: {
    appId: "飞书开放平台的 App ID（cli_ 开头）。改完需要重启。",
    domain: "开放平台域名。国际版填 https://open.larksuite.com",
    logLevel: "debug / info / warn / error。排错时改 debug。",
    permissionGate: "off / notify / gate / lockdown。gate 表示工具调用需要你审批。",
    busyDelivery: "steer（插队，默认）/ queue（排队）。",
    sessionPageSize: "会话列表每页行数（5–20）。",
    intentTimeoutMs: "AI 意图识别超时（毫秒）。超时会降级成空表单，不影响使用。",
    staleExecutionMs: "看门狗阈值（毫秒）；0 关闭。等待你审批的时间不算卡死。",
    cardThrottleMs: "运行卡更新节流（毫秒）。飞书限同一卡片 ≤10 次/秒。",
  },
  label: {
    appId: "App ID",
    domain: "开放平台域名",
    logLevel: "日志级别",
    permissionGate: "审批门",
    busyDelivery: "忙时投递",
    sessionPageSize: "会话列表每页行数",
    intentTimeoutMs: "意图识别超时",
    staleExecutionMs: "看门狗阈值",
    cardThrottleMs: "卡片更新节流",
  },
} as const;

const en = {
  title: "Feishu Bridge",
  description: "One Feishu topic = one dsh session; in-card approvals and questions, long connection with no public endpoint.",
  overridden: "Overridden",
  reset: "Reset to default",
  readOnly: "This deployment's settings are read-only.",
  unavailable: "The plugin is not loaded right now, so it cannot be configured.",
  save: "Save",
  saving: "Saving…",
  saveFailed: "This deployment did not accept these values; they are kept for you to fix.",
  invalidNumber: "Enter a number, or leave blank to use the default.",
  hint: {
    appId: "The App ID from the Feishu developer console (starts with cli_). Restart after changing.",
    domain: "Open platform domain. Use https://open.larksuite.com for Lark.",
    logLevel: "debug / info / warn / error. Set debug when troubleshooting.",
    permissionGate: "off / notify / gate / lockdown. gate asks you before tool calls.",
    busyDelivery: "steer (jump the queue, default) / queue.",
    sessionPageSize: "Rows per page in the session list (5–20).",
    intentTimeoutMs: "AI intent-recognition timeout in ms. It degrades to an empty form on timeout.",
    staleExecutionMs: "Watchdog threshold in ms; 0 disables it. Time spent waiting for you is not idle.",
    cardThrottleMs: "Run-card update throttle in ms. Feishu allows ≤10 updates/sec per card.",
  },
  label: {
    appId: "App ID",
    domain: "Open platform domain",
    logLevel: "Log level",
    permissionGate: "Approval gate",
    busyDelivery: "Delivery when busy",
    sessionPageSize: "Session list page size",
    intentTimeoutMs: "Intent timeout",
    staleExecutionMs: "Watchdog threshold",
    cardThrottleMs: "Card throttle",
  },
} as const;

/** 页面文案读取器（`ctx.locale.bind()` 的返回值）。 */
type Translate = (key: string) => string;

/** 表单框架自己的标签，来自本页字典。 */
function formLabels(t: Translate): Record<string, string> {
  return {
    unavailable: t("unavailable"),
    readOnly: t("readOnly"),
    saveFailed: t("saveFailed"),
    save: t("save"),
    saving: t("saving"),
  };
}

/**
 * 渲染卡片：`summary` 时只回一行说明，否则回整张表单。
 *
 * props 由 slot 框架装配：`t`（按注册时声明的 `locale` 绑定）、`view`、
 * `edit` / `resetField` / `save` / `discard`（来自 `form.actions()`），
 * 以及 `hooks.<name>` 提升成的 `use<PascalName>` 选择器。
 */
function FeishuBridgeCard(props: Record<string, unknown>): unknown {
  const t = props.t as Translate;
  const view = props.view as string;
  const read = props.useFeishuBridgeForm as (selector: (s: unknown) => unknown) => Record<string, never>;
  const state = read((s: unknown) => s);
  if (view === "summary") return t("description");

  const edit = props.edit as (field: string, text: string) => void;
  const resetField = props.resetField as (field: string) => void;
  const shell = state as unknown as { writable?: boolean };

  return jsx(SettingsForm, {
    labels: formLabels(t),
    state,
    onSave: props.save,
    onDiscard: props.discard,
    children: jsxs(
      "div",
      {
        children: FIELDS.map((f) =>
          jsx(
            SettingsValueField,
            {
              id: `plugin-config-feishu-${f.field}`,
              label: t(`label.${f.field}`),
              hint: t(`hint.${f.field}`),
              overriddenLabel: t("overridden"),
              resetLabel: t("reset"),
              invalidLabel: t("invalidNumber"),
              numeric: f.numeric === true,
              disabled: shell.writable === false,
              ...((state as Record<string, unknown>)[f.field] as Record<string, unknown> | undefined),
              onEdit: (text: string) => edit(f.field, text),
              onReset: () => resetField(f.field),
            },
            f.field,
          ),
        ),
      },
      "fields",
    ),
  });
}

/** 桥接配置 scope 与页面表单。 */
class FeishuBridgeCardController {
  private readonly form: SettingsFormModel;
  private readonly store: unknown;

  constructor(scope: unknown) {
    this.form = new SettingsFormModel(scope as never, FIELD_SPECS);
    this.store = this.form.bind(() => this.projection());
  }

  private projection(): Record<string, unknown> {
    const out: Record<string, unknown> = { ...this.form.shell() };
    for (const f of FIELDS) out[f.field] = this.form.field(f.field);
    return out;
  }

  /** slot 框架注入给组件的 props。 */
  inject(): Record<string, unknown> {
    return { hooks: { feishuBridgeForm: this.store }, ...this.form.actions() };
  }

  dispose(): void {
    this.form.dispose();
  }
}

/** 浏览器半侧的必需服务。 */
export const inject = ["slots", "locale", "configForms"];

export function apply(ctx: {
  locale: { bind(ns: string): Translate; register(ns: string, dict: Record<string, unknown>): () => void };
  configForms: {
    get(ns: string): unknown;
    whileServed(namespaces: readonly string[], mount: () => void): () => void;
  };
  slots: {
    inject(name: string, mount: () => void): () => void;
    register(entry: Record<string, unknown>, component: unknown): unknown;
  };
  effect(callback: () => (() => void) | void, label?: string): void;
}): void {
  const t = ctx.locale.bind(LOCALE_NS);
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "feishu-bridge: dictionaries");

  const card = new FeishuBridgeCardController(ctx.configForms.get(CONFIG_NS));
  ctx.effect(() => () => card.dispose(), "feishu-bridge: form subscription");

  ctx.effect(
    () =>
      ctx.configForms.whileServed([CONFIG_NS], () =>
        ctx.slots.inject("plugins.row.config", () =>
          ctx.slots.register(
            {
              name: "plugins.row.config",
              key: `${BUNDLE_NAME}#${CONFIG_NS}`,
              label: () => t("title"),
              locale: LOCALE_NS,
              inject: () => card.inject(),
            },
            FeishuBridgeCard,
          ),
        ),
      ),
    "feishu-bridge: plugins page card",
  );
}
