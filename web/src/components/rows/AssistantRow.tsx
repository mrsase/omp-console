import type { MessageRecord } from "../../protocol/types";
import { formatDuration, formatTokens } from "../../protocol/format";
import { useRow } from "../../store/hooks";
import { Markdown } from "../markdown";
import { ThinkingRow } from "./ThinkingRow";
import { ToolRow } from "./ToolRow";
import { Gutter, LaneTag } from "./shared";

function stopNote(stopReason: string | null | undefined): string | null {
  if (!stopReason || stopReason === "stop" || stopReason === "toolUse") return null;
  if (stopReason === "length") return "length";
  return stopReason;
}

function metaCells(record: MessageRecord): string[] {
  const cells: string[] = [];
  if (record.usage) cells.push(`${formatTokens(record.usage.total)} tok`);
  if (record.durationMs) cells.push(formatDuration(record.durationMs));
  return cells;
}

export function AssistantRow({
  threadId,
  messageKey,
  showTurn,
  modelName,
}: {
  threadId: string;
  messageKey: string;
  showTurn: boolean;
  modelName: string;
}) {
  const record = useRow(threadId, messageKey);
  if (!record) return null;
  const hasText = record.blocks.some((block) => block.kind === "text" && (block.text.length > 0 || block.chunks.length > 0));
  const showHead = hasText || !record.streaming;
  const note = stopNote(record.stopReason);
  return (
    <article
      className="row"
      data-lane="assistant"
      data-message-key={messageKey}
      data-anchor={`assistant:${record.timestamp ?? messageKey}`}
      data-kind="message"
      aria-label={`omp response, turn ${record.turn}`}
    >
      <Gutter timestamp={record.timestamp} turn={record.turn} showTurn={showTurn} />
      <span className="spine" aria-hidden="true" />
      <div className="content">
        {showHead ? (
          <div className="lane-head">
            <LaneTag lane="assistant">omp</LaneTag>
            <div className="lane-meta">
              {modelName ? <span className="truncate">{modelName}</span> : null}
              {metaCells(record).map((cell) => (
                <span key={cell}>{cell}</span>
              ))}
              {note ? <span className="stop-note">{note}</span> : null}
            </div>
          </div>
        ) : null}
        {record.blocks.map((block, index) => {
          if (block.kind === "text") {
            const text = block.text || block.chunks.join("");
            if (!text) return null;
            const streaming = record.streaming && block.streaming;
            return (
              <div key={`text:${index}`} className={`assistant-text${streaming ? " caret" : ""}`}>
                <Markdown text={text} />
              </div>
            );
          }
          if (block.kind === "thinking") {
            return <ThinkingRow key={`think:${index}`} block={block} />;
          }
          if (block.kind === "tool") {
            return <ToolRow key={`tool:${block.callId || index}`} block={block} />;
          }
          return null;
        })}
        {record.error ? (
          <div className="assistant-error" role="alert">
            <span aria-hidden="true">!</span>
            <span>{record.error}</span>
            {record.retryable ? <span className="hint">retry with Send</span> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
