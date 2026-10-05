/**
 * `ctx.sessionQuery` 适配器 —— **会话列表与标题的唯一权威来源**。
 *
 * 为什么不再自己维护清单：上游把 `{sessionID,title,updatedAt}` 抄进自己的 KV，
 * 还要跟宿主对账（`session-list.ts` 甚至有三级回退：插件 API → HTTP → 本地镜像）。
 * DSH 的 `ctx.sessionQuery` 本身就是"全量逻辑语料 + 日志折叠出来的标题"，
 * 所以镜像不但多余，而且**注定漂移**。
 *
 * 可用性：`dsh-base` 用 `session-query-sqlite` 且 `openAt: never`。官方说明是
 * 「`openAt: never` keeps `ctx.sessionQuery` mounted — exact reads, titles, and
 * lineage traces stay available — while search calls fail」。因此本模块
 * **只用精确读取**（`listSessions` / `readTitle*`），**绝不碰 `searchSessions`**。
 *
 * 服务缺失（精简部署）时全部降级为空结果，并记一条 warn —— 会话列表变成空，
 * 但插件其余功能照常。
 */
import type { Context } from "@deepseek-ai/cordis";
import { errorMessage } from "../logger.js";
import type { Logger } from "../types.js";

/** 宿主返回的会话记录（只声明我们用到的字段）。 */
export interface HostSessionRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly origin?: string;
}

/** 宿主会话查询端口（可在没有 dsh 的环境里替换为假实现）。 */
export interface HostSessionQuery {
  /** 全量会话（宿主已是 newest-first；顺序不保证时由调用方再排）。 */
  list(): Promise<readonly HostSessionRecord[]>;
  /** 批量取标题（一次观察）；失败或缺失的会话不出现在结果里。 */
  titles(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** 单个会话是否存在（`/resume` 探活用）。 */
  exists(id: string): Promise<boolean>;
}

/** 一个都不返回的空实现（服务缺失时用）。 */
export const EMPTY_SESSION_QUERY: HostSessionQuery = {
  list: async () => [],
  titles: async () => new Map(),
  exists: async () => false,
};

interface RawRecord {
  readonly header?: {
    readonly id?: unknown;
    readonly createdAt?: unknown;
    readonly cwd?: unknown;
    readonly parentSession?: unknown;
    readonly origin?: unknown;
  };
}

function toRecord(raw: unknown): HostSessionRecord | undefined {
  const header = (raw as RawRecord | undefined)?.header;
  const id = header?.id;
  if (typeof id !== "string" || !id) return undefined;
  const createdAt = typeof header?.createdAt === "number" ? header.createdAt : 0;
  const cwd = typeof header?.cwd === "string" && header.cwd ? header.cwd : undefined;
  const parentSession =
    typeof header?.parentSession === "string" && header.parentSession ? header.parentSession : undefined;
  const origin = typeof header?.origin === "string" && header.origin ? header.origin : undefined;
  return {
    id,
    createdAt,
    ...(cwd ? { cwd } : {}),
    ...(parentSession ? { parentSession } : {}),
    ...(origin ? { origin } : {}),
  };
}

/** `readTitleSnapshots` 的结果项形状。 */
interface RawTitleResult {
  readonly sessionId?: unknown;
  readonly status?: unknown;
  readonly value?: { readonly title?: { readonly title?: unknown } | undefined };
}

/** 探测 `ctx.sessionQuery`，返回端口。服务不在时返回空实现。 */
export function createHostSessionQuery(ctx: Context, log: Logger): HostSessionQuery {
  let service:
    | {
        listSessions?: (signal?: AbortSignal) => Promise<unknown>;
        readTitleSnapshots?: (ids: readonly string[], signal?: AbortSignal) => Promise<unknown>;
        readTitle?: (id: string, signal?: AbortSignal) => Promise<unknown>;
        observeSession?: (id: string, options?: unknown) => Promise<unknown>;
      }
    | undefined;

  // 可选服务：`ctx.inject` 的回调在服务就绪后才执行，因此不假设加载顺序。
  ctx.inject(["sessionQuery"], (sub) => {
    service = (sub as unknown as { sessionQuery?: typeof service }).sessionQuery;
  });

  const resolve = () => service ?? (ctx.get("sessionQuery") as typeof service | undefined);

  return {
    list: async () => {
      const query = resolve()?.listSessions;
      if (typeof query !== "function") {
        log.warn("sessionQuery 不可用，会话列表将为空");
        return [];
      }
      try {
        const raw = await query.call(resolve());
        if (!Array.isArray(raw)) return [];
        return raw.map(toRecord).filter((r): r is HostSessionRecord => r !== undefined);
      } catch (error) {
        log.warn("列举会话失败", { reason: errorMessage(error) });
        return [];
      }
    },

    titles: async (ids) => {
      const out = new Map<string, string>();
      if (ids.length === 0) return out;
      const query = resolve()?.readTitleSnapshots;
      if (typeof query !== "function") return out;
      try {
        const raw = await query.call(resolve(), ids);
        if (!Array.isArray(raw)) return out;
        for (const item of raw as readonly RawTitleResult[]) {
          if (item?.status !== "fulfilled") continue;
          const id = typeof item.sessionId === "string" ? item.sessionId : "";
          const title = item.value?.title?.title;
          if (id && typeof title === "string" && title.trim()) out.set(id, title.trim());
        }
        return out;
      } catch (error) {
        log.warn("批量读取会话标题失败（不影响列表本身）", { reason: errorMessage(error) });
        return out;
      }
    },

    exists: async (id) => {
      // 优先用精确读取探活；`readTitle` 对不存在的会话返回 undefined 而不是抛。
      const query = resolve()?.readTitle;
      if (typeof query === "function") {
        try {
          return (await query.call(resolve(), id)) !== undefined;
        } catch (error) {
          log.debug("读取会话标题失败，改用 observeSession 探活", { id, reason: errorMessage(error) });
        }
      }
      const observe = resolve()?.observeSession;
      if (typeof observe !== "function") return false;
      try {
        const lease = (await observe.call(resolve(), id, { projectionMode: "none" })) as
          | { dispose?: () => void }
          | undefined;
        lease?.dispose?.();
        return lease !== undefined;
      } catch {
        return false;
      }
    },
  };
}
