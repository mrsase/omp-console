import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { answerDialog, cancelDialog, useApp } from "../lib/store";
import type { AskQuestion, UiDialog } from "../lib/types";
import { Icon } from "./Icons";

type Overlay = {
  element: HTMLElement;
  priority: number;
  dismiss: () => void;
  trap: boolean;
};

const overlays: Overlay[] = [];
const topOverlay = () => overlays.reduce<Overlay | undefined>(
  (top, overlay) => !top || overlay.priority >= top.priority ? overlay : top,
  undefined,
);
const focusable = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>(
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
)].filter((control) => control.getClientRects().length > 0);

/** One keyboard owner for stacked drawers, menus, and dialogs. */
export function useOverlay(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  dismiss: () => void,
  priority: number,
  trap = true,
) {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const previous = document.activeElement;
    const overlay: Overlay = { element, priority, dismiss: () => dismissRef.current(), trap };
    overlays.push(overlay);
    const focus = () => {
      const preferred = element.querySelector<HTMLElement>("[data-autofocus]");
      (preferred ?? focusable(element)[0] ?? element).focus();
    };
    if (topOverlay() === overlay) focus();
    const onKey = (event: KeyboardEvent) => {
      if (topOverlay() !== overlay || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        overlay.dismiss();
      } else if (event.key === "Tab" && overlay.trap) {
        const controls = focusable(element);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first) {
          event.preventDefault();
          element.focus();
        } else if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (overlay.trap && topOverlay() === overlay && event.target instanceof Node && !element.contains(event.target)) focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      const wasTop = topOverlay() === overlay;
      overlays.splice(overlays.indexOf(overlay), 1);
      if (!wasTop) return;
      const next = topOverlay();
      const current = document.activeElement;
      if (!next && current instanceof HTMLElement && current !== document.body &&
        current !== previous && !element.contains(current)) return;
      if (previous instanceof HTMLElement && previous.isConnected && (!next || next.element.contains(previous))) {
        previous.focus();
      } else if (next) {
        (focusable(next.element)[0] ?? next.element).focus();
      }
    };
  }, [ref, active, priority, trap]);
}

export function Dialogs() {
  const app = useApp();
  const thread = app.view ? app.threads[app.view] : null;
  const dialog = thread?.dialogs[0];
  if (!thread || !dialog) return null;
  return (
    <DialogShell
      key={dialog.id}
      dialog={dialog}
      threadId={thread.info.id}
      position={1}
      total={thread.dialogs.length}
    />
  );
}

