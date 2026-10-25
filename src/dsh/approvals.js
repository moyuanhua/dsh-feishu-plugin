/** Answers DSH approval/request waterfalls through Feishu cards. */
import { createSigner } from "../security.js";
import { describeError, truncate, uniqueId } from "../utils.js";
import { approvalCard, approvalResultCard } from "../cards.js";

export class FeishuApprovals {
  constructor({ ctx, bridge, sender, state, config, log, isAllowed }) {
    this.ctx = ctx;
    this.bridge = bridge;
    this.sender = sender;
    this.state = state;
    this.config = config;
    this.log = log;
    this.isAllowed = isAllowed;
    this.signer = createSigner(config.signSecret);
    this.pending = new Map();
    // Prepend: the Web UI approval answerer is also registered on this
    // waterfall. Without priority it can claim the request first, so a
    // Feishu-bound session shows an approval card in the Web UI but never in
    // Feishu. We claim linked sessions and delegate everything else.
    this.dispose = ctx.on(
      "approval/request",
      async (req, next) => {
        try {
          return await this.handleRequest(req, next);
        } catch (error) {
          this.log.warn("审批卡片处理失败", { error: describeError(error) });
          return next();
        }
      },
      { prepend: true },
    );
  }

  close() {
    try {
      this.dispose?.();
    } catch {
      /* ignore */
    }
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.resolve?.("cancelled");
    }
    this.pending.clear();
  }

  async handleRequest(req, next) {
    const sessionId = String(req?.agent?.id ?? "");
    const link = this.state.linkForSession(sessionId);
    if (!link?.anchorMessageId) return next();

    const key = uniqueId("ap_");
    const token = this.signer.sign({ kind: "approval", key });
    const view = await this.bridge.viewOf(sessionId);
    const card = approvalCard({
      toolName: req.toolName,
      reason: req.reason,
      sessionTitle: view.title,
      ttlMinutes: Math.round(this.config.approvalTtlMs / 60_000),
      approveToken: token,
      rejectToken: token,
    });

    const sent = await this.sender.replyCard(link.anchorMessageId, card);
    if (!sent.ok) {
      this.log.warn("审批卡发送失败，交给其他 answerer", { sessionId, error: sent.error });
      return next();
    }

    const outcome = await new Promise((resolve) => {
      const item = {
        key,
        sessionId,
        toolName: req.toolName,
        messageId: sent.messageId,
        resolve,
        timer: undefined,
        signal: req.signal,
        onAbort: undefined,
        settled: false,
      };
      this.pending.set(key, item);
      item.timer = setTimeout(() => this.settle(key, "cancelled", "⏰ 审批超时"), this.config.approvalTtlMs);
      item.timer.unref?.();
      if (req.signal) {
        item.onAbort = () => this.settle(key, "cancelled", "已取消");
        if (req.signal.aborted) item.onAbort();
        else req.signal.addEventListener("abort", item.onAbort, { once: true });
      }
    });

    this.log.info("审批已结算", { sessionId, tool: req.toolName, outcome });
    return outcome;
  }

  async settle(key, outcome, note, patch = true) {
    const item = this.pending.get(key);
    if (!item || item.settled) return false;
    item.settled = true;
    this.pending.delete(key);
    clearTimeout(item.timer);
    if (item.signal && item.onAbort) item.signal.removeEventListener("abort", item.onAbort);
    item.resolve?.(outcome);
    if (patch) {
      const approved = outcome === "allowed-once";
      await this.sender.patchCard(item.messageId, approvalResultCard({ approved, toolName: item.toolName }));
    }
    if (note) this.log.info("审批结束", { sessionId: item.sessionId, outcome, note });
    return true;
  }

  /** Card action: `{a:'approve'|'reject', t}`. */
  async handleAction(action) {
    const value = action.value ?? {};
    const payload = this.signer.verify(value.t);
    if (!payload || payload.kind !== "approval") return { toast: { type: "error", content: "凭证无效或已过期" } };
    if (!this.isAllowed(action.operatorOpenId)) {
      return { toast: { type: "error", content: "你不在允许名单内" } };
    }
    const item = this.pending.get(payload.key);
    if (!item) return { toast: { type: "error", content: "审批已结束或已过期" } };
    const approve = value.a === "approve";
    const toolName = item.toolName;
    await this.settle(payload.key, approve ? "allowed-once" : "rejected", undefined, false);
    const card = approvalResultCard({ approved: approve, toolName });
    return { card: { type: "raw", data: card }, toast: { type: "info", content: approve ? "已允许本次调用" : "已拒绝本次调用" } };
  }
}
