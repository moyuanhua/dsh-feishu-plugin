/**
 * dsh-feishu-plugin —— DeepSeek Harness（Cordis）插件入口。
 *
 * 形态与 dsh 插件约定一致：导出 `name` / `inject` / `Config` / `apply`，
 * 由 profile 的 `cordis.patch.yml` 里一条 `insert` 条目挂载（见 cordis.patch.yml）。
 *
 * 进度：
 * - M1 ✅ 配置 schema + 解析夹取；卡片按钮自签 token 内核（含单测）
 * - M2 ✅ 飞书长连接 supervisor；入站决策纯函数；单人 owner 绑定
 * - M3a ✅ 话题↔会话映射（`ctx.storageDomain` 领域表）、会话创建、真实投递（followup/steer）
 * - M3b ⬜ 流式回显卡片、`/new` `/sessions` `/resume` `/stop`
 * - M4 ⬜ 审批卡 / 提问卡 / 强停 / 看门狗 / 附件
 * - M5 ⬜ 扫码 onboarding、locale/icon、peer 区间、发布
 *
 * cordis 服务访问的两条硬规则（探针实测）：
 *   1. 必需服务必须写进 `inject`，否则属性访问抛
 *      `Error: cannot get property "agents" without inject`；
 *   2. `ctx.get(name)` **不是**服务查找 API（对 agents/tools/llm 一律返回 undefined），
 *      可选服务要用 `ctx.inject([...], (sub) => ...)` 子级。
 *
 * 关于"保活"：dsh 没有 opencode 的 location 空闲回收，插件与宿主进程同寿，
 * `ctx.effect` 负责卸载清理；会话不存活时按需 `ctx.agents.resume()` 恢复。
 */
import type { Context } from "@deepseek-ai/cordis";
import { deliverInbound, type DeliveryPort } from "./bridge/deliver.js";
import { decideInbound, type InboundMessageLike } from "./bridge/inbound.js";
import { MemoryTopicStore, openTopicStore, type TopicStore } from "./bridge/topics.js";
import { Config, resolveConfig, type Config as ConfigShape } from "./config.js";
import { createDshPort } from "./dsh/port.js";
import { createFeishuChannel } from "./feishu/channel.js";
import { ConnectionSupervisor } from "./feishu/connection.js";
import { createLogger, createLogSink, errorMessage, maskId } from "./logger.js";
import { OwnerPolicy } from "./security/allowlist.js";
import { MemoryStorage } from "./types.js";

export const name = "feishu";

/** 必需服务：投递消息要 agents；话题映射要 storageDomain。 */
export const inject: readonly string[] = ["agents", "storageDomain"];

export { Config, resolveConfig };
export type { ResolvedConfig } from "./config.js";

/**
 * 一次性打开话题映射表。
 *
 * 域表打开失败（后端未配置 / 域版本不符）不致命：降级为内存表并告警 ——
 * 映射丢失只会导致"下次消息新建一个会话"，不该让整条飞书通道不可用。
 */
async function resolveTopicStore(ctx: Context, log: ReturnType<typeof createLogger>): Promise<TopicStore> {
  try {
    return await openTopicStore(ctx.storageDomain, log);
  } catch (error) {
    log.warn("话题映射域表打开失败，降级为内存表（映射不跨重启）", { reason: errorMessage(error) });
    return new MemoryTopicStore();
  }
}

export function apply(ctx: Context, raw: ConfigShape = {}): void {
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

  // owner 白名单只需要 key/value 存储；M3b 起接到 storageDomain 的另一张表。
  const ownerPolicy = new OwnerPolicy(new MemoryStorage(), config.allowUsers);
  const port: DeliveryPort = createDshPort(ctx, log);
  let storePromise: Promise<TopicStore> | undefined;
  const store = (): Promise<TopicStore> => (storePromise ??= resolveTopicStore(ctx, log));

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
    log.info("入站消息被通道策略拒绝", { reason: event.reason, chatId: maskId(event.chatId) });
  });

  channel.onMessage(async (message) => {
    const allowed = await ownerPolicy.admit(message.senderId);
    const decision = decideInbound(message as InboundMessageLike, {
      allowed,
      groupEnabled: config.groupEnabled,
      // M3b：改为读 agent 投影状态（不轮询，用事件维护）。
      busy: false,
      busyDelivery: config.busyDelivery,
    });

    if (decision.kind === "ignore") {
      log.debug("忽略入站消息", { reason: decision.reason, sender: maskId(message.senderId) });
      return;
    }
    if (decision.kind === "command") {
      // M3b：交给 ctx.commands.execute(agent, line, [], signal)。
      log.info("收到命令（M3b 接入 ctx.commands 后执行）", { command: decision.text });
      return;
    }

    try {
      const topicStore = await store();
      const result = await deliverInbound(topicStore, port, message as InboundMessageLike, decision, {
        cwd: config.cwd,
      });
      log.info("已投递到会话", {
        sessionId: result.sessionId,
        created: result.created,
        delivery: decision.delivery,
        attachments: decision.attachmentCount,
        chars: decision.text.length,
        sender: maskId(message.senderId),
      });
    } catch (error) {
      log.error("投递失败", { reason: errorMessage(error), sender: maskId(message.senderId) });
    }
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
