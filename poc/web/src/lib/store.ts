import { useSyncExternalStore } from "react";
import type {
  AppState,
  AskQuestion,
  Block,
  CommandInfo,
  ContextUsage,
  Envelope,
  FsListing,
  LogEntry,
  ModelInfo,
  QueueMode,
  ReadyInfo,
  RecentSession,
  ServerInfo,
  SessionState,
  SessionStats,
  ThreadInfo,
  ThreadState,
  TodoPhase,
  ToolResult,
  ToolRun,
  UIMessage,
  UiDialog,
  Usage,
} from "./types";

import {
  asArray as arr,
  asBoolean as bool,
  asNumber as num,
  asObject as obj,
  asString as str,
  asStrings as arrStr,
  isObject,
} from "./json";

type Obj = Record<string, unknown>;
const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const basename = (path: string): string => {
  const clean = path.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
};

function parseStatus(value: unknown): ThreadInfo["status"] {
  return value === "ready" || value === "exited" ? value : "starting";
}

function parseReady(value: unknown): ReadyInfo | null {
  const r = obj(value);
  const protocolVersion = num(r.protocolVersion);
  const maxFrameBytes = num(r.maxFrameBytes);
  const maxReassembledFrameBytes = num(r.maxReassembledFrameBytes);
  if (
    protocolVersion === undefined ||
    maxFrameBytes === undefined ||
    maxReassembledFrameBytes === undefined
  ) {
    return null;
  }
  return {
    protocolVersion,
    supportedProtocolVersions: arr(r.supportedProtocolVersions).filter(
      (v): v is number => typeof v === "number",
    ),
    maxFrameBytes,
    maxReassembledFrameBytes,
    supportsBashExcludeFromContext: bool(r.supportsBashExcludeFromContext) ?? false,
  };
}

function threadInfoFrom(value: unknown): ThreadInfo | null {
  const raw = obj(value);
  const id = str(raw.id);
  const cwd = str(raw.cwd);
  if (!id || !cwd) return null;
  return {
    id,
    cwd,
    status: parseStatus(raw.status),
    pid: num(raw.pid) ?? 0,
    createdAt: num(raw.createdAt) ?? Date.now(),
    lastActivity: num(raw.lastActivity) ?? Date.now(),
    exitCode: num(raw.exitCode) ?? null,
    resume: str(raw.resume) ?? null,
    title: str(raw.title) || basename(cwd),
    model: str(raw.model) ?? null,
    modelName: str(raw.modelName) ?? null,
    sessionName: str(raw.sessionName) ?? null,
    sessionFile: str(raw.sessionFile) ?? null,
    sessionId: str(raw.sessionId) ?? null,
    thinking: str(raw.thinking) ?? null,
    ready: parseReady(raw.ready),
  };
}

function parseContextUsage(value: unknown): ContextUsage | undefined {
  const c = obj(value);
  const tokens = num(c.tokens);
  const contextWindow = num(c.contextWindow);
  const percent = num(c.percent);
  if (tokens === undefined || contextWindow === undefined) return undefined;
  return { tokens, contextWindow, percent: percent ?? (tokens / contextWindow) * 100 };
}

function parseTodos(value: unknown): TodoPhase[] {
  return arr(value).map((phaseRaw) => {
    const phase = obj(phaseRaw);
    return {
      name: str(phase.name) ?? "Todos",
      tasks: arr(phase.tasks).map((taskRaw) => {
        const task = obj(taskRaw);
        return {
          content: str(task.content) ?? "",
          status: (str(task.status) ?? "pending") as TodoPhase["tasks"][number]["status"],
          blocker: str(task.blocker),
        };
      }),
    };
  });
}

function parseUsage(value: unknown): Usage | undefined {
  const u = obj(value);
  if (!Object.keys(u).length) return undefined;
  return {
    input: num(u.input) ?? 0,
    output: num(u.output) ?? 0,
    cacheRead: num(u.cacheRead) ?? 0,
    cacheWrite: num(u.cacheWrite) ?? 0,
    totalTokens: num(u.totalTokens) ?? 0,
    cost: (() => {
      const total = num(obj(u.cost).total);
      return total === undefined ? undefined : { total };
    })(),
  };
}

function parseModels(value: unknown): ModelInfo[] {
  const source = Array.isArray(value) ? value : arr(obj(value).models);
  const models: ModelInfo[] = [];
  for (const raw of source) {
    const m = obj(raw);
    const id = str(m.id);
    const provider = str(m.provider);
    if (!id || !provider) continue;
    models.push({
      id,
      provider,
      name: str(m.name) ?? id,
      reasoning: bool(m.reasoning),
      input: arrStr(m.input),
      contextWindow: num(m.contextWindow) ?? null,
      cost: (() => {
        const c = obj(m.cost);
        return {
          input: num(c.input) ?? 0,
          output: num(c.output) ?? 0,
          cacheRead: num(c.cacheRead) ?? 0,
          cacheWrite: num(c.cacheWrite) ?? 0,
        };
      })(),
    });
  }
  return models;
}

function parseCommands(value: unknown): CommandInfo[] {
  const source = arr(Array.isArray(value) ? value : obj(value).commands);
  const out: CommandInfo[] = [];
  for (const raw of source) {
    const c = obj(raw);
    const name = str(c.name);
    if (!name) continue;
    out.push({
      name,
      description: str(c.description),
      input: (() => {
        const hint = str(obj(c.input).hint);
        return hint ? { hint } : undefined;
      })(),
      subcommands: arr(c.subcommands).flatMap((s) => {
        const sub = obj(s);
        const subName = str(sub.name);
        return subName ? [{ name: subName, description: str(sub.description) }] : [];
      }),
      source: str(c.source),
    });
  }
  return out;
}

function parseStats(value: unknown): SessionStats {
  const stats = obj(value);
  const tokens = obj(stats.tokens);
  return {
    sessionFile: str(stats.sessionFile),
    sessionId: str(stats.sessionId),
    userMessages: num(stats.userMessages) ?? 0,
    assistantMessages: num(stats.assistantMessages) ?? 0,
    toolCalls: num(stats.toolCalls) ?? 0,
    toolResults: num(stats.toolResults) ?? 0,
    totalMessages: num(stats.totalMessages) ?? 0,
    tokens: {
      input: num(tokens.input) ?? 0,
      output: num(tokens.output) ?? 0,
      reasoning: num(tokens.reasoning) ?? 0,
      cacheRead: num(tokens.cacheRead) ?? 0,
      cacheWrite: num(tokens.cacheWrite) ?? 0,
      total: num(tokens.total) ?? 0,
    },
    cost: num(stats.cost) ?? 0,
    contextUsage: parseContextUsage(stats.contextUsage),
  };
}

