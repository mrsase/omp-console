import { useEffect, useRef, useState } from "react";
import type { DialogRecord, ThreadRuntime } from "../protocol/types";
import {
  buildAskAnswers,
  emptySelections,
  fieldOptions,
  isApprovalOptions,
  isFieldAsk,
  optionHint,
  safeOptionIndex,
  setCustomInput,
  toggleSelection,
  type AskSelection,
} from "../protocol/dialogs";
import { openDialogs } from "../store/selectors";
import { useCountdown, useFocusTrap } from "./hooks";
import { Icon } from "./icons";

type Answer = Record<string, unknown>;

function destructive(text: string): boolean {
  return /\b(delete|remove|drop|overwrite|reset|destroy|discard)\b/i.test(text);
}

export function Dialogs({
  session,
  onAnswer,
}: {
  session: ThreadRuntime;
  onAnswer: (dialog: DialogRecord, answer: Answer, label?: string) => void;
}) {
  const dialogs = openDialogs(session);
  const dialog = dialogs[0];
  const sheetRef = useRef<HTMLDivElement>(null);
  const { seconds, expired } = useCountdown(dialog?.request.timeout ?? null, dialog?.request.id);
  const [confirmFocus, setConfirmFocus] = useState<"no" | "yes">("no");
  const [inputValue, setInputValue] = useState("");
  const [editorValue, setEditorValue] = useState(dialog?.request.prefill ?? "");
  const [fieldValue, setFieldValue] = useState("");
  const [selections, setSelections] = useState<Record<string, AskSelection>>(() =>
    emptySelections(dialog?.request.questions ?? []),
  );

  const dialogId = dialog?.request.id;
  useEffect(() => {
    if (!dialogId) return;
    const target = sheetRef.current?.querySelector<HTMLElement>("[data-autofocus]");
    target?.focus();
  }, [dialogId]);
  useEffect(() => {
    setInputValue("");
    setEditorValue(dialog?.request.prefill ?? "");
    setFieldValue("");
    setSelections(emptySelections(dialog?.request.questions ?? []));
    setConfirmFocus("no");
  }, [dialogId, dialog?.request.prefill, dialog?.request.questions]);

  const cancel = () => {
    if (!dialog || expired) return;
    onAnswer(dialog, { cancelled: true }, "cancelled");
  };
  useFocusTrap(sheetRef, Boolean(dialog), cancel);

  useEffect(() => {
    if (!dialog?.request.approval || expired) return;
    const options = dialog.request.options ?? [];
    const onKey = (event: KeyboardEvent) => {
      const digit = Number(event.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > options.length) return;
      event.preventDefault();
      event.stopPropagation();
      onAnswer(dialog, { value: options[digit - 1] }, options[digit - 1]);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [dialog, expired, onAnswer]);

  if (!dialog) return null;
  const request = dialog.request;
  const approval = request.approval;
  const isApproval = Boolean(approval) || (request.method === "select" && isApprovalOptions(request.options));
  const field = request.field ?? (isFieldAsk(request) ? { index: 1, total: null, previous: [] } : undefined);
  const { options: listedOptions, freeText } = fieldOptions(request);
  const position = dialogs.findIndex((entry) => entry.request.id === request.id) + 1;
  const title = approval?.heading ?? request.title ?? request.message ?? "omp needs an answer";

  const submitAsk = () => {
    if (!request.questions || expired) return;
    const answers = buildAskAnswers(request.questions, selections);
    onAnswer(dialog, { answers }, "answered");
  };

  return (
    <div className="dialog-scrim">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        data-width={request.method === "ask" ? "wide" : undefined}
        data-approval={isApproval ? "true" : "false"}
        ref={sheetRef}
        data-testid="dialog-sheet"
      >
        <div className="sheet-head">
          <div className="sheet-meta">
            <span className="kind">{request.method}</span>
            <span>
              {position} of {dialogs.length}
            </span>
            {seconds !== null ? <span className="countdown">{expired ? "timed out" : `${seconds}s`}</span> : null}
          </div>
          <button type="button" className="icon-button" aria-label="Cancel" onClick={cancel} disabled={expired}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="sheet-body">
          <h2 className="sheet-title" id="sheet-title">
            {title}
          </h2>

          {isApproval ? (
            <>
              <p className="sheet-message">omp wants to run this tool. Approving applies to this request only.</p>
              {approval?.command ? (
                <div className="approval-stripe">
                  <div className="tool-pane-label">command</div>
                  <div className="approval-command">{approval.command}</div>
                </div>
              ) : null}
              <div className="option-list" role="listbox" aria-label="Approval options">
                {(request.options ?? []).map((option, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    className="option-row"
                    key={option}
                    data-autofocus={index === safeOptionIndex(request.options ?? []) ? "true" : undefined}
                    disabled={expired}
                    onClick={() => onAnswer(dialog, { value: option }, option)}
                  >
                    <span className="option-hint">{optionHint(index)}</span>
                    <span className="option-main">
                      <span className="option-label">{option}</span>
                    </span>
                    <span className="option-chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {request.method === "select" && !isApproval && !field ? (
            <>
              {request.message ? <p className="sheet-message">{request.message}</p> : null}
              <div className="option-list" role="listbox" aria-label="Options">
                {(request.options ?? []).map((option, index) => {
                  const detail = request.optionDetails?.[index];
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      className="option-row"
                      key={`${option}:${index}`}
                      data-autofocus={index === 0 ? "true" : undefined}
                      disabled={expired}
                      onClick={() => onAnswer(dialog, { value: option }, option)}
                    >
                      <span className="option-hint">{optionHint(index)}</span>
                      <span className="option-main">
                        <span className="option-label">{option}</span>
                        {detail?.description ? <span className="option-description">{detail.description}</span> : null}
                        {detail?.preview ? <span className="option-preview">{detail.preview}</span> : null}
                      </span>
                      <span className="option-chevron" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          {request.method === "confirm" ? (
            <>
              <p className="sheet-message">{request.message ?? request.title ?? "Confirm?"}</p>
            </>
          ) : null}

          {request.method === "input" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!expired) onAnswer(dialog, { value: inputValue }, inputValue);
              }}
            >
              <input
                className="sheet-input"
                data-autofocus="true"
                type={request.secret ? "password" : "text"}
                value={inputValue}
                placeholder={request.placeholder ?? ""}
                aria-label={request.title ?? "Input"}
                disabled={expired}
                onChange={(event) => setInputValue(event.target.value)}
              />
            </form>
          ) : null}

          {request.method === "editor" ? (
            <textarea
              className="sheet-textarea"
              data-autofocus="true"
              value={editorValue}
              aria-label={request.title ?? "Editor"}
              disabled={expired}
              onChange={(event) => setEditorValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !expired) {
                  event.preventDefault();
                  onAnswer(dialog, { value: editorValue }, editorValue);
                }
              }}
            />
          ) : null}

          {request.method === "ask" && request.questions && request.questions.length > 0 ? (
            <div className="ask-form">
              {request.questions.map((question) => {
                const selection = selections[question.id] ?? { selectedOptions: [], customInput: "" };
                return (
                  <div className="question-block" key={question.id}>
                    {question.header ? <div className="question-header">{question.header}</div> : null}
                    <p className="question-text">{question.question}</p>
                    <div className="option-list" role="listbox" aria-label={question.question} aria-multiselectable={question.multi}>
                      {(question.options ?? []).map((option, index) => (
                        <button
                          type="button"
                          role="option"
                          aria-selected={selection.selectedOptions.includes(option.label)}
                          className="option-row"
                          key={option.label}
                          disabled={expired}
                          onClick={() =>
                            setSelections((current) => toggleSelection(request.questions!, current, question.id, option.label))
                          }
                        >
                          <span className="option-hint">{selection.selectedOptions.includes(option.label) ? "✓" : optionHint(index)}</span>
                          <span className="option-main">
                            <span className="option-label">
                              {option.label}
                              {question.recommended === index ? <span className="badge">recommended</span> : null}
                            </span>
                            {option.description ? <span className="option-description">{option.description}</span> : null}
                            {option.preview ? <span className="option-preview">{option.preview}</span> : null}
                          </span>
                        </button>
                      ))}
                    </div>
                    <input
                      className="free-text"
                      placeholder="Type your own answer"
                      aria-label={`${question.question} free text`}
                      value={selection.customInput}
                      disabled={expired}
                      onChange={(event) =>
                        setSelections((current) => setCustomInput(request.questions!, current, question.id, event.target.value))
                      }
                    />
                    {question.multi ? <div className="multi-note">multi-select accumulates; submit sends all answers</div> : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {request.method === "select" && field ? (
            <>
              <div className="field-progress">
                <span>
                  field {field.index}
                  {field.total ? ` of ${field.total}` : ""}
                </span>
                {request.title ? <span>{request.title}</span> : null}
              </div>
              {field.previous.length > 0 ? (
                <div className="field-previous">
                  {field.previous.map((entry) => `${entry.question}: ${entry.answer}`).join("\n")}
                </div>
              ) : null}
              <div className="option-list" role="listbox" aria-label={request.title ?? "Field"}>
                {listedOptions.map((option, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    className="option-row"
                    key={option}
                    disabled={expired}
                    onClick={() => onAnswer(dialog, { value: option }, option)}
                  >
                    <span className="option-hint">{optionHint(index)}</span>
                    <span className="option-main">
                      <span className="option-label">{option}</span>
                    </span>
                  </button>
                ))}
              </div>
              {freeText ? (
                <input
                  className="free-text"
                  data-autofocus="true"
                  placeholder="Other (type your own)"
                  aria-label="Other answer"
                  value={fieldValue}
                  disabled={expired}
                  onChange={(event) => setFieldValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !expired && fieldValue.trim()) {
                      event.preventDefault();
                      onAnswer(dialog, { value: fieldValue.trim() }, fieldValue.trim());
                    }
                  }}
                />
              ) : null}
              {request.multi ? <div className="multi-note">choose one at a time, then Done</div> : null}
            </>
          ) : null}

          {expired ? (
            <p className="timed-out" role="status">
              Timed out — omp chooses the default
            </p>
          ) : null}
        </div>
        <div className="sheet-actions">
          <button type="button" className="control" onClick={cancel} disabled={expired}>
            Cancel
          </button>
          <span className="spacer" />
          {request.method === "confirm" ? (
            <>
              <button
                type="button"
                className="control"
                data-autofocus={confirmFocus === "no" ? "true" : undefined}
                disabled={expired}
                onFocus={() => setConfirmFocus("no")}
                onClick={() => onAnswer(dialog, { confirmed: false }, "no")}
              >
                No
              </button>
              <button
                type="button"
                className={destructive(`${request.title ?? ""} ${request.message ?? ""}`) ? "primary danger" : "primary"}
                disabled={expired}
                onClick={() => onAnswer(dialog, { confirmed: true }, "yes")}
              >
                Yes
              </button>
            </>
          ) : null}
          {request.method === "input" ? (
            <button
              type="button"
              className="primary"
              disabled={expired}
              onClick={() => onAnswer(dialog, { value: inputValue }, inputValue)}
            >
              Continue
            </button>
          ) : null}
          {request.method === "editor" ? (
            <button
              type="button"
              className="primary"
              disabled={expired}
              onClick={() => onAnswer(dialog, { value: editorValue }, editorValue)}
            >
              Save
            </button>
          ) : null}
          {request.method === "ask" ? (
            <button type="button" className="primary" disabled={expired} onClick={submitAsk}>
              Submit
            </button>
          ) : null}
          <span className="sheet-hint">
            {dialog.request.method === "confirm" ? "No is the safe default" : "Enter to answer · Esc to cancel"}
          </span>
        </div>
        {request.method === "confirm" && destructive(`${request.title ?? ""} ${request.message ?? ""}`) ? (
          <span className="sr-only" data-destructive="true" />
        ) : null}
      </div>
    </div>
  );
}
