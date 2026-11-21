import type {
  AppState,
  ConnectionState,
  DialogRecord,
  Envelope,
  InfoResponse,
  RawFrame,
  RecentSession,
  ThreadInfo,
  ThreadRuntime,
} from "../protocol/types";
import { emptyState } from "../protocol/state";
import { cloneThread } from "../protocol/records";
import { reduceEnvelope, reduceFrame } from "../protocol/reduce";
import { hydrateMessages } from "../protocol/hydrate";

type Listener = () => void;

const ROW_SEPARATOR = "\u0000";

function rootFingerprint(state: AppState): string {
  const parts: string[] = [state.connection, state.selected ?? "", state.version ?? ""];
  for (const id of state.threadOrder) {
    const thread = state.threads[id];
    parts.push(
      [
        id,
        thread?.status,
        thread?.title,
        thread?.model,
        thread?.thinking,
        thread?.unknownFrames,
        thread?.exitCode,
        thread?.sessionFile,
        thread?.resume,
        thread?.sessionId,
        thread?.sessionName,
      ].join("|"),
    );
    const session = state.sessions[id];
    if (!session) continue;
    parts.push(
      [
        session.rows.join(","),
        session.queue.steering.map((item) => item.id).join(","),
        session.queue.followUp.map((item) => item.id).join(","),
        session.dialogs.map((dialog) => `${dialog.request.id}:${dialog.status}`).join(","),
        session.statuses.map((entry) => entry.text).join(","),
        session.widgets.map((entry) => entry.key).join(","),
        session.todoPhases.map((phase) => `${phase.name}:${phase.tasks.map((task) => task.status).join("")}`).join("|"),
        session.model?.id ?? "",
        session.model?.name ?? "",
        session.thinkingLevel ?? "",
        session.sessionName ?? "",
        session.sessionFile ?? "",
        session.sessionId ?? "",
        session.title ?? "",
        session.streaming ? "1" : "0",
        session.compacting ? "1" : "0",
        session.settled ? "1" : "0",
        session.agentActive ? "1" : "0",
        session.turn,
        session.tokens.total,
        session.cost.toFixed(6),
        session.stats.totalMessages,
        session.contextUsage?.percent ?? "",
        session.unknown.total,
        session.protocolLog.length,
        session.hydration.messages ? "m" : "",
        session.hydration.state ? "s" : "",
        session.hydration.busy ? "b" : "",
        session.editorText ?? "",
        session.lastError ?? "",
        session.notifications.length,
        session.commands.length,
        session.levels.join(","),
        session.models.length,
        session.queue.liveSteered,
      ].join("~"),
    );
  }
  parts.push(state.notices.map((notice) => notice.message).join("|"), state.recent.length.toString());
  return parts.join("\n");
}

export interface StoreOptions {
  /** false runs listeners synchronously (tests, SSR). */
  coalesce?: boolean;
  schedule?: (callback: () => void) => void;
}

export class ConsoleStore {
  private state: AppState = emptyState();
  private rootListeners = new Set<Listener>();
  private rowListeners = new Map<string, Set<Listener>>();
  private dirtyRows = new Set<string>();
  private rootDirty = false;
  private scheduled = false;
  private readonly coalesce: boolean;
  private readonly schedule: (callback: () => void) => void;

