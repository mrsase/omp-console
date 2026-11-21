import { useState } from "react";
import type { ToolBlock } from "../../protocol/types";
import { formatDuration } from "../../protocol/format";
import { useNow } from "../hooks";

const PATH_TOOLS: Record<string, true> = {
  read: true,
  write: true,
  edit: true,
  ast_edit: true,
  apply_patch: true,
};

const GLOB_TOOLS: Record<string, true> = { glob: true, find: true };

function firstString(args: Record<string, unknown>): string | null {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function toolSummary(block: ToolBlock): string {
  const args = block.args ?? {};
  const name = block.name;
  if (name === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    return command.length > 110 ? `${command.slice(0, 109)}…` : command;
  }
  if (PATH_TOOLS[name]) {
    const path = args.path ?? args.file_path ?? args.file ?? args.target;
    if (typeof path === "string") return path;
  }
  if (name === "grep" || name === "ast_grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    const path = typeof args.path === "string" ? args.path : "";
    return `/${pattern}/ ${path}`.trim();
  }
  if (GLOB_TOOLS[name]) {
    const pattern = typeof args.pattern === "string" ? args.pattern : typeof args.glob === "string" ? args.glob : "";
    const path = typeof args.path === "string" ? args.path : "";
    return `${pattern} ${path}`.trim();
  }
  if (name === "task") {
    const description = args.description ?? args.intent ?? args.prompt;
    if (typeof description === "string") return description.length > 110 ? `${description.slice(0, 109)}…` : description;
  }
  if (name === "web_search") {
    const query = args.query ?? args.q;
    if (typeof query === "string") return query;
  }
  if (name === "ask") return "question";
  const first = firstString(args);
  if (first) return first.length > 110 ? `${first.slice(0, 109)}…` : first;
  const text = block.argsText || block.partialArgs;
  return text.replace(/\s+/g, " ").slice(0, 110);
}

export function ToolRow({ block }: { block: ToolBlock }) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [expandLines, setExpandLines] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [mountedAt] = useState(() => Date.now());
  const now = useNow(250, block.state === "running");
  const elapsed = block.state === "running" ? now - mountedAt : null;
  const output = block.output || "";
  const lineCount = output ? output.split("\n").length : 0;
  const tooLong = output.length > 6000;
  const tooManyLines = lineCount > 40;
  let visibleOutput = output;
  if (tooLong && !showAll) visibleOutput = output.slice(0, 6000);
  else if (tooManyLines && !expandLines) visibleOutput = output.split("\n").slice(0, 12).join("\n");
  const duration = block.state === "running" ? elapsed : block.durationMs;
  return (
    <div className="tool" data-lane="tool">
      <button
        type="button"
        className="tool-row"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tool-status" data-state={block.state} aria-label={block.state}>
          {block.state === "running" ? <span className="tool-spinner" /> : block.state === "error" ? "×" : "✓"}
        </span>
        <span className="tool-name">{block.name || "tool"}</span>
        <span className="tool-summary">{toolSummary(block)}</span>
        {duration !== null && duration !== undefined ? (
          <span className="tool-duration">{formatDuration(duration)}</span>
        ) : null}
        {block.state === "error" ? <span className="tool-error-tag">error</span> : null}
        <span className="tool-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {expanded ? (
        <div className="tool-inspector">
          <div className="tool-pane">
            <span className="tool-pane-label">arguments</span>
            <pre className="tool-pre">
              {block.argsText || (Object.keys(block.args).length > 0 ? JSON.stringify(block.args, null, 2) : "—")}
            </pre>
          </div>
          <div className="tool-pane">
            <span className="tool-pane-label">output</span>
            <pre className="tool-pre" data-lines={tooManyLines && !expandLines ? "12" : undefined}>
              {visibleOutput || "—"}
            </pre>
            {tooLong && !showAll ? (
              <button className="tool-disclosure" type="button" onClick={() => setShowAll(true)}>
                show all ({output.length.toLocaleString()} chars)
              </button>
            ) : null}
            {tooManyLines && !expandLines ? (
              <button className="tool-disclosure" type="button" onClick={() => setExpandLines(true)}>
                expand ({lineCount} lines)
              </button>
            ) : null}
            {showAll && tooLong ? (
              <button className="tool-disclosure" type="button" onClick={() => setShowAll(false)}>
                cap at 6,000
              </button>
            ) : null}
            {block.details !== undefined && block.details !== null ? (
              <>
                <button className="tool-disclosure" type="button" onClick={() => setShowRaw((value) => !value)}>
                  {showRaw ? "hide raw" : "raw"}
                </button>
                {showRaw ? <pre className="tool-pre">{JSON.stringify(block.details, null, 2)}</pre> : null}
              </>
            ) : null}
          </div>
          {block.images.length > 0 ? (
            <div className="tool-images">
              {block.images.map((image, index) => (
                <img
                  key={index}
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`Tool image ${index + 1}`}
                  loading="lazy"
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
