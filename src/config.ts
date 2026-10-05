/**
 * 插件配置：schemastery schema + 解析后的运行时形状。
 *
 * 遵循官方《插件配置》的两条约定（`docs/user/develop/basic/config.zh.md`）：
 * 1. **默认值写在 schema 里**，`resolveConfig` 只负责派生值（签名密钥）与形状归一化；
 * 2. **凡是不同部署可能取不同值的参数都要做成配置字段**（"能否在 cordis.yml 里改这个值而不改代码？"）
 *    —— 因此退避参数、卡片节流/上限、标题长度都在这里，而不是散落在各模块的常量。
 *
 * 与上游 opencode 版的差异：上游从 `plugins/feishu.json` / `ctx.options` / 环境变量三处取值，
 * 并且"解析永不抛异常"；dsh 版的配置由 profile 的 patch 条目提供、由 Loader 用本 schema 校验，
 * 因此**非法取值在插件加载时就响亮失败**（区间约束写在 schema 里），而"缺凭据"仍然只是禁用。
 */
import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

export type PermissionGate = "off" | "notify" | "gate" | "lockdown";
export type BusyDelivery = "steer" | "queue";
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 未解析的原始配置（来自 patch 条目的 `config:`，由 schema 校验并填默认值）。 */
export interface Config {
  /** 飞书 App ID（`cli_…`）。缺省时进入扫码注册引导（M5 实现）。 */
  appId?: string;
  /** 飞书 App Secret；也可用 appSecretRef 经 ctx.credentials 取值。 */
  appSecret?: string;
  /** 凭据名（环境变量 / dotenv / 凭据提供方），经 ctx.credentials 每次启动解析。 */
  appSecretRef?: string;
  /** 开放平台域名：feishu（默认）或 lark 国际版。 */
  domain?: string;
  /** 工作目录基线；缺省为宿主进程 cwd。 */
  cwd?: string;
  /** 允许使用机器人的 open_id 白名单；空 = 仅首个发消息者绑定的 owner。 */
  allowUsers?: string[];
  /**
   * 群入口开关（预留）。**默认 false**：不申请任何群权限，机器人物理上收不到群消息。
   * 打开需自行在开发者后台加 `im:message.group_at_msg:readonly` 并发布版本。
   */
  groupEnabled?: boolean;
  /** 全局审批门：off 不介入 / notify 只提示 / gate 无匹配即问 / lockdown 无匹配即拒。 */
  permissionGate?: PermissionGate;
  /** 免审批工具白名单，支持 `prefix*`。 */
  allowTools?: string[];
  /** 强制拒绝（优先于白名单）。 */
  denyTools?: string[];
  /** 允许的工作目录根；越界与系统目录拒绝。 */
  allowedRoots?: string[];
  /** 忙时新消息投递：steer 立即插队（默认）或 queue 原生排队。 */
  busyDelivery?: BusyDelivery;
  /** 看门狗阈值（ms）；0 = 关闭看门狗。 */
  staleExecutionMs?: number;
  /** 审批卡 / token 有效期（ms）与卡片 TTL 对齐。 */
  approvalTtlMs?: number;
  /** 流式回填（打字机卡片）。 */
  stream?: boolean;
  /** 附件落盘目录；缺省为 <会话目录>/.dsh-feishu/inbox/。 */
  attachmentsDir?: string;
  /** 单个入站附件上限（字节）。 */
  maxAttachmentBytes?: number;
  /** 日志级别。 */
  logLevel?: LogLevel;
  /** 日志文件路径；true = 默认位置。 */
  logFile?: string | boolean;

  // —— 长连接退避（M2） ——
  /** 首次重连延迟（ms）。 */
  connectBackoffInitialMs?: number;
  /** 退避上限（ms）。 */
  connectBackoffMaxMs?: number;
  /** 单次中断内的最大连续失败次数，超出后放弃（默认 10）。 */
  connectBackoffMaxAttempts?: number;