function parseSession(value: unknown): SessionState {
  const data = obj(value);
  const model = obj(data.model);
  const provider = str(model.provider);
  const modelId = str(model.id);
  const queued = obj(data.queuedMessages);
  return {
    model:
      provider && modelId
        ? { provider, id: modelId, name: str(model.name) }
        : undefined,
    thinkingLevel: str(data.thinkingLevel),
    isStreaming: bool(data.isStreaming),
    isCompacting: bool(data.isCompacting),
    sessionFile: str(data.sessionFile),
    sessionId: str(data.sessionId),
    sessionName: str(data.sessionName),
    autoCompactionEnabled: bool(data.autoCompactionEnabled),
    messageCount: num(data.messageCount),
    queuedMessageCount: num(data.queuedMessageCount),
    hasPendingAsyncWork: bool(data.hasPendingAsyncWork),
    isSettled: bool(data.isSettled),
    queuedMessages:
      data.queuedMessages === undefined
        ? undefined
        : {
            steering: arrStr(queued.steering),
            followUp: arrStr(queued.followUp),
            liveSteered: num(queued.liveSteered) ?? 0,
          },
    todoPhases:
      data.todoPhases === undefined ? undefined : parseTodos(data.todoPhases),
    contextUsage: parseContextUsage(data.contextUsage),
    tokensPerSecond:
      typeof data.tokensPerSecond === "number"
        ? data.tokensPerSecond
        : data.tokensPerSecond === null
          ? null
          : undefined,
  };
}

// ---------------------------------------------------------------------------
// Transcript normalization
// ---------------------------------------------------------------------------

function argsText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeBlocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  const blocks: Block[] = [];
  for (const raw of arr(content)) {
    if (typeof raw === "string") {
      blocks.push({ kind: "text", text: raw });
      continue;
    }
    const c = obj(raw);
    switch (str(c.type)) {
      case "text":
        blocks.push({ kind: "text", text: str(c.text) ?? "" });
        break;
      case "thinking":
        blocks.push({ kind: "thinking", text: str(c.thinking) ?? "", done: true });
        break;
      case "redactedThinking":
        blocks.push({ kind: "other", label: "redacted thinking" });
        break;
      case "image":
        blocks.push({
          kind: "image",
          mimeType: str(c.mimeType) ?? "image/png",
          data: str(c.data) ?? "",
        });
        break;
      case "toolCall":
        blocks.push({
          kind: "toolCall",
          id: str(c.id) ?? "",
          name: str(c.name) ?? "tool",
          args: c.arguments,
          argsText: argsText(c.arguments),
          done: true,
        });
        break;
      default:
        blocks.push({ kind: "other", label: str(c.type) ?? "content" });
    }
  }
  return blocks;
}

function normalizeMessage(
  value: unknown,
  messageId?: string,
  index = 0,
): UIMessage | null {
  const m = obj(value);
  const role = str(m.role);
  if (!role) return null;
  const timestamp = num(m.timestamp) ?? Date.now();
  const key = messageId ?? `h:${role}:${timestamp}:${index}`;
  const message: UIMessage = {
    key,
    role,
    timestamp,
    blocks: normalizeBlocks(m.content),
  };

  if (role === "assistant") {
    message.model = str(m.model);
    message.provider = str(m.provider);
    message.usage = parseUsage(m.usage);
    message.duration = num(m.duration);
    message.stopReason = str(m.stopReason);
    message.error =
      message.stopReason === "aborted" ? undefined : str(m.errorMessage);
  }
  if (role === "bashExecution" || role === "pythonExecution") {
    message.command = str(m.command) ?? str(m.code) ?? "";
    message.output = str(m.output) ?? "";
    message.exitCode = num(m.exitCode);
    message.isError = m.cancelled === true || (message.exitCode ?? 0) !== 0;
  }
  if (role === "toolResult") {
    message.toolCallId = str(m.toolCallId);
    message.toolName = str(m.toolName);
    message.isError = m.isError === true;
    message.details = m.details;
  }
  if (role === "custom" || role === "hookMessage") {
    message.customType = str(m.customType);
  }
  if (role === "branchSummary") {
    message.blocks = [{ kind: "text", text: str(m.summary) ?? "" }];
  }
  if (role === "compactionSummary") {
    message.blocks = [{ kind: "text", text: str(m.summary) ?? "" }];
  }
  if (role === "fileMention") {
    const paths = arr(m.files)
      .map((f) => str(obj(f).path))
      .filter((p): p is string => !!p);
    message.blocks = [{ kind: "text", text: paths.join("\n") }];
  }
  return message;
}

function toolResultOf(message: UIMessage): ToolResult | null {
  if (message.role !== "toolResult" || !message.toolCallId) return null;
  const text = message.blocks
    .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
  const images = message.blocks
    .filter((b): b is Extract<Block, { kind: "image" }> => b.kind === "image")
    .map((b) => ({ mimeType: b.mimeType, data: b.data }));
  return {
    toolCallId: message.toolCallId,
    name: message.toolName ?? "tool",
    text,
    images,
    isError: message.isError === true,
    details: message.details,
  };
}

function upsertMessage(list: UIMessage[], message: UIMessage): UIMessage[] {
  const byKey = list.findIndex((m) => m.key === message.key);
  if (byKey >= 0) {
    const next = list.slice();
    next[byKey] = { ...message, key: list[byKey].key };
    return next;
  }
  const byTime = list.findIndex(
    (m) => m.role === message.role && m.timestamp === message.timestamp,
  );
  if (byTime >= 0) {
    const next = list.slice();
    next[byTime] = { ...message, key: list[byTime].key };
    return next;
  }
  return [...list, message];
}

