import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommand } from "../src/commands.js";
import { createSigner } from "../src/security.js";
import { StateStore } from "../src/state.js";
import { DshBridge } from "../src/dsh/controller.js";
import { FeishuQuestions } from "../src/dsh/questions.js";
import { RunCards } from "../src/dsh/runs.js";
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

test("completeText streams a one-shot LLM answer without creating a session", async () => {
  const calls = [];
  const llm = {
    async prepareCall(config) {
      return {
        config,
        async *stream(options) {
          calls.push(options);
          yield { type: "text-delta", text: '{"intent":' };
          yield { type: "text-delta", text: '"list"}' };
        },
      };
    },
  };
  const bridge = new DshBridge(
    { get: (key) => (key === "llm" ? llm : undefined) },
    { defaultModel: { provider: "p", model: "m" } },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  const text = await bridge.completeText({ system: "sys", prompt: "hello", sessionId: "session-route" });
  assert.equal(text, '{"intent":"list"}');
  assert.equal(calls[0].system, "sys");
  assert.equal(calls[0].sessionId, "session-route");
  assert.equal(calls[0].messages[0].content[0].text, "hello");
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

test("runCard folds every tool into one drawer and shows the total count", () => {
  const tools = Array.from({ length: 5 }, (_, index) => ({
    callId: `c${index}`,
    name: "bash",
    preview: `echo ${index}`,
    status: "done",
  }));
  const live = runCard({
    run: { sessionId: "s", status: "running", startedAt: Date.now(), tools, toolTotal: 5, streamingText: "" },
    maxAnswerChars: 4_000,
  });
  const json = JSON.stringify(live);
  assert.match(json, /collapsible_panel/);
  assert.match(json, /5 次工具调用（进行中）/);
  assert.match(json, /✅ \*\*bash\*\* — echo 4/);
  const done = runCard({
    run: { sessionId: "s", status: "done", startedAt: Date.now(), tools, toolTotal: 5, text: "ok" },
    maxAnswerChars: 4_000,
  });
  assert.match(JSON.stringify(done), /5 次工具调用/);
  assert.match(JSON.stringify(done), /✅ \*\*bash\*\* — echo 4/);
});

test("runCard always reserves thinking and tool drawers, even when empty", () => {
  const card = runCard({
    run: { sessionId: "s", status: "running", startedAt: Date.now(), tools: [], toolTotal: 0, streamingText: "" },
    maxAnswerChars: 4_000,
  });
  const json = JSON.stringify(card);
  assert.match(json, /思考过程（思考中…）/);
  assert.match(json, /工具调用（暂无）/);
  assert.match(json, /暂无思考内容/);
  assert.match(json, /暂无工具调用/);
});

test("runCard keeps a fixed skeleton with a collapsed thinking panel", () => {
  const card = runCard({
    run: {
      sessionId: "s",
      status: "running",
      startedAt: Date.now(),
      tools: [{ callId: "c1", name: "bash", preview: "ls", status: "running" }],
      toolTotal: 1,
      streamingReasoning: "先看看目录，再决定怎么改。",
      streamingText: "",
      canStop: true,
    },
    maxAnswerChars: 4_000,
  });
  const json = JSON.stringify(card);
  assert.match(json, /思考过程/);
  assert.match(json, /正在(思考|调用)/);
  assert.match(json, /collapsible_panel/);
  assert.match(json, /强制停止/);
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
    openedSessionCard({ view: { sessionId: "session-demo", title: "demo", cwd: "/tmp", model: { provider: "p", model: "m" }, perm: "workspace-write" }, style: "entered" }),
    modelCard({ sid: "s1", current: { provider: "p", model: "m" }, models: [{ provider: "p", providerName: "P", model: "m", name: "M" }] }),
    permissionCard({ sid: "s1", current: "workspace-write", perms: [{ value: "workspace-write", name: "Workspace write" }] }),
    approvalCard({ toolName: "bash", reason: "needs write", approveToken: "a", rejectToken: "r" }),
    questionCard({ token: "t", question: { id: "q1", question: "Proceed?", options: [{ label: "Yes" }] }, index: 0, total: 2 }),
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


test("question cards use buttons for single, multi-select and text prompts", () => {
  const single = questionCard({
    token: "t",
    question: { id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
    index: 0,
    total: 2,
  });
  const singleButtons = single.body.elements.filter((element) => element.tag === "button");
  assert.ok(singleButtons.some((element) => element.behaviors?.[0]?.value?.a === "qpick"));
  assert.equal(single.body.elements.find((element) => element.tag === "form"), undefined);

  const textOnly = questionCard({
    token: "t",
    question: { id: "q3", question: "Any note?" },
    index: 0,
    total: 1,
  });
  const textForm = textOnly.body.elements.find((element) => element.tag === "form");
  assert.equal(textForm.elements.find((element) => element.name === "custom").tag, "input");
  assert.equal(textForm.elements.find((element) => element.name === "submit").behaviors?.[0]?.value?.a, "qtextsubmit");

  const multi = questionCard({
    token: "t",
    question: { id: "q2", question: "Pick many", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
    index: 1,
    total: 2,
    selected: ["A"],
  });
  const multiButtons = multi.body.elements.filter((element) => element.tag === "button");
  assert.ok(multiButtons.some((element) => element.behaviors?.[0]?.value?.a === "qsubmit"));
  assert.ok(multiButtons.some((element) => element.text.content.includes("✅ A")));
});

function questionHarness() {
  const patches = [];
  const replies = [];
  const recalled = [];
  const sender = {
    async replyCard(_anchor, card) {
      return { ok: true, messageId: "om_question" };
    },
    async replyText(anchor, text) {
      replies.push({ anchor, text });
      return { ok: true, messageId: "om_text" };
    },
    async patchCard(messageId, card) {
      patches.push({ messageId, card });
      return { ok: true };
    },
    async recallMessage(messageId) {
      recalled.push(messageId);
      return { ok: true };
    },
  };
  const config = { signSecret: "test-secret", questionTtlMs: 60_000 };
  const rotations = [];
  const lateAnswers = [];
  const questions = new FeishuQuestions({
    ctx: {
      on: () => () => {},
      get: (name) =>
        name === "userQuestions"
          ? {
              answer(agent, callId, batch) {
                lateAnswers.push({ agent, callId, batch });
                return true;
              },
            }
          : undefined,
    },
    bridge: {},
    sender,
    state: { linkForSession: () => ({ anchorMessageId: "om_anchor" }) },
    config,
    log: { debug() {}, info() {}, warn() {} },
    isAllowed: () => true,
    onAnswered: async (info) => rotations.push(info),
  });
  return { questions, patches, replies, rotations, recalled, lateAnswers };
}

test("plain text replies answer the current question and advance sequentially", async () => {
  const { questions } = questionHarness();
  const pending = questions.handleRequest(
    {
      agent: { id: "session-test" },
      questions: [
        { id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
        { id: "q2", question: "Pick many", multiSelect: true, options: [{ label: "C" }, { label: "D" }] },
      ],
    },
    () => Promise.reject(new Error("should not delegate")),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await questions.tryAnswerText("session-test", "A"), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await questions.tryAnswerText("session-test", "C、D"), true);
  const result = await pending;
  assert.deepEqual(result.answers, [
    { id: "q1", selected: ["A"] },
    { id: "q2", selected: ["C", "D"] },
  ]);
  questions.close();
});

test("form input submits a custom text answer", async () => {
  const { questions, rotations } = questionHarness();
  const pending = questions.handleRequest(
    {
      agent: { id: "session-text" },
      questions: [{ id: "q1", question: "Any note?" }],
    },
    () => Promise.reject(new Error("should not delegate")),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const item = [...questions.pending.values()][0];
  const token = questions.signer.sign({ kind: "question", key: item.key });
  const action = await questions.handleAction({
    value: { a: "qtextsubmit", t: token, i: 0 },
    formValue: { custom: "typed answer" },
    operatorOpenId: "ou_test",
  });
  assert.equal(action.toast.type, "success");
  const result = await pending;
  assert.deepEqual(result.answers, [{ id: "q1", selected: [], custom: "typed answer" }]);
  assert.equal(rotations.length, 1);
  questions.close();
});

test("multi-select toggles buttons and submits the selected labels", async () => {
  const { questions, patches, rotations } = questionHarness();
  const pending = questions.handleRequest(
    {
      agent: { id: "session-form" },
      questions: [
        { id: "q1", question: "Pick many", multiSelect: true, options: [{ label: "Red" }, { label: "Blue" }] },
      ],
    },
    () => Promise.reject(new Error("should not delegate")),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const item = [...questions.pending.values()][0];
  const token = questions.signer.sign({ kind: "question", key: item.key });
  const base = { t: token, i: 0 };
  await questions.handleAction({ value: { a: "qpick", ...base, s: "Red" }, operatorOpenId: "ou_test" });
  await questions.handleAction({ value: { a: "qpick", ...base, s: "Blue" }, operatorOpenId: "ou_test" });
  assert.deepEqual(item.selections.get("q1"), ["Red", "Blue"]);
  const action = await questions.handleAction({
    value: { a: "qsubmit", ...base },
    operatorOpenId: "ou_test",
  });
  assert.equal(action.toast.type, "success");
  const result = await pending;
  assert.deepEqual(result.answers, [{ id: "q1", selected: ["Red", "Blue"] }]);
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].anchorMessageId, "om_question");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(patches.length >= 1);
  questions.close();
});

test("long card content is truncated below the Feishu 30KB limit", () => {
  const huge = "长".repeat(20_000);
  const card = runCard({
    run: {
      sessionId: "s1",
      status: "done",
      startedAt: Date.now(),
      tools: [],
      text: huge,
      streamingText: huge,
      streamingReasoning: huge,
      canStop: false,
    },
    maxAnswerChars: 20_000,
  });
  const bytes = Buffer.byteLength(JSON.stringify(card), "utf8");
  assert.ok(bytes <= 29_000, `card is ${bytes} bytes`);
  assert.match(JSON.stringify(card), /卡片已截断/);
});

test("late question answers are delivered through userQuestions.answer", async () => {
  const { questions, lateAnswers, rotations } = questionHarness();
  const agent = { id: "session-late" };
  const pending = questions.handleRequest(
    {
      agent,
      wait: { callId: "call_late" },
      questions: [{ id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
    },
    () => Promise.reject(new Error("should not delegate")),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await questions.markExpired([...questions.pending.keys()][0]);
  assert.equal(await questions.tryAnswerText("session-late", "B"), true);
  const result = await pending;
  assert.deepEqual(result.answers, [{ id: "q1", selected: ["B"] }]);
  assert.equal(lateAnswers.length, 1);
  assert.equal(lateAnswers[0].agent, agent);
  assert.equal(lateAnswers[0].callId, "call_late");
  assert.deepEqual(lateAnswers[0].batch.answers, [{ id: "q1", selected: ["B"] }]);
  assert.equal(rotations.length, 1);
  questions.close();
});

test("recover cancels pending questions and recalls their cards", async () => {
  const { questions, recalled } = questionHarness();
  const pending = questions.handleRequest(
    {
      agent: { id: "session-recover" },
      questions: [{ id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
    },
    () => Promise.reject(new Error("should not delegate")),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const count = await questions.recover("session-recover");
  assert.equal(count, 1);
  assert.equal(questions.pending.size, 0);
  assert.deepEqual(recalled, ["om_question"]);
  const result = await pending;
  assert.deepEqual(result.answers, []);
  questions.close();
});

test("run cards rotate to a fresh card after a question is answered", async () => {
  const sent = [];
  const patches = [];
  const runs = new RunCards({
    bridge: {},
    sender: {
      async replyCard(anchor, card) {
        sent.push({ anchor, card });
        return { ok: true, messageId: "om_new" };
      },
      async patchCard(messageId, card) {
        patches.push({ messageId, card });
        return { ok: true };
      },
      async sendCard() {
        return { ok: false };
      },
    },
    state: {},
    config: { maxAnswerChars: 4_000, streamThrottleMs: 100 },
    log: { debug() {}, info() {}, warn() {} },
  });
  runs.runs.set("session-rotate", {
    sessionId: "session-rotate",
    chatId: "oc_chat",
    anchorMessageId: "om_old",
    messageId: "om_old_run",
    status: "running",
    startedAt: Date.now(),
    tools: [],
    toolTotal: 0,
    text: "old partial",
    streamingText: "old partial",
    streamingReasoning: "",
    turn: 2,
    step: 1,
    error: "",
    canStop: true,
    promptCount: 1,
    model: "p/m",
    perm: "workspace-write",
    finished: false,
  });
  const fresh = await runs.rotate("session-rotate", {
    anchorMessageId: "om_question",
    chatId: "oc_chat",
    threadId: "omt_topic",
  });
  assert.ok(fresh);
  assert.equal(fresh.continued, true);
  assert.equal(fresh.messageId, "om_new");
  assert.equal(sent[0].anchor, "om_question");
  assert.equal(sent[0].card.header.title.content, "🤖 继续处理");
  assert.equal(runs.runs.get("session-rotate"), fresh);
  assert.equal(patches.length, 1);
  assert.match(JSON.stringify(patches[0].card), /回答已提交/);
  runs.dispose();
});
