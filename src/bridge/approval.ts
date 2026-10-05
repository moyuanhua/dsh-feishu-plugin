/**
 * 审批桥：把 dsh 的 `approval/request` waterfall 接到飞书卡片。
 *
 * **逻辑来源**：opencode-feishu-plugin `src/permission.ts` 的 `ApprovalManager`（MIT，Copyright (c) 2026 moyuanhua）
 * —— 策略判定、token 绑定、点击校验序（白名单 → 验签绑 operator → 会话匹配 → nonce 防重放）、
 * 「拒绝级联驳回本会话其余待批」、「本会话内允许该工具」全部沿用上游语义。
 *
 * **形状差异（宿主接缝不同，不是逻辑不同）**：
 * 上游是「`permission.evaluate` hook 改写 effect → `permission.asked` → 发卡 → `permission.reply()`」三段式；
 * dsh 的 `approval/request` 是 **waterfall**：桥直接 await 用户点击，然后返回
 * `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`。因此这里用 pending promise
 * 代替上游的 track/reply，安全判定与按钮语义保持不变。
 *
 * 安全红线（沿用上游）：
 * - **没有飞书映射的会话一律委托**（`next()`），绝不把 GUI/TUI 会话变成等飞书点击的 ask；
 * - 无 `callId` 的请求也委托（无法可靠配对与校验）；
 * - 点击人必须是 owner/白名单，且必须与 token 里绑定的 operator 一致；
 * - 同一 token 只能消费一次（`ReplayGuard`）。
 */
import {
  buildApprovalCard,
  buildResolvedCard,
  buildSessionAllowResolvedCard,
  type ApprovalCardInput,
} from "../feishu/cards.js";
import { errorMessage } from "../logger.js";
import { allowActionsForGrant } from "./perm-presets.js";
import {
  decideEffectForSession,
  parseAllowSessionValue,
  parseApprovalValue,
  type GateConfig,
  type SessionGate,
} from "./permission.js";
import { presetAskActions, presetGateMode } from "./perm-presets.js";
import type { AllowSessionClaims, ReplayGuard, VerifyResult } from "../security/token.js";
import type { Logger, PermissionPreset, SessionLink } from "../types.js";

/** dsh 的审批结果词表（只有 `allowed-once` 是授权）。 */
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** `approval/request` 事件里我们需要的字段（结构类型，便于单测）。 */
export interface ApprovalRequestLike {
  readonly toolName: string;
  readonly callId?: unknown;
  readonly reason?: string;
  readonly displayReason?: Record<string, string>;
}

export interface ApprovalCardPort {
  sendCard(chatId: string, card: object): Promise<string>;
  patchCard(messageId: string, card: object): Promise<void>;
}

export interface ApprovalDeps {
  readonly config: GateConfig;
  readonly log: Logger;
  readonly cardPort: ApprovalCardPort;
  /** sessionId → 飞书投递目标（无映射 = 不接管）。 */
  readonly getLink: (sessionId: string) => Promise<SessionLink | undefined>;
  readonly setSessionMeta: (
    sessionId: string,
    patch: Partial<Omit<SessionLink, "chatId" | "openId">>,
  ) => Promise<boolean>;
  readonly isAllowed: (openId: string) => boolean;
  /** 签发审批 token（上游 `sign`）。 */
  readonly sign: (input: { requestID: string; sessionID: string; openId: string }) => string;
  readonly verify: (token: string, expect?: { r?: string; s?: string; u?: string }) => VerifyResult;
  readonly replay: ReplayGuard;
  /** 「本会话内允许该工具」按钮总开关（默认 true）。 */
  readonly sessionAllowButton?: boolean;
  /** 签发 allow_session token（缺省 = 不渲染该按钮）。 */
  readonly signAllowSession?: (input: { requestID: string; sessionID: string; action: string }) => string;
  readonly verifyAllowSession?: (
    token: string,
    expect?: { sessionID?: string; action?: string },
  ) => VerifyResult<AllowSessionClaims>;
  /** 该会话是否已放行某 action（幂等提示用）。 */
  readonly hasSessionAllow?: (sessionId: string, action: string) => boolean;
  /** 卡片点击的 toast 文案（可注入以便单测断言）。 */
  readonly toast?: (type: "success" | "info" | "error" | "warning", content: string) => unknown;
  readonly now?: () => number;
}