function makeToolResultMap(messages: UIMessage[]): Record<string, ToolResult> {
  const map: Record<string, ToolResult> = {};
  for (const message of messages) {
    const result = toolResultOf(message);
    if (result) map[result.toolCallId] = result;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const storedTheme = (() => {
  const value = document.documentElement.dataset.theme;
  return value === "light" ? "light" : "dark";
})();

const storedQueue = (() => {
  try {
    const value = localStorage.getItem("omp.queueMode");
    return value === "followUp" ? "followUp" : "steer";
  } catch {
    return "steer";
  }
})();

let state: AppState = {
  connected: false,
  threads: {},
  order: [],
  view: null,
  recent: [],
  recentLoaded: false,
  models: [],
  toasts: [],
  theme: storedTheme,
  modal: null,
  confirmState: null,
  sidebarOpen: false,
  showTodos: false,
  queueMode: storedQueue,
};

const listeners = new Set<() => void>();
let toastSeq = 0;
let logSeq = 0;
let commandSeq = 0;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AppState {
  return state;
}

export function useApp(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function blankThread(info: ThreadInfo): ThreadState {
  return {
    info,
    models: state.models,
    levels: [],
    commands: [],
    messages: [],
    toolResults: {},
    toolRuns: {},
    activity: {
      running: false,
      turn: 0,
      settled: info.status === "ready",
    },
    queue: { steering: [], followUp: [] },
    todos: [],
    dialogs: [],
    statuses: {},
    widgets: {},
    log: [],
    lastFrameAt: info.lastActivity,
  };
}

function toast(level: "info" | "success" | "warning" | "error", text: string) {
  const id = ++toastSeq;
  state = { ...state, toasts: [...state.toasts, { id, level, text }].slice(-5) };
  emit();
  window.setTimeout(() => {
    state = { ...state, toasts: state.toasts.filter((t) => t.id !== id) };
    emit();
  }, 5200);
}

export { toast };

function pushLog(t: ThreadState, level: LogEntry["level"], text: string): ThreadState {
  const entry: LogEntry = { id: ++logSeq, ts: Date.now(), level, text };
  return { ...t, log: [...t.log, entry].slice(-200) };
}

function patch(threadId: string, update: (t: ThreadState) => ThreadState) {
  const current = state.threads[threadId];
  if (!current) return;
  const next = update(current);
  if (next === current) return;
  state = {
    ...state,
    threads: {
      ...state.threads,
      [threadId]: { ...next, lastFrameAt: Date.now() },
    },
  };
  emit();
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let reconnectDelay = 400;

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

export function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  socket = new WebSocket(wsUrl());
  socket.onopen = () => {
    reconnectDelay = 400;
    state = { ...state, connected: true };
    emit();
    if (state.view) {
      sendView(state.view);
      hydrate(state.view);
    }
  };
  socket.onmessage = (event) => {
    try {
      handleEnvelope(JSON.parse(event.data as string));
    } catch {
      // Ignore malformed frames; the server only emits JSON.
    }
  };
  socket.onclose = () => {
    socket = null;
    if (state.connected) {
      state = { ...state, connected: false };
      emit();
    }
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.7, 5000);
  };
  socket.onerror = () => {
    socket?.close();
  };
}

function sendView(thread: string | null) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ op: "view", thread }));
  }
}

function send(
  thread: string,
  frame: Record<string, unknown>,
  quiet = false,
): string | null {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    if (!quiet) toast("warning", "Not connected to the omp-web server");
    return null;
  }
  const explicit = typeof frame.id === "string" ? frame.id : null;
  const id = explicit ?? `ui-${++commandSeq}-${Date.now().toString(36)}`;
  socket.send(JSON.stringify({ op: "command", thread, frame: { ...frame, id } }));
  return id;
}

function hydrate(threadId: string) {
  const t = state.threads[threadId];
  if (!t) return;
  send(threadId, { type: "get_state" }, true);
  send(threadId, { type: "get_session_stats" }, true);
  send(threadId, { type: "get_messages" }, true);
  send(threadId, { type: "get_available_thinking_levels" }, true);
  if (!t.commands.length) {
    send(threadId, { type: "get_available_commands" }, true);
  }
  if (!state.models.length && !t.models.length) {
    send(threadId, { type: "get_available_models" }, true);
  }
}

function handleEnvelope(raw: unknown) {
  const envelope = obj(raw) as Partial<Envelope> & Obj;
  const op = str(envelope.op);

  switch (op) {
    case "hello": {
      const infos = arr(envelope.threads)
        .map(threadInfoFrom)
        .filter((v): v is ThreadInfo => !!v);
      const threads: Record<string, ThreadState> = {};
      for (const info of infos) {
        const existing = state.threads[info.id];
        threads[info.id] = existing
          ? { ...existing, info }
          : blankThread(info);
      }
      const order = infos.map((i) => i.id);
      state = { ...state, threads, order, connected: true };
      if (state.view && !threads[state.view]) state.view = null;
      emit();
      if (state.view) {
        selectThread(state.view);
      } else if (order.length) {
        selectThread(order[0]);
      }
      break;
    }
    case "thread": {
      const info = threadInfoFrom(envelope.thread);
      if (info) upsertThread(info);
      break;
    }
    case "thread_removed": {
      const id = str(envelope.id);
      if (id) removeThreadLocal(id);
      break;
    }
    case "frame": {
      const thread = str(envelope.thread);
      const frame = obj(envelope.frame);
      if (thread && str(frame.type)) applyFrame(thread, frame);
      break;
    }
    case "lagged": {
      const thread = str(envelope.thread);
      if (thread) {
        const skipped = num(envelope.skipped) ?? 0;
        patch(thread, (t) => pushLog(t, "warning", `dropped ${skipped} frames; resyncing`));
        hydrate(thread);
      }
      break;
    }
    case "notice": {
      const thread = str(envelope.thread);
      const level = str(envelope.level) ?? "info";
      const message = str(envelope.message) ?? "";
      if (thread) {
        patch(thread, (t) => pushLog(t, level as LogEntry["level"], message));
      }
      if (level === "warning" || level === "error") {
        toast(level, message);
      }
      break;
    }
    default:
      break;
  }
}

function upsertThread(incoming: ThreadInfo) {
  const existing = state.threads[incoming.id];
  const wasReady = existing?.info.status;
  const info: ThreadInfo = existing
    ? {
        ...incoming,
        sessionFile: incoming.sessionFile ?? existing.info.sessionFile,
        sessionId: incoming.sessionId ?? existing.info.sessionId,
        sessionName: incoming.sessionName ?? existing.info.sessionName,
        model: incoming.model ?? existing.info.model,
        modelName: incoming.modelName ?? existing.info.modelName,
        thinking: incoming.thinking ?? existing.info.thinking,
      }
    : incoming;
  const thread = existing ? { ...existing, info } : blankThread(info);
  if (info.status === "exited") {
    thread.activity = { ...thread.activity, running: false, settled: true };
  }
  state = {
    ...state,
    threads: { ...state.threads, [info.id]: thread },
    order: state.order.includes(info.id)
      ? state.order
      : [info.id, ...state.order],
  };
  emit();
  if (state.view === info.id && info.status === "ready" && wasReady !== "ready") {
    hydrate(info.id);
  }
}

function removeThreadLocal(id: string) {
  if (!state.threads[id]) return;
  const threads = { ...state.threads };
  delete threads[id];
  const order = state.order.filter((x) => x !== id);
  let view = state.view;
  if (view === id) {
    view = order[0] ?? null;
  }
  state = { ...state, threads, order, view };
  emit();
  if (view) selectThread(view);
}

// ---------------------------------------------------------------------------
// Frame reducer
// ---------------------------------------------------------------------------

