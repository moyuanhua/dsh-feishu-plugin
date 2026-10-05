/**
 * dsh-feishu-plugin —— DeepSeek Harness（Cordis）插件入口。
 *
 * 形态与 dsh 插件约定一致：导出 `name` / `inject` / `Config` / `apply`，
 * 由 profile 的 `cordis.patch.yml` 里一条 `insert` 条目挂载。
 *
 * 当前进度（M1 骨架）：
 * - ✅ 配置 schema + 解析/夹取（src/config.ts）
 * - ✅ 卡片按钮自签 token 与防重放内核（src/security/token.ts，含单测）
 * - ⬜ 飞书长连接（@larksuite/channel）、会话桥、审批/提问桥、流式回显（M2–M4）
 *
 * `inject` 目前为空：M2 起会按实际用到的 dsh 接缝补全（agents / sessions / user-approval /
 * user-questions / commands / settings 等），在未确认服务名之前不声明，避免整棵插件树加载失败。
 */
import { Config, resolveConfig, type Config as ConfigShape } from "./config.js";

export const name = "feishu";

/** 依赖的宿主服务：M2 起补全。空数组 = 只依赖基础 ctx。 */
export const inject: readonly string[] = [];

export { Config, resolveConfig };
export type { ResolvedConfig } from "./config.js";

/** 只用到 logger 的最小 ctx 视图，避免在接缝确定前绑死 cordis 类型。 */
interface MinimalContext {
  readonly logger?: (name: string) => {
    info(message: string): void;
    warn(message: string): void;
  };
}

/**
 * Cordis 插件入口。
 *
 * 配置无效（缺 appId/appSecret）时只告警并保持禁用：绝不抛异常阻断宿主启动
 * （沿用上游"解析永不抛异常"的红线）。
 */
export function apply(ctx: MinimalContext, raw: ConfigShape = {}): void {
  const config = resolveConfig(raw);
  const log = ctx.logger?.("feishu");

  if (!config.enabled) {
    log?.warn("未配置飞书凭据（appId + appSecret/appSecretRef），插件保持禁用");
    return;
  }

  log?.info(
    `已加载：domain=${config.domain} gate=${config.permissionGate} ` +
      `busyDelivery=${config.busyDelivery} groupEnabled=${config.groupEnabled} ` +
      `allowedRoots=${config.allowedRoots.length}（M1 骨架：尚未建立飞书长连接）`,
  );
}
