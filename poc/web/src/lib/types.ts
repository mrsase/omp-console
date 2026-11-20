export type ThreadStatus = "starting" | "ready" | "exited";

export interface ReadyInfo {
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
  supportsBashExcludeFromContext: boolean;
}

export interface ThreadInfo {
  id: string;
  cwd: string;
  status: ThreadStatus;
  pid: number;
  createdAt: number;
  lastActivity: number;
  exitCode: number | null;
  resume: string | null;
  title: string;
  model: string | null;
  modelName: string | null;
  sessionName: string | null;
  sessionFile: string | null;
  sessionId: string | null;
  thinking: string | null;
  ready: ReadyInfo | null;
}

export interface RecentSession {
  path: string;
  id: string | null;
  title: string;
  cwd: string;
  updatedAt: number;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface ServerInfo {
  version: string;
  ompBin: string;
  home: string;
  cwd: string;
  maxThreads: number;
  sessionRoot: string;
  staticReady: boolean;
  addr: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number | null;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CommandInfo {
  name: string;
  description?: string;
  input?: { hint?: string };
  subcommands?: { name: string; description?: string }[];
  source?: string;
}

export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}

export interface TodoTask {
  content: string;
  status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
  blocker?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
  /** Leading steering entries already delivered into the live response. */
  liveSteered?: number;
}

export interface SessionState {
  model?: { provider: string; id: string; name?: string };
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  queuedMessageCount?: number;
  hasPendingAsyncWork?: boolean;
  isSettled?: boolean;
  queuedMessages?: QueuedMessages;
  todoPhases?: TodoPhase[];
  contextUsage?: ContextUsage;
  tokensPerSecond?: number | null;
}

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; done: boolean }
  | { kind: "toolCall"; id: string; name: string; argsText: string; args?: unknown; done: boolean }
  | { kind: "image"; mimeType: string; data: string }
  | { kind: "other"; label: string };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { total: number };
}

export interface UIMessage {
  key: string;
  role: string;
  timestamp: number;
  blocks: Block[];
  streaming?: boolean;
  model?: string;
  provider?: string;
  usage?: Usage;
  duration?: number;
  stopReason?: string;
  error?: string;
  /** bashExecution / pythonExecution */
  command?: string;
  output?: string;
  exitCode?: number;
  isError?: boolean;
  customType?: string;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  text: string;
  images: { mimeType: string; data: string }[];
  isError: boolean;
  details?: unknown;
}

export interface ToolRun {
  id: string;
  name: string;
  args?: unknown;
  startedAt: number;
  endedAt?: number;
  partial?: string;
  text?: string;
  isError?: boolean;
}

export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  header?: string;
  options: AskOption[];
  multi?: boolean;
  recommended?: number;
}

export type UiDialog =
  | {
      kind: "select";
      id: string;
      title: string;
      options: { label: string; description?: string }[];
      timeout?: number;
    }
  | { kind: "confirm"; id: string; title: string; message: string; timeout?: number }
  | {
      kind: "input";
      id: string;
      title: string;
      placeholder?: string;
      secret?: boolean;
      timeout?: number;
      editor?: boolean;
      prefill?: string;
      promptStyle?: boolean;
    }
  | { kind: "ask"; id: string; questions: AskQuestion[]; timeout?: number };

export interface Activity {
  running: boolean;
  startedAt?: number;
  turn: number;
  settled: boolean;
  retry?: { attempt: number; maxAttempts: number; message: string; delayMs: number };
  compaction?: { kind: "auto" | "manual"; action?: string };
}

export interface LogEntry {
  id: number;
  ts: number;
  level: "info" | "warning" | "error";
  text: string;
}

export interface Toast {
  id: number;
  level: "info" | "success" | "warning" | "error";
  text: string;
}

export interface ThreadState {
  info: ThreadInfo;
  session?: SessionState;
  stats?: SessionStats;
  models: ModelInfo[];
  levels: string[];
  commands: CommandInfo[];
  messages: UIMessage[];
  toolResults: Record<string, ToolResult>;
  toolRuns: Record<string, ToolRun>;
  activity: Activity;
  queue: QueuedMessages;
  todos: TodoPhase[];
  dialogs: UiDialog[];
  statuses: Record<string, string>;
  widgets: Record<string, string[]>;
  log: LogEntry[];
  editor?: { text: string; nonce: number; images?: { mimeType: string; data: string }[] };
  lastFrameAt: number;
  lastError?: string;
}

export type Modal = { kind: "new" } | null;

export interface ConfirmState {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  action: () => void;
}

export type QueueMode = "steer" | "followUp";

export interface AppState {
  connected: boolean;
  threads: Record<string, ThreadState>;
  order: string[];
  view: string | null;
  recent: RecentSession[];
  recentLoaded: boolean;
  models: ModelInfo[];
  info?: ServerInfo;
  toasts: Toast[];
  theme: "dark" | "light";
  modal: Modal;
  confirmState: ConfirmState | null;
  sidebarOpen: boolean;
  showTodos: boolean;
  queueMode: QueueMode;
}

export type Envelope =
  | { op: "hello"; version: string; threads: ThreadInfo[] }
  | { op: "thread"; thread: ThreadInfo }
  | { op: "thread_removed"; id: string }
  | { op: "frame"; thread: string; frame: RpcFrame }
  | { op: "lagged"; thread: string; skipped: number }
  | { op: "notice"; thread: string; level: "info" | "warning" | "error"; message: string }
  | { op: "pong" };

/**
 * Wire frames are untrusted JSON from the omp child. Only `type` is assumed;
 * every other field is narrowed with runtime helpers before use.
 */
export interface RpcFrame {
  type: string;
  [key: string]: unknown;
}

export const THINKING_FALLBACK = ["off", "low", "medium", "high", "xhigh", "max"];
