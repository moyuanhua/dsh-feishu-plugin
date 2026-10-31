/**
 * dsh-feishu-plugin — Feishu/Lark long-connection bridge for DeepSeek Harness.
 *
 * A DSH Host plugin (not a Client plugin): it owns one WebSocket connection to
 * Feishu, maps topics to DSH sessions, and uses DSH's own services for session
 * creation, prompts, approvals, questions, models and permission presets.
 */
import { FeishuApp } from "./app.js";
import { resolveConfig } from "./config.js";
import { Config } from "./config-schema.js";
import { createLogger } from "./logger.js";
import { describeError, maskId } from "./utils.js";

export { Config };
export const name = "dsh-feishu-plugin";
const BUILD_TAG = "0.5.15";
export const inject = ["sessionController", "sessions"];

export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const log = createLogger({ level: config.logLevel, file: config.logFile });

  for (const warning of config.warnings) log.warn(warning);

  if (!config.enabled) {
    log.warn("飞书桥接未启用（缺少 appId 或 appSecret）", {
      reason: config.disabledReason,
      hasAppId: Boolean(config.appId),
      hasAppSecret: Boolean(config.appSecret),
      logFile: config.logFile,
    });
    return () => {};
  }

  log.info("飞书桥接初始化", {
    buildTag: BUILD_TAG,
    domain: config.domain,
    appId: maskId(config.appId),
    allowUsers: config.allowUsers.length,
    allowedRoots: config.allowedRoots,
    defaultDirectory: config.defaultDirectory,
    stream: config.stream,
    busyDelivery: config.busyDelivery,
    logFile: config.logFile,
  });

  const app = new FeishuApp({ ctx, config, rawConfig, log });
  try {
    await app.init();
    app.start();
  } catch (error) {
    log.error("飞书桥接启动失败", { error: describeError(error) });
    app.dispose();
    return () => {};
  }

  // Volatile credential fields update live: the settings page writes them
  // through config-editor and the loader updates the reference in place.
  let pending;
  const scheduleReconfigure = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      void app.reconfigure();
    }, 150);
    pending.unref?.();
  };
  const offSettings = ctx.on("settings/document-updated", (ns) => {
    if (String(ns) === "feishu") scheduleReconfigure();
  });
  const offReload = ctx.on("app-boot/config-reload", scheduleReconfigure);

  return () => {
    clearTimeout(pending);
    offSettings?.();
    offReload?.();
    log.info("飞书桥接已停止");
    app.dispose();
  };
}
