/** Thin Feishu message sender: create/reply/patch cards and files. */
import { str } from "../utils.js";

export function describeLarkError(error) {
  const base = error instanceof Error ? error.message : String(error);
  const data = error?.response?.data;
  if (data && typeof data === "object") {
    const parts = [];
    if (data.code !== undefined) parts.push(`code=${String(data.code)}`);
    if (typeof data.msg === "string") parts.push(`msg=${data.msg}`);
    if (typeof data.error?.message === "string") parts.push(`detail=${data.error.message}`);
    if (parts.length) return `${base} [${parts.join(" ")}]`;
  }
  return base;
}

function ok(res) {
  return !res?.code || res.code === 0;
}

export function createSender(client, log) {
  return {
    async sendCard(chatId, card) {
      if (!chatId) return { ok: false, error: "missing chatId" };
      try {
        const res = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return res?.data?.message_id
          ? { ok: true, messageId: res.data.message_id }
          : { ok: false, error: "missing message_id" };
      } catch (error) {
        log.warn("发送卡片失败", { chatId, error: describeLarkError(error) });
        return { ok: false, error: describeLarkError(error) };
      }
    },

    async replyCard(messageId, card, options = {}) {
      if (!messageId) return { ok: false, error: "missing messageId" };
      try {
        const res = await client.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "interactive",
            content: JSON.stringify(card),
            ...(options.replyInThread ? { reply_in_thread: true } : {}),
          },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        const newId = res?.data?.message_id;
        return newId
          ? {
              ok: true,
              messageId: newId,
              ...(res.data.thread_id ? { threadId: res.data.thread_id } : {}),
              ...(res.data.root_id ? { rootId: res.data.root_id } : {}),
            }
          : { ok: false, error: "missing message_id" };
      } catch (error) {
        log.warn("回复卡片失败", { messageId, error: describeLarkError(error) });
        return { ok: false, error: describeLarkError(error) };
      }
    },

    async recallMessage(messageId) {
      if (!messageId) return { ok: false, error: "missing messageId" };
      try {
        const res = await client.im.message.delete({ path: { message_id: messageId } });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describeLarkError(error) };
      }
    },

    async patchCard(messageId, card) {
      if (!messageId) return { ok: false, error: "missing messageId" };
      try {
        const res = await client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(card) },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return { ok: true };
      } catch (error) {
        log.debug("更新卡片失败", { messageId, error: describeLarkError(error) });
        return { ok: false, error: describeLarkError(error) };
      }
    },

    async sendText(chatId, text) {
      if (!chatId) return { ok: false, error: "missing chatId" };
      try {
        const res = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return { ok: true, messageId: res?.data?.message_id };
      } catch (error) {
        return { ok: false, error: describeLarkError(error) };
      }
    },

    async replyText(messageId, text, options = {}) {
      if (!messageId) return { ok: false, error: "missing messageId" };
      try {
        const res = await client.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "text",
            content: JSON.stringify({ text }),
            ...(options.replyInThread ? { reply_in_thread: true } : {}),
          },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return {
          ok: true,
          messageId: res?.data?.message_id,
          ...(res?.data?.thread_id ? { threadId: res.data.thread_id } : {}),
        };
      } catch (error) {
        return { ok: false, error: describeLarkError(error) };
      }
    },

    async getMessageMeta(messageId) {
      if (!messageId) return undefined;
      try {
        const res = await client.im.message.get({ path: { message_id: messageId } });
        if (!ok(res)) return undefined;
        const item = res?.data?.items?.[0];
        if (!item) return undefined;
        return {
          threadId: str(item.thread_id) || undefined,
          rootId: str(item.root_id) || undefined,
          parentId: str(item.parent_id) || undefined,
        };
      } catch {
        return undefined;
      }
    },

    async sendFile(chatId, fileName, bytes, replyToMessageId) {
      try {
        const uploaded = await client.im.file.create({
          data: { file_type: "stream", file_name: fileName, file: bytes },
        });
        const fileKey = uploaded?.file_key;
        if (!fileKey) return { ok: false, error: "missing file_key" };
        const payload = { msg_type: "file", content: JSON.stringify({ file_key: fileKey }) };
        const res = replyToMessageId
          ? await client.im.message.reply({ path: { message_id: replyToMessageId }, data: payload })
          : await client.im.message.create({
              params: { receive_id_type: "chat_id" },
              data: { receive_id: chatId, ...payload },
            });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return { ok: true, messageId: res?.data?.message_id };
      } catch (error) {
        return { ok: false, error: describeLarkError(error) };
      }
    },

    /** Download one message resource and return its bytes plus content type. */
    async downloadResource(messageId, fileKey, kind) {
      try {
        const res = await client.im.messageResource.get({
          params: { type: kind === "image" ? "image" : "file" },
          path: { message_id: messageId, file_key: fileKey },
        });
        if (!res || typeof res.writeFile !== "function") {
          return { ok: false, error: "资源接口未返回文件流" };
        }
        const { mkdtemp, readFile, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = await mkdtemp(join(tmpdir(), "dsh-feishu-"));
        const target = join(dir, "resource.bin");
        try {
          await res.writeFile(target);
          const bytes = await readFile(target);
          const contentType = str(res.headers?.["content-type"] ?? res.headers?.["Content-Type"]);
          return { ok: true, bytes, contentType };
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      } catch (error) {
        log.warn("下载飞书资源失败", { messageId, kind, error: describeLarkError(error) });
        return { ok: false, error: describeLarkError(error) };
      }
    },
  };
}
