import { formatTime } from "../../protocol/format";

export function Gutter({
  timestamp,
  turn,
  showTurn,
}: {
  timestamp: number | null;
  turn: number;
  showTurn: boolean;
}) {
  return (
    <div className="gutter" aria-hidden="true">
      <time dateTime={timestamp ? new Date(timestamp).toISOString() : undefined}>{formatTime(timestamp)}</time>
      {showTurn ? <span className="turn-label">turn {turn}</span> : null}
    </div>
  );
}

export function LaneTag({ lane, children }: { lane: "you" | "assistant" | "thinking" | "tool" | "system"; children: string }) {
  return (
    <span className="lane-tag" data-lane={lane}>
      {children}
    </span>
  );
}

export function formatChars(count: number): string {
  if (count < 1000) return `${count} chars`;
  return `${(count / 1000).toFixed(1)}k chars`;
}
