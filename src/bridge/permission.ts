/**
 * 权限审批门的**纯策略层**。
 *
 * **逻辑来源**：opencode-feishu-plugin `src/permission.ts`（MIT，Copyright (c) 2026 moyuanhua）的
 * 纯函数部分（`decideEffect` / `decideEffectForSession` / `parseApprovalValue` / `parseAllowSessionValue`），
 * 逐行搬运。
 *
 * **与上游的差别（宿主接缝不同，不是逻辑不同）**：
 * - 上游接线是「`permission.evaluate` hook 改写 effect → `permission.asked` 事件 → 发卡 →
 *   `permission.reply(...)`」三段式；
 * - dsh 的接缝是 `ctx.on('approval/request', (req, next) => Promise<ApprovalOutcome>)` 的
 *   **waterfall**：桥可以直接 await 用户点击后返回 `allowed-once` / `rejected` / `cancelled`，
 *   不需要 evaluate hook 与 reply API。
 * 因此上游那个管卡片生命周期的 `ApprovalManager` 类没有照搬，而是由 `src/bridge/approval.ts`
 * 按 waterfall 的形状重新实现；**策略判定（本文件）与 token 载荷（security/token.ts）仍是上游逻辑**。
 */
import { matchesAny } from "../security/allowlist.js";

export type PermissionEffect = "allow" | "ask" | "deny";
/** 上游的三个按钮语义（dsh 侧映射见 approval.ts：once/always → allowed-once，reject → rejected）。 */
export type PermissionReply = "once" | "always" | "reject";

export interface GateConfig {
  readonly permissionGate: "off" | "notify" | "gate" | "lockdown";
  readonly allowTools: readonly string[];
  readonly denyTools: readonly string[];
  readonly approvalTtlMs: number;
  readonly maxResourcesShown: number;
}

export interface EffectDecision {
  /** undefined = 不改变原生判定。 */
  readonly effect?: PermissionEffect;
  readonly message?: string;
}

/**
 * 纯策略：根据 action 与配置决定是否改写 effect。
 * 注意：`ask` 是否可投递（会话有无飞书映射）由调用方判定，不在纯函数内。
 */
export function decideEffect(action: string, config: GateConfig): EffectDecision {
  if (config.permissionGate === "off" || config.permissionGate === "notify") {
    return {};
  }
  if (matchesAny(action, config.denyTools)) {
    return { effect: "deny", message: `dsh-feishu policy: ${action} 已在 denyTools` };
  }
  if (matchesAny(action, config.allowTools)) {
    return { effect: "allow" };
  }
  if (config.permissionGate === "lockdown") {
    return { effect: "deny", message: `dsh-feishu lockdown: ${action} 不在 allowTools` };
  }
  return { effect: "ask", message: `dsh-feishu: 需要人工批准 ${action}` };
}

/** 会话级 gate：由 `session:<sid>` 上的权限预设推导。 */
export interface SessionGate {
  readonly gateMode: "off" | "gate";
  /** gate 模式下强制升级为 ask 的动作（如 shell/edit/external_directory）。 */
  readonly askActions?: readonly string[];
}

/**
 * 会话级权限策略。无会话预设时**回退**到全局 `decideEffect`。
 *
 * 有预设时：
 * - `off`：完全不介入（原生判定生效）；
 * - `gate`：denyTools → deny；allowTools → allow；askActions → ask；其余**继承**（不改写），
 *   因此不会把只读类工具误伤成 ask（与全局 gate 的「其余一律 ask」不同）。
 *
 * `allowActions` 是审批卡「本会话内允许该工具」写入的会话级放行集合：命中时**优先于 askActions**
 * 返回 allow（避免会话 ruleset 被 gate 再次改成 ask），但 `denyTools`（安全红线）仍优先。
 */
export function decideEffectForSession(
  action: string,
  config: GateConfig,
  session: SessionGate | undefined,
  allowActions?: readonly string[],
): EffectDecision {
  if (!session) {
    const base = decideEffect(action, config);
    // 仅拦截「本会被 ask」的动作；permissionGate=off/notify 时保持不介入。
    if (base.effect === "ask" && allowActions && allowActions.length > 0 && matchesAny(action, allowActions)) {
      return { effect: "allow" };
    }
    return base;
  }
  if (session.gateMode === "off") return {};
  if (matchesAny(action, config.denyTools)) {
    return { effect: "deny", message: `dsh-feishu policy: ${action} 已在 denyTools` };
  }
  if (matchesAny(action, config.allowTools)) {
    return { effect: "allow" };
  }
  if (allowActions && allowActions.length > 0 && matchesAny(action, allowActions)) {
    return { effect: "allow" };
  }
  if (session.askActions && matchesAny(action, session.askActions)) {
    return { effect: "ask", message: `dsh-feishu: 会话预设需人工批准 ${action}` };
  }
  return {};
}

export interface ApprovalActionValue {
  readonly token: string;
  readonly decision: PermissionReply;
}

/** 解析按钮 value：`{ t: token, d: "once"|"always"|"reject" }`。 */
export function parseApprovalValue(rawValue: unknown): ApprovalActionValue | undefined {
  if (typeof rawValue !== "object" || rawValue === null) return undefined;
  const record = rawValue as Record<string, unknown>;
  const token = typeof record.t === "string" ? record.t : "";
  const d = record.d;
  if (!token) return undefined;
  if (d !== "once" && d !== "always" && d !== "reject") return undefined;
  return { token, decision: d };
}

export interface AllowSessionActionValue {
  readonly action: string;
  readonly token: string;
}

/**
 * 解析「本会话内允许该工具」按钮 value：`{ cmd:"allow_session", a:<action>, t:<token> }`。
 * 非该按钮返回 undefined。
 */
export function parseAllowSessionValue(rawValue: unknown): AllowSessionActionValue | undefined {
  if (typeof rawValue !== "object" || rawValue === null) return undefined;
  const record = rawValue as Record<string, unknown>;
  if (record.cmd !== "allow_session") return undefined;
  const action = typeof record.a === "string" ? record.a : "";
  const token = typeof record.t === "string" ? record.t : "";
  if (!action || !token) return undefined;
  return { action, token };
}
