/**
 * dsh-feishu-plugin —— DeepSeek Harness（Cordis）插件入口。
 *
 * 形态与 dsh 插件约定一致：导出 `name` / `inject` / `Config` / `apply`，
 * 由 profile 的 `cordis.patch.yml` 里一条 `insert` 条目挂载（见 cordis.patch.yml）。
 *
 * 进度：
 * - M1 ✅ 配置 schema + 解析夹取；卡片按钮自签 token 内核（含单测）
 * - M2 ✅ 飞书长连接 supervisor（世代化 + 有界退避 + dispose 收敛）；
 *        入站决策纯函数（单人白名单 / 群开关 / bot 回环 / 空消息 / 命令识别）；
 *        单人 owner 绑定与白名单
 * - M3 ⬜ 话题↔会话映射（ctx.storageDomain）、投递（followup/steer）、流式回显
 * - M4 ⬜ 审批卡 / 提问卡 / 强停 / 看门狗 / 附件
 * - M5 ⬜ 扫码 onboarding、locale/icon、peer 区间、发布
 *
 * 关于"保活"：dsh 没有 opencode 的 location 空闲回收，插件与宿主进程同寿，
 * `ctx.effect` 负责卸载清理；会话不存活时按需 `ctx.sessionController.resolveAgent()` 恢复，
 * 因此上游 340 行 keepalive + 网关选举在 dsh 版中整段删除。
 */
import { decideInbound, type InboundMessageLike } from "./bridge/inbound.js";
import { Config, resolveConfig, type Config as ConfigShape } from "./config.js";
import { createFeishuChannel } from "./feishu/channel.js";
import { ConnectionSupervisor } from "./feishu/connection.js";
import { createLogger, createLogSink, maskId } from "./logger.js";
import { OwnerPolicy } from "./security/allowlist.js";
import { MemoryStorage, type DshContext, type StorageLike } from "./types.js";

export const name = "feishu";

/**
 * 依赖的宿主服务：桥必须有 `agents` 才能投递消息。
 * 其余服务（storageDomain / sessionController / commands / user-approval / user-questions）
 * 在 M3/M4 用到时再声明，避免在缺服务的 profile 里让整棵插件树加载失败。
 */
export const inject: readonly string[] = ["agents"];

export { Config, resolveConfig };
export type { ResolvedConfig } from "./config.js";

/**
 * 取持久化实现。
 *
 * M2 只支持内存实现：dsh 的持久化接缝是 `ctx.storageDomain`（领域表），
 * 需要先 `defineDomain` 再 `open()`，属于 M3 的「话题↔会话映射」一并落地。
 * 在此之前 owner 绑定不跨重启保留（会告警提示）。
 */
function resolveStorage(ctx: DshContext, warn: (message: string, meta?: Record<string, unknown>) => void): StorageLike {
  const candidate = ctx.get?.("feishuStorage");
  if (candidate && typeof candidate === "object" && "get" in candidate && "set" in candidate) {
    return candidate as StorageLike;
  }
  warn("未找到持久化接缝，owner 绑定仅存于内存（M3 接入 ctx.storageDomain 后持久化）");
  return new MemoryStorage();
}

export function apply(ctx: DshContext, raw: ConfigShape = {}): void {
  const config = resolveConfig(raw);
  const sink = createLogSink(typeof config.logFile === "string" ? config.logFile : undefined);
  const log = createLogger({
    level: config.logLevel,
    ...(sink ? { sink: sink.sink } : {}),
  });

  if (!config.enabled) {
    log.warn("未配置飞书凭据（appId + appSecret/appSecretRef），插件保持禁用");
    sink?.close();
    return;
  }

  const storage = resolveStorage(ctx, (message, meta) => log.warn(message, meta));
  const ownerPolicy = new OwnerPolicy(storage, config.allowUsers);

  const channel = createFeishuChannel({
    appId: config.appId!,
    appSecret: config.appSecret!,
    ...(config.domain ? { domain: config.domain } : {}),
    allowUsers: config.allowUsers,
    groupEnabled: config.groupEnabled,
    log,
  });

  const supervisor = new ConnectionSupervisor({
    connect: () => channel.connect(),
    disconnect: () => channel.disconnect(),
    log,
    onState: (state, detail) => {
      if (state === "failed") log.error("长连接进入失败终态", { ...detail });
    },
  });

  channel.onReconnecting(() => supervisor.noteReconnecting());
  channel.onReconnected(() => supervisor.noteReconnected());

  channel.onReject((event) => {
    // SDK 层策略（群未授权 / 发送者不在白名单 / 未 @ / bot 回环）拒绝投递时的可观测点。
    log.info("入站消息被通道策略拒绝", { reason: event.reason, chatId: maskId(event.chatId) });
  });

  channel.onMessage(async (message) => {
    const allowed = await ownerPolicy.admit(message.senderId);
    const decision = decideInbound(message as InboundMessageLike, {
      allowed,
      groupEnabled: config.groupEnabled,
      // M3：改为读 agent.status（不要轮询，用事件维护的投影）。
      busy: false,
      busyDelivery: config.busyDelivery,
    });

    if (decision.kind === "ignore") {
      log.debug("忽略入站消息", { reason: decision.reason, sender: maskId(message.senderId) });
      return;
    }
    if (decision.kind === "command") {
      // M3：交给 ctx.commands.execute(agent, line, [], signal)。
      log.info("收到命令（M3 接入 ctx.commands 后执行）", { command: decision.text });
      return;
    }
    // M3：按话题↔会话映射解析 sessionId → resolveAgent → applyDelivery(followup/steer)。
    log.info("收到任务消息（M3 接入会话映射与投递）", {
      delivery: decision.delivery,
      attachments: decision.attachmentCount,
      chars: decision.text.length,
      sender: maskId(message.senderId),
    });
  });

  ctx.effect(() => {
    log.info("已加载", {
      domain: config.domain,
      gate: config.permissionGate,
      busyDelivery: config.busyDelivery,
      groupEnabled: config.groupEnabled,
      roots: config.allowedRoots.length,
    });
    supervisor.start();
    return async () => {
      await supervisor.stop();
      sink?.close();
    };
  });
}
