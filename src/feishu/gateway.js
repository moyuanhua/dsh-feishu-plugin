/** Feishu long-connection gateway: WSClient + EventDispatcher. */
import * as Lark from "@larksuiteoapi/node-sdk";
import { parseCardAction, parseIncomingMessage } from "./events.js";

function bridgeLogger(log, tag) {
  const write = (level) => (...args) => {
    const text = args
      .map((value) => {
        if (typeof value === "string") return value;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join(" ")
      .slice(0, 800);
    log[level](`${tag} ${text}`);
  };
  return { error: write("error"), warn: write("warn"), info: write("info"), debug: write("debug"), trace: write("debug") };
}

export function createFeishuClient({ appId, appSecret, domain }) {
  return new Lark.Client({
    appId,
    appSecret,
    domain: domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
  });
}

export function startGateway({ appId, appSecret, domain, log, onMessage, onCardAction }) {
  const logger = bridgeLogger(log, "lark");

  const dispatcher = new Lark.EventDispatcher({
    loggerLevel: Lark.LoggerLevel.info,
    logger,
  }).register({
    "im.message.receive_v1": (data) => {
      try {
        const message = parseIncomingMessage(data);
        if (!message) return;
        void Promise.resolve(onMessage(message)).catch((error) => {
          log.error("消息处理失败", { error: String(error) });
        });
      } catch (error) {
        log.error("消息解析异常", { error: String(error) });
      }
    },
    "card.action.trigger": async (data) => {
      try {
        const action = parseCardAction(data);
        if (!action) return {};
        return (await onCardAction(action)) ?? {};
      } catch (error) {
        log.error("卡片回调异常", { error: String(error) });
        return { toast: { type: "error", content: "处理失败，请重试" } };
      }
    },
  });

  let wsClient;
  let stopped = false;
  let lastRestartAt = 0;
  let watchdog;
  let statusTimer;

  const connect = () => {
    wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain: domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
      logger,
      // The SDK pings every ~120s. Without pingTimeout it never notices a
      // half-open socket (NAT idle timeout, Wi-Fi switch, laptop sleep): the
      // TCP connection stays ESTABLISHED, Feishu stops pushing events, and no
      // close/error fires, so reconnection never starts. 30s of no inbound
      // frame after a ping terminates the socket and drives the SDK reconnect.
      wsConfig: { pingTimeout: 30 },
      onReady: () => log.info("飞书长连接已就绪（收到 ready）"),
      onReconnecting: () => log.warn("飞书长连接正在重连"),
      onReconnected: () => log.info("飞书长连接已重连"),
      onError: (error) => log.error("飞书长连接错误", { error: error instanceof Error ? error.message : String(error) }),
    });
    void wsClient.start({ eventDispatcher: dispatcher }).catch((error) => {
      if (!stopped) log.error("飞书长连接启动失败", { error: String(error) });
    });
  };

  const restart = (reason) => {
    if (stopped) return;
    const now = Date.now();
    if (now - lastRestartAt < 120_000) return;
    lastRestartAt = now;
    log.warn("飞书长连接重启", { reason });
    try {
      wsClient?.close({ force: true });
    } catch (error) {
      log.warn("关闭飞书长连接失败", { error: String(error) });
    }
    connect();
  };

  connect();

  watchdog = setInterval(() => {
    if (stopped) return;
    let status;
    try {
      status = wsClient?.getConnectionStatus?.();
    } catch (error) {
      log.warn("读取飞书长连接状态失败", { error: String(error) });
      return;
    }
    const state = status?.state;
    if (state === "failed" || state === "closed") {
      restart(`state:${state}`);
      return;
    }
    log.info("飞书长连接状态", { status });
  }, 60_000);
  watchdog.unref?.();

  statusTimer = setTimeout(() => {
    if (stopped) return;
    try {
      log.info("飞书长连接状态", {
        status: typeof wsClient?.getConnectionStatus === "function" ? wsClient.getConnectionStatus() : "unknown",
      });
    } catch (error) {
      log.warn("读取飞书长连接状态失败", { error: String(error) });
    }
  }, 6_000);
  statusTimer.unref?.();
  log.info("飞书长连接已启动（WSClient）");

  return {
    stop() {
      stopped = true;
      clearTimeout(statusTimer);
      clearInterval(watchdog);
      try {
        wsClient?.close({ force: true });
      } catch (error) {
        log.warn("关闭飞书长连接失败", { error: String(error) });
      }
    },
  };
}
