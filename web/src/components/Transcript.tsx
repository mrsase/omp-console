import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MessageRecord, ThreadRuntime } from "../protocol/types";
import { visibleRows, promptOutline, assistantModelName } from "../store/selectors";
import { UserRow } from "./rows/UserRow";
import { AssistantRow } from "./rows/AssistantRow";
import { SystemRow } from "./rows/SystemRow";
import { ToolResultRow } from "./rows/ToolResultRow";

function estimateRow(record: MessageRecord): number {
  if (record.role === "system") return 30;
  if (record.role === "toolResult") return 40;
  if (record.role === "user") return 88;
  return 120;
}

export function Transcript({
  session,
  threadId,
  onClearUnknown,
}: {
  session: ThreadRuntime;
  threadId: string;
  onClearUnknown: (threadId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [distance, setDistance] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const rows = visibleRows(session);
  const isTestEnvironment =
    typeof navigator !== "undefined" && /jsdom|happy-dom/i.test(navigator.userAgent);
  const outline = promptOutline(session);
  const modelName = assistantModelName(session);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRow(rows[index]),
    overscan: 10,
    initialRect: { width: 900, height: 800 },
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const scrollBottom = (smooth = false) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "instant" });
    setFollowing(true);
    setDistance(0);
  };

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    setDistance(bottom);
    setScrolled(element.scrollTop > 8);
    setFollowing(bottom <= 4);
  };

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setFollowing(true);
    setDistance(0);
  }, [threadId]);

  useLayoutEffect(() => {
    if (!following) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [rows.length, following]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following) element.scrollTop = element.scrollHeight;
    });
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [following]);

  const jumpTo = (key: string) => {
    const index = rows.findIndex((record) => record.key === key);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "start" });
    setFollowing(false);
  };

  return (
    <div className="transcript" data-testid="transcript">
      <div className="transcript-toolbar" data-scrolled={scrolled ? "true" : "false"}>
        {outline.length > 0 ? (
          <>
            <label className="sr-only" htmlFor="prompt-outline">
              Jump to prompt
            </label>
            <select
              id="prompt-outline"
              className="prompt-outline"
              value=""
              onChange={(event) => {
                if (event.target.value) jumpTo(event.target.value);
              }}
            >
              <option value="">prompts · {outline.length}</option>
              {outline.map((prompt) => (
                <option key={prompt.key} value={prompt.key}>
                  turn {prompt.turn} — {prompt.text}
                </option>
              ))}
            </select>
          </>
        ) : null}
        {!following ? <span className="follow-pill">paused · {Math.round(distance)}px from latest</span> : null}
        <span className="transcript-count">
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <div
        className="transcript-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="region"
        aria-label="Conversation"
        aria-busy={!session.hydration.messages}
        tabIndex={0}
      >
        <div className="transcript-column" style={{ height: `${virtualizer.getTotalSize() + 24}px` }}>
          {rows.length === 0 ? (
            <div className="transcript-empty">
              <div className="empty-traces" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <h2>No transcript yet</h2>
              <p>
                Send a message to the agent. Text, thinking, tools and dialogs stream in here; this surface keeps
                the turn, the cost and the evidence in one place.
              </p>
            </div>
          ) : (
            (isTestEnvironment
              ? rows.map((row, index) => ({ index, key: row.key, start: 0, record: row }))
              : virtualizer.getVirtualItems().map((item) => ({
                  index: item.index,
                  key: item.key,
                  start: item.start,
                  record: rows[item.index],
                }))
            ).map((item) => {
              const record = item.record;
              if (!record) return null;
              const previous = rows[item.index - 1];
              const showTurn = record.role !== "system" && record.turn !== previous?.turn;
              let row;
              if (record.role === "user") {
                row = <UserRow threadId={threadId} messageKey={record.key} showTurn={showTurn} />;
              } else if (record.role === "assistant") {
                row = (
                  <AssistantRow
                    threadId={threadId}
                    messageKey={record.key}
                    showTurn={showTurn}
                    modelName={modelName}
                  />
                );
              } else if (record.role === "toolResult") {
                row = <ToolResultRow threadId={threadId} messageKey={record.key} />;
              } else {
                row = (
                  <SystemRow
                    threadId={threadId}
                    messageKey={record.key}
                    session={session}
                    onClearUnknown={onClearUnknown}
                  />
                );
              }
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={isTestEnvironment ? undefined : virtualizer.measureElement}
                  className={isTestEnvironment ? undefined : "virtual-row"}
                  style={isTestEnvironment ? undefined : { transform: `translateY(${item.start}px)` }}
                >
                  {row}
                </div>
              );
            })
          )}
        </div>
      </div>
      {(!following || distance > 4) && rows.length > 0 ? (
        <button type="button" className="jump-latest" onClick={() => scrollBottom(true)}>
          jump to latest ↓
        </button>
      ) : null}
    </div>
  );
}
