import { useState } from "react";
import type { MessageRecord } from "../../protocol/types";
import { useRow } from "../../store/hooks";
import { Gutter, LaneTag } from "./shared";

function imageSize(record: MessageRecord): string {
  const image = record.images?.[0];
  if (!image) return "";
  const bytes = Math.floor((image.data.length * 3) / 4);
  const dimensions = image.width && image.height ? `${image.width}×${image.height} · ` : "";
  return `${dimensions}${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function UserRow({
  threadId,
  messageKey,
  showTurn,
}: {
  threadId: string;
  messageKey: string;
  showTurn: boolean;
}) {
  const record = useRow(threadId, messageKey);
  const [expanded, setExpanded] = useState(false);
  if (!record) return null;
  const text = record.blocks.map((block) => (block.kind === "text" ? block.text || block.chunks.join("") : "")).join("");
  const collapsible = text.length > 1200 || text.split("\n").length > 12;
  const colors = record.images ?? [];
  return (
    <article
      className="row"
      data-lane="you"
      data-message-key={messageKey}
      data-anchor={`user:${record.timestamp ?? messageKey}`}
      data-kind="message"
      aria-label={`Your prompt, turn ${record.turn}`}
    >
      <Gutter timestamp={record.timestamp} turn={record.turn} showTurn={showTurn} />
      <span className="spine" aria-hidden="true" />
      <div className="content">
        <div className="lane-head">
          <LaneTag lane="you">you</LaneTag>
          {showTurn ? <span className="hint">turn {record.turn}</span> : null}
        </div>
        <div className="prompt-prose" data-collapsed={collapsible && !expanded ? "true" : "false"}>
          {text}
        </div>
        {collapsible ? (
          <button className="prompt-disclosure" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "show less" : "show full prompt"}
          </button>
        ) : null}
        {colors.length > 0 ? (
          <div className="prompt-images">
            {colors.map((image, index) => (
              <figure key={`${messageKey}:image:${index}`}>
                <img
                  className="prompt-image"
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={`Attachment ${index + 1}`}
                  loading="lazy"
                />
                <figcaption className="image-caption">
                  {colors.length > 1 ? `${index + 1}/${colors.length} · ` : ""}
                  {imageSize(record)}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
