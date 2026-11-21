import { Fragment, type ReactNode } from "react";

const SAFE_SCHEME = /^(https?:|mailto:)/i;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}:${index}`;
    index += 1;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        const label = link[1];
        const href = link[2].trim();
        if (SAFE_SCHEME.test(href)) {
          nodes.push(
            <a key={key} href={href} rel="noreferrer noopener" target="_blank">
              {label}
            </a>,
          );
        } else {
          nodes.push(label);
        }
      } else {
        nodes.push(token);
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

interface Block {
  kind: "paragraph" | "heading" | "code" | "list" | "quote";
  level?: number;
  lines: string[];
  ordered?: boolean;
}

export function Markdown({ text }: { text: string }) {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", lines: body });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, lines: [heading[2]] });
      index += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const body: string[] = [];
      while (index < lines.length && (/^\s*[-*]\s+/.test(lines[index]) || /^\s*\d+\.\s+/.test(lines[index]))) {
        body.push(lines[index].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "list", lines: body, ordered });
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        body.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    const body: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !lines[index].startsWith("```") &&
      !/^(#{1,4})\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !lines[index].startsWith(">")
    ) {
      body.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: body });
  }

  return (
    <div className="md">
      {blocks.map((block, blockIndex) => {
        const key = `block:${blockIndex}`;
        if (block.kind === "code") {
          return (
            <pre key={key}>
              <code>{block.lines.join("\n")}</code>
            </pre>
          );
        }
        if (block.kind === "heading") {
          const level = Math.min(4, Math.max(1, block.level ?? 1));
          const content = inline(block.lines[0] ?? "", key);
          if (level === 1) return <h1 key={key}>{content}</h1>;
          if (level === 2) return <h2 key={key}>{content}</h2>;
          if (level === 3) return <h3 key={key}>{content}</h3>;
          return <h4 key={key}>{content}</h4>;
        }
        if (block.kind === "list") {
          const items = block.lines.map((line, itemIndex) => (
            <li key={`${key}:${itemIndex}`}>{inline(line, `${key}:${itemIndex}`)}</li>
          ));
          return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
        }
        if (block.kind === "quote") {
          return (
            <blockquote key={key}>
              {block.lines.map((line, lineIndex) => (
                <Fragment key={`${key}:${lineIndex}`}>
                  {lineIndex > 0 ? <br /> : null}
                  {inline(line, `${key}:${lineIndex}`)}
                </Fragment>
              ))}
            </blockquote>
          );
        }
        return (
          <p key={key}>
            {block.lines.map((line, lineIndex) => (
              <Fragment key={`${key}:${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {inline(line, `${key}:${lineIndex}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
