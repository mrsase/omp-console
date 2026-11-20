import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  promoteQueued,
  removeQueued,
  resumeThread,
  sendPrompt,
  setQueueMode,
  stopThread,
  toast,
  useApp,
} from "../lib/store";
import type { CommandInfo, ThreadState } from "../lib/types";
import { Icon } from "./Icons";
import { taggedSummary } from "../lib/markdown";

type Attachment = { mimeType: string; data: string };

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 150 * 1024;

type DraftValue = { text: string; images: Attachment[]; pending: number };

// Keep drafts outside the keyed conversation subtree, but notify only its composer.
// Entries are retained only for sessions that still exist in the app.
class SessionDraft {
  value: DraftValue;
  editorNonce: number | undefined;
  imageGeneration = 0;
  private listeners = new Set<() => void>();

  constructor(editor: ThreadState["editor"]) {
    this.value = { text: editor?.text ?? "", images: editor?.images ?? [], pending: 0 };
    this.editorNonce = editor?.nonce;
  }

  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  update(value: Partial<DraftValue>) {
    this.value = { ...this.value, ...value };
    for (const listener of this.listeners) listener();
  }

  replace(text: string, images: Attachment[]) {
    this.imageGeneration += 1;
    this.update({ text, images, pending: 0 });
  }
}

const sessionDrafts = new Map<string, SessionDraft>();

function draftFor(thread: ThreadState): SessionDraft {
  let entry = sessionDrafts.get(thread.info.id);
  if (!entry) {
    entry = new SessionDraft(thread.editor);
    sessionDrafts.set(thread.info.id, entry);
  }
  return entry;
}

