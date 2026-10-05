import { describe, expect, test } from "vitest";
import { ConnectionSupervisor, type ConnectionState } from "../src/feishu/connection.js";

/** 手动推进的定时器：记录延迟、只保留最后一个待触发回调。 */
function manualTimer() {
  let pending: (() => void) | undefined;
  const delays: number[] = [];
  let cancelled = 0;
  return {
    delays,
    setTimer: (callback: () => void, delayMs: number) => {
      delays.push(delayMs);
      pending = callback;
      return {
        cancel: () => {
          cancelled += 1;
          pending = undefined;
        },
      };
    },
    get cancelledCount() {
      return cancelled;
    },
    get hasPending() {
      return pending !== undefined;
    },
    async fire(): Promise<void> {
      const callback = pending;
      pending = undefined;
      callback?.();
      await flush();
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

interface Harness {
  supervisor: ConnectionSupervisor;
  timer: ReturnType<typeof manualTimer>;
  states: ConnectionState[];
  connects: () => number;
  disconnects: () => number;
}

function harness(options: {
  connect: () => Promise<void>;
  backoff?: { initialMs?: number; maxMs?: number; factor?: number; maxAttempts?: number };
}): Harness {
  const timer = manualTimer();
  const states: ConnectionState[] = [];
  let connects = 0;
  let disconnects = 0;
  const supervisor = new ConnectionSupervisor({
    connect: () => {
      connects += 1;
      return options.connect();
    },
    disconnect: async () => {
      disconnects += 1;
    },
    onState: (state) => states.push(state),
    setTimer: timer.setTimer,
    ...(options.backoff ? { backoff: options.backoff } : {}),
  });
  return {
    supervisor,
    timer,
    states,
    connects: () => connects,
    disconnects: () => disconnects,
  };
}

describe("ConnectionSupervisor", () => {
  test("首次连接成功 → connected，且不再重试", async () => {
    const h = harness({ connect: async () => {} });
    h.supervisor.start();
    await flush();
    expect(h.supervisor.state).toBe("connected");
    expect(h.connects()).toBe(1);
    expect(h.timer.delays).toEqual([]);
  });

  test("失败按指数退避重试，成功后预算清零", async () => {
    let failures = 2;
    const h = harness({
      connect: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("connect failed");
        }
      },
      backoff: { initialMs: 500, factor: 2, maxMs: 30_000, maxAttempts: 10 },
    });
    h.supervisor.start();
    await flush();
    expect(h.supervisor.state).toBe("backoff");
    expect(h.timer.delays).toEqual([500]);

    await h.timer.fire();
    expect(h.supervisor.state).toBe("backoff");
    expect(h.timer.delays).toEqual([500, 1000]);

    await h.timer.fire();
    expect(h.supervisor.state).toBe("connected");
    expect(h.supervisor.attemptCount).toBe(0);
    expect(h.connects()).toBe(3);
  });

  test("重试预算耗尽 → failed 并停止（不再调度）", async () => {
    const h = harness({
      connect: async () => {
        throw new Error("always down");
      },
      backoff: { initialMs: 100, factor: 2, maxAttempts: 2 },
    });
    h.supervisor.start();
    await flush();
    await h.timer.fire();
    await flush();
    expect(h.supervisor.state).toBe("backoff");
    await h.timer.fire();
    expect(h.supervisor.state).toBe("failed");
    expect(h.timer.hasPending).toBe(false);
    expect(h.connects()).toBe(3);
  });

  test("stop() 取消待触发定时器、断开连接，并丢弃过期尝试的结果", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      connect: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    h.supervisor.start();
    await flush();
    expect(h.supervisor.state).toBe("connecting");

    const stopped = h.supervisor.stop();
    release?.();
    await stopped;
    await flush();

    expect(h.supervisor.state).toBe("stopped");
    expect(h.disconnects()).toBe(1);
    expect(h.timer.cancelledCount).toBeGreaterThanOrEqual(0);
  });

  test("stop() 之后的重连/重连完成事件不再改状态", async () => {
    const h = harness({ connect: async () => {} });
    h.supervisor.start();
    await flush();
    await h.supervisor.stop();
    h.supervisor.noteReconnecting();
    h.supervisor.noteReconnected();
    expect(h.supervisor.state).toBe("stopped");
  });

  test("SDK 的 reconnecting/reconnected 事件映射：重连成功后预算清零", async () => {
    const h = harness({ connect: async () => {} });
    h.supervisor.start();
    await flush();
    h.supervisor.noteReconnecting();
    expect(h.supervisor.state).toBe("reconnecting");
    h.supervisor.noteReconnected();
    expect(h.supervisor.state).toBe("connected");
    expect(h.supervisor.attemptCount).toBe(0);
  });

  test("start() 幂等：重复调用不会叠加连接", async () => {
    const h = harness({ connect: async () => {} });
    h.supervisor.start();
    h.supervisor.start();
    await flush();
    expect(h.connects()).toBe(1);
  });
});
