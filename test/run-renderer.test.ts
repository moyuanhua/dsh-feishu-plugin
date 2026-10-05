import { describe, expect, test } from "vitest";
import {
  renderRunMarkdown,
  runCardTitle,
  shouldRenderAfter,
  type RunRenderOptions,
} from "../src/bridge/run-renderer.js";
import { initialRunState, reduceRunState, type RunEvent, type RunState } from "../src/bridge/run-state.js";

const T0 = 1_700_000_000_000;
const TITLE = "DeepSeek 运行";
const BASE: RunRenderOptions = {};

type ToolBlock = RunState["tools"][number];

function tool(name: string, status: ToolBlock["status"] = "running", detail?: string): ToolBlock {
  return detail === undefined ? { kind: "tool", name, status } : { kind: "tool", name, status, detail };
}

/** 以初始状态为底，按需覆盖字段。 */
function stateWith(partial: Partial<RunState>): RunState {
  return { ...initialRunState(T0), ...partial };
}

/** 通过 reducer 走一遍事件，得到真实状态（渲染器只读状态，不关心事件形状）。 */
function run(events: readonly RunEvent[]): RunState {
  let state = initialRunState(T0);
  let clock = T0;
  for (const event of events) {
    clock += 10;
    state = reduceRunState(state, event, clock);
  }
  return state;
}

describe("runCardTitle：状态图标只出现在卡片 header", () => {
  // 缺陷回归：旧实现把 `⏳ **<title>**` 同时写进 header 和正文，于是"没有正文"时
  // 用户看到的正文就是一句像回答的标题（截图里的 "✅ **安装dlink**"）。
  test("四种运行状态各有独立图标", () => {
    expect(runCardTitle(TITLE, "running")).toBe("⏳ DeepSeek 运行");
    expect(runCardTitle(TITLE, "done")).toBe("✅ DeepSeek 运行");
    expect(runCardTitle(TITLE, "failed")).toBe("❌ DeepSeek 运行");
    expect(runCardTitle(TITLE, "stopped")).toBe("⏹ DeepSeek 运行");
  });

  test("正文不再包含标题", () => {
    for (const status of ["running", "done", "failed", "stopped"] as const) {
      const md = renderRunMarkdown(stateWith({ status, text: "正文" }), BASE);
      expect(md).not.toContain(TITLE);
      expect(md).toBe("正文");
    }
  });
});

describe("renderRunMarkdown：空正文必须显式说明", () => {
  test("运行中且没有任何内容 → 说明尚未产生输出，不是空白卡", () => {
    expect(renderRunMarkdown(stateWith({}), BASE)).toBe("_（运行中，尚未产生输出…）_");
  });

  test("终态且没有任何内容 → 说明本轮没有文本输出", () => {
    expect(renderRunMarkdown(stateWith({ status: "done" }), BASE)).toBe("_（本轮没有文本输出）_");
    expect(renderRunMarkdown(stateWith({ status: "stopped" }), BASE)).toBe("_（本轮没有文本输出）_");
  });

  test("只有强停按钮时仍然算没有正文", () => {
    const md = renderRunMarkdown(stateWith({}), { ...BASE, stop: { token: "t" } });
    expect(md).toContain("_（运行中，尚未产生输出…）_");
  });

  test("有失败原因时不再补空正文说明（原因本身已经是内容）", () => {
    const md = renderRunMarkdown(stateWith({ status: "failed", reason: "构建失败" }), BASE);
    expect(md).toBe("⚠️ 构建失败");
    expect(md).not.toContain("本轮没有文本输出");
  });

  test("reason 单独成行；没有 reason 时不出现告警行", () => {
    const withReason = renderRunMarkdown(stateWith({ status: "failed", reason: "构建失败：tsc 报错" }), BASE);
    expect(withReason).toContain("⚠️ 构建失败：tsc 报错");
    expect(withReason.split("\n\n")[0]).toBe("⚠️ 构建失败：tsc 报错");

    expect(renderRunMarkdown(stateWith({ status: "failed", text: "x" }), BASE)).not.toContain("⚠️");
  });
});

