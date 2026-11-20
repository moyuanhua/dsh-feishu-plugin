/**
 * Markdown → Feishu rich-text `post` renderer.
 *
 * Chat answers can be delivered as plain text, but plain text has no bold, no
 * links and no code blocks. `post` is the plainest message type that renders
 * them, so answers look like normal chat messages instead of cards.
 *
 * `post` has no markdown parser of its own: every block has to be translated
 * into Feishu's node tags (text / a / code_block / hr) and inline styles
 * (bold / italic / lineThrough). Anything post cannot represent degrades to
 * the nearest thing it can: headings become bold lines, tables become
 * monospaced code blocks, quotes get a left bar prefix.
 */

/** Feishu code_block language enum, keyed by markdown fence info string. */
const CODE_LANG = {
  js: "JAVASCRIPT", javascript: "JAVASCRIPT", jsx: "JAVASCRIPT", mjs: "JAVASCRIPT",
  ts: "TYPESCRIPT", typescript: "TYPESCRIPT", tsx: "TYPESCRIPT",
  py: "PYTHON", python: "PYTHON",
  sh: "SHELL", bash: "SHELL", shell: "SHELL", zsh: "SHELL", console: "SHELL",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
  go: "GO", rust: "RUST", rs: "RUST", java: "JAVA",
  c: "C", cpp: "CPP", "c++": "CPP", csharp: "CS", "c#": "CS",
  sql: "SQL", html: "HTML", xml: "XML", css: "CSS", scss: "CSS",
  md: "MARKDOWN", markdown: "MARKDOWN", diff: "DIFF", dockerfile: "DOCKERFILE",
  lua: "LUA", php: "PHP", ruby: "RUBY", rb: "RUBY", kotlin: "KOTLIN", swift: "SWIFT",
  plaintext: "PLAINTEXT", text: "PLAINTEXT",
};

/** One Feishu post text node, optionally styled. */
function textNode(text, style) {
  const node = { tag: "text", text };
  if (style && style.length) node.style = style;
  return node;
}

/**
 * Split one line of markdown into inline Feishu nodes: code spans, bold,
 * strikethrough, links, italic. Unmatched markers stay literal.
 */
function inline(src) {
  const out = [];
  let buf = "";
  const flush = (style) => {
    if (!buf) return;
    out.push(textNode(buf, style));
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        // post has no inline-code style: keep the text, drop the ticks.
        out.push(textNode(src.slice(i + 1, end), []));
        i = end + 1;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i) {
        flush();
        out.push(textNode(src.slice(i + 2, end), ["bold"]));
        i = end + 2;
        continue;
      }
    }
    if (ch === "~" && src[i + 1] === "~") {
      const end = src.indexOf("~~", i + 2);
      if (end > i) {
        flush();
        out.push(textNode(src.slice(i + 2, end), ["lineThrough"]));
        i = end + 2;
        continue;
      }
    }
    if (ch === "[") {
      const close = src.indexOf("](", i);
      if (close > i) {
        const paren = src.indexOf(")", close + 2);
        if (paren > close) {
          flush();
          out.push({ tag: "a", text: src.slice(i + 1, close), href: src.slice(close + 2, paren) });
          i = paren + 1;
          continue;
        }
      }
    }
    if (ch === "*" && src[i + 1] !== "*" && src[i + 1] !== " ") {
      const end = src.indexOf("*", i + 1);
      if (end > i + 1) {
        flush();
        out.push(textNode(src.slice(i + 1, end), ["italic"]));
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out.length ? out : [textNode("")];
}

/** Parse one markdown table row into trimmed cells. */
function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

/** Render markdown table rows as an aligned monospaced block. */
function tableBlock(rows) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, idx) => {
      widths[idx] = Math.max(widths[idx] ?? 0, cell.length);
    });
  }
  const lines = rows.map((row) =>
    row
      .map((cell, idx) => cell + " ".repeat(Math.max(0, (widths[idx] ?? 0) - cell.length)))
      .join("  ")
      .trimEnd(),
  );
  return { tag: "code_block", language: "PLAINTEXT", text: lines.join("\n") };
}

/**
 * Translate markdown into Feishu post content: an array of paragraphs, each
 * paragraph an array of inline nodes.
 */
export function mdToPostContent(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const content = [];
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    content.push(inline(para.join(" ")));
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[1].toLowerCase();
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      content.push([{ tag: "code_block", language: CODE_LANG[lang] ?? "PLAINTEXT", text: body.join("\n") }]);
      continue;
    }

    // A table needs a header row plus a separator row to count as one.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      flushPara();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = tableCells(lines[i]);
        if (!/^[\s:-]+$/.test(cells.join(""))) rows.push(cells);
        i += 1;
      }
      content.push([tableBlock(rows)]);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flushPara();
      content.push([{ tag: "hr" }]);
      i += 1;
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }

    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      flushPara();
      content.push([textNode(head[2].trim(), ["bold"])]);
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      while (i < lines.length) {
        const quote = lines[i].match(/^\s*>\s?(.*)$/);
        if (!quote) break;
        content.push([textNode("\u258F "), ...inline(quote[1])]);
        i += 1;
      }
      continue;
    }

    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      const depth = Math.min(3, Math.floor(item[1].replace(/\t/g, "  ").length / 2));
      const marker = /\d/.test(item[2]) ? item[2].replace(/[.)]$/, ".") : "\xB7";
      content.push([textNode("\u3000".repeat(depth) + marker + " "), ...inline(item[3])]);
      i += 1;
      continue;
    }

    para.push(line.trim());
    i += 1;
  }

  flushPara();
  if (content.length === 0) content.push([textNode("")]);
  return content;
}

function weightOf(block) {
  return block.reduce((total, node) => total + (node.text?.length ?? 40), 0);
}

/**
 * A single paragraph can exceed the whole message limit (one long line of
 * prose, or a big code block). Split its text nodes at the character boundary
 * so no post is ever emitted over the limit.
 */
function splitBlock(block, limit) {
  if (weightOf(block) <= limit) return [block];
  const pieces = [];
  let cur = [];
  let size = 0;
  for (const node of block) {
    const text = node.text;
    if (text === undefined) {
      cur.push(node);
      size += 40;
      continue;
    }
    let rest = text;
    while (rest.length > limit - size) {
      const take = limit - size;
      if (take > 0) {
        cur.push({ ...node, text: rest.slice(0, take) });
        rest = rest.slice(take);
      }
      pieces.push(cur);
      cur = [];
      size = 0;
    }
    if (rest) {
      cur.push(rest === text ? node : { ...node, text: rest });
      size += rest.length;
    }
  }
  if (cur.length) pieces.push(cur);
  return pieces;
}

/**
 * Render markdown into one or more post messages, each under `limit`
 * characters of visible text.
 */
export function mdToPosts(md, limit = 6000) {
  const content = mdToPostContent(md);
  const blocks = content.flatMap((block) => splitBlock(block, limit));
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const block of blocks) {
    const weight = weightOf(block);
    if (size + weight > limit && cur.length) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(block);
    size += weight;
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((body) => ({ zh_cn: { title: "", content: body } }));
}
