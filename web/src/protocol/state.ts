import type {
  AppState,
  HydrationState,
  MessageRecord,
  SessionStats,
  ThreadRuntime,
  UnknownEvidence,
  UsageSnapshot,
} from "./types";

export function zeroUsage(): UsageSnapshot {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

export function emptyStats(): SessionStats {
  return {
    sessionFile: null,
    sessionId: null,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    messageCount: 0,
    tokens: zeroUsage(),
    cost: 0,
    premiumRequests: 0,
    contextUsage: null,
  };
}

export function emptyHydration(): HydrationState {
  return {
    state: false,
    messages: false,
    stats: false,
    levels: false,
    models: false,
    commands: false,
    busy: false,
    busyRetries: 0,
    lastError: null,
  };
}

export function emptyUnknown(): UnknownEvidence {
  return { total: 0, counts: {}, ring: [], loggedTypes: [] };
}

export function emptyThread(id: string): ThreadRuntime {
  return {
    id,
    meta: null,
    rows: [],
    messages: {},
    toolOwners: {},
    queue: { steering: [], followUp: [], liveSteered: 0 },
    dialogs: [],
    notifications: [],
    statuses: [],
    widgets: [],
    commands: [],
    models: [],
    levels: [],
    model: null,
    thinkingLevel: null,
    sessionName: null,
    sessionFile: null,
    sessionId: null,
    title: null,
    autoCompaction: null,
    todoPhases: [],
    stats: emptyStats(),
    tokens: zeroUsage(),
    cost: 0,
    tokensPerSecond: null,
    messageCount: 0,
    contextUsage: null,
    spark: [],
    streaming: false,
    compacting: false,
    agentActive: false,
    settled: false,
    turn: 0,
    retry: null,
    unknown: emptyUnknown(),
    protocolLog: [],
    simulator: [],
    hydration: emptyHydration(),
    seq: 0,
    lastError: null,
    lastPrompt: null,
    editorText: null,
    fieldAnswers: [],
    restoredInput: null,
    turnStamps: [],
    activeCompaction: null,
    activeRetry: null,
  };
}

export function emptyState(): AppState {
  return {
    connection: "connecting",
    version: null,
    protocol: null,
    threads: {},
    threadOrder: [],
    sessions: {},
    selected: null,
    notices: [],
    info: null,
    recent: [],
    helpRequested: false,
  };
}

export function emptyMessage(key: string, role: MessageRecord["role"], lane: MessageRecord["lane"]): MessageRecord {
  return {
    key,
    id: null,
    role,
    lane,
    turn: 0,
    seq: 0,
    timestamp: null,
    version: 0,
    streaming: false,
    blocks: [],
    source: "live",
  };
}
