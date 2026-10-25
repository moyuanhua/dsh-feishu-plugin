import assert from "node:assert/strict";
import test from "node:test";
import { buildIntentPrompt, fallbackIntent, parseIntentDecision, resolveIntent } from "../src/console/intent.js";

const context = {
  sessions: [
    { sessionId: "session-aaa", title: "飞书插件修复", cwd: "/Users/code/wps/dsh-feishu-plugin" },
    { sessionId: "session-bbb", title: "股票数据整理", cwd: "/Users/code/wps/stock" },
  ],
  dirs: [
    { path: "/Users/code/wps", label: "默认" },
    { path: "/Users/code/wps/dsh-feishu-plugin", label: "dsh-feishu-plugin" },
    { path: "/Users/code/wps/stock", label: "stock" },
  ],
  models: [
    { provider: "opencode-go", model: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { provider: "deepseek", model: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  ],
  perms: [
    { value: "workspace-write", name: "workspace-write" },
    { value: "danger-full-access", name: "danger-full-access" },
  ],
  roots: ["/Users/code/wps"],
  defaults: { directory: "/Users/code/wps", model: { provider: "opencode-go", model: "deepseek-v4.1-flash" }, perm: "workspace-write" },
};

test("prompt includes sessions, candidate dirs and the default directory", () => {
  const prompt = buildIntentPrompt({ text: "把飞书插件里的工具卡收起来", ...context, history: [] });
  assert.match(prompt, /session-aaa/);
  assert.match(prompt, /飞书插件修复/);
  assert.match(prompt, /\/Users\/code\/wps\/dsh-feishu-plugin/);
  assert.match(prompt, /默认目录：\/Users\/code\/wps/);
});

test("parses fenced JSON and ignores surrounding prose", () => {
  const decision = parseIntentDecision('好的：\n```json\n{"intent":"create","dir":"/Users/code/wps/dsh-feishu-plugin","dir_source":"existing","title":"收紧工具卡","model":"opencode-go/deepseek-v4.1-flash","perm":"workspace-write"}\n```');
  assert.equal(decision.intent, "create");
  assert.equal(decision.directory, "/Users/code/wps/dsh-feishu-plugin");
  assert.equal(decision.title, "收紧工具卡");
});

test("rejects unknown intents and malformed JSON", () => {
  assert.equal(parseIntentDecision("not json"), undefined);
  assert.equal(parseIntentDecision('{"intent":"delete_everything"}'), undefined);
});

test("resolves create with existing directory, model and permission", () => {
  const resolved = resolveIntent(
    { intent: "create", directory: "/Users/code/wps/stock/", dirSource: "existing", title: "整理股票", model: "DeepSeek V4 Pro", perm: "danger-full-access" },
    context,
  );
  assert.equal(resolved.intent, "create");
  assert.equal(resolved.directory, "/Users/code/wps/stock");
  assert.equal(resolved.model.provider, "deepseek");
  assert.equal(resolved.perm, "danger-full-access");
});

test("falls back to the default directory and asks when outside roots", () => {
  const fallback = resolveIntent({ intent: "create", title: "随便聊聊" }, context);
  assert.equal(fallback.directory, "/Users/code/wps");
  assert.equal(fallback.dirSource, "default");
  const outside = resolveIntent({ intent: "create", directory: "/tmp/elsewhere" }, context);
  assert.equal(outside.intent, "clarify");
});

test("resolves enter by 1-based index, id prefix and title", () => {
  assert.equal(resolveIntent({ intent: "enter", target: "2" }, context).sessionId, "session-bbb");
  assert.equal(resolveIntent({ intent: "enter", target: "session-aaa" }, context).sessionId, "session-aaa");
  assert.equal(resolveIntent({ intent: "enter", target: "股票" }, context).sessionId, "session-bbb");
  assert.equal(resolveIntent({ intent: "enter", target: "飞书插件开发" }, context).sessionId, "session-aaa");
  const ambiguous = resolveIntent({ intent: "enter", target: "session" }, context);
  assert.equal(ambiguous.intent, "clarify");
});

test("ambiguous open requests fall back to the chooser without the model", () => {
  // The model is expected to decide create/enter/clarify itself; "open" is
  // only a deterministic fallback for when the model call fails.
  assert.equal(parseIntentDecision('{"intent":"open"}'), undefined);
  assert.equal(fallbackIntent("开启会话", context).intent, "open");
  assert.equal(fallbackIntent("继续", context).intent, "open");
});

test("deterministic fallback keeps create/list/enter usable without the model", () => {
  const create = fallbackIntent("帮我修一下 dsh 飞书插件", context);
  assert.equal(create.intent, "create");
  assert.equal(create.directory, "/Users/code/wps");
  assert.match(create.title, /飞书插件/);
  assert.equal(fallbackIntent("有哪些会话", context).intent, "list");
  assert.equal(fallbackIntent("你好", context).intent, "chat");
  assert.equal(fallbackIntent("进入飞书插件修复", context).sessionId, "session-aaa");
});

test("unknown clarify question gets a usable default", () => {
  const resolved = resolveIntent({ intent: "clarify" }, context);
  assert.equal(resolved.intent, "clarify");
  assert.ok(resolved.question.length > 0);
});