describe("renderRunMarkdown：正文截断", () => {
  test("超 maxTextChars 截断并追加 …(已截断)", () => {
    const text = "答".repeat(300);
    const md = renderRunMarkdown(stateWith({ text }), { ...BASE, maxTextChars: 10 });

    expect(md).toContain(`${"答".repeat(10)}…(已截断)`);
    expect(md).not.toContain("答".repeat(11));
  });

  test("默认上限 2048；未超限时原样输出", () => {
    const long = "x".repeat(2_048);
    expect(renderRunMarkdown(stateWith({ text: long }), BASE)).toContain(long);
    expect(renderRunMarkdown(stateWith({ text: "x".repeat(2_049) }), BASE)).toContain("…(已截断)");

    const short = renderRunMarkdown(stateWith({ text: "简短回答" }), { ...BASE, maxTextChars: 10 });
    expect(short).toContain("简短回答");
    expect(short).not.toContain("已截断");
  });

  test("maxTextChars = 0 时只剩截断标记，空正文不产生空段落", () => {
    expect(renderRunMarkdown(stateWith({ text: "还有内容" }), { ...BASE, maxTextChars: 0 })).toContain(
      "…(已截断)",
    );
    expect(renderRunMarkdown(stateWith({ text: "" }), { ...BASE, maxTextChars: 0 })).toBe(
      "_（运行中，尚未产生输出…）_",
    );
  });
});

describe("renderRunMarkdown：工具折叠阈值", () => {
  test("运行中 2 个工具不合并，各自成行", () => {
    const md = renderRunMarkdown(stateWith({ tools: [tool("read_file"), tool("grep")] }), BASE);

    expect(md).toContain("🔧 read_file");
    expect(md).toContain("🔧 grep");
    expect(md).not.toContain("×2");
  });

  test("运行中 3 个工具合并为一行（取最后一次调用的名字）", () => {
    const md = renderRunMarkdown(
      stateWith({ tools: [tool("read_file"), tool("grep"), tool("write")] }),
      BASE,
    );

    expect(md).toContain("🔧 write ×3");
    expect(md).not.toContain("read_file");
    expect(md).not.toContain("🔧 write\n");
  });

  test("阈值可调：collapseToolThreshold = 2 时 2 个工具即合并", () => {
    const md = renderRunMarkdown(stateWith({ tools: [tool("read_file"), tool("grep")] }), {
      ...BASE,
      collapseToolThreshold: 2,
    });

    expect(md).toContain("🔧 grep ×2");
    expect(md).not.toContain("read_file");
  });

  test("单块工具带 detail 时不会渲染尽人皆知的 ×1", () => {
    const md = renderRunMarkdown(stateWith({ tools: [tool("read_file", "ok", "12 行")] }), BASE);

    expect(md).toContain("✅ read_file — 12 行");
    expect(md).not.toContain("×1");
  });
});

describe("renderRunMarkdown：maxToolBlocks 折叠", () => {
  const many = Array.from({ length: 14 }, (_, i) => tool(`tool-${String(i + 1).padStart(2, "0")}`));

  test("默认 12：最旧的 2 个折叠成一行摘要", () => {
    const md = renderRunMarkdown(stateWith({ tools: many }), BASE);

    expect(md).toContain("…另有 2 个工具调用");
    expect(md).toContain("🔧 tool-14 ×12");
    expect(md).not.toContain("tool-01");
    expect(md).not.toContain("tool-02");
  });

  test("自定义 maxToolBlocks 生效，且摘要行在合并行之前", () => {
    const md = renderRunMarkdown(stateWith({ tools: many.slice(0, 5) }), { ...BASE, maxToolBlocks: 3 });
    const lines = md.split("\n");

    expect(lines[0]).toBe("…另有 2 个工具调用");
    expect(lines[1]).toBe("🔧 tool-05 ×3");
    expect(md).not.toContain("tool-03");
  });

  test("工具数不超上限时没有摘要行", () => {
    const md = renderRunMarkdown(stateWith({ tools: many.slice(0, 12) }), BASE);
    expect(md).not.toContain("…另有");
  });
});

describe("renderRunMarkdown：终态整体折叠", () => {
  const two = [tool("read_file", "ok"), tool("grep", "error", "exit 1")];

  test("运行中展开，终态折叠为一行", () => {
    const running = renderRunMarkdown(stateWith({ tools: two }), BASE);
    expect(running).toContain("✅ read_file");
    expect(running).toContain("❌ grep — exit 1");

    const done = renderRunMarkdown(stateWith({ status: "done", tools: two }), BASE);
    expect(done).toContain("🔧 grep ×2");
    expect(done).not.toContain("read_file");
    expect(done).not.toContain("exit 1");
  });

  test("终态 + 4 个工具全部折叠（不再保留最新一块的展开）", () => {
    const tools = [tool("a", "ok"), tool("b", "ok"), tool("c", "ok"), tool("d", "ok")];
    const md = renderRunMarkdown(stateWith({ status: "stopped", tools }), BASE);

    expect(md).toContain("🔧 d ×4");
    expect(md).not.toContain("✅ a");
  });

  test("终态 + 单个工具仍单独成行（单个没有可折叠的语义）", () => {
    const md = renderRunMarkdown(stateWith({ status: "done", tools: [tool("read_file", "ok")] }), BASE);
    expect(md).toContain("✅ read_file");
  });
});