function DialogShell({
  dialog,
  threadId,
  position,
  total,
}: {
  dialog: UiDialog;
  threadId: string;
  position: number;
  total: number;
}) {
  const [deadline] = useState(() =>
    dialog.timeout ? Date.now() + dialog.timeout : 0,
  );
  const [now, setNow] = useState(() => Date.now());
  const shell = useRef<HTMLDivElement>(null);
  useOverlay(shell, true, () => cancelDialog(threadId, dialog.id), 60);

  useEffect(() => {
    if (!deadline) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);


  const remaining = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;

  return (
    <div
      className="modal-backdrop dialog-backdrop"
      onMouseDown={() => cancelDialog(threadId, dialog.id)}
    >
      <div
        className={`modal dlg-modal dlg-${dialog.kind}`}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={titleFor(dialog)}
        ref={shell}
        tabIndex={-1}
      >
        <div className="dlg-head">
          <div className="dlg-titles">
            <h3>{titleFor(dialog)}</h3>
            <div className="dlg-sub">
              {total > 1 && <span className="dlg-count">{position} of {total}</span>}
              {remaining !== null && (
                <span className="dlg-time">Auto-selects in {remaining}s</span>
              )}
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={() => cancelDialog(threadId, dialog.id)}
            aria-label="Cancel"
            title="Cancel"
          >
            <Icon name="x" />
          </button>
        </div>

        {dialog.kind === "ask" && (
          <AskBody dialog={dialog} threadId={threadId} />
        )}
        {dialog.kind === "select" && (
          <SelectBody dialog={dialog} threadId={threadId} />
        )}
        {dialog.kind === "confirm" && (
          <ConfirmBody dialog={dialog} threadId={threadId} />
        )}
        {dialog.kind === "input" && (
          <InputBody dialog={dialog} threadId={threadId} />
        )}
      </div>
    </div>
  );
}

function titleFor(dialog: UiDialog): string {
  if (dialog.kind === "ask") return "One quick question";
  return dialog.title;
}

function AskBody({ dialog, threadId }: { dialog: Extract<UiDialog, { kind: "ask" }>; threadId: string }) {
  const [selected, setSelected] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    for (const question of dialog.questions) {
      const recommended =
        question.recommended !== undefined
          ? question.options[question.recommended]?.label
          : undefined;
      initial[question.id] =
        !question.multi && recommended ? [recommended] : [];
    }
    return initial;
  });
  const [custom, setCustom] = useState<Record<string, string>>({});

  const toggle = (question: AskQuestion, label: string) => {
    setSelected((current) => {
      const picked = current[question.id] ?? [];
      if (question.multi) {
        return {
          ...current,
          [question.id]: picked.includes(label)
            ? picked.filter((item) => item !== label)
            : [...picked, label],
        };
      }
      return {
        ...current,
        [question.id]: picked.includes(label) ? [] : [label],
      };
    });
    if (!question.multi) {
      setCustom((current) => ({ ...current, [question.id]: "" }));
    }
  };

  const answered = dialog.questions.every(
    (question) =>
      (selected[question.id]?.length ?? 0) > 0 ||
      (custom[question.id]?.trim().length ?? 0) > 0,
  );

  const submit = () => {
    answerDialog(threadId, dialog.id, {
      answers: dialog.questions.map((question) => ({
        id: question.id,
        selectedOptions: selected[question.id] ?? [],
        customInput: custom[question.id]?.trim() || undefined,
      })),
    });
  };

  return (
    <>
      <div className="dlg-body ask-body">
        {dialog.questions.map((question) => (
          <div className="ask-question" key={question.id}>
            {question.header && (
              <div className="ask-header">{question.header}</div>
            )}
            <div className="ask-text">{question.question}</div>
            <div className="ask-options">
              {question.options.map((option, index) => {
                const picked = (selected[question.id] ?? []).includes(option.label);
                return (
                  <button
                    className={`dlg-option ${picked ? "picked" : ""}`}
                    key={`${question.id}-${index}`}
                    onClick={() => toggle(question, option.label)}
                    aria-pressed={picked}
                  >
                    <span className="dlg-option-top">
                      <span className="dlg-option-label">{option.label}</span>
                      {question.recommended === index && (
                        <span className="dlg-badge">recommended</span>
                      )}
                      {picked && <Icon name="check" size={12} />}
                    </span>
                    {option.description && (
                      <span className="dlg-option-desc">{option.description}</span>
                    )}
                    {option.preview && (
                      <pre className="dlg-preview">{option.preview}</pre>
                    )}
                  </button>
                );
              })}
            </div>
            <input
              className="input dlg-custom"
              placeholder="Other (type your own)"
              value={custom[question.id] ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setCustom((current) => ({ ...current, [question.id]: value }));
                if (!question.multi && value.trim()) {
                  setSelected((current) => ({ ...current, [question.id]: [] }));
                }
              }}
            />
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button
          className="btn btn-ghost"
          onClick={() => cancelDialog(threadId, dialog.id)}
        >
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={!answered}>
          Submit
        </button>
      </div>
    </>
  );
}

function SelectBody({ dialog, threadId }: { dialog: Extract<UiDialog, { kind: "select" }>; threadId: string }) {
  return (
    <div className="dlg-body">
      <div className="select-list">
        {dialog.options.map((option, index) => (
          <button
            className="dlg-option"
            key={`${option.label}-${index}`}
            onClick={() =>
              answerDialog(threadId, dialog.id, { value: option.label })
            }
          >
            <span className="dlg-option-top">
              <span className="dlg-option-label">{option.label}</span>
              <Icon name="chevron-right" size={12} />
            </span>
            {option.description && (
              <span className="dlg-option-desc">{option.description}</span>
            )}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button
          className="btn btn-ghost"
          onClick={() => cancelDialog(threadId, dialog.id)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ConfirmBody({ dialog, threadId }: { dialog: Extract<UiDialog, { kind: "confirm" }>; threadId: string }) {
  return (
    <>
      <div className="dlg-body">
        <p className="confirm-text">{dialog.message}</p>
      </div>
      <div className="modal-actions">
        <button
          className="btn btn-ghost"
          data-autofocus
          onClick={() =>
            answerDialog(threadId, dialog.id, { confirmed: false })
          }
        >
          No
        </button>
        <button
          className="btn btn-primary"
          onClick={() => answerDialog(threadId, dialog.id, { confirmed: true })}
        >
          Yes
        </button>
      </div>
    </>
  );
}

function InputBody({ dialog, threadId }: { dialog: Extract<UiDialog, { kind: "input" }>; threadId: string }) {
  const [value, setValue] = useState(dialog.prefill ?? "");
  const submit = () => {
    answerDialog(threadId, dialog.id, { value });
  };
  return (
    <>
      <div className="dlg-body">
        {dialog.editor ? (
          <textarea
            className={`input dlg-textarea ${dialog.promptStyle ? "prompt" : ""}`}
            value={value}
            placeholder={dialog.placeholder}
            data-autofocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
        ) : (
          <input
            className="input"
            type={dialog.secret ? "password" : "text"}
            value={value}
            placeholder={dialog.placeholder}
            data-autofocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        )}
      </div>
      <div className="modal-actions">
        <button
          className="btn btn-ghost"
          onClick={() => cancelDialog(threadId, dialog.id)}
        >
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit}>
          {dialog.editor ? "Submit" : "OK"}
        </button>
      </div>
    </>
  );
}
