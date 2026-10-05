/**
 * 入站附件规格。
 *
 * 纯逻辑语义来自上游 `feishu/attachments.ts`（MIT）：类型支持、文件名清洗、大小上限、超时、
 * 失败一律降级为占位文本而不阻断消息；存储接缝按 dsh 的附件服务重写。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  attachmentNotice,
  AttachmentTimeoutError,
  imageMediaTypeOf,
  ingestAttachments,
  isDownloadableResource,
  sanitizeAttachmentName,
  type AttachmentIngestDeps,
  type InboundResourceLike,
} from "../src/bridge/attachments.js";
import type { Logger } from "../src/types.js";

const LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const IMAGE: InboundResourceLike = { type: "image", fileKey: "fk_img", fileName: "shot.png" };
const FILE: InboundResourceLike = { type: "file", fileKey: "fk_file", fileName: "report.pdf" };

function deps(over: Partial<AttachmentIngestDeps> = {}): AttachmentIngestDeps {
  return {
    log: LOG,
    download: async () => ({ data: new Uint8Array([1, 2, 3]) }),
    admitImage: async (input) => ({ type: "image", admitted: true, mediaType: input.mediaType, name: input.name }),
    saveFile: async (input) => ({ id: "att_1", name: input.name }),
    maxBytes: 1024,
    timeoutMs: 1_000,
    ...over,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("纯辅助", () => {
  test("sanitizeAttachmentName：去分隔符/控制字符/前导点，限长 120，空则回退", () => {
    // 上游顺序：先替换分隔符 → 再去控制字符 → 最后剥掉前导点
expect(sanitizeAttachmentName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeAttachmentName("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(sanitizeAttachmentName("...hidden")).toBe("hidden");
    expect(sanitizeAttachmentName(undefined)).toBe("attachment");
    expect(sanitizeAttachmentName("x".repeat(200)).length).toBe(120);
  });

  test("imageMediaTypeOf：按后缀识别图片，未知返回 undefined", () => {
    expect(imageMediaTypeOf("a.PNG")).toBe("image/png");
    expect(imageMediaTypeOf("a.jpeg")).toBe("image/jpeg");
    expect(imageMediaTypeOf("a.webp")).toBe("image/webp");
    expect(imageMediaTypeOf("a.txt")).toBeUndefined();
    expect(imageMediaTypeOf("noext")).toBeUndefined();
  });

  test("isDownloadableResource：只有 image/file", () => {
    expect(isDownloadableResource("image")).toBe(true);
    expect(isDownloadableResource("file")).toBe(true);
    expect(isDownloadableResource("audio")).toBe(false);
    expect(isDownloadableResource("sticker")).toBe(false);
  });
});

describe("ingestAttachments", () => {
  test("图片：媒体类型来自响应头 → admitImage → 产出部件", async () => {
    const calls: unknown[] = [];
    const results = await ingestAttachments("om_1", [IMAGE], {
      ...deps(),
      download: async () => ({ data: new Uint8Array([1, 2, 3, 4]), mediaType: "image/png" }),
      admitImage: async (input) => {
        calls.push(input);
        return { type: "image", admitted: true };
      },
    });
    expect(results).toEqual([
      { ok: true, kind: "image", name: "shot.png", size: 4, part: { type: "image", admitted: true } },
    ]);
    expect(calls).toEqual([{ data: new Uint8Array([1, 2, 3, 4]), mediaType: "image/png", name: "shot.png" }]);
  });

  test("图片：无响应头时按后缀推断", async () => {
    const results = await ingestAttachments("om_1", [IMAGE], deps());
    expect(results[0]).toMatchObject({ ok: true, kind: "image" });
  });

  test("文件：saveFile → 产出 {type:'file', attachment}", async () => {
    const results = await ingestAttachments("om_1", [FILE], deps());
    expect(results).toEqual([
      {
        ok: true,
        kind: "file",
        name: "report.pdf",
        size: 3,
        part: { type: "file", attachment: { id: "att_1", name: "report.pdf" } },
      },
    ]);
  });

  test("不支持的类型 → 占位说明（不下载）", async () => {
    let downloads = 0;
    const results = await ingestAttachments("om_1", [{ type: "audio", fileKey: "fk", fileName: "v.m4a" }], {
      ...deps(),
      download: async () => {
        downloads += 1;
        return { data: new Uint8Array() };
      },
    });
    expect(downloads).toBe(0);
    expect(results[0]).toMatchObject({ ok: false, kind: "unsupported", name: "v.m4a" });
  });

  test("超限 → 丢弃并给出原因", async () => {
    const results = await ingestAttachments("om_1", [FILE], {
      ...deps(),
      download: async () => ({ data: new Uint8Array(2048) }),
    });
    expect(results[0]).toMatchObject({ ok: false, kind: "file" });
    expect((results[0] as { reason: string }).reason).toContain("超过上限");
  });

  test("下载超时 → 降级（不抛）", async () => {
    // 注意：假定时器下必须先发起、再推进时间，最后 await（否则会死等）。
    const pending = ingestAttachments("om_1", [IMAGE], {
      ...deps(),
      timeoutMs: 100,
      download: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(200);
    const results = await pending;
    expect(results[0]).toMatchObject({ ok: false, kind: "image" });
    expect((results[0] as { reason: string }).reason).toContain("下载超时");
  });

  test("下载抛错 → 降级并带失败原因", async () => {
    const results = await ingestAttachments("om_1", [IMAGE], {
      ...deps(),
      download: async () => {
        throw new Error("403 forbidden");
      },
    });
    expect((results[0] as { reason: string }).reason).toContain("403 forbidden");
  });

  test("不支持的图片类型（如 bmp）→ 降级", async () => {
    const results = await ingestAttachments("om_1", [{ ...IMAGE, fileName: "a.bmp" }], deps());
    expect(results[0]).toMatchObject({ ok: false, kind: "image" });
    expect((results[0] as { reason: string }).reason).toContain("不支持的图片类型");
  });

  test("入库失败 → 降级（不阻断整条消息）", async () => {
    const results = await ingestAttachments("om_1", [IMAGE, FILE], {
      ...deps(),
      admitImage: async () => {
        throw new Error("disk full");
      },
    });
    expect(results[0]).toMatchObject({ ok: false, kind: "image" });
    expect(results[1]).toMatchObject({ ok: true, kind: "file" });
  });
});

describe("attachmentNotice", () => {
  test("全成功 → undefined（不加噪音）", async () => {
    expect(attachmentNotice(await ingestAttachments("om_1", [FILE], deps()))).toBeUndefined();
  });

  test("有失败 → 逐条列出名称与原因", async () => {
    const results = await ingestAttachments("om_1", [{ type: "audio", fileKey: "fk", fileName: "v.m4a" }], deps());
    const notice = attachmentNotice(results);
    expect(notice).toContain("v.m4a");
    expect(notice).toContain("暂不支持 audio 类型");
  });
});

describe("AttachmentTimeoutError", () => {
  test("名字与消息稳定（日志区分超时与其它失败）", () => {
    const error = new AttachmentTimeoutError();
    expect(error.name).toBe("AttachmentTimeoutError");
    expect(error.message).toBe("attachment-timeout");
  });
});