  // —— 卡片渲染与更新（M3b） ——
  /** 运行卡更新节流（ms）；飞书限同一卡片 ≤10 次/秒，默认 700。 */
  cardThrottleMs?: number;
  /** 运行卡正文截断字符数，默认 2048。 */
  cardMaxTextChars?: number;
  /** 运行卡最多渲染多少个工具块，默认 12。 */
  cardMaxToolBlocks?: number;
  /** 单卡正文上限（字符），超过则封卡翻页，默认 30000（官方元素上限）。 */
  cardMaxChars?: number;
  /** 从首条消息生成话题标题的最大字符数，默认 20。 */
  topicTitleMaxChars?: number;
}

export const Config: z<Config> = z.object({
  appId: z.string().description("飞书 App ID（cli_…）"),
  appSecret: z.string().description("飞书 App Secret（永不写入日志）"),
  appSecretRef: z.string().role("credential-ref").description("凭据名，经 ctx.credentials 解析"),
  domain: z.string().default("https://open.feishu.cn").description("开放平台域名"),
  cwd: z.string().description("工作目录基线，缺省为宿主 cwd"),
  allowUsers: z.array(z.string()).default([]).description("open_id 白名单；空 = 仅 owner"),
  groupEnabled: z.boolean().default(false).description("群入口开关（预留；默认关）"),
  permissionGate: z
    .union([z.const("off"), z.const("notify"), z.const("gate"), z.const("lockdown")])
    .default("gate")
    .description("全局审批门"),
  allowTools: z.array(z.string()).description("免审批工具白名单，支持 prefix*"),
  denyTools: z.array(z.string()).default([]).description("强制拒绝的工具"),
  allowedRoots: z.array(z.string()).description("允许的工作目录根"),
  busyDelivery: z.union([z.const("steer"), z.const("queue")]).default("steer").description("忙时投递方式"),
  staleExecutionMs: z.number().min(0).max(3_600_000).default(300_000).description("看门狗阈值（ms）；0 = 关闭"),
  approvalTtlMs: z.number().min(30_000).max(86_400_000).default(600_000).description("审批 token 有效期（ms）"),
  stream: z.boolean().default(true).description("流式回填"),
  attachmentsDir: z.string().description("入站附件落盘目录"),
  maxAttachmentBytes: z
    .number()
    .min(1024 * 1024)
    .max(100 * 1024 * 1024)
    .default(20 * 1024 * 1024)
    .description("单个附件上限（字节）"),
  logLevel: z
    .union([z.const("debug"), z.const("info"), z.const("warn"), z.const("error")])
    .default("info")
    .description("日志级别"),
  logFile: z.union([z.string(), z.boolean()]).default(false).description("日志文件路径或 true"),

  connectBackoffInitialMs: z.number().min(100).max(60_000).default(500).description("首次重连延迟（ms）"),
  connectBackoffMaxMs: z.number().min(1_000).max(600_000).default(30_000).description("退避上限（ms）"),
  connectBackoffMaxAttempts: z.number().min(1).max(100).default(10).description("最大连续失败次数"),

  cardThrottleMs: z.number().min(0).max(10_000).default(700).description("运行卡更新节流（ms）"),
  cardMaxTextChars: z.number().min(200).max(100_000).default(2_048).description("运行卡正文截断字符数"),
  cardMaxToolBlocks: z.number().min(1).max(200).default(12).description("运行卡工具块上限"),
  cardMaxChars: z.number().min(1_000).max(30_000).default(30_000).description("单卡正文上限（字符）"),
  topicTitleMaxChars: z.number().min(4).max(200).default(20).description("话题标题最大字符数"),
});

