import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown, taggedSummary } from "../lib/markdown";
import { formatDuration, formatTokens, truncate } from "../lib/format";
import { isObject } from "../lib/json";
import type {
  Block,
  ThreadState,
  ToolResult,
  ToolRun,
  UIMessage,
} from "../lib/types";
import { Icon } from "./Icons";

type TextBlock = Extract<Block, { kind: "text" }>;
type ThinkingBlockType = Extract<Block, { kind: "thinking" }>;
type ToolCallBlock = Extract<Block, { kind: "toolCall" }>;
type ImageBlock = Extract<Block, { kind: "image" }>;

export function Transcript({ thread }: { thread: ThreadState }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<{ key?: string; id?: string; offset: number; scrollTop: number } | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [readingMode, setReadingMode] = useState(false);
  const [expandedPrompts, setExpandedPrompts] = useState<ReadonlySet<string>>(() => new Set());
  const togglePrompt = useCallback((key: string) => {
    setExpandedPrompts((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const scrollId = useId();

  const captureAnchor = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    if (stick.current) {
      anchor.current = null;
      return;
    }
    const top = element.getBoundingClientRect().top;
    let entry: Element | undefined;
    const children = content.current?.children;
    for (let index = 0; children && index < children.length; index++) {
      const child = children[index];
      if (child.getBoundingClientRect().bottom > top) {
        entry = child;
        break;
      }
    }
    anchor.current = {
      key: entry?.getAttribute("data-message-key") ?? undefined,
      id: entry?.getAttribute("data-message-anchor") ?? undefined,
      offset: entry ? entry.getBoundingClientRect().top - top : 0,
      scrollTop: element.scrollTop,
    };
  }, []);

  const syncScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    if (stick.current) {
      element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    } else if (anchor.current) {
      // History hydration may replace live keys or prepend older messages.
      // Preserve the visible message, not its old absolute scroll position.
      const saved = anchor.current;
      let entry: Element | undefined;
      const children = content.current?.children;
      if (saved.key && children) {
        for (const child of children) {
          if (child.getAttribute("data-message-key") === saved.key) {
            entry = child;
            break;
          }
        }
      }
      for (let index = 0; !entry && saved.id && children && index < children.length; index++) {
        const child = children[index];
        if (child.getAttribute("data-message-anchor") === saved.id) {
          entry = child;
          break;
        }
      }
      const top = entry
        ? element.scrollTop + entry.getBoundingClientRect().top -
          element.getBoundingClientRect().top - saved.offset
        : saved.scrollTop;
      element.scrollTo({ top, behavior: "instant" });
    }
    setShowLatest(
      element.scrollHeight - element.scrollTop - element.clientHeight > 4,
    );
    captureAnchor();
  }, [captureAnchor]);

  useLayoutEffect(() => {
    stick.current = true;
    anchor.current = null;
    syncScroll();
  }, [thread.info.id, syncScroll]);

  useLayoutEffect(() => {
    syncScroll();
  }, [thread.messages, thread.toolRuns, thread.toolResults, syncScroll]);

  useLayoutEffect(() => {
    // Images, expanded tool output, and viewport changes can resize the
    // transcript without a new message arriving.
    const observer = new ResizeObserver(syncScroll);
    if (content.current) observer.observe(content.current);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, [thread.info.id, syncScroll]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const away =
      element.scrollHeight - element.scrollTop - element.clientHeight > 4;
    stick.current = !away;
    setShowLatest(away);
    captureAnchor();
  };

  const pauseFollowing = () => {
    stick.current = false;
    captureAnchor();
  };

  const jumpToLatest = () => {
    stick.current = true;
    syncScroll();
    scroller.current?.focus({ preventScroll: true });
  };

  const callIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of thread.messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.blocks) {
        if (block.kind === "toolCall" && block.id) ids.add(block.id);
      }
    }
    return ids;
  }, [thread.messages]);

  const orphanRuns = Object.values(thread.toolRuns).filter(
    (run) => !callIds.has(run.id),
  );
  const awaitingHistory =
    !thread.messages.length &&
    thread.info.status !== "exited" &&
    (thread.info.status === "starting" ||
      !thread.session ||
      (thread.session.messageCount ?? 0) > 0);
  const prompts = useMemo(
    () => thread.messages.filter((message) => message.role === "user"),
    [thread.messages],
  );

  const collapsePrompts = () => {
    pauseFollowing();
    const key = anchor.current?.key;
    const element = scroller.current;
    if (key && expandedPrompts.has(key) && element) {
      const entry = [...(content.current?.children ?? [])].find(
        (child) => child.getAttribute("data-message-key") === key,
      );
      if (entry) element.scrollTop += entry.getBoundingClientRect().top - element.getBoundingClientRect().top;
      captureAnchor();
    }
    element?.focus({ preventScroll: true });
    setExpandedPrompts(new Set());
  };

  return (
    <div className="transcript-region" onKeyDown={(event) => {
      if (event.key === "Escape" && readingMode) {
        event.preventDefault();
        setReadingMode(false);
      }
    }}>
      {thread.messages.length > 0 && (
        <div className="transcript-nav">
          <details className="transcript-history">
            <summary>History · {prompts.length} {prompts.length === 1 ? "prompt" : "prompts"}</summary>
            <div className="transcript-history-panel">
              <select
                className="select"
                aria-label="Jump to a prompt"
                value=""
                onChange={(event) => {
                  const element = scroller.current;
                  const entry = [...(content.current?.children ?? [])].find(
                    (child) => child.getAttribute("data-message-key") === event.target.value,
                  );
                  if (!element || !entry) return;
                  const history = event.currentTarget.closest("details");
                  if (history) history.open = false;
                  stick.current = false;
                  element.scrollTop += entry.getBoundingClientRect().top - element.getBoundingClientRect().top;
                  captureAnchor();
                  setShowLatest(true);
                  element.focus({ preventScroll: true });
                }}
              >
                <option value="">Jump to a prompt…</option>
                {prompts.map((message, index) => (
                  <option key={message.key} value={message.key}>
                    {index + 1}. {truncate(taggedSummary(textOf(message)).replace(/\s+/g, " "), 100) || "Image attachment"}
                  </option>
                ))}
              </select>
              <span>{thread.messages.length} messages</span>
              {expandedPrompts.size > 0 && (
                <button type="button" className="btn btn-small btn-ghost transcript-collapse"
                  aria-controls={scrollId} onClick={collapsePrompts}>
                  Collapse prompts
                </button>
              )}
            </div>
          </details>
          {showLatest && (
            <button type="button" className="btn btn-small btn-ghost transcript-latest"
              aria-controls={scrollId} onClick={jumpToLatest}>
              <Icon name="chevron-down" size={12} /> Latest
            </button>
          )}
          <button type="button" className="btn btn-ghost transcript-read"
            aria-pressed={readingMode}
            title={readingMode ? "Restore header and composer (Escape)" : "Hide header and composer to focus on the conversation"}
            onClick={() => {
              pauseFollowing();
              setReadingMode((value) => !value);
            }}>
            {readingMode ? "Exit reading mode" : "Reading mode"}
          </button>
        </div>
      )}
      <div
        id={scrollId}
        className="transcript-scroll"
        ref={scroller}
        role="region"
        aria-label="Conversation"
        aria-busy={awaitingHistory}
        tabIndex={0}
        onScroll={onScroll}
        onWheel={(event) => {
          if (event.deltaY < 0) pauseFollowing();
        }}
        onTouchMove={pauseFollowing}
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pauseFollowing();
        }}
        onClickCapture={(event) => {
          if (event.target instanceof Element && event.target.closest("button, summary")) {
            pauseFollowing();
            const promptToggle = event.target.closest(".user-prompt-toggle");
            const entry = promptToggle?.closest(".transcript-entry");
            const element = scroller.current;
            if (entry && element) {
              // A disclosure changes the prompt below this stable starting point.
              element.scrollTop += entry.getBoundingClientRect().top - element.getBoundingClientRect().top;
              captureAnchor();
            }
          }
        }}
      >
        <div className="transcript" ref={content}>
          {!thread.messages.length ? (
            <div className="transcript-empty">
              <div className="transcript-empty-mark" aria-hidden="true">o</div>
              <h2>{awaitingHistory ? "Loading conversation…" : "Ready when you are."}</h2>
              {awaitingHistory ? (
                <p>Messages will appear here when the session is ready.</p>
              ) : (
                <p>
                  Describe the task, paste a screenshot, or type <code>/</code> for
                  commands.
                </p>
              )}
            </div>
          ) : (
            <>
              {thread.messages.map((message) => {
                if (message.role === "toolResult" && message.toolCallId && callIds.has(message.toolCallId)) {
                  return null;
                }
                return (
                  <MessageView
                    key={message.key}
                    message={message}
                    results={thread.toolResults}
                    runs={thread.toolRuns}
                    expanded={expandedPrompts.has(message.key)}
                    onTogglePrompt={togglePrompt}
                  />
                );
              })}
              {orphanRuns.map((run) => (
                <RunCard key={run.id} run={run} />
              ))}
              <div className="transcript-tail" aria-hidden="true" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type MessageViewProps = {
  message: UIMessage;
  results: Record<string, ToolResult>;
  runs: Record<string, ToolRun>;
  expanded: boolean;
  onTogglePrompt: (key: string) => void;
};

const MessageView = memo(function MessageView(props: MessageViewProps) {
  const view = messageView(props);
  if (!view) return null;
  return (
    <div
      className="transcript-entry"
      data-message-anchor={`${props.message.role}:${props.message.timestamp}`}
      data-message-key={props.message.key}
    >
      {view}
    </div>
  );
});

function messageView({ message, results, runs, expanded, onTogglePrompt }: MessageViewProps) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} expanded={expanded} onToggle={onTogglePrompt} />;
    case "assistant":
      return <AssistantMessage message={message} results={results} runs={runs} />;
    case "toolResult":
      return <StandaloneResult message={message} />;
    case "bashExecution":
    case "pythonExecution":
      return <TerminalMessage message={message} />;
    case "compactionSummary":
      return (
        <DividerCard
          label="Context compacted"
          text={textOf(message)}
          icon="archive"
        />
      );
    case "branchSummary":
      return <DividerCard label="Branch summary" text={textOf(message)} icon="branch" />;
    case "command":
      return (
        <div className="command-output">
          <pre>{textOf(message)}</pre>
        </div>
      );
    case "custom":
    case "hookMessage":
      if (!textOf(message).trim()) return null;
      return (
        <details className="custom-card">
          <summary className="custom-label">{message.customType ?? "Extension context"}</summary>
          <Markdown text={textOf(message)} />
        </details>
      );
    case "fileMention":
      return (
        <div className="file-mention">
          <Icon name="paperclip" size={12} />
          <span>{truncate(textOf(message), 120)}</span>
        </div>
      );
    case "developer":
      return null;
    default:
      return (
        <div className="unknown-message">
          <div className="unknown-role">{message.role}</div>
          {message.blocks.map((block, index) =>
            block.kind === "text" ? (
              <Markdown key={index} text={block.text} />
            ) : null,
          )}
        </div>
      );
  }
}

