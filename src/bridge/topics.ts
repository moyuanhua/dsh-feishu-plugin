/**
 * 话题 ↔ 会话映射的持久化（临时实现）。
 *
 * 注：按上游逻辑逐层搬运后，会话映射由 `src/bridge/session-map.ts` 的 5 层 key + 多会话列表承担；
 * 本模块是 M3a 阶段的单层临时实现，待 `src/index.ts` 接到 SessionMap 后删除。
 *
 * 上游用 `ctx.storage` 的 5 层前缀 key（`chat:<id>:sessions` / `thread:<tid>` / `root:<rootId>` …）；
 * dsh 的持久化接缝是 `ctx.storageDomain`（领域表，zod 校验记录），因此这里改成一张表：
 * `topics` 表，key = `chat:<chatId>` 或 `thread:<threadId>`，value = 一条 TopicRecord。
 *
 * 设计取舍：
 * - 只保留"当前会话"这一层（上游那套 `sessions[]` 多会话列表属于 GUI 交互增强，放到 M3b 的
 *   `/sessions` 命令再扩展，先用最小可用形状）；
 * - 读出的记录仍做一次形状校验 —— 存储域虽然有 zod，但我们的适配层可能拿到内存实现。
 */
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import type { Logger } from "../types.js";

export interface TopicRecord {
  /** dsh 会话 id（`feishu-<uuid>`）。 */
  readonly sessionId: string;
  /** 该会话的工作目录（绝对路径）。 */
  readonly cwd: string;
  /** 话题标题（取自首条消息）。 */
  readonly title: string;
  /** 飞书 chat id。 */
  readonly chatId: string;
  /** 话题 id（群话题场景才有）。 */
  readonly threadId?: string;
  /** 最近一次投递时间（ms epoch）。 */
  readonly updatedAt: number;
}

/**
 * 存储域声明：`topics` 一张表。
 *
 * 注意：`defineDomain` 在**模块加载时**就校验域名单表名（`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`，
 * 不含连字符）—— 写成 `feishu-topics` 会直接抛错让插件加载失败，所以是 `feishu_topics`。
 */
export const FEISHU_TOPICS_DOMAIN = defineDomain({
  name: "feishu_topics",
  version: 1,
  tables: {
    topics: domainTable(
      z.object({
        sessionId: z.string(),
        cwd: z.string(),
        title: z.string(),
        chatId: z.string(),
        threadId: z.string().optional(),
        updatedAt: z.number(),
      }),
    ),
  },
});

export interface TopicStore {
  get(key: string): TopicRecord | undefined;
  put(key: string, record: TopicRecord): Promise<void>;
  remove(key: string): Promise<void>;
  entries(): Array<[string, TopicRecord]>;
}

/** 内存实现：单测、以及宿主没有 storageDomain 服务时的降级（会告警）。 */
export class MemoryTopicStore implements TopicStore {
  private readonly data = new Map<string, TopicRecord>();

  get(key: string): TopicRecord | undefined {
    return this.data.get(key);
  }

  async put(key: string, record: TopicRecord): Promise<void> {
    this.data.set(key, record);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }

  entries(): Array<[string, TopicRecord]> {
    return [...this.data.entries()];
  }
}

/** 只声明我们用到的 storageDomain 形状，避免把宿主类型钉死。 */
export interface StorageDomainLike {
  open(spec: unknown): Promise<{
    table(name: string): {
      get(key: string): unknown;
      put(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
      entries(): IterableIterator<[string, unknown]>;
    };
    close(): void;
  }>;
}

function isTopicRecord(value: unknown): value is TopicRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    typeof record.cwd === "string" &&
    typeof record.title === "string" &&
    typeof record.chatId === "string" &&
    typeof record.updatedAt === "number"
  );
}

/** 打开域表并把它的表 API 适配成 TopicStore。 */
export async function openTopicStore(domain: StorageDomainLike, log: Logger): Promise<TopicStore> {
  const opened = await domain.open(FEISHU_TOPICS_DOMAIN);
  const table = opened.table("topics");
  return {
    get: (key) => {
      const raw = table.get(key);
      return isTopicRecord(raw) ? raw : undefined;
    },
    put: (key, record) => table.put(key, record),
    remove: async (key) => {
      await table.delete(key);
    },
    entries: () => {
      const out: Array<[string, TopicRecord]> = [];
      for (const [key, value] of table.entries()) {
        if (isTopicRecord(value)) out.push([key, value]);
      }
      return out;
    },
  };
}

/**
 * 映射 key 的选取（与上游路由语义一致）：
 * - 有 `threadId` → 话题维度（一个飞书话题 = 一个会话）；
 * - 否则 → chat 维度（单聊 = 一个会话）。
 */
export function topicKey(input: { readonly chatId: string; readonly threadId?: string }): string {
  return input.threadId ? `thread:${input.threadId}` : `chat:${input.chatId}`;
}
