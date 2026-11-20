export type TaggedNode = string | TaggedElement | { kind: "literal"; source: string };

export interface TaggedElement {
  name: string;
  attributes: ReadonlyArray<readonly [string, string]>;
  children: TaggedNode[];
  kind: "html" | "protocol";
}

interface TagToken {
  start: number;
  end: number;
  name: string;
  attributes: Array<readonly [string, string]>;
  closing: boolean;
  selfClosing: boolean;
  match?: number;
}

const HTML_TAGS: Record<string, true> = {
  a: true, abbr: true, b: true, blockquote: true, br: true, code: true, dd: true, del: true,
  details: true, div: true, dl: true, dt: true, em: true, h1: true, h2: true, h3: true,
  h4: true, h5: true, h6: true, hr: true, i: true, kbd: true, li: true, mark: true,
  ol: true, p: true, pre: true, s: true, samp: true, small: true, span: true, strong: true,
  sub: true, summary: true, sup: true, table: true, tbody: true, td: true, th: true,
  thead: true, tr: true, u: true, ul: true,
};
const LITERAL_TAGS: Record<string, true> = {
  script: true, style: true, iframe: true, object: true, embed: true, svg: true, math: true,
  textarea: true, xmp: true, title: true, template: true, noscript: true, form: true,
  button: true, input: true, select: true, option: true, link: true, meta: true, base: true,
  img: true, video: true, audio: true, source: true, track: true, canvas: true,
};
const VOID_TAGS: Record<string, true> = {
  br: true, hr: true, img: true, input: true, link: true, meta: true, base: true,
  embed: true, source: true, track: true,
};
const OPEN_PROTOCOL_TAGS: Record<string, true> = {
  notice: true, reminder: true, context: true, task: true, result: true, results: true,
  warning: true, note: true, instructions: true, instruction: true, system: true,
  developer: true, user: true, assistant: true, analysis: true, thinking: true,
  response: true, answer: true, final: true, tool: true, tool_call: true, tool_result: true,
  task_result: true, "task-results": true, "system-reminder": true, system_reminder: true,
  "system-context": true, "project-context": true, environment: true, environment_context: true,
  environment_details: true, session_context: true, additional_context: true, important: true,
  critical: true, constraints: true, rules: true, policy: true, goal: true, contract: true,
  target: true, change: true, acceptance: true, completion: true, directives: true,
  workflow: true, workstation: true,
};

function isKnownProtocol(name: string): boolean {
  return Object.hasOwn(OPEN_PROTOCOL_TAGS, name) || /(?:^|[-_])(?:notice|reminder|notification|context|instructions?|results?|warning)$/.test(name);
}

