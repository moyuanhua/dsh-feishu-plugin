/**
 * 插件配置：schemastery schema + 解析/夹取（clamp）后的运行时形状。
 *
 * 与上游 opencode 版的区别：
 * - 上游从 `plugins/feishu.json` / `ctx.options` / 环境变量三处取值；dsh 版本的配置由
 *   profile 的 `cordis.patch.yml` 里该条目的 `config:` 提供，并由 Loader 用本 schema 校验，
 *   因此这里只保留「schema + 默认值 + 夹取」，不再自己找文件。
 * - 上游 `permissionGate` 的四档语义（off/notify/gate/lockdown）与默认 `gate` 保持一致。
 *
 * 设计红线（沿用上游）：解析永不抛异常；缺 appSecret 只禁用插件，不阻断宿主启动。
 */
import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

export type PermissionGate = "off" | "notify" | "gate" | "lockdown";
export type BusyDelivery = "steer" | "queue";
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 未解析的原始配置（来自 patch 条目的 `config:`）。 */
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
}

export const Config: z<Config> = z.object({
  appId: z.string().description("飞书 App ID（cli_…）"),
  appSecret: z.string().description("飞书 App Secret（永不写入日志）"),
  appSecretRef: z.string().description("凭据名，经 ctx.credentials 解析"),
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
  staleExecutionMs: z.number().default(300_000).description("看门狗阈值（ms）；0 = 关闭"),
  approvalTtlMs: z.number().default(600_000).description("审批 token 有效期（ms）"),
  stream: z.boolean().default(true).description("流式回填"),
  attachmentsDir: z.string().description("入站附件落盘目录"),
  maxAttachmentBytes: z.number().default(20 * 1024 * 1024).description("单个附件上限（字节）"),
  logLevel: z
    .union([z.const("debug"), z.const("info"), z.const("warn"), z.const("error")])
    .default("info")
    .description("日志级别"),
  logFile: z.union([z.string(), z.boolean()]).default(false).description("日志文件路径或 true"),
});

/** 解析后的运行时配置：默认值已补齐、数值已夹取、signSecret 已派生。 */
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
  /** 卡片按钮 token 的签名密钥（appSecret 派生；缺 appSecret 时为空串）。 */
  readonly signSecret: string;
  /** 缺凭据时为 false：插件保持禁用，不连接飞书。 */
  readonly enabled: boolean;
}

/** 上游默认免审批白名单；dsh 工具名与之不同，故按 dsh 命名给默认值。 */
const DEFAULT_ALLOW_TOOLS = ["read", "glob", "grep", "web_fetch"];

const TTL_MIN_MS = 30_000;
const TTL_MAX_MS = 24 * 60 * 60 * 1000;
const STALE_MAX_MS = 60 * 60 * 1000;
const ATTACHMENT_MIN_BYTES = 1024 * 1024;
const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

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

export function resolveConfig(raw: Config = {}): ResolvedConfig {
  const appId = raw.appId?.trim() || undefined;
  const appSecret = raw.appSecret?.trim() || undefined;

  const staleRaw = raw.staleExecutionMs ?? 300_000;
  const staleExecutionMs = staleRaw === 0 ? 0 : clamp(staleRaw, 1_000, STALE_MAX_MS, 300_000);

  const allowedRoots = cleanList(raw.allowedRoots);
  const attachmentsDir = raw.attachmentsDir?.trim() || undefined;

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
    staleExecutionMs,
    approvalTtlMs: clamp(raw.approvalTtlMs ?? 600_000, TTL_MIN_MS, TTL_MAX_MS, 600_000),
    stream: raw.stream !== false,
    attachmentsDir,
    maxAttachmentBytes: clamp(
      raw.maxAttachmentBytes ?? 20 * 1024 * 1024,
      ATTACHMENT_MIN_BYTES,
      ATTACHMENT_MAX_BYTES,
      20 * 1024 * 1024,
    ),
    logLevel: raw.logLevel ?? "info",
    logFile: raw.logFile ?? false,
    signSecret: appSecret ? deriveSignSecret(appSecret) : "",
    enabled: Boolean(appId && (appSecret || raw.appSecretRef)),
  };
}