function UserMessage({ message, expanded, onToggle }: {
  message: UIMessage;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const promptId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const images = message.blocks.filter(
    (block): block is ImageBlock => block.kind === "image",
  );
  const text = message.blocks
    .filter((block): block is TextBlock => block.kind === "text")
    .map((block) => block.text)
    .join("\n");
  const lengthy = text.length > 1200 || text.split("\n").length > 12;
  const collapsed = lengthy && !expanded;
  const promptPreview = useMemo(
    () => collapsed ? taggedSummary(text).slice(0, 600).split("\n").slice(0, 8).join("\n") : "",
    [collapsed, text],
  );
  return (
    <div className="msg user">
      <div className="bubble">
        {text && (
          <div className="user-prompt">
            {lengthy && (
              <button
                type="button"
                ref={toggle}
                className="user-prompt-toggle btn btn-small btn-ghost"
                aria-expanded={!collapsed}
                aria-controls={promptId}
                onClick={() => onToggle(message.key)}
              >
                <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
                {collapsed ? `Show full prompt · ${text.length.toLocaleString()} characters` : "Collapse prompt"}
              </button>
            )}
            {collapsed && <div className="user-prompt-preview">{promptPreview}…</div>}
            <div id={promptId} className="user-prompt-content" hidden={collapsed}>
              <Markdown text={text} />
            </div>
            {lengthy && expanded && (
              <button
                type="button"
                className="user-prompt-toggle btn btn-small btn-ghost"
                aria-expanded
                aria-controls={promptId}
                onClick={() => {
                  toggle.current?.focus({ preventScroll: true });
                  onToggle(message.key);
                }}
              >
                <Icon name="chevron-right" size={12} /> Collapse prompt
              </button>
            )}
          </div>
        )}
        {images.length > 0 && (
          <div className="image-row">
            {images.map((image, index) => (
              <img
                className="msg-image"
                key={index}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={`User attachment ${index + 1}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  results,
  runs,
}: {
  message: UIMessage;
  results: Record<string, ToolResult>;
  runs: Record<string, ToolRun>;
}) {
  const hasText = message.blocks.some(
    (block) => block.kind === "text" && block.text.trim().length > 0,
  );
  return (
    <div className={`msg assistant ${message.streaming ? "streaming" : ""}`}>
      <div className="avatar" aria-hidden="true">o</div>
      <div className="assistant-body">
        {message.blocks.map((block, index) => {
          switch (block.kind) {
            case "text":
              if (!block.text.trim()) return null;
              return <Markdown key={index} text={block.text} />;
            case "thinking":
              return <Thinking key={index} block={block} />;
            case "toolCall":
              return (
                <ToolCard
                  key={block.id || `call-${index}`}
                  call={block}
                  result={block.id ? results[block.id] : undefined}
                  run={block.id ? runs[block.id] : undefined}
                />
              );
            case "image":
              return (
                <img
                  key={index}
                  className="msg-image"
                  src={`data:${block.mimeType};base64,${block.data}`}
                  alt="model output"
                />
              );
            default:
              return (
                <span className="unknown-block" key={index}>
                  {block.label}
                </span>
              );
          }
        })}

        {message.streaming && !hasText && !message.blocks.length && (
          <div className="thinking-live">
            <span className="spinner tiny" />
            Thinking…
          </div>
        )}

        {message.streaming && hasText && <span className="caret" />}

        {message.stopReason === "aborted" &&
          !message.blocks.some(
            (block) =>
              (block.kind === "text" && block.text.trim()) ||
              block.kind === "toolCall",
          ) && <div className="message-stopped">Stopped</div>}

        {message.error && (
          <div className="message-error">
            <Icon name="alert" size={13} />
            {message.error}
          </div>
        )}

        {!message.streaming && message.role === "assistant" && (
          <AssistantMeta message={message} />
        )}
      </div>
    </div>
  );
}

function AssistantMeta({ message }: { message: UIMessage }) {
  const parts: string[] = [];
  if (message.model) parts.push(message.model);
  if (message.usage?.totalTokens) {
    parts.push(`${formatTokens(message.usage.totalTokens)} tok`);
  }
  if (message.duration) parts.push(formatDuration(message.duration));
  if (message.stopReason && message.stopReason !== "stop") {
    parts.push(message.stopReason);
  }
  if (!parts.length) return null;
  return <div className="assistant-meta">{parts.join(" · ")}</div>;
}

function Thinking({ block }: { block: ThinkingBlockType }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className={`thinking ${block.done ? "done" : "live"}`}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
      >
        <span className={block.done ? "thinking-dot" : "thinking-dot pulse"} aria-hidden="true" />
        <span>{block.done ? "Thought" : "Thinking"}</span>
        <span className="thinking-count">{formatTokens(block.text.length)} chars</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={11} />
      </button>
      {open && <pre id={bodyId} className="thinking-body">{block.text}</pre>}
    </div>
  );
}

function ToolCard({
  call,
  result,
  run,
}: {
  call: ToolCallBlock;
  result?: ToolResult;
  run?: ToolRun;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const bodyId = useId();
  const outputId = useId();
  const text = result?.text ?? run?.text ?? run?.partial ?? "";
  const pending = !result && (!run || !run.endedAt);
  const isError = result?.isError === true || run?.isError === true;
  const summary = toolSummary(call.name, call.args, call.argsText);
  const elapsed =
    run?.endedAt !== undefined ? run.endedAt - run.startedAt : undefined;

  return (
    <div className={`tool ${open ? "open" : ""} ${isError ? "error" : ""}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
      >
        <span
          className={`tool-status ${pending ? "running" : isError ? "error" : "ok"}`}
          role="img"
          aria-label={pending ? "Running" : isError ? "Failed" : "Completed"}
        >
          {pending ? (
            <span className="spinner tiny" />
          ) : isError ? (
            <Icon name="x" size={10} />
          ) : (
            <Icon name="check" size={10} />
          )}
        </span>
        <span className="tool-name">{call.name}</span>
        <span className="tool-summary">{summary}</span>
        {elapsed !== undefined && (
          <span className="tool-time">{formatDuration(elapsed)}</span>
        )}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>

      {open && (
        <div id={bodyId} className="tool-body">
          {call.argsText && (
            <>
              <div className="tool-label">Arguments</div>
              <pre className="tool-args">{call.argsText}</pre>
            </>
          )}
          {text && (
            <>
              <div className="tool-label">Output</div>
              <pre id={outputId} className="tool-output">
                {showAll || text.length <= 6000 ? text : `${text.slice(0, 6000)}\n…`}
              </pre>
              {text.length > 6000 && (
                <button
                  type="button"
                  aria-expanded={showAll}
                  aria-controls={outputId}
                  className="btn btn-small btn-ghost"
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll ? "Show less" : "Show all"}
                </button>
              )}
            </>
          )}
          {result?.images.map((image, index) => (
            <img
              key={index}
              className="tool-image"
              src={`data:${image.mimeType};base64,${image.data}`}
              alt="tool output"
            />
          ))}
          {pending && !text && (
            <div className="tool-running">
              <span className="spinner tiny" /> Running…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunCard({ run }: { run: ToolRun }) {
  const call: ToolCallBlock = {
    kind: "toolCall",
    id: run.id,
    name: run.name,
    args: run.args,
    argsText:
      typeof run.args === "string" ? run.args : JSON.stringify(run.args ?? {}, null, 2),
    done: true,
  };
  return (
    <div className="msg assistant">
      <div className="avatar" aria-hidden="true">o</div>
      <div className="assistant-body">
        <ToolCard call={call} run={run} />
      </div>
    </div>
  );
}

function StandaloneResult({ message }: { message: UIMessage }) {
  const name = message.toolName ?? "tool";
  return (
    <ToolCard
      call={{
        kind: "toolCall", id: message.toolCallId ?? message.key,
        name, args: {}, argsText: "", done: true,
      }}
      result={{
        toolCallId: message.toolCallId ?? message.key,
        name,
        text: textOf(message),
        images: message.blocks.filter((block): block is ImageBlock => block.kind === "image"),
        isError: message.isError === true,
      }}
    />
  );
}

function TerminalMessage({ message }: { message: UIMessage }) {
  const [open, setOpen] = useState(false);
  const outputId = useId();
  const output = message.output ?? "";
  return (
    <div className={`terminal ${message.isError ? "error" : ""}`}>
      <button
        type="button"
        className="terminal-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? outputId : undefined}
      >
        <Icon name="terminal" size={13} />
        <span className="terminal-command">
          {message.command || (message.role === "pythonExecution" ? "Python execution" : "Shell execution")}
        </span>
        {message.exitCode !== undefined && (
          <span className={`terminal-code ${message.isError ? "bad" : ""}`}>
            exit {message.exitCode}
          </span>
        )}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {open && (
        <pre id={outputId} className="terminal-output">{output || "(no output)"}</pre>
      )}
    </div>
  );
}

function DividerCard({
  label,
  text,
  icon,
}: {
  label: string;
  text: string;
  icon: "archive" | "branch";
}) {
  return (
    <details className="divider-card">
      <summary>
        <Icon name={icon} size={12} />
        {label}
      </summary>
      {text && <Markdown text={text} />}
    </details>
  );
}

function textOf(message: UIMessage): string {
  return message.blocks
    .filter((block): block is TextBlock => block.kind === "text")
    .map((block) => block.text)
    .join("\n");
}


function toolSummary(name: string, args: unknown, raw: string): string {
  if (isObject(args)) {
    const pick = (key: string): string | undefined =>
      typeof args[key] === "string" ? (args[key] as string) : undefined;
    switch (name) {
      case "bash":
        return truncate(pick("command") ?? raw, 110);
      case "read":
      case "write":
      case "edit":
      case "ast_edit":
        return pick("path") ?? raw;
      case "grep":
      case "ast_grep":
        return `/${pick("pattern") ?? pick("query") ?? ""}/ ${
          pick("path") ?? ""
        }`.trim();
      case "glob":
      case "find":
        return `${pick("pattern") ?? ""} ${pick("path") ?? ""}`.trim();
      case "task":
        return truncate(pick("description") ?? "", 110);
      case "web_search":
        return truncate(pick("query") ?? "", 110);
      case "todo":
        return "update plan";
      default:
        break;
    }
    const first = Object.entries(args).find(([, value]) => typeof value === "string");
    if (first) return truncate(String(first[1]), 110);
  }
  return truncate(raw, 110);
}