function applyFrame(threadId: string, frame: Obj) {
  const type = str(frame.type);
  if (!type) return;

  if (type === "response") {
    handleResponse(threadId, frame);
    return;
  }

  switch (type) {
    case "agent_start":
      patch(threadId, (t) => ({
        ...t,
        activity: {
          running: true,
          startedAt: t.activity.running ? t.activity.startedAt : Date.now(),
          turn: t.activity.turn,
          settled: false,
        },
      }));
      break;

    case "turn_start":
      patch(threadId, (t) => ({
        ...t,
        activity: {
          ...t.activity,
          running: true,
          startedAt: t.activity.startedAt ?? Date.now(),
          turn: t.activity.turn + 1,
          settled: false,
        },
      }));
      break;

    case "turn_end":
      patch(threadId, (t) => ({
        ...t,
        activity: { ...t.activity },
      }));
      break;

    case "agent_end": {
      const incoming = arr(frame.messages)
        .map((m, i) => normalizeMessage(m, undefined, i))
        .filter((m): m is UIMessage => !!m);
      const terminal = frame.isTerminal !== false;
      patch(threadId, (t) => {
        let messages = t.messages;
        for (const message of incoming) messages = upsertMessage(messages, message);
        return {
          ...t,
          messages,
          toolResults: makeToolResultMap(messages),
          activity: {
            ...t.activity,
            running: !terminal,
            settled: terminal,
            retry: undefined,
            compaction: undefined,
          },
        };
      });
      if (terminal) {
        window.setTimeout(() => {
          send(threadId, { type: "get_state" }, true);
          send(threadId, { type: "get_session_stats" }, true);
        }, 40);
      }
      break;
    }

    case "session_settled":
      patch(threadId, (t) => ({
        ...t,
        activity: { ...t.activity, running: false, settled: true },
      }));
      break;

    case "message_start": {
      const messageId = str(frame.messageId);
      const message = normalizeMessage(frame.message, messageId);
      if (!message) return;
      if (message.role === "assistant") message.streaming = true;
      patch(threadId, (t) => {
        const messages = upsertMessage(t.messages, message);
        return {
          ...t,
          messages,
          toolResults:
            message.role === "toolResult"
              ? makeToolResultMap(messages)
              : t.toolResults,
        };
      });
      break;
    }

    case "message_update": {
      const messageId = str(frame.messageId);
      const event = obj(frame.assistantMessageEvent);
      const eventType = str(event.type);
      if (!eventType) return;
      const rawMessage = frame.message;
      patch(threadId, (t) => {
        const idx = messageId
          ? t.messages.findIndex((m) => m.key === messageId)
          : -1;
        let message = idx >= 0 ? t.messages[idx] : undefined;

        if (!message && isObject(rawMessage)) {
          const created = normalizeMessage(rawMessage, messageId);
          if (!created) return t;
          created.streaming = true;
          message = created;
        }
        if (!message) return t;

        const next: UIMessage = { ...message, streaming: true };

        if (isObject(event.partial)) {
          next.blocks = normalizeBlocks(obj(event.partial).content);
          const usage = parseUsage(obj(event.partial).usage);
          if (usage) next.usage = usage;
        } else {
          next.blocks = applyAssistantDelta(message.blocks, event);
        }

        if (eventType === "done" && isObject(event.message)) {
          const done = normalizeMessage(event.message, messageId);
          if (done) {
            done.streaming = false;
            return {
              ...t,
              messages: upsertMessage(t.messages, done),
            };
          }
        }
        if (eventType === "error") {
          const errorMessage = normalizeMessage(event.error, messageId);
          if (errorMessage) {
            errorMessage.streaming = false;
            errorMessage.error =
              errorMessage.error ?? str(event.reason) ?? "generation failed";
            return {
              ...t,
              messages: upsertMessage(t.messages, errorMessage),
              activity: { ...t.activity, running: false, settled: true },
            };
          }
        }

        const messages =
          idx >= 0
            ? t.messages.map((m) => (m.key === message?.key ? next : m))
            : [...t.messages, next];
        return { ...t, messages };
      });
      break;
    }

    case "message_end": {
      const messageId = str(frame.messageId);
      const message = normalizeMessage(frame.message, messageId);
      if (!message) return;
      message.streaming = false;
      patch(threadId, (t) => {
        const messages = upsertMessage(t.messages, message);
        return {
          ...t,
          messages,
          toolResults:
            message.role === "toolResult"
              ? makeToolResultMap(messages)
              : t.toolResults,
        };
      });
      break;
    }

    case "tool_execution_start": {
      const id = str(frame.toolCallId);
      if (!id) return;
      const run: ToolRun = {
        id,
        name: str(frame.toolName) ?? "tool",
        args: frame.args,
        startedAt: Date.now(),
      };
      patch(threadId, (t) => ({
        ...t,
        toolRuns: { ...t.toolRuns, [id]: run },
      }));
      break;
    }

    case "tool_execution_update": {
      const id = str(frame.toolCallId);
      if (!id) return;
      const partial = argsText(frame.partialResult);
      patch(threadId, (t) => {
        const run = t.toolRuns[id];
        if (!run) return t;
        return { ...t, toolRuns: { ...t.toolRuns, [id]: { ...run, partial } } };
      });
      break;
    }

    case "tool_execution_end": {
      const id = str(frame.toolCallId);
      if (!id) return;
      const result = obj(frame.result);
      const text = normalizeBlocks(result.content)
        .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
        .map((b) => b.text)
        .join("\n");
      patch(threadId, (t) => {
        const run = t.toolRuns[id];
        if (!run) return t;
        return {
          ...t,
          toolRuns: {
            ...t.toolRuns,
            [id]: {
              ...run,
              endedAt: Date.now(),
              text,
              isError: frame.isError === true,
            },
          },
        };
      });
      break;
    }

    case "queue_update":
      patch(threadId, (t) => ({
        ...t,
        queue: {
          steering: arrStr(frame.steering),
          followUp: arrStr(frame.followUp),
          liveSteered: num(frame.liveSteered) ?? 0,
        },
      }));
      break;

    case "model_changed":
      patch(threadId, (t) => pushLog(t, "info", "model changed"));
      send(threadId, { type: "get_state" }, true);
      break;

    case "thinking_level_changed": {
      const level = str(frame.thinkingLevel);
      patch(threadId, (t) => ({
        ...t,
        info: level ? { ...t.info, thinking: level } : t.info,
        session: t.session ? { ...t.session, thinkingLevel: level } : t.session,
      }));
      break;
    }

    case "session_info_update": {
      const title = str(frame.title);
      const sessionId = str(frame.sessionId);
      patch(threadId, (t) => ({
        ...t,
        info: {
          ...t.info,
          title: title ?? t.info.title,
          sessionName: title ?? t.info.sessionName,
          sessionId: sessionId ?? t.info.sessionId,
        },
      }));
      break;
    }

    case "available_commands_update":
      patch(threadId, (t) => ({
        ...t,
        commands: parseCommands(frame.commands),
      }));
      break;

    case "auto_retry_start":
      patch(threadId, (t) => ({
        ...t,
        activity: {
          ...t.activity,
          running: true,
          settled: false,
          retry: {
            attempt: num(frame.attempt) ?? 1,
            maxAttempts: num(frame.maxAttempts) ?? 1,
            message: str(frame.errorMessage) ?? "provider error",
            delayMs: num(frame.delayMs) ?? 0,
          },
        },
      }));
      break;

    case "auto_retry_end":
      patch(threadId, (t) => ({
        ...t,
        activity: { ...t.activity, retry: undefined },
      }));
      if (frame.success === false) {
        toast("error", str(frame.finalError) ?? "Automatic retry failed");
      }
      break;

    case "auto_compaction_start":
      patch(threadId, (t) => ({
        ...t,
        activity: {
          ...t.activity,
          compaction: { kind: "auto", action: str(frame.action) ?? "auto" },
        },
      }));
      break;

    case "auto_compaction_end":
      patch(threadId, (t) => ({
        ...t,
        activity: { ...t.activity, compaction: undefined },
      }));
      if (frame.errorMessage) {
        toast("warning", str(frame.errorMessage) ?? "Compaction failed");
      }
      break;

    case "manual_compaction_start":
      patch(threadId, (t) => ({
        ...t,
        activity: {
          ...t.activity,
          compaction: { kind: "manual", action: str(frame.mode) ?? "manual" },
        },
      }));
      break;

    case "manual_compaction_end":
      patch(threadId, (t) => ({
        ...t,
        activity: { ...t.activity, compaction: undefined },
      }));
      if (frame.aborted === true) {
        toast("info", "Compaction cancelled");
      } else if (frame.errorMessage) {
        toast("warning", str(frame.errorMessage) ?? "Compaction failed");
      } else if (frame.skipped !== true) {
        toast("success", "Conversation compacted");
      }
      break;

    case "prompt_result": {
      const status = str(frame.status);
      if (status === "error") {
        const error = obj(frame.error);
        const message =
          str(error.message) ?? "The prompt failed before reaching the model";
        patch(threadId, (t) => pushLog(t, "error", message));
        toast("error", message);
      }
      if (frame.sessionSettled === true) {
        patch(threadId, (t) => ({
          ...t,
          activity: { ...t.activity, running: false, settled: true },
        }));
      }
      break;
    }

    case "prompt_result": {
      const status = str(frame.status);
      if (status === "error") {
        const error = obj(frame.error);
        const message =
          str(error.message) ?? "The prompt failed before reaching the model";
        patch(threadId, (t) => pushLog(t, "error", message));
        toast("error", message);
      }
      if (frame.sessionSettled === true) {
        patch(threadId, (t) => ({
          ...t,
          activity: { ...t.activity, running: false, settled: true },
        }));
      }
      break;
    }

    case "notice": {
      const level = (str(frame.level) ?? "info") as LogEntry["level"];
      const message = str(frame.message) ?? "";
      patch(threadId, (t) => pushLog(t, level, message));
      if (level === "warning" || level === "error") toast(level, message);
      break;
    }

    case "command_output": {
      const text = str(frame.text) ?? "";
      if (!text) return;
      const message: UIMessage = {
        key: `cmd:${Date.now()}:${logSeq++}`,
        role: "command",
        timestamp: Date.now(),
        blocks: [{ kind: "text", text }],
      };
      patch(threadId, (t) => ({
        ...t,
        messages: [...t.messages, message],
      }));
      break;
    }

    case "extension_ui_request":
      handleUiRequest(threadId, frame);
      break;

    case "extension_error":
      patch(threadId, (t) =>
        pushLog(
          t,
          "error",
          `${str(frame.event) ?? "extension"}: ${str(frame.error) ?? "error"}`,
        ),
      );
      break;

    case "rpc_frame_error": {
      const message = str(frame.message) ?? "transport frame error";
      patch(threadId, (t) => pushLog(t, "warning", message));
      break;
    }

    default:
      break;
  }
}

