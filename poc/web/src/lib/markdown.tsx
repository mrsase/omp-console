import { Fragment, createElement, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { parseTaggedContent, taggedTitle } from "./tagged-content";
import type { TaggedElement, TaggedNode } from "./tagged-content";

export { taggedSummary } from "./tagged-content";

interface RenderContext {
  prefix: string;
  nodes: Exclude<TaggedNode, string>[];
}

const INLINE_HTML = /^(?:a|abbr|b|br|code|del|em|i|kbd|mark|s|samp|small|span|strong|sub|sup|u)$/;

function markerNode(text: string, context: RenderContext): Exclude<TaggedNode, string> | undefined {
  if (!text.startsWith(context.prefix)) return undefined;
  const index = /^(\d+)\uE001/.exec(text.slice(context.prefix.length));
  return index ? context.nodes[Number(index[1])] : undefined;
}

function prepareNodes(nodes: TaggedNode[], context: RenderContext): string {
  return nodes.map((node) => {
    if (typeof node === "string") return node;
    const marker = `${context.prefix}${context.nodes.push(node) - 1}\uE001`;
    const block = node.kind === "literal" ? node.source.includes("\n") : node.kind === "protocol" || !INLINE_HTML.test(node.name);
    return block ? `\n\n${marker}\n\n` : marker;
  }).join("");
}

type Block =
  | { kind: "fence"; lang: string; code: string }
  | { kind: "tagged"; node: Exclude<TaggedNode, string> }
  | { kind: "heading"; level: number; text: string }
  | { kind: "hr" }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "para"; lines: string[] };

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_RE = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const CODE_RE = /^(`+)([\s\S]*?[^`])\1(?!`)/;
const BOLD_RE = /^\*\*([\s\S]+?)\*\*/;
const ITALIC_RE = /^\*(?![\s*])([^*\n]*[^\s*])\*/;
const STRIKE_RE = /^~~([\s\S]+?)~~/;
const LINK_RE = /^\[([^\]]*)\]\(([^)\s]+)\)/;
const URL_RE = /^https?:\/\/[^\s<>"'`]+/;
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function fenceLang(line: string): string | null {
  const m = FENCE_RE.exec(line);
  return m ? m[2].trim().split(/\s+/)[0] : null;
}

function isHr(line: string): boolean {
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(line.replace(/\s+/g, ""));
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((cell) => cell.trim());
}

function isTableSep(line: string): boolean {
  return line.includes("|") && splitRow(line).every((cell) => /^:?-+:?$/.test(cell));
}

function atBlockStart(lines: string[], j: number, context: RenderContext): boolean {
  const line = lines[j];
  if (line === undefined) return true;
  const t = line.trim();
  if (markerNode(t, context)) return true;
  if (t === "" || fenceLang(line) !== null || isHr(t) || HEADING_RE.test(t) || t.startsWith(">")) return true;
  if (UL_RE.test(line) || OL_RE.test(line)) return true;
  return t.includes("|") && j + 1 < lines.length && isTableSep(lines[j + 1]);
}

