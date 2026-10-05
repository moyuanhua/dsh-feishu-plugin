/**
 * 把 dsh 的 `ctx.storageDomain` 适配成上游 `SessionMap` 需要的 KV 端口。
 *
 * 上游用 `ctx.storage.get/set/remove` 的一层 KV 命名空间（6 个 key 前缀，见 `session-map.ts`）；
 * dsh 的持久化接缝是**领域表**（`defineDomain` + `domainTable`，记录在持久化边界用 zod 校验）。
 * 因此这里声明一张 `kv` 表（key = 上游的前缀 key，value = 任意 JSON），
 * 让上游那套 key 布局与解析逻辑**原封不动**地跑在 dsh 上。
 *
 * 域名单必须是 snake_case（`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`，含连字符会在模块加载时抛错）。
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import type { Logger, StorageLike } from "../types.js";

/** 领域声明：一张 KV 表，承载会话映射的全部 key 层。 */
export const FEISHU_KV_DOMAIN = defineDomain({
  name: "feishu_bridge",
  version: 1,
  tables: {
    // 值形状因 key 层而异（会话记录 / 话题映射 / 根消息 / 反向索引），
    // 因此表级 schema 放行任意 JSON，由 session-map 的解析函数做逐层容错校验。
    kv: domainTable(z.unknown()),
  },
});

interface OpenedTable {
  get(key: string): unknown;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  entries(): IterableIterator<[string, unknown]>;
}

interface OpenedDomain {
  table(name: string): OpenedTable;
  close(): void;
}

/** 只声明我们用到的 storageDomain 形状，避免把宿主类型钉死。 */
export interface StorageDomainLike {
  open(spec: unknown): Promise<OpenedDomain>;
}

/** 域表支撑的 KV：额外暴露 `close()`（由调用方的 `ctx.effect` 释放）与 `entries()`（诊断用）。 */
export interface DomainKv extends StorageLike {
  readonly close: () => void;
  entries(): Array<[string, unknown]>;
}

/** 打开域表并适配成 KV 端口。打开失败由调用方决定是否降级到内存实现。 */
export async function openDomainKv(domain: StorageDomainLike, log: Logger): Promise<DomainKv> {
  const opened = await domain.open(FEISHU_KV_DOMAIN);
  const table = opened.table("kv");
  log.debug("会话映射域表已打开", { domain: FEISHU_KV_DOMAIN.name, version: FEISHU_KV_DOMAIN.version });
  return {
    get: (key) => table.get(key),
    set: (key, value) => table.put(key, value),
    remove: async (key) => {
      await table.delete(key);
    },
    entries: () => [...table.entries()],
    close: () => opened.close(),
  };
}