function applyAssistantDelta(blocks: Block[], event: Obj): Block[] {
  const kind = str(event.type);
  const contentIndex = num(event.contentIndex) ?? 0;
  const next = blocks.slice();
  while (next.length <= contentIndex) next.push({ kind: "text", text: "" });
  const block = obj(event.block);
  const current = next[contentIndex];

  switch (kind) {
    case "text_start":
      next[contentIndex] = { kind: "text", text: str(block.text) ?? "" };
      break;
    case "text_delta": {
      const delta = str(event.delta) ?? "";
      next[contentIndex] =
        current?.kind === "text"
          ? { ...current, text: current.text + delta }
          : { kind: "text", text: delta };
      break;
    }
    case "text_end": {
      const text =
        str(event.content) ?? (current?.kind === "text" ? current.text : "");
      next[contentIndex] = { kind: "text", text };
      break;
    }
    case "thinking_start":
      next[contentIndex] = {
        kind: "thinking",
        text: str(block.thinking) ?? "",
        done: false,
      };
      break;
    case "thinking_delta": {
      const delta = str(event.delta) ?? "";
      next[contentIndex] =
        current?.kind === "thinking"
          ? { ...current, text: current.text + delta }
          : { kind: "thinking", text: delta, done: false };
      break;
    }
    case "thinking_end": {
      const text =
        str(event.content) ??
        (current?.kind === "thinking" ? current.text : "");
      next[contentIndex] = { kind: "thinking", text, done: true };
      break;
    }
    case "toolcall_start":
      next[contentIndex] = {
        kind: "toolCall",
        id: str(block.id) ?? `pending-${contentIndex}`,
        name: str(block.name) ?? "tool",
        argsText: "",
        done: false,
      };
      break;
    case "toolcall_delta": {
      const delta = str(event.delta) ?? "";
      next[contentIndex] =
        current?.kind === "toolCall"
          ? { ...current, argsText: current.argsText + delta }
          : {
              kind: "toolCall",
              id: `pending-${contentIndex}`,
              name: "tool",
              argsText: delta,
              done: false,
            };
      break;
    }
    case "toolcall_end": {
      const call = obj(event.toolCall);
      next[contentIndex] = {
        kind: "toolCall",
        id: str(call.id) ?? `pending-${contentIndex}`,
        name: str(call.name) ?? "tool",
        args: call.arguments,
        argsText: argsText(call.arguments),
        done: true,
      };
      break;
    }
    case "image_end": {
      const image = obj(event.content);
      next[contentIndex] = {
        kind: "image",
        mimeType: str(image.mimeType) ?? "image/png",
        data: str(image.data) ?? "",
      };
      break;
    }
    default:
      break;
  }
  return next;
}

