import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ImageCompressor } from "../store/attachments";
import {
  COMMAND_BUDGET,
  MAX_IMAGES,
  overBudget,
  prepareAttachments,
} from "../store/attachments";
import { clearDraft, loadDraft, saveDraft } from "../store/drafts";
import { paletteRows, promptFrame, removeQueuedFrame, promoteQueuedFrame, slashQuery } from "../store/commands";
import type { RawFrame, QueueItem, ThreadRuntime } from "../protocol/types";
import { formatBytes } from "../protocol/format";
import { isRunning } from "../store/selectors";
import { Icon } from "./icons";

export function Composer({
  threadId,
  session,
  connected,
  onSend,
  onStop,
  onLocalCommand,
  onEditorConsumed,
  onRestoredConsumed,
  restoredInput,
  compress,
}: {
  threadId: string;
  session: ThreadRuntime;
  connected: boolean;
  onSend: (frame: RawFrame) => void;
  onStop: () => void;
  onLocalCommand: (command: string) => void;
  onEditorConsumed: () => void;
  onRestoredConsumed: () => void;
  restoredInput: { id: number; text: string; images: { mimeType: string; data: string }[] } | null;
  compress?: ImageCompressor;
}) {
  const [text, setText] = useState(() => loadDraft(threadId));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"steer" | "followUp">("steer");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const consumedRestore = useRef<number | null>(null);
  const restoredCallback = useRef(onRestoredConsumed);
  restoredCallback.current = onRestoredConsumed;

  const running = isRunning(session);
  const starting = session.meta?.status === "starting";
  const query = slashQuery(text);
  const rows = useMemo(
    () => (query.active && !paletteDismissed ? paletteRows(session.commands, query.query) : []),
    [query.active, query.query, paletteDismissed, session.commands],
  );
  const paletteOpen = rows.length > 0;
  const queued: QueueItem[] = [...session.queue.steering, ...session.queue.followUp];

  useEffect(() => {
    setText(loadDraft(threadId));
    setAttachments([]);
    setError(null);
    setPaletteDismissed(false);
  }, [threadId]);

  useEffect(() => {
    saveDraft(threadId, text);
  }, [threadId, text]);

  useEffect(() => {
    if (session.editorText === null || session.editorText === undefined) return;
    setText(session.editorText);
    onEditorConsumed();
    textareaRef.current?.focus();
  }, [session.editorText, onEditorConsumed]);

  useEffect(() => {
    if (!restoredInput || consumedRestore.current === restoredInput.id) return;
    consumedRestore.current = restoredInput.id;
    if (restoredInput.text) {
      setText((current) => (current.trim() ? `${current}\n\n${restoredInput.text}` : restoredInput.text));
    }
    if (restoredInput.images.length > 0) {
      const restored: Attachment[] = restoredInput.images.map((image, index) => ({
        name: `restored-${index + 1}`,
        mimeType: image.mimeType,
        data: image.data,
        width: 0,
        height: 0,
        bytes: Math.floor((image.data.length * 3) / 4),
      }));
      setAttachments((current) => [...current, ...restored].slice(0, MAX_IMAGES));
    }
    restoredCallback.current();
  }, [restoredInput?.id]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 12 * 22.5)}px`;
  }, [text]);

  useEffect(() => {
    setPaletteIndex(0);
  }, [query.query]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (attachments.length >= MAX_IMAGES) {
      setError(`At most ${MAX_IMAGES} images per message.`);
      return;
    }
    setPreparing((value) => value + files.length);
    const result = await prepareAttachments(files, attachments.length, compress);
    setPreparing((value) => Math.max(0, value - files.length));
    if (result.attachments.length > 0) {
      const next = [...attachments, ...result.attachments];
      if (overBudget(next)) {
        setError(`Attachments exceed the ${Math.round(COMMAND_BUDGET / 1024)} KiB command budget.`);
      } else {
        setAttachments(next);
        setError(null);
      }
    }
    if (result.errors.length > 0) setError(result.errors[0]);
  };

  const send = () => {
    const current = textareaRef.current?.value ?? text;
    const trimmed = current.trim();
    if (starting || (trimmed.length === 0 && attachments.length === 0)) return;
    if (overBudget(attachments)) {
      setError(`Attachments exceed the ${Math.round(COMMAND_BUDGET / 1024)} KiB command budget.`);
      return;
    }
    const effective = !running ? "send" : mode === "steer" ? "steer" : "queue";
    const frame = promptFrame(trimmed, attachments, effective);
    onSend(frame);
    setText("");
    clearDraft(threadId);
    setAttachments([]);
    setError(null);
    setPaletteDismissed(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const acceptPalette = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const name = row.command.name;
    if (row.command.source === "console") {
      onLocalCommand(name);
      setText("");
      clearDraft(threadId);
    } else {
      setText(`/${name} `);
    }
    setPaletteDismissed(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229;
    if (event.key === "Enter" && !event.shiftKey) {
      if (composing) return;
      if (paletteOpen) {
        event.preventDefault();
        acceptPalette(paletteIndex);
        return;
      }
      event.preventDefault();
      send();
      return;
    }
    if (paletteOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setPaletteIndex((value) => (value + 1) % rows.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setPaletteIndex((value) => (value - 1 + rows.length) % rows.length);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        acceptPalette(paletteIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPaletteDismissed(true);
        return;
      }
    }
    if (event.key === "Escape") {
      const target = event.target as HTMLTextAreaElement;
      if (target.selectionStart === 0 && target.selectionEnd === 0 && text.length === 0 && running) {
        event.preventDefault();
        onStop();
      }
    }
  };

  return (
    <div
      className="composer"
      data-testid="composer"
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {session.widgets.map((widget) => (
        <div className="composer-widgets" key={widget.key}>
          {widget.lines.map((line, index) => (
            <span key={index}>{line}</span>
          ))}
        </div>
      ))}

      {queued.length > 0 ? (
        <div className="queue-strip" aria-live="polite" aria-label="Queued messages">
          {queued.map((item) => (
            <span className="queue-chip" key={item.id} data-kind={item.kind}>
              <span className="queue-chip-kind">{item.kind === "followUp" ? "next" : "steer"}</span>
              <span className="queue-chip-text" title={item.text}>
                {item.text}
              </span>
              {item.kind === "followUp" ? (
                <button
                  type="button"
                  aria-label="Promote queued message"
                  title="Promote"
                  onClick={() => onSend(promoteQueuedFrame(item))}
                >
                  ↑
                </button>
              ) : null}
              <button
                type="button"
                aria-label="Remove queued message"
                title="Remove"
                onClick={() => onSend(removeQueuedFrame(item))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="attachments" aria-label="Attachments">
          {attachments.map((attachment, index) => (
            <div className="attachment" key={`${attachment.name}:${index}`}>
              <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} />
              <span className="attachment-meta">{formatBytes(attachment.bytes)}</span>
              <button
                type="button"
                className="attachment-remove"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => setAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {paletteOpen ? (
        <div className="slash-palette" role="listbox" aria-label="Commands">
          {rows.map((row, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === paletteIndex}
              className="palette-row"
              key={row.command.name}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setPaletteIndex(index)}
              onClick={() => acceptPalette(index)}
            >
              <span className="palette-name">
                /{row.command.name}
                {row.alias ? <span className="palette-alias"> {row.alias}</span> : null}
              </span>
              <span className="palette-description">{row.command.description ?? ""}</span>
              <span className="palette-hint">{row.command.input?.hint ?? ""}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div
        className="composer-field"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
      >
        <span className="composer-glyph" aria-hidden="true">
          ❯
        </span>
        <textarea
          ref={textareaRef}
          className="composer-input"
          value={text}
          rows={1}
          aria-label="Message"
          placeholder={
            starting
              ? "Starting omp…"
              : running
                ? mode === "steer"
                  ? "Steer the turn…"
                  : "Queue a follow-up…"
                : "Message omp…"
          }
          onChange={(event) => {
            setText(event.target.value);
            setPaletteDismissed(false);
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length > 0) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          data-testid="composer-input"
        />
      </div>

      <div className="composer-toolbar">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="attachment-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void addFiles(files);
          }}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="Attach images"
          title="Attach images"
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="paperclip" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Commands"
          title="Commands"
          onClick={() => {
            if (!text.startsWith("/")) setText("/");
            textareaRef.current?.focus();
          }}
        >
          <Icon name="slash" />
        </button>
        <span className="spacer" />
        {running ? (
          <>
            <div className="mode-control" role="group" aria-label="Message mode">
              <button type="button" aria-pressed={mode === "steer"} onClick={() => setMode("steer")}>
                Steer now
              </button>
              <button type="button" aria-pressed={mode === "followUp"} onClick={() => setMode("followUp")}>
                Queue next
              </button>
            </div>
            <button type="button" className="stop-button" onClick={onStop}>
              <Icon name="stop" size={12} />
              Stop
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="send-button"
          onClick={send}
          disabled={starting || (!text.trim() && attachments.length === 0)}
        >
          {running ? (mode === "steer" ? "Steer" : "Queue") : "Send"}
          <kbd>⏎</kbd>
        </button>
      </div>

      <div className="composer-state">
        <span>Enter to send · Shift+Enter for newline</span>
        <span className="right">
          {preparing > 0 ? <span>preparing {preparing} image{preparing === 1 ? "" : "s"}…</span> : null}
          {error ? <span className="composer-error">{error}</span> : null}
          {!error && running ? <span>omp is working</span> : null}
          {!error && !running && !connected ? <span>Disconnected · draft kept locally</span> : null}
        </span>
      </div>

      {dragging ? <div className="drop-overlay">Drop images to attach</div> : null}
    </div>
  );
}
