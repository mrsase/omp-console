import { useState } from "react";
import { useRow } from "../../store/hooks";
import { Gutter } from "./shared";

export function ToolResultRow({
  threadId,
  messageKey,
}: {
  threadId: string;
  messageKey: string;
}) {
  const record = useRow(threadId, messageKey);
  const [expanded, setExpanded] = useState(false);
  if (!record) return null;
  const text = record.blocks.map((block) => (block.kind === "text" ? block.text : "")).join("");
  return (
    <article
      className="row"
      data-lane="tool"
      data-message-key={messageKey}
      data-anchor={`tool:${record.timestamp ?? messageKey}`}
      data-kind="message"
      aria-label={`Tool result ${record.toolName ?? ""}`}
    >
      <Gutter timestamp={record.timestamp} turn={record.turn} showTurn={false} />
      <span className="spine" aria-hidden="true" />
      <div className="content">
        <button type="button" className="tool-row" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <span className="tool-status" data-state={record.isError ? "error" : "done"}>
            {record.isError ? "×" : "✓"}
          </span>
          <span className="tool-name">{record.toolName || "tool"}</span>
          <span className="tool-summary">{text.split("\n")[0] || "result"}</span>
          <span className="tool-chevron" aria-hidden="true">
            ›
          </span>
        </button>
        {expanded ? <pre className="tool-pre">{text || "—"}</pre> : null}
      </div>
    </article>
  );
}
