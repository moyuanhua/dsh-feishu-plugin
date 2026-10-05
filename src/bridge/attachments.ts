/**
 * 入站附件（图片 / 文件）接收。
 *
 * **逻辑来源**：opencode-feishu-plugin `src/feishu/attachments.ts`（MIT，Copyright (c) 2026 moyuanhua）
 * 的**纯语义**：可支持类型、文件名清洗、单附件大小上限、下载超时、
 * 失败/不支持类型一律**降级为占位文本而不阻断消息**（用户仍能得到反馈）。
 *
 * **与上游的差别（存储接缝不同）**：上游把字节落盘到会话目录（`.opencode/temp/...`）并用
 * `file://` URI 交给 prompt，因此需要 `resolveAttachmentDir` 与 `.gitignore`；
 * dsh 有内容寻址的附件服务 —— 图片走 `ctx.attachments.admitPromptContent()` 换成持久引用、
 * 文件走 `saveFile()`，所以本模块不碰文件系统，只负责"下载 → 校验 → 交给附件服务 → 产出 prompt 部件"。
 *
 * 需要应用开通 **`im:message:readonly`**（消息资源下载接口要求）；未开通/下载失败只降级。
 */
import { errorMessage } from "../logger.js";
import type { Logger } from "../types.js";

/** 可下载的资源类型（其它类型如 audio/video/sticker 只给占位说明）。 */
const DOWNLOADABLE = new Set(["image", "file"]);

/** dsh 附件服务接受的图片媒体类型（其余一律降级为文本说明）。 */
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface InboundResourceLike {
  readonly type: string;
  readonly fileKey: string;
  readonly fileName?: string;
}

/** 下载结果：字节 + 可选媒体类型（来自响应头；缺省时按文件名后缀推断）。 */
export interface DownloadedResource {
  readonly data: Uint8Array;
  readonly mediaType?: string;
}

export interface AttachmentIngestDeps {
  readonly log: Logger;
  /** 从飞书下载一条消息资源（SDK 的 `downloadResource` / `downloadResourceWithMeta`）。 */
  readonly download: (input: {
    readonly messageId: string;
    readonly fileKey: string;
    readonly type: string;
  }) => Promise<DownloadedResource>;
  /** 图片：交给附件服务换成持久引用（真实实现 = `ctx.attachments.admitPromptContent`）。 */
  readonly admitImage: (input: {
    readonly data: Uint8Array;
    readonly mediaType: string;
    readonly name?: string;
  }) => Promise<unknown>;
  /** 文件：逐字节持久化（真实实现 = `ctx.attachments.saveFile`）。 */
  readonly saveFile: (input: { readonly data: Uint8Array; readonly name?: string }) => Promise<unknown>;
  /** 单附件上限（字节）。 */
  readonly maxBytes: number;
  /** 单附件下载超时（ms）。 */
  readonly timeoutMs: number;
}

export type IngestedAttachment =
  | {
      readonly ok: true;
      readonly kind: "image" | "file";
      readonly name: string;
      readonly size: number;
      /** prompt 部件（图片 = admitted 后的部件；文件 = `{type:'file', attachment}`）。 */
      readonly part: unknown;
    }
  | {
      readonly ok: false;
      readonly kind: "image" | "file" | "unsupported";
      readonly name: string;
      readonly reason: string;
    };

/** 超时哨兵错误，便于日志区分「超时」与「其它失败」（上游同名）。 */
export class AttachmentTimeoutError extends Error {
  constructor() {
    super("attachment-timeout");
    this.name = "AttachmentTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AttachmentTimeoutError()), Math.max(1, ms));
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 文件名清洗：去掉路径分隔符 / 控制字符 / 前导点，限长 120；
 * 清洗后为空则回退 `fallback`（逐行搬运上游 `sanitizeAttachmentName`）。
 */
export function sanitizeAttachmentName(raw: string | undefined, fallback = "attachment"): string {
  const base = (raw ?? "").trim();
  const cleaned = base
    .replace(/[\\/]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || fallback;
}

const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 按文件名后缀推断图片媒体类型；非图片/未知后缀返回 undefined。 */
export function imageMediaTypeOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return undefined;
  return MEDIA_TYPE_BY_EXT[name.slice(dot).toLowerCase()];
}

export function isDownloadableResource(type: string): boolean {
  return DOWNLOADABLE.has(type);
}

/**
 * 接收一条消息的全部附件。
 *
 * 单条失败**只影响该条**（降级为占位文本），不阻断消息投递 —— 与上游一致。
 */
export async function ingestAttachments(
  messageId: string,
  resources: readonly InboundResourceLike[],
  deps: AttachmentIngestDeps,
): Promise<IngestedAttachment[]> {
  const out: IngestedAttachment[] = [];
  for (const resource of resources) {
    const name = sanitizeAttachmentName(resource.fileName, `feishu-${resource.type}`);
    if (!isDownloadableResource(resource.type)) {
      out.push({ ok: false, kind: "unsupported", name, reason: `暂不支持 ${resource.type} 类型` });
      continue;
    }

    let downloaded: DownloadedResource;
    try {
      downloaded = await withTimeout(
        deps.download({ messageId, fileKey: resource.fileKey, type: resource.type }),
        deps.timeoutMs,
      );
    } catch (error) {
      const reason =
        error instanceof AttachmentTimeoutError ? "下载超时" : `下载失败：${errorMessage(error)}`;
      deps.log.warn("附件下载失败，降级为占位说明", { name, type: resource.type, reason });
      out.push({ ok: false, kind: resource.type === "image" ? "image" : "file", name, reason });
      continue;
    }

    if (downloaded.data.byteLength > deps.maxBytes) {
      const reason = `超过上限（${downloaded.data.byteLength} > ${deps.maxBytes} 字节）`;
      deps.log.warn("附件超限，已丢弃", { name, reason });
      out.push({ ok: false, kind: resource.type === "image" ? "image" : "file", name, reason });
      continue;
    }

    try {
      if (resource.type === "image") {
        const mediaType = downloaded.mediaType ?? imageMediaTypeOf(name);
        if (!mediaType || !IMAGE_MEDIA_TYPES.has(mediaType)) {
          const reason = `不支持的图片类型 ${mediaType ?? "（未知）"}`;
          deps.log.warn("图片类型不受支持，降级为占位说明", { name, reason });
          out.push({ ok: false, kind: "image", name, reason });
          continue;
        }
        const part = await deps.admitImage({ data: downloaded.data, mediaType, name });
        out.push({ ok: true, kind: "image", name, size: downloaded.data.byteLength, part });
      } else {
        const ref = await deps.saveFile({ data: downloaded.data, name });
        out.push({
          ok: true,
          kind: "file",
          name,
          size: downloaded.data.byteLength,
          part: { type: "file", attachment: ref },
        });
      }
    } catch (error) {
      const reason = `附件入库失败：${errorMessage(error)}`;
      deps.log.warn("附件入库失败，降级为占位说明", { name, reason });
      out.push({ ok: false, kind: resource.type === "image" ? "image" : "file", name, reason });
    }
  }
  return out;
}

/**
 * 生成降级占位文本：把失败/不支持的附件告诉模型与用户（上游"降级为纯占位文本 + 失败原因"）。
 * 全部成功时返回 undefined（不往消息里塞噪音）。
 */
export function attachmentNotice(results: readonly IngestedAttachment[]): string | undefined {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return undefined;
  return failed
    .map((result) => `⚠️ 附件「${(result as Extract<IngestedAttachment, { ok: false }>).name}」未接收：${(result as Extract<IngestedAttachment, { ok: false }>).reason}`)
    .join("\n");
}