  constructor(options: StoreOptions = {}) {
    this.coalesce = options.coalesce ?? true;
    this.schedule =
      options.schedule ??
      ((callback) => {
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => callback());
        else setTimeout(callback, 0);
      });
  }

  getState = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.rootListeners.add(listener);
    return () => {
      this.rootListeners.delete(listener);
    };
  };

  subscribeRow(threadId: string, key: string, listener: Listener): () => void {
    const rowKey = `${threadId}${ROW_SEPARATOR}${key}`;
    const set = this.rowListeners.get(rowKey) ?? new Set<Listener>();
    set.add(listener);
    this.rowListeners.set(rowKey, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.rowListeners.delete(rowKey);
    };
  }

  rowVersion(threadId: string, key: string): number {
    return this.state.sessions[threadId]?.messages[key]?.version ?? -1;
  }

  row(threadId: string, key: string) {
    return this.state.sessions[threadId]?.messages[key];
  }

  session(threadId: string): ThreadRuntime | undefined {
    return this.state.sessions[threadId];
  }

  dispatch(envelope: Envelope): void {
    if (envelope.op === "pong") return;
    this.commit(reduceEnvelope(this.state, envelope));
  }

  dispatchFrame(threadId: string, frame: RawFrame): void {
    this.commit(reduceFrame(this.state, frame, threadId));
  }

  pushFrames(threadId: string, frames: RawFrame[]): void {
    let next = this.state;
    for (const frame of frames) next = reduceFrame(next, frame, threadId);
    this.commit(next, true);
  }

  hydrate(threadId: string, messages: unknown[]): void {
    const session = this.state.sessions[threadId];
    if (!session) return;
    const next: AppState = { ...this.state, sessions: { ...this.state.sessions } };
    const cloned = cloneThread(session);
    hydrateMessages(cloned, messages);
    next.sessions[threadId] = cloned;
    this.commit(next);
  }

  setSelected(id: string | null): void {
    if (this.state.selected === id) return;
    this.commit({ ...this.state, selected: id });
  }

  setConnection(connection: ConnectionState, version: string | null = this.state.version): void {
    if (this.state.connection === connection && this.state.version === version) return;
    this.commit({ ...this.state, connection, version });
  }

  setThreads(threads: ThreadInfo[]): void {
    let next = this.state;
    for (const thread of threads) {
      next = reduceEnvelope(next, { op: "thread", thread });
    }
    if (!next.selected && threads[0]) next = { ...next, selected: threads[0].id };
    this.commit(next, true);
  }

  setInfo(info: InfoResponse): void {
    this.commit({ ...this.state, info });
  }

  setRecent(recent: RecentSession[]): void {
    this.commit({ ...this.state, recent });
  }

  addNotice(level: "info" | "warn" | "error", message: string): void {
    const notices = [...this.state.notices, { id: `local:${Date.now()}:${this.state.notices.length}`, level, message }].slice(-8);
    this.commit({ ...this.state, notices });
  }

  replaceSession(threadId: string, update: (session: ThreadRuntime) => ThreadRuntime): void {
    const session = this.state.sessions[threadId];
    if (!session) return;
    this.commit({ ...this.state, sessions: { ...this.state.sessions, [threadId]: update(cloneThread(session)) } });
  }

  resolveDialog(threadId: string, dialogId: string, status: DialogRecord["status"], answerLabel?: string): void {
    this.replaceSession(threadId, (session) => {
      session.dialogs = session.dialogs.map((dialog) =>
        dialog.request.id === dialogId ? { ...dialog, status, answerLabel } : dialog,
      );
      return session;
    });
  }

  recordFieldAnswer(threadId: string, question: string, answer: string): void {
    this.replaceSession(threadId, (session) => {
      session.fieldAnswers = [...session.fieldAnswers, { question, answer }].slice(-20);
      return session;
    });
  }

  clearRestoredInput(threadId: string): void {
    this.replaceSession(threadId, (session) => {
      session.restoredInput = null;
      return session;
    });
  }

  clearEditorText(threadId: string): void {
    this.replaceSession(threadId, (session) => {
      session.editorText = null;
      return session;
    });
  }

  clearUnknown(threadId: string): void {
    this.replaceSession(threadId, (session) => {
      session.unknown = { total: 0, counts: {}, ring: [], loggedTypes: [] };
      session.rows = session.rows.filter((key) => key !== "sys:protocol");
      delete session.messages["sys:protocol"];
      return session;
    });
  }

  /** Abort the turn and hand the withdrawn queue back to the composer. */
  abortAndRestoreQueue(threadId: string, send: (frame: RawFrame) => void): { text: string; images: { mimeType: string; data: string }[] } {
    const session = this.state.sessions[threadId];
    const items = session ? [...session.queue.steering, ...session.queue.followUp] : [];
    send({ type: "abort_and_restore_queue" });
    const text = items.map((item) => item.text).filter(Boolean).join("\n\n");
    const images = items.flatMap((item) => item.images);
    this.replaceSession(threadId, (next) => {
      next.queue = { steering: [], followUp: [], liveSteered: next.queue.liveSteered };
      next.restoredInput = { id: Date.now(), text, images };
      return next;
    });
    return { text, images };
  }

  private commit(next: AppState, forceRoot = false): void {
    const previous = this.state;
    this.state = next;
    if (next === previous) return;
    this.dirtyRows = collectDirtyRows(previous, next, this.dirtyRows);
    if (forceRoot || rootFingerprint(previous) !== rootFingerprint(next)) this.rootDirty = true;
    this.requestFlush();
  }

  private requestFlush(): void {
    if (this.scheduled) return;
    if (!this.coalesce) {
      this.flush();
      return;
    }
    this.scheduled = true;
    this.schedule(() => this.flush());
  }

  flush(): void {
    this.scheduled = false;
    if (this.rootDirty) {
      this.rootDirty = false;
      for (const listener of Array.from(this.rootListeners)) listener();
    }
    if (this.dirtyRows.size > 0) {
      const rows = [...this.dirtyRows];
      this.dirtyRows.clear();
      for (const rowKey of rows) {
        const set = this.rowListeners.get(rowKey);
        if (!set) continue;
        for (const listener of Array.from(set)) listener();
      }
    }
  }
}

function collectDirtyRows(previous: AppState, next: AppState, target: Set<string>): Set<string> {
  for (const [threadId, session] of Object.entries(next.sessions)) {
    const prior = previous.sessions[threadId];
    if (!prior) {
      for (const key of Object.keys(session.messages)) target.add(`${threadId}${ROW_SEPARATOR}${key}`);
      continue;
    }
    for (const [key, record] of Object.entries(session.messages)) {
      if (prior.messages[key]?.version !== record.version) target.add(`${threadId}${ROW_SEPARATOR}${key}`);
    }
  }
  return target;
}

export function createStore(options?: StoreOptions): ConsoleStore {
  return new ConsoleStore(options);
}
