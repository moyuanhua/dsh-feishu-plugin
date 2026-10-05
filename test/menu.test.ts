/**
 * 机器人自定义菜单规格。
 *
 * 缺陷 5 的回归：旧实现没有注册 `application.bot.menu_v6`，
 * 用户点菜单按钮**毫无反应**（日志里只有 `no application.bot.menu_v6 handle`）。
 * 现在菜单 key 会被合成等价命令，走与文本完全相同的管线。
 */
import { describe, expect, test } from "vitest";
import { BOT_MENU_EVENT, isKnownMenuCommand, parseBotMenuEvent } from "../src/bridge/menu.js";

/** 飞书 `application.bot.menu_v6` 的真实信封形状。 */
function menuPayload(eventKey: string, openId = "ou_owner"): unknown {
  return {
    schema: "2.0",
    header: { event_id: "evt_1", event_type: BOT_MENU_EVENT, create_time: "1700000000000" },
    event: {
      operator: { operator_id: { open_id: openId, union_id: "on_1", user_id: "u_1" } },
      event_key: eventKey,
      timestamp: 1_700_000_000,
    },
  };
}

describe("parseBotMenuEvent", () => {
  test("new / sessions 两个 key 合成为等价命令", () => {
    expect(parseBotMenuEvent(menuPayload("new"))).toEqual({
      openId: "ou_owner",
      eventKey: "new",
      command: "/new",
    });
    expect(parseBotMenuEvent(menuPayload("sessions"))).toEqual({
      openId: "ou_owner",
      eventKey: "sessions",
      command: "/sessions",
    });
  });

  test("key 大小写与 / 前缀都容忍（上游同）", () => {
    expect(parseBotMenuEvent(menuPayload("NEW"))?.command).toBe("/new");
    expect(parseBotMenuEvent(menuPayload("/new"))?.command).toBe("/new");
    expect(parseBotMenuEvent(menuPayload("ls"))?.command).toBe("/sessions");
  });

  test("未知 key 静默忽略（返回 undefined，调用方不打错误日志）", () => {
    expect(parseBotMenuEvent(menuPayload("something-else"))).toBeUndefined();
    expect(parseBotMenuEvent(menuPayload(""))).toBeUndefined();
  });

  test("形状不对时返回 undefined，不抛异常", () => {
    expect(parseBotMenuEvent(undefined)).toBeUndefined();
    expect(parseBotMenuEvent(null)).toBeUndefined();
    expect(parseBotMenuEvent("nope")).toBeUndefined();
    expect(parseBotMenuEvent({})).toBeUndefined();
    expect(parseBotMenuEvent({ event: {} })).toBeUndefined();
  });

  test("拿不到 open_id 时返回 undefined（白名单无法校验就不处理）", () => {
    expect(
      parseBotMenuEvent({ event: { event_key: "new", operator: { operator_id: {} } } }),
    ).toBeUndefined();
    expect(parseBotMenuEvent({ event: { event_key: "new" } })).toBeUndefined();
  });

  test("兼容 event 在顶层（非信封）与 camelCase 字段", () => {
    expect(parseBotMenuEvent({ event_key: "new", operator: { operator_id: { open_id: "ou_x" } } })).toEqual({
      openId: "ou_x",
      eventKey: "new",
      command: "/new",
    });
    expect(parseBotMenuEvent({ eventKey: "sessions", operator: { operatorId: { openId: "ou_y" } } })).toEqual({
      openId: "ou_y",
      eventKey: "sessions",
      command: "/sessions",
    });
  });
});

describe("isKnownMenuCommand", () => {
  test("菜单表里的命令都被命令解析器认识（防两张表不同步）", () => {
    expect(isKnownMenuCommand("/new")).toBe(true);
    expect(isKnownMenuCommand("/sessions")).toBe(true);
    expect(isKnownMenuCommand("/definitely-not-a-command")).toBe(false);
  });
});