/** 解析后的运行时配置：默认值已由 schema 补齐，这里只做形状归一化与派生。 */
export interface ResolvedConfig {
  readonly appId: string | undefined;
  readonly appSecret: string | undefined;
  readonly appSecretRef: string | undefined;
  readonly domain: string;
  readonly cwd: string;
  readonly allowUsers: readonly string[];
  readonly groupEnabled: boolean;
  readonly permissionGate: PermissionGate;
  readonly allowTools: readonly string[];
  readonly denyTools: readonly string[];
  readonly allowedRoots: readonly string[];
  readonly busyDelivery: BusyDelivery;
  readonly staleExecutionMs: number;
  readonly approvalTtlMs: number;
  readonly stream: boolean;
  readonly attachmentsDir: string | undefined;
  readonly maxAttachmentBytes: number;
  readonly logLevel: LogLevel;
  readonly logFile: string | boolean;
  readonly connectBackoffInitialMs: number;
  readonly connectBackoffMaxMs: number;
  readonly connectBackoffMaxAttempts: number;
  readonly cardThrottleMs: number;
  readonly cardMaxTextChars: number;
  readonly cardMaxToolBlocks: number;
  readonly cardMaxChars: number;
  readonly topicTitleMaxChars: number;
  /** 卡片按钮 token 的签名密钥（appSecret 派生；缺 appSecret 时为空串）。 */
  readonly signSecret: string;
  /** 缺凭据时为 false：插件保持禁用，不连接飞书。 */
  readonly enabled: boolean;
}

/** 上游默认免审批白名单；dsh 工具名与之不同，故按 dsh 命名给默认值。 */
const DEFAULT_ALLOW_TOOLS = ["read", "glob", "grep", "web_fetch"];

function cleanList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/** 由 appSecret 派生签名密钥，避免额外配置项。沿用上游的域分隔前缀习惯。 */
export function deriveSignSecret(appSecret: string): string {
  return createHash("sha256").update(`dsh-feishu/approval/v1:${appSecret}`).digest("hex");
}

/**
 * 归一化配置。
 *
 * 区间与枚举约束已由 schema 在加载时校验（非法值会直接让插件加载失败），
 * 所以这里不再做 clamp —— 只补 schema 无法表达的派生与列表清洗。
 */
export function resolveConfig(raw: Config = {}): ResolvedConfig {
  const appId = raw.appId?.trim() || undefined;
  const appSecret = raw.appSecret?.trim() || undefined;
  const allowedRoots = cleanList(raw.allowedRoots);

  return {
    appId,
    appSecret,
    appSecretRef: raw.appSecretRef?.trim() || undefined,
    domain: (raw.domain?.trim() || "https://open.feishu.cn").replace(/\/+$/, ""),
    cwd: raw.cwd?.trim() || process.cwd(),
    allowUsers: cleanList(raw.allowUsers),
    groupEnabled: raw.groupEnabled === true,
    permissionGate: raw.permissionGate ?? "gate",
    allowTools: raw.allowTools === undefined ? [...DEFAULT_ALLOW_TOOLS] : cleanList(raw.allowTools),
    denyTools: cleanList(raw.denyTools),
    allowedRoots: allowedRoots.length > 0 ? allowedRoots : [homedir()],
    busyDelivery: raw.busyDelivery ?? "steer",
    staleExecutionMs: raw.staleExecutionMs ?? 300_000,
    approvalTtlMs: raw.approvalTtlMs ?? 600_000,
    stream: raw.stream !== false,
    attachmentsDir: raw.attachmentsDir?.trim() || undefined,
    maxAttachmentBytes: raw.maxAttachmentBytes ?? 20 * 1024 * 1024,
    logLevel: raw.logLevel ?? "info",
    logFile: raw.logFile ?? false,
    connectBackoffInitialMs: raw.connectBackoffInitialMs ?? 500,
    connectBackoffMaxMs: raw.connectBackoffMaxMs ?? 30_000,
    connectBackoffMaxAttempts: raw.connectBackoffMaxAttempts ?? 10,
    cardThrottleMs: raw.cardThrottleMs ?? 700,
    cardMaxTextChars: raw.cardMaxTextChars ?? 2_048,
    cardMaxToolBlocks: raw.cardMaxToolBlocks ?? 12,
    cardMaxChars: raw.cardMaxChars ?? 30_000,
    topicTitleMaxChars: raw.topicTitleMaxChars ?? 20,
    signSecret: appSecret ? deriveSignSecret(appSecret) : "",
    enabled: Boolean(appId && (appSecret || raw.appSecretRef)),
  };
}