interface PendingApproval {
  readonly requestID: string;
  readonly sessionId: string;
  readonly chatId: string;
  readonly input: ApprovalCardInput;
  readonly messageId: string;
  readonly resolve: (outcome: ApprovalOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>();
  private disposed = false;

  constructor(private readonly deps: ApprovalDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private toast(type: "success" | "info" | "error" | "warning", content: string): unknown {
    if (this.deps.toast) return this.deps.toast(type, content);
    return { toast: { type, content } };
  }

  /** 会话预设 → 会话级 gate（上游 `SessionGate`）。 */
  private sessionGateOf(link: SessionLink): SessionGate | undefined {
    const preset: PermissionPreset | undefined = link.perm;
    if (!preset) return undefined;
    return { gateMode: presetGateMode(preset), askActions: presetAskActions(preset) };
  }

  /**
   * 处理一次审批请求。
   *
   * 返回值即 waterfall 的答案：`allowed-once` 是唯一授权词；委托时调 `next()`。
   */
  async handle(
    sessionId: string | undefined,
    request: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (this.disposed) return next();
    // 无会话身份 / 无 callId：无法可靠配对与校验 → 交回宿主（上游同样要求 callId）。
    if (!sessionId || request.callId === undefined || request.callId === null) return next();

    const link = await this.deps.getLink(sessionId);
    // 没有飞书映射 = 不是本桥的会话：绝不接管（否则 GUI 会话会挂在这里等飞书点击）。
    if (!link) return next();

    const action = request.toolName;
    const decision = decideEffectForSession(
      action,
      this.deps.config,
      this.sessionGateOf(link),
      link.allowActions,
    );

    if (decision.effect === "allow") {
      this.deps.log.debug("审批免问（白名单/会话放行）", { sessionId, action });
      return "allowed-once";
    }
    if (decision.effect === "deny") {
      this.deps.log.info("审批直接拒绝（denyTools / lockdown）", { sessionId, action });
      return "rejected";
    }
    if (decision.effect !== "ask") return next();

    return this.ask(sessionId, link, action, request, decision.message);
  }

  /** 发审批卡并等点击（TTL 到期 → cancelled）。 */
  private async ask(
    sessionId: string,
    link: SessionLink,
    action: string,
    request: ApprovalRequestLike,
    message: string | undefined,
  ): Promise<ApprovalOutcome> {
    const requestID = String(request.callId);
    const openId = link.openId;
    const token = this.deps.sign({ requestID, sessionID: sessionId, openId });
    const allowSessionToken =
      this.deps.sessionAllowButton !== false && this.deps.signAllowSession
        ? this.deps.signAllowSession({ requestID, sessionID: sessionId, action })
        : undefined;

    const input: ApprovalCardInput = {
      requestID,
      sessionID: sessionId,
      action,
      resources: [],
      ...(request.reason ?? message ? { message: request.reason ?? message! } : {}),
      // dsh 的审批请求不带「可持久化保存项」信息：始终允许在当前实现里等价于允许一次。
      canPersistAlways: false,
      token,
      ...(allowSessionToken ? { allowSessionToken } : {}),
      maxResourcesShown: this.deps.config.maxResourcesShown,
    };

    let messageId: string;
    try {
      messageId = await this.deps.cardPort.sendCard(link.chatId, buildApprovalCard(input));
    } catch (error) {
      // 卡片发不出去就不能接管：交回宿主，避免把轮次卡在等一个永远不来的点击上。
      this.deps.log.error("审批卡发送失败，委托宿主处理", { sessionId, action, reason: errorMessage(error) });
      return "unavailable";
    }

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestID);
        this.deps.log.warn("审批超时，按取消处理", { sessionId, action, requestID });
        void this.patchResolved(
          input,
          messageId,
          { reply: "reject", operatorOpenId: openId, at: this.now() },
        );
        resolve("cancelled");
      }, this.deps.config.approvalTtlMs);