// Parse attributes rather than handing untrusted markup to a browser/HTML parser.
function readTag(source: string, start: number): TagToken | null {
  const head = /^<(\/?)([a-z][a-z0-9:_-]*)\b/.exec(source.slice(start));
  if (!head) return null;
  let i = start + head[0].length;
  const attributes: Array<readonly [string, string]> = [];
  const closing = head[1] === "/";
  while (i < source.length) {
    const whitespace = /^\s*/.exec(source.slice(i))![0].length;
    i += whitespace;
    if (source[i] === ">" || source.startsWith("/>", i)) {
      const selfClosing = source[i] === "/";
      if (closing && (selfClosing || attributes.length > 0)) return null;
      return { start, end: i + (selfClosing ? 2 : 1), name: head[2], attributes, closing, selfClosing };
    }
    if (!whitespace || closing) return null;
    const attribute = /^[a-zA-Z_:][\w:.-]*/.exec(source.slice(i));
    if (!attribute) return null;
    const name = attribute[0];
    i += name.length;
    const afterName = i;
    const equals = i + /^\s*/.exec(source.slice(i))![0].length;
    let value = "";
    if (source[equals] === "=") {
      i = equals + 1;
      i += /^\s*/.exec(source.slice(i))![0].length;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const end = source.indexOf(quote, i + 1);
        if (end < 0) return null;
        value = source.slice(i + 1, end);
        i = end + 1;
      } else {
        const unquoted = /^[^\s<>`="']+/.exec(source.slice(i));
        if (!unquoted) return null;
        value = unquoted[0];
        i += value.length;
      }
    } else {
      i = afterName;
    }
    attributes.push([name, value]);
  }
  return null;
}

function codeEnd(source: string, start: number): number | null {
  // Fences are opaque, including unterminated streaming fences.
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  if (/^ {0,3}$/.test(source.slice(lineStart, start))) {
    const fence = /^(\x60{3,}|~{3,})[^\n]*(?:\n|$)/.exec(source.slice(start));
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`, "gm");
      close.lastIndex = start + fence[0].length;
      const match = close.exec(source);
      return match ? match.index + match[0].length : source.length;
    }
  }
  if (source[start] !== "`") return null;
  const delimiter = /^`+/.exec(source.slice(start))![0];
  let end = source.indexOf(delimiter, start + delimiter.length);
  while (end >= 0) {
    if (source[end - 1] !== "`" && source[end + delimiter.length] !== "`") return end + delimiter.length;
    end = source.indexOf(delimiter, end + delimiter.length);
  }
  return start + delimiter.length;
}

/** Recognizes balanced wrappers; bare placeholders and malformed markup stay literal. */
export function parseTaggedContent(source: string): TaggedNode[] {
  const tokens: TagToken[] = [];
  const stack: number[] = [];
  let opaque: string | null = null;
  for (let i = 0; i < source.length;) {
    if (!opaque) {
      const end = source[i] === "`" || source[i] === "~" ? codeEnd(source, i) : null;
      if (end !== null) { i = end; continue; }
      if (source[i] === "\\" && source[i + 1] === "<") { i += 2; continue; }
      if (source.startsWith("<!--", i)) {
        const end = source.indexOf("-->", i + 4);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
    }
    const token = source[i] === "<" ? readTag(source, i) : null;
    if (!token || (opaque && !(token.closing && token.name === opaque))) { i++; continue; }
    const index = tokens.length;
    tokens.push(token);
    i = token.end;
    if (token.closing) {
      let match = stack.length - 1;
      while (match >= 0 && tokens[stack[match]].name !== token.name) match--;
      if (match >= 0) {
        const opening = stack[match];
        tokens[opening].match = index;
        stack.length = match;
      }
      opaque = null;
    } else if (!token.selfClosing && !Object.hasOwn(VOID_TAGS, token.name)) {
      stack.push(index);
      if (token.name === "pre" || token.name === "code" || token.name === "file" || Object.hasOwn(LITERAL_TAGS, token.name)) opaque = token.name;
    }
  }

  const build = (start: number, end: number, first: number, depth: number): TaggedNode[] => {
    const nodes: TaggedNode[] = [];
    let cursor = start;
    for (let ti = first; ti < tokens.length && tokens[ti].start < end; ti++) {
      const token = tokens[ti];
      if (token.start < cursor || token.closing) continue;
      const closing = token.match === undefined ? undefined : tokens[token.match];
      const html = Object.hasOwn(HTML_TAGS, token.name);
      const known = isKnownProtocol(token.name);
      const paired = closing !== undefined && closing.end <= end;
      const metadata = token.name === "meta" && token.selfClosing && token.attributes.some(([name]) => name === "lines" || name === "size");
      const literal = Object.hasOwn(LITERAL_TAGS, token.name) && !metadata;
      const voidTag = Object.hasOwn(VOID_TAGS, token.name);
      const recognized = !literal && (paired || ((html || known || metadata) && (token.selfClosing || voidTag)) || (known && !token.selfClosing));
      const bodyEnd = paired ? closing.start : token.selfClosing || voidTag ? token.end : end;
      const elementEnd = paired ? closing.end : bodyEnd;
      if (literal || depth >= 48) {
        if (token.start > cursor) nodes.push(source.slice(cursor, token.start));
        nodes.push({ kind: "literal", source: source.slice(token.start, elementEnd) });
        cursor = elementEnd;
        if (paired) ti = token.match!;
        continue;
      }
      if (!recognized) continue;
      if (token.start > cursor) nodes.push(source.slice(cursor, token.start));
      const children = token.name === "pre" || token.name === "code" || token.name === "file"
        ? [source.slice(token.end, bodyEnd)]
        : build(token.end, bodyEnd, ti + 1, depth + 1);
      nodes.push({ name: token.name, attributes: token.attributes, children, kind: html ? "html" : "protocol" });
      cursor = elementEnd;
      if (paired) ti = token.match!;
      else if (elementEnd === end) break;
    }
    if (cursor < end) nodes.push(source.slice(cursor, end));
    return nodes;
  };
  return build(0, source.length, 0, 0);
}

export function taggedTitle(name: string): string {
  return name.replace(/[-_:]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Readable wrapper-free previews. Literal code/source and unknown malformed tags are retained. */
export function taggedSummary(text: string): string {
  const plain = (nodes: TaggedNode[]): string => nodes.map((node) => {
    if (typeof node === "string") return node;
    if (node.kind === "literal") return node.source;
    const body = plain(node.children);
    if (node.kind === "protocol") {
      const metadata = node.attributes.map(([key, value]) => value ? `${key}: ${value}` : key).join(" · ");
      return `\n${taggedTitle(node.name)}${metadata ? ` (${metadata})` : ""}\n${body}\n`;
    }
    if (node.name === "br" || node.name === "hr") return "\n";
    return `${body}${/^(?:details|summary|div|p|pre|blockquote|h[1-6]|li|tr)$/.test(node.name) ? "\n" : ""}`;
  }).join("");
  return plain(parseTaggedContent(text)).replace(/\n{3,}/g, "\n\n").trim();
}