export function Composer({ thread }: { thread: ThreadState }) {
  const app = useApp();
  const sessionDraft = useMemo(() => draftFor(thread), [thread.info.id]);
  const { text: draft, images, pending } = useSyncExternalStore(
    sessionDraft.subscribe, sessionDraft.getSnapshot, sessionDraft.getSnapshot,
  );
  const queuedSummaries = useMemo(() => new Map(
    [...thread.queue.steering, ...thread.queue.followUp].map((message) => [message, taggedSummary(message)]),
  ), [thread.queue.steering, thread.queue.followUp]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [commandBrowser, setCommandBrowser] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const slashId = useId();
  const hintId = useId();

  useEffect(() => {
    for (const id of sessionDrafts.keys()) {
      if (!app.threads[id]) sessionDrafts.delete(id);
    }
  }, [app.threads]);

  const running = thread.activity.running || thread.session?.isStreaming === true;
  const ended = thread.info.status === "exited";
  const starting = thread.info.status === "starting";

  const slashQuery = useMemo(() => {
    const match = /^\/([A-Za-z0-9:_-]*)$/.exec(draft);
    return match ? match[1] : null;
  }, [draft]);

  const slashItems = useMemo(() => {
    if (slashDismissed || (!commandBrowser && slashQuery === null)) return [];
    const query = commandBrowser ? "" : (slashQuery ?? "").toLowerCase();
    const matching = thread.commands
      .filter((command) => command.name.toLowerCase().startsWith(query));
    return commandBrowser ? matching : matching.slice(0, 9);
  }, [slashQuery, slashDismissed, commandBrowser, thread.commands]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery, commandBrowser]);

  useEffect(() => {
    textarea.current?.focus();
  }, [thread.info.id]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element || element.clientWidth === 0) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft, thread.info.status]);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.clientWidth;
      if (nextWidth > 0 && nextWidth !== width) {
        element.style.height = "0px";
        element.style.height = `${element.scrollHeight}px`;
      }
      width = nextWidth;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [thread.info.status]);

  const editorNonce = thread.editor?.nonce;
  useLayoutEffect(() => {
    if (!thread.editor || sessionDraft.editorNonce === editorNonce) return;
    sessionDraft.editorNonce = editorNonce;
    sessionDraft.replace(thread.editor.text, thread.editor.images ?? []);
    requestAnimationFrame(() => textarea.current?.focus());
  }, [editorNonce, sessionDraft, thread.editor]);

  const canSend =
    app.connected &&
    !ended &&
    !starting &&
    pending === 0 &&
    (draft.trim().length > 0 || images.length > 0);

  const submit = () => {
    if (!canSend) {
      if (!app.connected) toast("warning", "Not connected to the omp-web server");
      return;
    }
    if (!sendPrompt(thread.info.id, draft, images)) return;
    sessionDraft.replace("", []);
    setSlashDismissed(false);
    setCommandBrowser(false);
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const applyCommand = (command: CommandInfo) => {
    sessionDraft.update({ text: `/${command.name} ${commandBrowser && slashQuery === null ? draft : ""}` });
    setSlashDismissed(true);
    setCommandBrowser(false);
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (slashItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((index) => (index + 1) % slashItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex(
          (index) => (index - 1 + slashItems.length) % slashItems.length,
        );
        return;
      }
      if (!event.shiftKey && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        const picked = slashItems[slashIndex];
        if (picked) applyCommand(picked);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(true);
        setCommandBrowser(false);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Escape" && running && !draft) {
      event.preventDefault();
      stopThread(thread.info.id);
    }
  };

  const addFiles = (files: File[]) => {
    const picked = files.filter((file) => file.type.startsWith("image/"));
    if (!picked.length) return;
    const room = MAX_IMAGES - sessionDraft.value.images.length - sessionDraft.value.pending;
    if (room <= 0) {
      toast("warning", `At most ${MAX_IMAGES} images per message`);
      return;
    }
    const selected = picked.slice(0, room);
    if (selected.length < picked.length) {
      toast("warning", `At most ${MAX_IMAGES} images per message`);
    }
    const generation = sessionDraft.imageGeneration;
    sessionDraft.update({ pending: sessionDraft.value.pending + selected.length });
    for (const file of selected) {
      void prepareImage(file)
        .then((attachment) => {
          if (sessionDraft.imageGeneration !== generation) return;
          sessionDraft.update({
            images: [...sessionDraft.value.images, attachment],
          });
        })
        .catch((error: unknown) => {
          if (sessionDraft.imageGeneration !== generation) return;
          toast(
            "error",
            `Could not attach ${file.name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          if (sessionDraft.imageGeneration === generation) {
            sessionDraft.update({ pending: sessionDraft.value.pending - 1 });
          }
        });
    }
  };

  const queued = thread.queue.steering.length + thread.queue.followUp.length;
  const widgets = Object.entries(thread.widgets);

  if (ended) {
    return (
      <div className="composer-wrap">
        <div className="composer-inner">
          <div className="composer ended">
            <span>This session has ended.</span>
            <button
              className="btn btn-small"
              onClick={() => resumeThread(thread.info.id)}
            >
              <Icon name="play" size={12} />
              Resume
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {widgets.length > 0 && (
          <div className="widget-stack">
            {widgets.map(([key, lines]) => (
              <details className="widget" key={key}>
                <summary>{key}</summary>
                <pre>{lines.join("\n")}</pre>
              </details>
            ))}
          </div>
        )}

        {queued > 0 && (
          <div className="queue-bar">
            <span className="queue-label">Queued</span>
            {thread.queue.steering.map((message, index) =>
              index < (thread.queue.liveSteered ?? 0) ? (
                <div className="qchip sent" key={`l-${index}`}>
                  <span className="qkind sent">sent</span>
                  <span className="qtext" title={queuedSummaries.get(message)}>
                    {queuedSummaries.get(message)}
                  </span>
                </div>
              ) : (
                <div className="qchip" key={`s-${index}`}>
                  <span className="qkind steer">steer</span>
                  <span className="qtext" title={queuedSummaries.get(message)}>
                    {queuedSummaries.get(message)}
                  </span>
                  <button
                    className="qbtn"
                    onClick={() =>
                      removeQueued(thread.info.id, message, "steering")
                    }
                    aria-label="Remove queued message"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </div>
              ),
            )}
            {thread.queue.followUp.map((message, index) => (
              <div className="qchip" key={`f-${index}`}>
                <span className="qkind next">next</span>
                <span className="qtext" title={queuedSummaries.get(message)}>
                  {queuedSummaries.get(message)}
                </span>
                <button
                  className="qbtn"
                  onClick={() => promoteQueued(thread.info.id, message)}
                  aria-label="Promote to steering"
                  title="Promote to steering"
                >
                  <Icon name="send" size={10} />
                </button>
                <button
                  className="qbtn"
                  onClick={() => removeQueued(thread.info.id, message, "followUp")}
                  aria-label="Remove queued message"
                >
                  <Icon name="x" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className={`composer ${dragging ? "dragging" : ""} ${
            running ? "busy" : ""
          }`}
          onDragOver={(event) => {
            if (Array.from(event.dataTransfer.types).includes("Files")) {
              event.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addFiles(Array.from(event.dataTransfer.files));
          }}
        >
          {images.length > 0 && (
            <div className="attach-row">
              {images.map((image, index) => (
                <div className="attach" key={index}>
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt="attachment preview"
                  />
                  <button
                    className="attach-remove"
                    onClick={() => sessionDraft.update({
                      images: sessionDraft.value.images.filter((_, item) => item !== index),
                    })}
                    aria-label="Remove image"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="composer-field">
            {slashItems.length > 0 && (
              <div id={slashId} className="slash-menu" role="listbox" aria-label="Available commands">
                {slashItems.map((command, index) => (
                  <button
                    key={command.name}
                    id={`${slashId}-${index}`}
                    className={`slash-item ${index === slashIndex ? "on" : ""}`}
                    onMouseEnter={() => setSlashIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
                      applyCommand(command);
                    }}
                    role="option"
                    aria-selected={index === slashIndex}
                  >
                    <span className="slash-name">/{command.name}</span>
                    <span className="slash-desc">{command.description}</span>
                    {command.input?.hint && (
                      <span className="slash-hint">{command.input.hint}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <textarea
              ref={textarea}
              className="composer-input"
              value={draft}
              rows={1}
              aria-label="Message"
              aria-describedby={hintId}
              aria-autocomplete="list"
              aria-controls={slashItems.length > 0 ? slashId : undefined}
              aria-activedescendant={slashItems.length > 0 ? `${slashId}-${slashIndex}` : undefined}
              placeholder={
                starting
                  ? "Starting omp…"
                  : running
                    ? app.queueMode === "steer"
                      ? "Steer the turn…"
                      : "Queue a follow-up…"
                    : "Message omp…"
              }
              disabled={starting}
              onChange={(event) => {
                sessionDraft.update({ text: event.target.value });
                setSlashDismissed(false);
                setCommandBrowser(false);
              }}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.items)
                  .filter(
                    (item) => item.kind === "file" && item.type.startsWith("image/"),
                  )
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => !!file);
                if (files.length) {
                  if (!event.clipboardData.getData("text/plain")) event.preventDefault();
                  addFiles(files);
                }
              }}
            />
          </div>

          <div className="composer-bar">
            <div className="composer-left">
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  addFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <button
                className="btn btn-small btn-ghost composer-attach"
                onClick={() => fileInput.current?.click()}
                title="Attach images"
                aria-label="Attach images"
                disabled={starting}
              >
                <Icon name="paperclip" size={15} />
                <span className="composer-action-label">Attach</span>
              </button>
              <button
                className="btn btn-small btn-ghost composer-commands"
                disabled={starting || thread.commands.length === 0}
                aria-expanded={slashItems.length > 0}
                aria-controls={slashItems.length > 0 ? slashId : undefined}
                onClick={() => {
                  setSlashDismissed(false);
                  setCommandBrowser((value) => !value);
                  textarea.current?.focus();
                }}
              >
                <span aria-hidden="true">/</span>
                <span className="composer-action-label">Commands</span>
              </button>
            </div>
            <div className="composer-right">
              {running && (
                <label className="composer-mode" title="Steer between tool calls, or queue a follow-up after this turn">
                  <span className="composer-action-label">While running</span>
                  <select className="select" aria-label="Message delivery while running"
                    value={app.queueMode}
                    onChange={(event) => setQueueMode(event.target.value === "steer" ? "steer" : "followUp")}>
                    <option value="steer">Steer now</option>
                    <option value="followUp">Queue next</option>
                  </select>
                </label>
              )}
              {running && (
                <button
                  className="btn btn-small btn-ghost stop"
                  onClick={() => stopThread(thread.info.id)}
                  title="Stop and restore queued input"
                >
                  <Icon name="stop" size={13} />
                  <span>Stop</span>
                </button>
              )}
              <button
                className="send-btn"
                onClick={submit}
                disabled={!canSend}
                title={running ? app.queueMode === "steer" ? "Steer the running turn" : "Queue after this turn" : "Send message"}
              >
                <Icon name="send" size={15} />
                <span>{running ? app.queueMode === "steer" ? "Steer" : "Queue" : "Send"}</span>
              </button>
            </div>
          </div>
          <div className="composer-status">
            <span id={hintId} className="composer-hint">Enter to {running ? app.queueMode === "steer" ? "steer" : "queue" : "send"} · Shift+Enter for newline</span>
            {(pending > 0 || !app.connected || running) && (
              <span className="composer-state" role="status">
                {pending > 0 ? `Preparing ${pending} ${pending === 1 ? "image" : "images"}…` : !app.connected ? "Disconnected · draft saved" : "omp is working"}
              </span>
            )}
          </div>

          {dragging && <div className="drop-overlay">Drop images to attach</div>}
        </div>
      </div>
    </div>
  );
}

async function prepareImage(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file);
  try {
    let maxDimension = 1280;
    let quality = 0.84;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const scale = Math.min(
        1,
        maxDimension / Math.max(bitmap.width, bitmap.height),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas is unavailable");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const rendered = Promise.withResolvers<Blob | null>();
      canvas.toBlob(rendered.resolve, "image/jpeg", quality);
      const blob = await rendered.promise;
      if (blob && blob.size <= MAX_IMAGE_BYTES) {
        const dataUrl = await readAsDataUrl(blob);
        return {
          mimeType: "image/jpeg",
          data: dataUrl.slice(dataUrl.indexOf(",") + 1),
        };
      }
      maxDimension = Math.round(maxDimension * 0.72);
      quality = Math.max(0.45, quality - 0.1);
    }
    throw new Error("image is still too large after compression");
  } finally {
    bitmap.close();
  }
}

function readAsDataUrl(blob: Blob): Promise<string> {
  const read = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => read.resolve(String(reader.result));
  reader.onerror = () => read.reject(reader.error ?? new Error("read failed"));
  reader.readAsDataURL(blob);
  return read.promise;
}
