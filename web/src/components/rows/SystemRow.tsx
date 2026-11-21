import { useState } from "react";
import type { ThreadRuntime } from "../../protocol/types";
import { useRow } from "../../store/hooks";
import { Gutter } from "./shared";

function glyph(tone: string): string {
  if (tone === "warn") return "◆";
  if (tone === "err") return "✕";
  if (tone === "ok") return "✓";
  return "◇";
}

export function SystemRow({
  threadId,
  messageKey,
  session,
  onClearUnknown,
}: {
  threadId: string;
  messageKey: string;
  session: ThreadRuntime;
  onClearUnknown?: (threadId: string) => void;
}) {
  const record = useRow(threadId, messageKey);
  const [expanded, setExpanded] = useState(false);
  if (!record?.system) return null;
  const row = record.system;
  const isTurn = row.label === "turn";
  const unknown = isTurn ? null : session.unknown;
  const drawer = row.kind === "unknown" || row.kind === "lagged";
  return (
    <article
      className="row"
      data-lane="system"
      data-message-key={messageKey}
      data-anchor={`system:${record.timestamp ?? messageKey}`}
      data-kind={isTurn ? "turn" : "system"}
      aria-label={`System event ${row.label}`}
    >
      <Gutter timestamp={record.timestamp} turn={record.turn} showTurn={false} />
      <span className="spine" aria-hidden="true" />
      <div className="content">
        {isTurn ? (
          <div className="turn-rule">
            <span>turn {record.turn}</span>
            {row.summary ? <span>{row.summary}</span> : null}
          </div>
        ) : (
          <button
            type="button"
            className="system-row"
            data-tone={row.tone}
            aria-expanded={expanded || drawer ? expanded : expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="system-glyph" aria-hidden="true">
              {glyph(row.tone)}
            </span>
            <span className="system-label">{row.label}</span>
            <span className="system-summary">{row.summary}</span>
          </button>
        )}
        {!isTurn && expanded && row.body ? <div className="system-body">{row.body}</div> : null}
        {!isTurn && drawer && expanded && unknown ? (
          <div className="protocol-drawer">
            <div className="protocol-line">
              unknown frames: {unknown.total} · kinds: {Object.keys(unknown.counts).join(", ") || "none"}
              {onClearUnknown ? (
                <button
                  type="button"
                  className="tool-disclosure"
                  onClick={() => onClearUnknown(threadId)}
                  style={{ marginLeft: 8 }}
                >
                  clear evidence
                </button>
              ) : null}
            </div>
            {unknown.ring.map((frame, index) => (
              <code className="protocol-line" key={index}>
                <b>{frame.type}</b> {frame.raw}
              </code>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
