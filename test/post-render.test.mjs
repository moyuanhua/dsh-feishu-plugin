import assert from "node:assert/strict";
import test from "node:test";
import { mdToPostContent, mdToPosts } from "../src/post-render.js";

function flat(content) {
  return content.map((block) => block.map((node) => node.text ?? "").join(""));
}

test("post renderer keeps headings as bold lines", () => {
  const content = mdToPostContent("# 标题\n正文");
  assert.deepEqual(flat(content), ["标题", "正文"]);
  assert.deepEqual(content[0][0].style, ["bold"]);
});

test("post renderer splits inline styles into separate nodes", () => {
  const [block] = mdToPostContent("前 **加粗** 中 `代码` 后");
  const styles = block.map((node) => ({ text: node.text, style: node.style ?? [] }));
  assert.deepEqual(styles, [
    { text: "前 ", style: [] },
    { text: "加粗", style: ["bold"] },
    { text: " 中 ", style: [] },
    { text: "代码", style: [] },
    { text: " 后", style: [] },
  ]);
});

test("post renderer turns links into anchor nodes", () => {
  const [block] = mdToPostContent("看[这个](https://example.com)");
  const link = block.find((node) => node.tag === "a");
  assert.deepEqual(link, { tag: "a", text: "这个", href: "https://example.com" });
});

test("post renderer maps fenced code blocks to Feishu languages", () => {
  const content = mdToPostContent("```ts\nconst a = 1;\n```\n```未知语言\nx\n```");
  const blocks = content.filter((block) => block[0].tag === "code_block");
  assert.equal(blocks[0][0].language, "TYPESCRIPT");
  assert.equal(blocks[0][0].text, "const a = 1;");
  assert.equal(blocks[1][0].language, "PLAINTEXT");
});

test("post renderer degrades tables to aligned code blocks", () => {
  const content = mdToPostContent("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(content.length, 1);
  assert.equal(content[0][0].tag, "code_block");
  assert.match(content[0][0].text, /^a\s+b\n1\s+2$/);
});

test("post renderer keeps quotes, lists and rules distinguishable", () => {
  const content = mdToPostContent("> 引用\n\n- 一\n- 二\n\n---");
  const texts = flat(content);
  assert.equal(texts[0], "\u258F 引用");
  assert.deepEqual(texts.slice(1, 3), ["\xB7 一", "\xB7 二"]);
  assert.equal(content.at(-1)[0].tag, "hr");
});

test("post renderer numbers ordered list items", () => {
  const content = mdToPostContent("1. 第一\n2. 第二");
  assert.deepEqual(flat(content), ["1. 第一", "2. 第二"]);
});

test("post renderer splits long answers into several posts", () => {
  const paragraph = "这是一段很长的内容。".repeat(200);
  const posts = mdToPosts(`${paragraph}\n\n${paragraph}\n\n${paragraph}`, 1_000);
  assert.ok(posts.length > 1);
  for (const post of posts) {
    const visible = post.zh_cn.content.flat().reduce((total, node) => total + (node.text?.length ?? 0), 0);
    assert.ok(visible <= 1_000 + 40);
  }
});

test("post renderer emits one empty paragraph for empty input", () => {
  const [post] = mdToPosts("");
  assert.deepEqual(post.zh_cn.content, [[{ tag: "text", text: "" }]]);
});