      this.pending.set(requestID, {
        requestID,
        sessionId,
        chatId: link.chatId,
        input,
        messageId,
        resolve,
        timer,
      });
      this.deps.log.info("已发审批卡，等待点击", { sessionId, action, requestID, messageId });
    });
  }

  /**
   * 处理卡片点击。返回给飞书的 toast 响应（`card.action.trigger` 的原生反馈）。
   *
   * 校验序与上游一致：解析 value → 验签（token 绑 operator）→ 白名单 → 会话匹配 → nonce 防重放。
   */
  async handleCardAction(event: {
    readonly operator: { readonly openId: string };
    readonly action: { readonly value: unknown };
  }): Promise<unknown> {
    const operator = event.operator.openId;
    const value = event.action.value;

    const allowSession = parseAllowSessionValue(value);
    if (allowSession) return this.handleAllowSession(allowSession.action, allowSession.token, operator);

    const approved = parseApprovalValue(value);
    if (!approved) return undefined;

    const verified = this.deps.verify(approved.token);
    if (!verified.ok) {
      this.deps.log.warn("审批 token 校验失败", { reason: verified.reason });
      return this.toast("error", "操作已失效，请重新发起");
    }
    const claims = verified.claims as { r: string; s: string; u: string; n: string };
    if (claims.u !== operator) return this.toast("error", "这不是发给你的审批");
    if (!this.deps.isAllowed(operator)) return this.toast("error", "无权操作");

    const pending = this.pending.get(claims.r);
    if (!pending) return this.toast("warning", "该请求已处理");

    if (!this.deps.replay.consume(claims.n)) return this.toast("warning", "该操作已被处理");

    this.pending.delete(claims.r);
    clearTimeout(pending.timer);

    const outcome: ApprovalOutcome = approved.decision === "reject" ? "rejected" : "allowed-once";
    void this.patchResolved(pending.input, pending.messageId, {
      reply: approved.decision,
      operatorOpenId: operator,
      at: this.now(),
    });
    // 上游语义：拒绝会级联驳回同会话其余待批请求（卡片文案已警示）。
    if (approved.decision === "reject") this.cascadeReject(pending.sessionId, approved.decision);

    pending.resolve(outcome);
    const label = approved.decision === "reject" ? "已拒绝" : approved.decision === "always" ? "已始终允许" : "已允许一次";
    this.deps.log.info("审批已处理", { requestID: claims.r, sessionId: pending.sessionId, operator, decision: approved.decision });
    return this.toast(outcome === "rejected" ? "warning" : "success", label);
  }

  /** 「本会话内允许该工具」：持久化 allowActions，并顺带用 once 答复当前挂起请求。 */
  private async handleAllowSession(action: string, token: string, operator: string): Promise<unknown> {
    if (!this.deps.verifyAllowSession) return this.toast("error", "该功能未启用");
    const verified = this.deps.verifyAllowSession(token);
    if (!verified.ok) {
      this.deps.log.warn("会话放行 token 校验失败", { reason: verified.reason });
      return this.toast("error", "操作已失效，请重新发起");
    }
    if (!this.deps.isAllowed(operator)) return this.toast("error", "无权操作");
    if (!this.deps.replay.consume(verified.claims.n)) return this.toast("warning", "该操作已被处理");

    const sessionId = verified.claims.s;
    const link = await this.deps.getLink(sessionId);
    if (!link) return this.toast("error", "会话已不存在");

    // 上游 `allowActionsForGrant`：shell/bash 一起放行，避免只放行一个、另一个仍被 gate 降级。
    const grant = allowActionsForGrant(action);
    const existing = link.allowActions ?? [];
    const merged = [...new Set([...existing, ...grant])];
    await this.deps.setSessionMeta(sessionId, { allowActions: merged });

    const input: ApprovalCardInput = {
      requestID: verified.claims.r,
      sessionID: sessionId,
      action,
      resources: [],
      canPersistAlways: false,
      token,
      maxResourcesShown: this.deps.config.maxResourcesShown,
    };
    const messageId = this.pending.get(verified.claims.r)?.messageId;
    if (messageId) {
      try {
        await this.deps.cardPort.patchCard(
          messageId,
          buildSessionAllowResolvedCard(input, { action, operatorOpenId: operator, at: this.now() }),
        );
      } catch (error) {
        this.deps.log.warn("会话放行结果卡更新失败", { reason: errorMessage(error) });
      }
    }

    // 顺带用 once 答复当前挂起的请求（否则它仍会卡住）。
    const pending = this.pending.get(verified.claims.r);
    if (pending) {
      this.pending.delete(verified.claims.r);
      clearTimeout(pending.timer);
      pending.resolve("allowed-once");
    }
    this.deps.log.info("已允许本会话内该工具", { sessionId, action, grants: grant.join(",") });
    return this.toast("success", `已允许本会话内 ${action}`);
  }

  /** 拒绝 / 取消时把同会话其余待批一并驳回（上游语义）。 */
  private cascadeReject(sessionId: string, reply: "once" | "always" | "reject"): void {
    for (const [requestID, pending] of [...this.pending]) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(requestID);
      clearTimeout(pending.timer);
      void this.patchResolved(pending.input, pending.messageId, {
        reply,
        operatorOpenId: "cascade",
        at: this.now(),
      });
      pending.resolve("rejected");
      this.deps.log.info("级联驳回同会话待批请求", { requestID, sessionId });
    }
  }

  private async patchResolved(
    input: ApprovalCardInput,
    messageId: string,
    outcome: { reply: "once" | "always" | "reject"; operatorOpenId: string; at: number },
  ): Promise<void> {
    if (!messageId) return;
    try {
      await this.deps.cardPort.patchCard(messageId, buildResolvedCard(input, outcome));
    } catch (error) {
      this.deps.log.warn("审批结果卡更新失败", { reason: errorMessage(error) });
    }
  }

  /** 卸载：把仍在等点击的请求全部按取消收敛，避免悬挂的 promise。 */
  dispose(): void {
    this.disposed = true;
    for (const [requestID, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve("cancelled");
      this.deps.log.debug("卸载时取消待批请求", { requestID });
    }
    this.pending.clear();
  }

  /** 当前待批数量（诊断/测试用）。 */
  get pendingCount(): number {
    return this.pending.size;
  }
}

/** 供 index.ts 复用的回答词表。 */
export type { SessionGate };
