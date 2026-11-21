import type { AppState, Envelope, RawFrame, ThreadInfo, ThreadRuntime } from "./types";
import { cloneThread, pushSystemRow } from "./records";
import { emptyThread } from "./state";
import { HANDLED_TYPES, KNOWN_TYPES, noteUnknown, PROTOCOL_ROW_KEY } from "./known";
import {
  handleAgentEnd,
  handleAgentStart,
  handleBranchSummary,
  handleCommands,
  handleCompactionEnd,
  handleCompactionStart,
  handleConfig,
  handleExtensionUi,
  handleModelChanged,
  handleNotice,
  handlePromptResult,
  handleQueueUpdate,
  handleReady,
  handleRetryEnd,
  handleRetryStart,
  handleSessionInfo,
  handleSettled,
  handleThinkingChanged,
  handleTurnEnd,
  handleTurnStart,
} from "./events";
import { handleMessageEnd, handleMessageStart, handleMessageUpdate, handleToolEnd, handleToolStart, handleToolUpdate } from "./stream";
import { handleResponse, hydrateMessages } from "./hydrate";

type Frame = RawFrame & { [key: string]: unknown };

export function threadSession(state: AppState, id: string): ThreadRuntime {
  return state.sessions[id] ?? emptyThread(id);
}

function ensureSession(state: AppState, id: string): ThreadRuntime {
  if (!state.sessions[id]) {
    state.sessions[id] = emptyThread(id);
    state.sessions[id].meta = state.threads[id] ?? null;
  }
  return state.sessions[id];
}

function upsertThread(state: AppState, thread: ThreadInfo): void {
  state.threads = { ...state.threads, [thread.id]: thread };
  if (!state.threadOrder.includes(thread.id)) state.threadOrder = [...state.threadOrder, thread.id];
  const session = ensureSession(state, thread.id);
  session.meta = thread;
  if (thread.sessionId && !session.sessionId) session.sessionId = thread.sessionId;
  if (thread.sessionFile && !session.sessionFile) session.sessionFile = thread.sessionFile;
  if (thread.sessionName && !session.sessionName) session.sessionName = thread.sessionName;
  if (thread.model && !session.model) {
    session.model = { id: thread.model, provider: "", name: thread.modelName ?? thread.model };
  }
  if (thread.thinking && !session.thinkingLevel) session.thinkingLevel = thread.thinking;
}

function removeThread(state: AppState, id: string): void {
  const threads = { ...state.threads };
  const sessions = { ...state.sessions };
  delete threads[id];
  delete sessions[id];
  state.threads = threads;
  state.sessions = sessions;
  state.threadOrder = state.threadOrder.filter((entry) => entry !== id);
  if (state.selected === id) state.selected = state.threadOrder[0] ?? null;
}

function addGlobalNotice(state: AppState, entry: AppState["notices"][number]): void {
  state.notices = [...state.notices, entry].slice(-8);
}

export function reduceEnvelope(state: AppState, envelope: Envelope): AppState {
  const next: AppState = {
    ...state,
    threads: { ...state.threads },
    sessions: { ...state.sessions },
    notices: [...state.notices],
    threadOrder: [...state.threadOrder],
  };
  switch (envelope.op) {
    case "hello": {
      next.connection = "open";
      next.version = envelope.version;
      next.protocol = envelope.protocol;
      for (const thread of envelope.threads) upsertThread(next, thread);
      if (!next.selected && envelope.threads.length > 0) next.selected = envelope.threads[0].id;
      return next;
    }
    case "thread": {
      upsertThread(next, envelope.thread);
      return next;
    }
    case "thread_removed": {
      removeThread(next, envelope.id);
      return next;
    }
    case "frame": {
      return reduceFrame(next, envelope.frame, envelope.thread);
    }
    case "lagged": {
      const session = ensureSession(next, envelope.thread);
      const cloned = cloneThread(session);
      cloned.hydration = { ...cloned.hydration, messages: false, state: false, stats: false, busy: false };
      cloned.protocolLog = [
        ...cloned.protocolLog,
        { id: `lag:${cloned.seq}`, level: "warn", message: `lagged: ${envelope.skipped} frame(s) skipped` },
      ];
      pushSystemRow(
        cloned,
        {
          label: "protocol",
          summary: `lagged · ${envelope.skipped} frame${envelope.skipped === 1 ? "" : "s"} skipped · resyncing`,
          tone: "warn",
          kind: "lagged",
        },
        { key: PROTOCOL_ROW_KEY },
      );
      next.sessions[envelope.thread] = cloned;
      return next;
    }
    case "notice": {
      if (envelope.thread) {
        const session = ensureSession(next, envelope.thread);
        const cloned = cloneThread(session);
        cloned.protocolLog = [
          ...cloned.protocolLog,
          { id: `notice:${cloned.seq}:${envelope.message}`, level: envelope.level === "error" ? "warn" : "info", message: envelope.message },
        ];
        pushSystemRow(
          cloned,
          {
            label: "notice",
            summary: envelope.message,
            tone: envelope.level === "error" ? "err" : envelope.level === "warn" ? "warn" : "info",
            kind: "server",
          },
          { key: `sys:server:${cloned.seq}` },
        );
        next.sessions[envelope.thread] = cloned;
      } else {
        addGlobalNotice(next, { id: `n:${state.notices.length}:${envelope.message}`, level: envelope.level, message: envelope.message });
      }
      return next;
    }
    case "pong":
      return next;
    default:
      return next;
  }
}