function handleResponse(threadId: string, frame: Obj) {
  const command = str(frame.command) ?? "";
  const success = frame.success === true;
  const data = frame.data;

  if (!success) {
    const message = str(frame.error) ?? "command failed";
    const code = str(frame.code);
    if (command === "get_messages" && code === "session_busy") {
      patch(threadId, (t) => pushLog(t, "info", "history requested while busy; will retry"));
      return;
    }
    patch(threadId, (t) => pushLog(t, "error", `${command || "command"}: ${message}`));
    toast("error", `${command || "command"}: ${message}`);
    return;
  }

  switch (command) {
    case "get_state": {
      const session = parseSession(data);
      patch(threadId, (t) => {
        const model = session.model;
        const info: ThreadInfo = {
          ...t.info,
          model: model ? `${model.provider}/${model.id}` : t.info.model,
          modelName: model?.name ?? t.info.modelName,
          thinking: session.thinkingLevel ?? t.info.thinking,
          sessionName: session.sessionName ?? t.info.sessionName,
          title: session.sessionName || t.info.title,
          sessionFile: session.sessionFile ?? t.info.sessionFile,
          sessionId: session.sessionId ?? t.info.sessionId,
        };
        const running = session.isStreaming ?? t.activity.running;
        return {
          ...t,
          session,
          info,
          queue: session.queuedMessages ?? t.queue,
          todos: session.todoPhases ?? t.todos,
          activity: {
            ...t.activity,
            running,
            startedAt:
              running && !t.activity.running
                ? Date.now()
                : t.activity.running
                  ? t.activity.startedAt
                  : undefined,
            settled: session.isSettled ?? t.activity.settled,
          },
        };
      });
      break;
    }

    case "get_session_stats": {
      const stats = parseStats(data);
      patch(threadId, (t) => ({
        ...t,
        stats,
        info: {
          ...t.info,
          sessionFile: stats.sessionFile ?? t.info.sessionFile,
          sessionId: stats.sessionId ?? t.info.sessionId,
        },
      }));
      break;
    }

    case "get_messages": {
      const incoming = arr(obj(data).messages)
        .map((m, i) => normalizeMessage(m, undefined, i))
        .filter((m): m is UIMessage => !!m);
      patch(threadId, (t) => {
        let messages = incoming;
        // A hydration snapshot can be older than events already applied. Keep
        // anything local that is newer than the snapshot's frontier.
        const frontier = messages.reduce(
          (max, message) => Math.max(max, message.timestamp),
          0,
        );
        for (const live of t.messages) {
          if (
            live.streaming ||
            live.role === "command" ||
            live.timestamp > frontier
          ) {
            messages = upsertMessage(messages, live);
          }
        }
        return {
          ...t,
          messages,
          toolResults: makeToolResultMap(messages),
        };
      });
      break;
    }

    case "get_available_models": {
      const models = parseModels(data);
      state = { ...state, models };
      patch(threadId, (t) => ({ ...t, models }));
      break;
    }

    case "get_available_thinking_levels":
      patch(threadId, (t) => ({ ...t, levels: arrStr(obj(data).levels) }));
      break;

    case "get_available_commands":
      patch(threadId, (t) => ({ ...t, commands: parseCommands(data) }));
      break;

    case "set_model": {
      const model = obj(data);
      const provider = str(model.provider);
      const id = str(model.id);
      if (!provider || !id) return;
      patch(threadId, (t) => ({
        ...t,
        info: {
          ...t.info,
          model: `${provider}/${id}`,
          modelName: str(model.name) ?? t.info.modelName,
        },
        session: t.session
          ? {
              ...t.session,
              model: { provider, id, name: str(model.name) },
            }
          : t.session,
      }));
      break;
    }

    case "set_thinking_level": {
      const level = str(obj(data).level) ?? str(obj(data).thinkingLevel);
      if (!level) return;
      patch(threadId, (t) => ({
        ...t,
        info: { ...t.info, thinking: level },
        session: t.session ? { ...t.session, thinkingLevel: level } : t.session,
      }));
      break;
    }

    case "abort_and_restore_queue": {
      const payload = obj(data);
      const restored = [...arr(payload.steering), ...arr(payload.followUp)];
      const texts: string[] = [];
      const images: { mimeType: string; data: string }[] = [];
      for (const item of restored) {
        if (typeof item === "string") {
          texts.push(item);
          continue;
        }
        const entry = obj(item);
        const text = str(entry.text);
        if (text) texts.push(text);
        for (const image of arr(entry.images)) {
          const img = obj(image);
          const data = str(img.data);
          if (data) {
            images.push({
              mimeType: str(img.mimeType) ?? "image/png",
              data,
            });
          }
        }
      }
      if (texts.length || images.length) {
        patch(threadId, (t) => ({
          ...t,
          editor: {
            text: texts.join("\n\n"),
            nonce: Date.now(),
            images: images.length ? images : undefined,
          },
        }));
      }
      break;
    }

    case "new_session": {
      if (obj(data).cancelled === true) {
        toast("info", "Session change cancelled");
        return;
      }
      patch(threadId, (t) => ({
        ...t,
        messages: [],
        toolResults: {},
        toolRuns: {},
        queue: { steering: [], followUp: [] },
        todos: [],
        stats: undefined,
        activity: { running: false, turn: 0, settled: true },
      }));
      hydrate(threadId);
      break;
    }

    case "fork": {
      if (obj(data).cancelled === true) {
        toast("info", "Fork cancelled");
        return;
      }
      toast("success", "Conversation forked");
      hydrate(threadId);
      break;
    }

    case "remove_queued_message": {
      const payload = obj(data);
      if (payload.removed === false) {
        patch(threadId, (t) => pushLog(t, "info", "message was already delivered"));
      }
      const restored = arr(payload.images)
        .map((raw) => {
          const image = obj(raw);
          const imageData = str(image.data);
          return imageData
            ? {
                mimeType: str(image.mimeType) ?? "image/png",
                data: imageData,
              }
            : null;
        })
        .filter((image): image is { mimeType: string; data: string } => !!image);
      if (restored.length) {
        patch(threadId, (t) => ({
          ...t,
          editor: {
            text: t.editor?.text ?? "",
            nonce: Date.now(),
            images: [...(t.editor?.images ?? []), ...restored],
          },
        }));
      }
      break;
    }

    case "set_auto_compaction": {
      send(threadId, { type: "get_state" }, true);
      break;
    }

    case "compact": {
      toast("success", "Compaction finished");
      send(threadId, { type: "get_state" }, true);
      break;
    }

    case "export_html": {
      const path = str(data) ?? str(obj(data).path) ?? str(obj(data).outputPath);
      toast("success", path ? `Exported to ${path}` : "Session exported");
      break;
    }

    case "prompt": {
      if (obj(data).agentInvoked === false) {
        send(threadId, { type: "get_state" }, true);
      }
      break;
    }

    default:
      break;
  }
}

