/** Normalize Feishu long-connection payloads into small internal shapes. */
import { isRecord, str } from "../utils.js";

export function stripMentions(text) {
  return str(text).replace(/@_user_\d+\s*/g, "").trim();
}

function json(raw) {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function postText(content) {
  const title = str(content.title);
  const blocks = Array.isArray(content.content) ? content.content : [];
  const lines = [];
  if (title) lines.push(title);
  for (const paragraph of blocks) {
    if (!Array.isArray(paragraph)) continue;
    const segments = [];
    for (const element of paragraph) {
      if (!isRecord(element)) continue;
      if ((element.tag === "text" || element.tag === "at") && element.text) segments.push(str(element.text));
      else if (element.tag === "a" && element.text) {
        segments.push(element.href ? `${element.text}(${element.href})` : str(element.text));
      } else if (element.tag === "img") segments.push("[图片]");
      else if (element.tag === "file" || element.tag === "media") segments.push("[文件]");
    }
    if (segments.length) lines.push(segments.join(""));
  }
  return lines.join("\n").trim();
}

export function extractText(messageType, rawContent) {
  const content = json(rawContent);
  switch (messageType) {
    case "text":
      return stripMentions(content?.text);
    case "post":
      return postText(content ?? {});
    case "image":
      return "[图片]";
    case "file":
      return "[文件]";
    case "audio":
      return "[语音消息]";
    case "media":
      return "[视频消息]";
    case "sticker":
      return "[表情包]";
    case "interactive":
      return "[卡片消息]";
    case "share_chat":
      return "[群分享]";
    case "share_user":
      return "[用户名片]";
    case "merge_forward":
      return "[合并转发消息]";
    default:
      return messageType ? `[不支持的消息类型: ${messageType}]` : "";
  }
}

/** All image/file resources carried by one message, including inline post images. */
export function extractAttachments(messageType, rawContent) {
  const content = json(rawContent);
  if (!content) return [];
  const out = [];
  const push = (kind, key, name) => {
    const fileKey = str(key);
    if (!fileKey) return;
    out.push({ kind, fileKey, ...(name ? { fileName: name } : {}) });
  };
  if (messageType === "image") push("image", content.image_key);
  else if (messageType === "file") push("file", content.file_key, str(content.file_name));
  else if (messageType === "post") {
    for (const paragraph of Array.isArray(content.content) ? content.content : []) {
      if (!Array.isArray(paragraph)) continue;
      for (const element of paragraph) {
        if (!isRecord(element)) continue;
        if (element.tag === "img") push("image", element.image_key);
        else if (element.tag === "file" || element.tag === "media") {
          push("file", element.file_key, str(element.file_name));
        }
      }
    }
  }
  return out;
}

export function parseIncomingMessage(data) {
  const payload = isRecord(data?.event) ? data.event : data;
  if (!isRecord(payload)) return undefined;
  const message = payload.message;
  if (!isRecord(message)) return undefined;
  const chatId = str(message.chat_id);
  const messageId = str(message.message_id);
  if (!chatId || !messageId) return undefined;
  const messageType = str(message.message_type) || "text";
  const rawContent = str(message.content);
  const sender = payload.sender;
  const senderOpenId =
    (isRecord(sender) && isRecord(sender.sender_id) ? str(sender.sender_id.open_id) : "") ||
    str(payload.sender_id?.open_id);

  const attachments = extractAttachments(messageType, rawContent);
  return {
    eventId: str(payload.event_id),
    messageId,
    chatId,
    chatType: str(message.chat_type) || "p2p",
    messageType,
    text: extractText(messageType, rawContent),
    attachments,
    senderOpenId,
    createTime: str(message.create_time),
    threadId: str(message.thread_id) || undefined,
    rootId: str(message.root_id) || undefined,
    parentId: str(message.parent_id) || undefined,
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
  };
}

export function parseCardAction(data) {
  const payload = isRecord(data?.event) ? data.event : data;
  if (!isRecord(payload)) return undefined;
  const context = isRecord(payload.context) ? payload.context : {};
  const action = isRecord(payload.action) ? payload.action : {};
  const operator = isRecord(payload.operator) ? payload.operator : {};
  const operatorOpenId = str(operator.open_id);
  if (!operatorOpenId) return undefined;

  let value = action.value;
  if (typeof value === "string") value = json(value) ?? value;
  const formValue = isRecord(action.form_value) ? action.form_value : undefined;

  return {
    value,
    formValue,
    messageId: str(context.open_message_id) || str(payload.open_message_id),
    chatId: str(context.open_chat_id) || str(payload.open_chat_id),
    operatorOpenId,
    token: str(payload.token) || undefined,
    threadId: str(context.thread_id) || undefined,
  };
}
