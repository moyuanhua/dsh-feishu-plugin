import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommand } from "../src/commands.js";
import { createSigner } from "../src/security.js";
import { StateStore } from "../src/state.js";
import { DshBridge } from "../src/dsh/controller.js";
import { isUnder, validateDirectory } from "../src/utils.js";
import {
  approvalCard,
  helpCard,
  mainHintCard,
  modelCard,
  openedSessionCard,
  newSessionFormCard,
  permissionCard,
  questionCard,
  runCard,
  sessionListCard,
} from "../src/cards.js";

test("command parser understands management commands", () => {
  assert.deepEqual(parseCommand("/new 我的任务"), { name: "new", args: "我的任务", raw: "/new 我的任务" });
  assert.equal(parseCommand("/model").name, "model");
  assert.equal(parseCommand("/MODEL gpt").name, "model");
  assert.equal(parseCommand("/nope").name, "unknown");
  assert.equal(parseCommand("hello"), undefined);
});

test("path guard stays inside allowed roots", () => {
  const root = "/tmp/dsh-feishu-test-root";
  assert.equal(validateDirectory(`${root}/project`, [root]).ok, true);
  assert.equal(validateDirectory("/etc", [root]).ok, false);
  assert.equal(validateDirectory("/", [root]).ok, false);
  assert.equal(validateDirectory("relative/path", [root]).ok, false);
  assert.equal(isUnder(`${root}/a`, root), true);
  assert.equal(isUnder("/tmp/other", root), false);
});

test("signed card tokens expire and verify", () => {
  const signer = createSigner("secret");
  const token = signer.sign({ hello: "world", exp: Date.now() + 10_000 });
  assert.equal(signer.verify(token)?.hello, "world");
  assert.equal(signer.verify(`${token}x`), undefined);
  assert.equal(signer.verify(signer.sign({ hello: "world", exp: Date.now() - 1 })), undefined);
});

test("state binds thread and root aliases to sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-feishu-state-"));
  try {
    const store = new StateStore({ file: join(dir, "state.json") });
    await store.load();
    store.bindThread({
      threadId: "omt_1",
      rootId: "om_1",
      sessionId: "session-1",
      chatId: "oc_1",
      openId: "ou_1",
      anchorMessageId: "om_anchor",
      title: "demo",
    });
    assert.equal(store.sessionForThread("omt_1"), "session-1");
    assert.equal(store.sessionForRoot("om_1"), "session-1");
    assert.equal(store.linkForSession("session-1")?.anchorMessageId, "om_anchor");
    store.bindThread({
      rootId: "om_2",
      sessionId: "session-2",
      chatId: "oc_1",
      openId: "ou_1",
      anchorMessageId: "om_root_anchor",
    });
    assert.equal(store.sessionForRoot("om_2"), "session-2");
    assert.equal(store.linkForSession("session-2")?.anchorMessageId, "om_root_anchor");
    await store.save();
    const reloaded = new StateStore({ file: join(dir, "state.json") });
    await reloaded.load();
    assert.equal(reloaded.sessionForThread("omt_1"), "session-1");
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("owner binding and allowlist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-feishu-owner-"));
  try {
    const store = new StateStore({ file: join(dir, "state.json") });
    await store.load();
    assert.equal(store.isAllowed("ou_first", []), true);
    assert.equal(store.isAllowed("ou_second", []), false);
    const configured = new StateStore({ file: join(dir, "state2.json") });
    await configured.load();
    assert.equal(configured.isAllowed("ou_x", ["ou_x"]), true);
    assert.equal(configured.isAllowed("ou_y", ["ou_x"]), false);
    await store.saving;
    await configured.saving;
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("DshBridge.prompt passes the AbortSignal required by prompt admission", async () => {
  let captured;
  const controller = {
    async prompt(request, signal) {
      captured = { request, signal };
      return { accepted: true };
    },
  };
  const bridge = new DshBridge(
    { get: (key) => (key === "sessionController" ? controller : undefined) },
    { allowedRoots: ["/tmp"], defaultDirectory: "/tmp" },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  await bridge.prompt("session-1", [{ type: "text", text: "hi" }], "queue", "req-1");
  assert.equal(captured.request.sessionId, "session-1");
  assert.equal(captured.request.mode, "queue");
  assert.ok(captured.signal instanceof AbortSignal);
});

test("sessionBrief extracts title, summary, last user and assistant text", async () => {
  const query = {
    async readSurface() {
      return {
        events: [
          { type: "user/message", surfaceOp: "append", data: { content: [{ type: "text", text: "first" }], source: { kind: "user" } } },
          { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "answer one" }] } } },
          { type: "user/message", surfaceOp: { op: "replace", startSeq: 1, endSeq: 2 }, data: { content: [{ type: "text", text: "compacted summary" }], source: { kind: "system" } } },
          { type: "user/message", surfaceOp: "append", data: { content: [{ type: "text", text: "latest question" }], source: { kind: "user" } } },
          { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "latest answer" }] } } },
        ],
      };
    },
    async readTitle() {
      return { title: "demo title" };
    },
  };
  const bridge = new DshBridge(
    { get: (key) => (key === "sessionQuery" ? query : undefined) },
    { allowedRoots: ["/tmp"], defaultDirectory: "/tmp" },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const brief = await bridge.sessionBrief("session-1");
  assert.equal(brief.title, "demo title");
  assert.equal(brief.summary, "compacted summary");
  assert.equal(brief.lastUser, "latest question");
  assert.equal(brief.lastAssistant, "latest answer");
});