function handleUiRequest(threadId: string, frame: Obj) {
  const method = str(frame.method) ?? "";
  const id = str(frame.id) ?? "";
  const timeout = num(frame.timeout);

  switch (method) {
    case "select": {
      const options = arrStr(frame.options);
      const details = arr(frame.optionDetails).map((d) => str(obj(d).description));
      const dialog: UiDialog = {
        kind: "select",
        id,
        title: str(frame.title) ?? "Choose",
        timeout,
        options: options.map((label, i) => ({
          label,
          description: details[i],
        })),
      };
      addDialog(threadId, dialog);
      break;
    }
    case "confirm": {
      addDialog(threadId, {
        kind: "confirm",
        id,
        title: str(frame.title) ?? "Confirm",
        message: str(frame.message) ?? "",
        timeout,
      });
      break;
    }
    case "input":
    case "editor": {
      addDialog(threadId, {
        kind: "input",
        id,
        title: str(frame.title) ?? "Input",
        placeholder: str(frame.placeholder),
        secret: method === "input" ? bool(frame.secret) : undefined,
        timeout,
        editor: method === "editor",
        prefill: str(frame.prefill),
        promptStyle: bool(frame.promptStyle),
      });
      break;
    }
    case "ask": {
      const questions: AskQuestion[] = arr(frame.questions).map((q) => {
        const question = obj(q);
        return {
          id: str(question.id) ?? "",
          question: str(question.question) ?? "",
          header: str(question.header),
          multi: bool(question.multi),
          recommended: num(question.recommended),
          options: arr(question.options).map((o) => {
            const option = obj(o);
            return {
              label: str(option.label) ?? "",
              description: str(option.description),
              preview: str(option.preview),
            };
          }),
        };
      });
      addDialog(threadId, { kind: "ask", id, questions, timeout });
      break;
    }
    case "cancel": {
      const target = str(frame.targetId);
      if (target) {
        patch(threadId, (t) => ({
          ...t,
          dialogs: t.dialogs.filter((d) => d.id !== target),
        }));
      }
      break;
    }
    case "notify": {
      const level = (str(frame.notifyType) ?? "info") as "info" | "warning" | "error";
      const message = str(frame.message) ?? "";
      patch(threadId, (t) => pushLog(t, level, message));
      if (message) toast(level, message);
      break;
    }
    case "setStatus": {
      const key = str(frame.statusKey) ?? "";
      const text = str(frame.statusText);
      patch(threadId, (t) => {
        const statuses = { ...t.statuses };
        if (text) statuses[key] = text;
        else delete statuses[key];
        return { ...t, statuses };
      });
      break;
    }
    case "setWidget": {
      const key = str(frame.widgetKey) ?? "";
      const lines = arrStr(frame.widgetLines);
      patch(threadId, (t) => {
        const widgets = { ...t.widgets };
        if (lines.length) widgets[key] = lines;
        else delete widgets[key];
        return { ...t, widgets };
      });
      break;
    }
    case "setTitle": {
      const title = str(frame.title);
      if (title) {
        patch(threadId, (t) => ({
          ...t,
          info: { ...t.info, title, sessionName: title },
        }));
      }
      break;
    }
    case "set_editor_text": {
      const text = str(frame.text) ?? "";
      patch(threadId, (t) => ({
        ...t,
        editor: { text, nonce: Date.now() },
      }));
      break;
    }
    case "open_url": {
      const raw = str(frame.launchUrl) ?? str(frame.url) ?? "";
      if (!raw) break;
      let safe: string | null = null;
      try {
        const parsed = new URL(raw);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          safe = parsed.href;
        }
      } catch {
        // Ignore malformed URLs.
      }
      if (safe) {
        patch(threadId, (t) => pushLog(t, "info", `Open in browser: ${safe}`));
        toast("info", `Open: ${safe}`);
        window.open(safe, "_blank", "noopener,noreferrer");
      } else {
        patch(threadId, (t) =>
          pushLog(t, "warning", "blocked a non-http URL from an extension"),
        );
      }
      break;
    }
    default:
      break;
  }
}

function addDialog(threadId: string, dialog: UiDialog) {
  patch(threadId, (t) => {
    const exists = t.dialogs.some((d) => d.id === dialog.id);
    return {
      ...t,
      dialogs: exists
        ? t.dialogs.map((d) => (d.id === dialog.id ? dialog : d))
        : [...t.dialogs, dialog],
      activity: { ...t.activity, running: true },
    };
  });
}