function parseBlocks(source: string, context: RenderContext): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t === "") { i++; continue; }
    const tagged = markerNode(t, context);
    if (tagged) { blocks.push({ kind: "tagged", node: tagged }); i++; continue; }

    const lang = fenceLang(line);
    if (lang !== null) {
      let j = i + 1;
      const opening = FENCE_RE.exec(line)!;
      const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`);
      while (j < lines.length && !closing.test(lines[j])) j++;
      blocks.push({ kind: "fence", lang, code: lines.slice(i + 1, j).join("\n") });
      i = j + 1; continue;
    }
    if (isHr(t)) { blocks.push({ kind: "hr" }); i++; continue; }

    const heading = HEADING_RE.exec(t);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      i++; continue;
    }

    if (t.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== "" && lines[j].includes("|")) j++;
      blocks.push({ kind: "table", head: splitRow(line), rows: lines.slice(i + 2, j).map(splitRow) });
      i = j; continue;
    }

    const ordered = OL_RE.test(line);
    const listRe = ordered ? OL_RE : UL_RE;
    let item = listRe.exec(line);
    if (item) {
      const start = ordered ? Number(item[1]) : 1;
      const items: string[] = [];
      let j = i;
      while (item) {
        items.push(ordered ? item[2] : item[1]);
        j++;
        item = j < lines.length ? listRe.exec(lines[j]) : null;
      }
      blocks.push({ kind: "list", ordered, start, items });
      i = j; continue;
    }

    if (t.startsWith(">")) {
      let j = i;
      while (j < lines.length && /^\s*>/.test(lines[j])) j++;
      blocks.push({ kind: "quote", text: lines.slice(i, j).map((q) => q.replace(/^\s*>\s?/, "")).join("\n") });
      i = j; continue;
    }

    let j = i + 1;
    while (j < lines.length && !atBlockStart(lines, j, context)) j++;
    blocks.push({ kind: "para", lines: lines.slice(i, j) });
    i = j;
  }
  return blocks;
}

function safeHref(raw: string): string | null {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? raw : null;
  } catch {
    return null;
  }
}

function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?]+$/, "");
  while (url.endsWith(")") && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) {
    url = url.slice(0, -1);
  }
  return url;
}

function inline(text: string, depth: number, context: RenderContext): ReactNode[] {
  const out: ReactNode[] = [];
  let buffer = "";
  let i = 0;
  const flush = (): void => {
    if (buffer.length > 0) {
      out.push(buffer);
      buffer = "";
    }
  };
  const anchor = (href: string, body: ReactNode): void => {
    flush();
    out.push(<a key={out.length} href={href} target="_blank" rel="noopener noreferrer">{body}</a>);
  };
  const emphasis = (tag: "strong" | "em" | "del", m: RegExpExecArray): void => {
    flush();
    out.push(createElement(tag, { key: out.length }, ...inline(m[1], depth + 1, context)));
    i += m[0].length;
  };

  while (i < text.length) {
    const rest = text.slice(i);
    const ch = rest[0];
    let m: RegExpExecArray | null;
    const tagged = markerNode(rest, context);
    if (tagged) {
      flush();
      out.push(<Fragment key={out.length}>{renderTag(tagged, depth, context)}</Fragment>);
      i = text.indexOf("\uE001", i) + 1;
      continue;
    }

    if (ch === "`" && (m = CODE_RE.exec(rest))) {
      flush();
      out.push(<code className="md-inline-code" key={out.length}>{m[2]}</code>);
      i += m[0].length;
      continue;
    }
    if (depth < 6) {
      if (ch === "*" && (m = BOLD_RE.exec(rest))) { emphasis("strong", m); continue; }
      if (ch === "*" && (m = ITALIC_RE.exec(rest))) { emphasis("em", m); continue; }
      if (ch === "~" && (m = STRIKE_RE.exec(rest))) { emphasis("del", m); continue; }

      const link = ch === "[" ? LINK_RE.exec(rest) : null;
      const href = link ? safeHref(link[2]) : null;
      if (link && href !== null) {
        anchor(href, inline(link[1], depth + 1, context));
        i += link[0].length;
        continue;
      }

      const bare = rest.startsWith("https://") || rest.startsWith("http://") ? URL_RE.exec(rest) : null;
      const url = bare ? trimUrl(bare[0]) : "";
      if (url.length > 8) {
        anchor(url, url);
        i += url.length;
        continue;
      }
    }
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = (): void => {
    const clipboard = navigator.clipboard;
    if (clipboard) void clipboard.writeText(code).catch(() => undefined);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-lang">{lang || "text"}</span>
        <button className="md-copy" type="button" onClick={onCopy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function renderBlocks(source: string, depth: number, context: RenderContext): ReactNode[] {
  const nodes: ReactNode[] = [];
  parseBlocks(source, context).forEach((block, bi) => {
    const key = `b${bi}`;
    switch (block.kind) {
      case "tagged":
        nodes.push(<Fragment key={key}>{renderTag(block.node, depth, context)}</Fragment>);
        return;
      case "fence":
        nodes.push(<CodeBlock key={key} lang={block.lang} code={block.code} />);
        return;
      case "heading":
        nodes.push(createElement(HEADING_TAGS[block.level - 1], { key }, ...inline(block.text, 0, context)));
        return;
      case "hr":
        nodes.push(<hr key={key} />);
        return;
      case "list": {
        const items = block.items.map((item, ii) => <li key={ii}>{inline(item, 0, context)}</li>);
        nodes.push(block.ordered ? <ol key={key} start={block.start}>{items}</ol> : <ul key={key}>{items}</ul>);
        return;
      }
      case "quote":
        nodes.push(
          <blockquote className="md-quote" key={key}>
            {depth < 6 ? renderBlocks(block.text, depth + 1, context) : <p>{inline(block.text, 0, context)}</p>}
          </blockquote>,
        );
        return;
      case "table": {
        const width = block.head.length;
        const row = (cells: string[], tag: "th" | "td", rowKey: number): ReactElement => (
          <tr key={rowKey}>
            {Array.from({ length: width }, (_, ci) => createElement(tag, { key: ci }, ...inline(cells[ci] ?? "", 0, context)))}
          </tr>
        );
        nodes.push(
          <table className="md-table" key={key}>
            <thead>{row(block.head, "th", 0)}</thead>
            <tbody>{block.rows.map((cells, ri) => row(cells, "td", ri))}</tbody>
          </table>,
        );
        return;
      }
      case "para":
        nodes.push(
          <p key={key}>
            {block.lines.map((line, li) => (
              <Fragment key={li}>
                {li > 0 ? <br /> : null}
                {inline(line, 0, context)}
              </Fragment>
            ))}
          </p>,
        );
        return;
    }
  });
  return nodes;
}

export function Markdown({ text }: { text: string }): ReactElement {
  let prefix = "\uE000";
  while (text.includes(prefix)) prefix += "\uE000";
  const context: RenderContext = { prefix, nodes: [] };
  return <div className="md">{renderBlocks(prepareNodes(parseTaggedContent(text), context), 0, context)}</div>;
}