test("every card builder produces serializable JSON 2.0", () => {
  const cards = [
    helpCard(),
    mainHintCard({ pendingKey: "token", pendingText: "hello" }),
    sessionListCard({
      sessions: [
        { sessionId: "s1", title: "demo", updatedAt: Date.now(), running: true, cwd: "/tmp/x", perm: "workspace-write" },
      ],
      page: 0,
      pageSize: 8,
    }),
    newSessionFormCard({
      values: { title: "demo", dir: "/tmp/x" },
      models: [{ provider: "p", providerName: "P", model: "m", name: "M" }],
      perms: [{ value: "workspace-write", name: "Workspace write" }],
      dirs: [{ name: "x", path: "/tmp/x", isRepo: false }],
      roots: ["/tmp"],
    }),
    openedSessionCard({ view: { title: "demo", cwd: "/tmp", model: { provider: "p", model: "m" }, perm: "workspace-write" }, style: "entered" }),
    modelCard({ sid: "s1", current: { provider: "p", model: "m" }, models: [{ provider: "p", providerName: "P", model: "m", name: "M" }] }),
    permissionCard({ sid: "s1", current: "workspace-write", perms: [{ value: "workspace-write", name: "Workspace write" }] }),
    approvalCard({ toolName: "bash", reason: "needs write", approveToken: "a", rejectToken: "r" }),
    questionCard({ token: "t", questions: [{ id: "q1", question: "Proceed?", options: [{ label: "Yes" }] }] }),
    runCard({
      run: {
        sessionId: "s1",
        status: "running",
        startedAt: Date.now(),
        tools: [{ name: "bash", preview: "ls", status: "done" }],
        streamingText: "hello",
        canStop: true,
      },
      maxAnswerChars: 4000,
    }),
  ];
  for (const card of cards) {
    const text = JSON.stringify(card);
    assert.ok(text.length > 20);
    assert.equal(card.schema, "2.0");
    assert.equal(card.config.update_multi, true);
  }
  const form = cards[3].body.elements.find((element) => element.tag === "form");
  assert.equal(form.tag, "form");
  assert.ok(form.elements.some((element) => element.name === "submit" && element.form_action_type === "submit"));
});
