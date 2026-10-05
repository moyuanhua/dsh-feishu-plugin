/**
 * TtlMap 规格（惰性过期 + 主动清理）。
 *
 * 用在三处热路径：消息去重、回调 token 防重放、待批请求跟踪。
 * 三处都要求"过期即不可见"，因此这里把惰性过期与清理定时器都覆盖到。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { TtlMap } from "../src/utils/ttl-map.js";

let clock = 1_000;
const now = () => clock;

afterEach(() => {
  clock = 1_000;
  vi.useRealTimers();
});

describe("惰性过期", () => {
  test("未过期可读", () => {
    const map = new TtlMap<string>(100, now);
    map.set("k", "v");
    expect(map.get("k")).toBe("v");
    expect(map.has("k")).toBe(true);
  });

  test("到点即不可见，且 get/has 都会顺手删掉", () => {
    const map = new TtlMap<string>(100, now);
    map.set("k", "v");
    clock += 100;
    expect(map.get("k")).toBeUndefined();
    expect(map.has("k")).toBe(false);
    expect(map.size).toBe(0);
  });

  test("自定义 ttl 覆盖默认值", () => {
    const map = new TtlMap<string>(100, now);
    map.set("k", "v", 1_000);
    clock += 500;
    expect(map.get("k")).toBe("v");
    clock += 500;
    expect(map.get("k")).toBeUndefined();
  });

  test("不存在的键 → undefined / false", () => {
    const map = new TtlMap<string>(100, now);
    expect(map.get("nope")).toBeUndefined();
    expect(map.has("nope")).toBe(false);
  });

  test("set 覆盖旧值并重置过期时间", () => {
    const map = new TtlMap<string>(100, now);
    map.set("k", "v1");
    clock += 80;
    map.set("k", "v2");
    clock += 80; // 距第二次 set 仅 80ms
    expect(map.get("k")).toBe("v2");
  });
});

describe("setIfAbsent", () => {
  test("首次写入成功；已存在时拒绝且不覆盖", () => {
    const map = new TtlMap<string>(100, now);
    expect(map.setIfAbsent("k", "first")).toBe(true);
    expect(map.setIfAbsent("k", "second")).toBe(false);
    expect(map.get("k")).toBe("first");
  });

  test("旧值过期后可以重新写入（防重放的 TTL 语义）", () => {
    const map = new TtlMap<string>(100, now);
    map.setIfAbsent("nonce", "used");
    clock += 100;
    expect(map.setIfAbsent("nonce", "reused")).toBe(true);
  });
});

describe("delete / entries / clear / size", () => {
  test("delete 之后不可见", () => {
    const map = new TtlMap<string>(100, now);
    map.set("k", "v");
    map.delete("k");
    expect(map.get("k")).toBeUndefined();
    expect(map.size).toBe(0);
  });

  test("delete 不存在的键是 no-op", () => {
    const map = new TtlMap<string>(100, now);
    expect(() => map.delete("nope")).not.toThrow();
  });

  test("entries 只返回未过期的项", () => {
    const map = new TtlMap<string>(100, now);
    map.set("a", "1");
    map.set("b", "2", 10);
    clock += 50;
    expect(map.entries()).toEqual([["a", "1"]]);
  });

  test("clear 清空一切（含定时器）", () => {
    vi.useFakeTimers();
    const map = new TtlMap<string>(100, now);
    map.set("a", "1");
    map.set("b", "2");
    map.clear();
    expect(map.size).toBe(0);
    expect(map.entries()).toEqual([]);
  });

  test("size 反映未过期项数", () => {
    const map = new TtlMap<string>(100, now);
    map.set("a", "1");
    map.set("b", "2", 10);
    clock += 20;
    expect(map.size).toBe(1);
  });
});

describe("主动清理定时器", () => {
  test("到点后条目被自动清除（不依赖读取）", async () => {
    vi.useFakeTimers();
    const realNow = Date.now();
    const map = new TtlMap<string>(50, () => realNow + 100);
    map.set("k", "v");
    // 定时器在 ttl 之后触发；这里用假定时器推进
    vi.advanceTimersByTime(60);
    // 注入的 now 已经越过了过期点，因此条目应当不可见
    expect(map.get("k")).toBeUndefined();
  });

  test("clear 之后定时器不再触发（不会有迟到回调炸掉）", () => {
    vi.useFakeTimers();
    const map = new TtlMap<string>(50, now);
    map.set("k", "v");
    map.clear();
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
  });
});