/** Apply one raw child frame. `threadId` defaults to the selected session. */
export function reduceFrame(state: AppState, frame: RawFrame, threadId?: string): AppState {
  const id = threadId ?? state.selected;
  if (!id) return state;
  const next: AppState = { ...state, threads: { ...state.threads }, sessions: { ...state.sessions } };
  const session = cloneThread(ensureSession(next, id));
  applyFrame(session, frame);
  next.sessions[id] = session;
  return next;
}

export function applyFrame(t: ThreadRuntime, frame: Frame): void {
  const type = typeof frame.type === "string" ? frame.type : "";
  t.seq += 1;
  switch (type) {
    case "ready": {
      handleReady(t, frame);
      return;
    }
    case "response": {
      handleResponse(t, frame);
      return;
    }
    case "prompt_result": {
      handlePromptResult(t, frame);
      return;
    }
    case "session_settled": {
      handleSettled(t);
      return;
    }
    case "agent_start": {
      handleAgentStart(t);
      return;
    }
    case "agent_end": {
      handleAgentEnd(t, frame);
      return;
    }
    case "turn_start": {
      handleTurnStart(t);
      return;
    }
    case "turn_end": {
      handleTurnEnd(t, frame);
      return;
    }
    case "message_start": {
      handleMessageStart(t, frame);
      return;
    }
    case "message_update": {
      handleMessageUpdate(t, frame);
      return;
    }
    case "message_end": {
      handleMessageEnd(t, frame);
      return;
    }
    case "tool_execution_start": {
      handleToolStart(t, frame);
      return;
    }
    case "tool_execution_update": {
      handleToolUpdate(t, frame);
      return;
    }
    case "tool_execution_end": {
      handleToolEnd(t, frame);
      return;
    }
    case "queue_update": {
      handleQueueUpdate(t, frame);
      return;
    }
    case "model_changed": {
      handleModelChanged(t, frame);
      return;
    }
    case "thinking_level_changed": {
      handleThinkingChanged(t, frame);
      return;
    }
    case "session_info_update": {
      handleSessionInfo(t, frame);
      return;
    }
    case "available_commands_update": {
      handleCommands(t, frame);
      return;
    }
    case "config_update": {
      handleConfig(t, frame);
      return;
    }
    case "notice": {
      handleNotice(t, frame);
      return;
    }
    case "extension_ui_request": {
      handleExtensionUi(t, frame);
      return;
    }
    case "auto_retry_start": {
      handleRetryStart(t, frame);
      return;
    }
    case "auto_retry_end": {
      handleRetryEnd(t, frame);
      return;
    }
    case "auto_compaction_start": {
      handleCompactionStart(t, frame, false);
      return;
    }
    case "auto_compaction_end": {
      handleCompactionEnd(t, frame, false);
      return;
    }
    case "manual_compaction_start": {
      handleCompactionStart(t, frame, true);
      return;
    }
    case "manual_compaction_end": {
      handleCompactionEnd(t, frame, true);
      return;
    }
    case "compaction_start": {
      handleCompactionStart(t, frame, true);
      return;
    }
    case "compaction_end": {
      handleCompactionEnd(t, frame, true);
      return;
    }
    case "branch_summary": {
      handleBranchSummary(t, frame);
      return;
    }
    default: {
      if (!HANDLED_TYPES[type]) {
        if (type && KNOWN_TYPES[type] !== true) {
          noteUnknown(t, frame);
        }
      }
    }
  }
}


/** Test/UI helper: replay an entire captured frame list. */
export function replay(state: AppState, threadId: string, frames: RawFrame[]): AppState {
  let next = state;
  for (const frame of frames) next = reduceFrame(next, frame, threadId);
  return next;
}

export { hydrateMessages };