// ---------------------------------------------------------------------------
// REST + actions
// ---------------------------------------------------------------------------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body: unknown = await response.json();
      message = str(obj(body).error) ?? message;
    } catch {
      // Keep the status text when the body is not JSON.
    }
    throw new Error(message || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function boot() {
  connect();
  const [info, threads, recent] = await Promise.allSettled([
    api<ServerInfo>("/api/info"),
    api<ThreadInfo[]>("/api/threads"),
    api<RecentSession[]>("/api/recent?limit=60"),
  ]);
  if (info.status === "fulfilled") {
    state = { ...state, info: info.value };
  }
  if (threads.status === "fulfilled") {
    for (const threadInfo of threads.value) {
      const existing = state.threads[threadInfo.id];
      state.threads[threadInfo.id] = existing
        ? { ...existing, info: threadInfo }
        : blankThread(threadInfo);
      if (!state.order.includes(threadInfo.id)) {
        state.order.push(threadInfo.id);
      }
    }
    state = { ...state, threads: { ...state.threads }, order: [...state.order] };
  }
  if (recent.status === "fulfilled") {
    state = { ...state, recent: recent.value, recentLoaded: true };
  }
  emit();

  if (!state.view && state.order.length) {
    selectThread(state.order[0]);
  } else if (state.view) {
    selectThread(state.view);
  }
}

export async function refreshRecent() {
  try {
    const recent = await api<RecentSession[]>("/api/recent?limit=60");
    state = { ...state, recent, recentLoaded: true };
    emit();
  } catch (error) {
    toast("warning", `Could not load recent sessions: ${errText(error)}`);
  }
}

export function selectThread(id: string) {
  const exists = !!state.threads[id];
  if (!exists) return;
  state = {
    ...state,
    view: id,
    sidebarOpen: false,
  };
  emit();
  sendView(id);
  hydrate(id);
}

export async function createThread(input: {
  cwd?: string;
  resume?: string;
  model?: string;
  thinking?: string;
}) {
  try {
    const info = await api<ThreadInfo>("/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const existing = state.threads[info.id];
    state = {
      ...state,
      threads: {
        ...state.threads,
        [info.id]: existing ? { ...existing, info } : blankThread(info),
      },
      order: state.order.includes(info.id)
        ? state.order
        : [info.id, ...state.order],
      modal: null,
    };
    emit();
    selectThread(info.id);
  } catch (error) {
    toast("error", `Could not start session: ${errText(error)}`);
    throw error;
  }
}

export function resumeSession(session: RecentSession) {
  return createThread({ cwd: session.cwd, resume: session.path });
}

export async function closeThread(id: string) {
  const info = state.threads[id]?.info;
  try {
    await api(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (error) {
    toast("error", `Could not close session: ${errText(error)}`);
    return;
  }
  removeThreadLocal(id);
  if (info?.sessionFile) window.setTimeout(() => void refreshRecent(), 400);
}

export function resumeThread(id: string) {
  const thread = state.threads[id];
  if (!thread) return;
  void createThread({
    cwd: thread.info.cwd,
    resume: thread.info.sessionFile ?? thread.info.resume ?? undefined,
  });
}

export function sendPrompt(
  threadId: string,
  text: string,
  images: { mimeType: string; data: string }[] = [],
): boolean {
  const thread = state.threads[threadId];
  if (!thread) return false;
  const message = text.trim();
  if (!message && !images.length) return false;
  const streaming = thread.activity.running || thread.session?.isStreaming === true;
  const frame: Record<string, unknown> = { type: "prompt", message };
  if (images.length) {
    frame.images = images.map((image) => ({
      type: "image",
      mimeType: image.mimeType,
      data: image.data,
    }));
  }
  if (streaming) frame.streamingBehavior = state.queueMode;
  // The RPC transport caps a command at 1 MiB; leave room for the envelope.
  if (new TextEncoder().encode(JSON.stringify(frame)).byteLength > 900 * 1024) {
    toast("warning", "Message is too large — remove an image or shorten it");
    return false;
  }
  if (send(threadId, frame) === null) return false;

  if (
    !thread.info.sessionName &&
    !message.startsWith("/") &&
    !thread.messages.some((m) => m.role === "user")
  ) {
    send(threadId, {
      type: "set_session_name",
      name: makeTitle(message),
    });
  }
  return true;
}

function makeTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").replace(/[*`#_>]/g, "").trim();
  return clean.length > 72 ? `${clean.slice(0, 71)}…` : clean;
}

export function stopThread(threadId: string) {
  send(threadId, { type: "abort_and_restore_queue" });
}

export function abortThread(threadId: string) {
  send(threadId, { type: "abort" });
}

export function setModel(threadId: string, provider: string, modelId: string) {
  send(threadId, { type: "set_model", provider, modelId });
}

export function setThinking(threadId: string, level: string) {
  send(threadId, { type: "set_thinking_level", level });
}

export function compactThread(threadId: string) {
  send(threadId, { type: "compact" });
}

export function toggleAutoCompaction(threadId: string) {
  const enabled = state.threads[threadId]?.session?.autoCompactionEnabled ?? false;
  send(threadId, { type: "set_auto_compaction", enabled: !enabled });
}

export function renameThread(threadId: string, name: string) {
  const title = name.trim();
  if (!title) return;
  patch(threadId, (t) => ({
    ...t,
    info: { ...t.info, title, sessionName: title },
  }));
  send(threadId, { type: "set_session_name", name: title });
  window.setTimeout(() => void refreshRecent(), 600);
}

export function newSessionInThread(threadId: string) {
  send(threadId, { type: "new_session" });
}

export function forkThread(threadId: string) {
  send(threadId, { type: "fork" });
}

export function exportThread(threadId: string) {
  send(threadId, { type: "export_html" });
}

export function removeQueued(
  threadId: string,
  message: string,
  queue: "steering" | "followUp",
) {
  send(threadId, { type: "remove_queued_message", message, queue });
}

export function promoteQueued(threadId: string, message: string) {
  send(threadId, { type: "promote_queued_message", message });
}

export function answerDialog(
  threadId: string,
  dialogId: string,
  response: Record<string, unknown>,
) {
  const sent = send(threadId, {
    type: "extension_ui_response",
    id: dialogId,
    ...response,
  });
  if (sent !== null) {
    patch(threadId, (t) => ({
      ...t,
      dialogs: t.dialogs.filter((d) => d.id !== dialogId),
    }));
  }
}

export function cancelDialog(threadId: string, dialogId: string) {
  answerDialog(threadId, dialogId, { cancelled: true });
}

export function pollRunningThread() {
  const id = state.view;
  if (!id) return;
  const thread = state.threads[id];
  if (!thread) return;
  if (!thread.activity.running && !thread.session?.isStreaming) return;
  send(id, { type: "get_state" }, true);
  send(id, { type: "get_session_stats" }, true);
}

// ---------------------------------------------------------------------------
// UI state actions
// ---------------------------------------------------------------------------

export function setQueueMode(mode: QueueMode) {
  try {
    localStorage.setItem("omp.queueMode", mode);
  } catch {
    // Storage may be unavailable in private contexts.
  }
  state = { ...state, queueMode: mode };
  emit();
}

export function openNewSession() {
  state = { ...state, modal: { kind: "new" } };
  emit();
  void refreshRecent();
}

export function closeModal() {
  state = { ...state, modal: null };
  emit();
}

export function confirmAction(action: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  state = {
    ...state,
    confirmState: {
      title: action.title,
      message: action.message,
      confirmLabel: action.confirmLabel,
      danger: action.danger,
      action: action.onConfirm,
    },
  };
  emit();
}

export function cancelConfirm() {
  state = { ...state, confirmState: null };
  emit();
}

export function runConfirm() {
  const pending = state.confirmState;
  state = { ...state, confirmState: null };
  emit();
  pending?.action();
}

export function toggleSidebar() {
  state = { ...state, sidebarOpen: !state.sidebarOpen };
  emit();
}

export function toggleTodos() {
  state = { ...state, showTodos: !state.showTodos };
  emit();
}

export function toggleTheme() {
  const theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("omp.theme", theme);
  } catch {
    // Ignore storage failures.
  }
  state = { ...state, theme };
  emit();
}

export async function browse(path?: string): Promise<FsListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return api<FsListing>(`/api/fs${query}`);
}

export function contextPercent(thread: ThreadState): number {
  const usage = thread.session?.contextUsage ?? thread.stats?.contextUsage;
  if (!usage) return 0;
  return Math.max(0, Math.min(100, usage.percent));
}

