import { useState } from "react";
import type { ThinkingBlock } from "../../protocol/types";
import { useThrottledValue } from "../hooks";
import { formatChars } from "./shared";

export function ThinkingRow({ block }: { block: ThinkingBlock }) {
  const [expanded, setExpanded] = useState(false);
  const text = block.text || block.chunks.join("");
  const liveCount = useThrottledValue(text.length, 1000);
  const chars = block.streaming ? liveCount : text.length;
  return (
    <div className="thinking" data-lane="thinking">
      <button
        type="button"
        className="thinking-strip"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="lane-tag" data-lane="thinking">
          think
        </span>
        <span className="thinking-label">{block.streaming ? "thinking" : "thought"}</span>
        <span className="thinking-count">{formatChars(chars)}</span>
        <span className="thinking-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {expanded ? <div className="thinking-body">{text || "…"}</div> : null}
    </div>
  );
}