describe("renderRunMarkdown：footer 与强停按钮", () => {
  test("footer 原样输出（无时间戳，由调用方决定内容）", () => {
    const md = renderRunMarkdown(stateWith({}), { ...BASE, footer: "DeepSeek-V41-Flash · 3s" });
    expect(md).toContain("DeepSeek-V41-Flash · 3s");
  });

  test("运行中渲染强停按钮（携带 token），终态不渲染", () => {
    const stop = { token: "stop-token-1" };
    const running = renderRunMarkdown(stateWith({}), { ...BASE, stop });
    expect(running).toContain("⏹ 强制停止");
    expect(running).toContain("stop-token-1");

    const done = renderRunMarkdown(stateWith({ status: "done" }), { ...BASE, stop });
    expect(done).not.toContain("强制停止");
    expect(done).not.toContain("stop-token-1");
  });
});

describe("renderRunMarkdown：纯函数与稳定性", () => {
  test("同一状态 + 同一选项渲染两次完全一致，且不改动 options", () => {
    const options: RunRenderOptions = {
      footer: "1s",
      stop: { token: "t" },
      maxTextChars: 32,
    };
    const snapshot = structuredClone(options);
    const state = run([
      { type: "text-delta", text: "正文" },
      { type: "tool-start", name: "read_file" },
      { type: "tool-end", name: "read_file", ok: true, detail: "12 行" },
    ]);

    const first = renderRunMarkdown(state, options);
    expect(renderRunMarkdown(state, options)).toBe(first);
    expect(options).toStrictEqual(snapshot);
    expect(first.split("\n\n")).toStrictEqual([
      "正文",
      "✅ read_file — 12 行",
      "1s",
      "⏹ 强制停止（token: t）",
    ]);
  });

  test("末尾 patch 与初始渲染结构一致：正文 → 工具 → footer（标题在 header 里）", () => {
    const done = run([
      { type: "text-delta", text: "流式" },
      { type: "assistant-message", text: "最终答案" },
      { type: "tool-start", name: "bash" },
      { type: "tool-end", name: "bash", ok: false, detail: "exit 1" },
      { type: "turn-end", outcome: "failed", reason: "命令失败" },
    ]);
    const md = renderRunMarkdown(done, { ...BASE, footer: "2s" });

    expect(md.split("\n\n")).toStrictEqual(["⚠️ 命令失败", "最终答案", "❌ bash — exit 1", "2s"]);
  });

  test("detail 单行化并截断到 200 字符", () => {
    const multiline = renderRunMarkdown(stateWith({ tools: [tool("bash", "ok", "第一行\n第二行")] }), BASE);
    expect(multiline).toContain("✅ bash — 第一行 第二行");

    const long = renderRunMarkdown(stateWith({ tools: [tool("bash", "ok", "d".repeat(250))] }), BASE);
    expect(long).toContain(`✅ bash — ${"d".repeat(200)}…`);
  });
});

describe("shouldRenderAfter", () => {
  test("运行中：未达 throttleMs 不渲染，达到才渲染", () => {
    const state = stateWith({ status: "running" });
    expect(shouldRenderAfter(state, 1_000, 400, 1_399)).toBe(false);
    expect(shouldRenderAfter(state, 1_000, 400, 1_400)).toBe(true);
    expect(shouldRenderAfter(state, 1_000, 400, 5_000)).toBe(true);
  });

  test("终态短路：无论距上次渲染多久都必须渲染（收尾要落地）", () => {
    expect(shouldRenderAfter(stateWith({ status: "done" }), 1_000, 400, 1_000)).toBe(true);
    expect(shouldRenderAfter(stateWith({ status: "failed", reason: "x" }), 0, 60_000, 1)).toBe(true);
    expect(shouldRenderAfter(stateWith({ status: "stopped" }), Number.MAX_SAFE_INTEGER, 400, 0)).toBe(true);
  });

  test("throttleMs ≤ 0 视为不节流；从未渲染过时立即渲染", () => {
    const state = stateWith({ status: "running" });
    expect(shouldRenderAfter(state, 1_000, 0, 1_000)).toBe(true);
    expect(shouldRenderAfter(state, 1_000, -100, 1_000)).toBe(true);
    expect(shouldRenderAfter(state, Number.NEGATIVE_INFINITY, 400, 0)).toBe(true);
  });
});
