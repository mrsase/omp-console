/**
 * Hand-written mirror of the wire types in `crates/omp-protocol` plus the
 * normalized client state. Contract-tested by replaying `docs/fixtures/*.jsonl`.
 * No DOM, no I/O: everything here is data.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One raw child frame, exactly as the server forwarded it. */
export interface RawFrame {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export type ThreadStatus = "starting" | "ready" | "exited";

export interface ReadyInfo {
  protocolVersion?: number;
  supportedProtocolVersions?: number[];
  maxFrameBytes?: number;
  maxReassembledFrameBytes?: number;
  supportsBashExcludeFromContext?: boolean;
  [key: string]: unknown;
}

export interface ProtocolInfo {
  version: 1 | 2;
  delta: boolean;
  eventFilter: boolean;
  degraded: string | null;
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
  protocol: ProtocolInfo;
  unknownFrames: number;
  unknownKinds: string[];
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
  symlink: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface OmpInfo {
  bin: string;
  found: boolean;
  version: string | null;
  supported: boolean;
  tested: boolean;
  message: string;
  checkedAt: number | null;
}

export interface InfoResponse {
  version: string;
  omp: OmpInfo;
  sessionRoot: string;
  maxThreads: number;
  wsSlots: number;
  dev: boolean;
  staticReady: boolean;
  addr: string;
  startedAt: number;
}

export type ConnectionState = "connecting" | "open" | "closed";

export interface AppNotice {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
}

/* ------------------------------ child frames ----------------------------- */

export interface AssistantEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  block?: unknown;
  toolCall?: unknown;
  message?: unknown;
  error?: string;
  [key: string]: unknown;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  partialArgs?: string;
  [key: string]: unknown;
}

export interface WireUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface WireUsage {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: WireUsageCost;
}

export interface WireMessage {
  role: string;
  content?: ContentBlock[] | string;
  timestamp?: number;
  api?: string;
  provider?: string;
  model?: string;
  usage?: WireUsage;
  stopReason?: string;
  duration?: number;
  ttft?: number;
  completedAt?: number;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  input?: string[];
}

export interface CommandInfo {
  name: string;
  description?: string;
  input?: { hint?: string };
  subcommands?: { name: string; description?: string }[];
  source?: string;
}

export interface QueuedWire {
  steering?: unknown[];
  followUp?: unknown[];
  liveSteered?: number;
}

export interface TodoTask {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  blocked?: string | null;
}

export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

/* ----------------------------- normalized state --------------------------- */

export type Lane = "you" | "assistant" | "thinking" | "tool" | "system";

export interface TextBlock {
  kind: "text";
  text: string;
  chunks: string[];
  streaming: boolean;
  started: boolean;
}

export interface ThinkingBlock {
  kind: "thinking";
  text: string;
  chunks: string[];
  streaming: boolean;
  started: boolean;
}

export type ToolState = "running" | "done" | "error";

export interface ToolBlock {
  kind: "tool";
  callId: string;
  name: string;
  args: Record<string, unknown>;
  partialArgs: string;
  argsText: string;
  state: ToolState;
  output: string;
  details: unknown;
  isError: boolean;
  images: { mimeType: string; data: string }[];
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  streaming: boolean;
}

export type Block = TextBlock | ThinkingBlock | ToolBlock;

export interface UsageSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface SystemRow {
  label: string;
  summary: string;
  body?: string;
  tone: "info" | "ok" | "warn" | "err";
  kind?: string;
  count?: number;
}

export type MessageRole = "user" | "assistant" | "toolResult" | "system";

export interface MessageRecord {
  key: string;
  id: string | null;
  role: MessageRole;
  lane: Lane;
  turn: number;
  seq: number;
  timestamp: number | null;
  version: number;
  streaming: boolean;
  blocks: Block[];
  images?: { mimeType: string; data: string; width?: number; height?: number }[];
  source: "live" | "hydrated" | "system";
  model?: string;
  modelName?: string;
  provider?: string;
  usage?: UsageSnapshot;
  stopReason?: string | null;
  durationMs?: number | null;
  ttftMs?: number | null;
  error?: string | null;
  retryable?: boolean;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  system?: SystemRow;
  requestId?: string;
  usageApplied?: boolean;
}

export type QueueKind = "steer" | "followUp" | "sent";

export interface QueueImage {
  mimeType: string;
  data: string;
}

export interface QueueItem {
  id: string;
  kind: QueueKind;
  text: string;
  images: QueueImage[];
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
  options?: AskOption[];
  multi?: boolean;
  recommended?: number;
}

export interface ApprovalInfo {
  tool: string;
  command: string | null;
  heading: string;
}

export interface DialogRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  optionDetails?: { description?: string; preview?: string }[];
  placeholder?: string;
  secret?: boolean;
  prefill?: string;
  promptStyle?: boolean;
  questions?: AskQuestion[];
  timeout: number | null;
  approval?: ApprovalInfo;
  multi?: boolean;
  field?: { index: number; total: number | null; previous: { question: string; answer: string }[] };
  url?: string;
  launchUrl?: string;
  instructions?: string;
  targetId?: string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: string;
  notifyType?: string;
}

export type DialogStatus = "open" | "answered" | "cancelled" | "expired" | "resolved";

export interface DialogRecord {
  request: DialogRequest;
  status: DialogStatus;
  answerLabel?: string;
}

export interface ExtensionStatus {
  key: string;
  text: string;
}

export interface WidgetState {
  key: string;
  lines: string[];
  placement: string;
}

export interface ProtocolLogEntry {
  id: string;
  level: "info" | "warn";
  message: string;
}

export interface UnknownFrame {
  type: string;
  raw: string;
}

export interface UnknownEvidence {
  total: number;
  counts: Record<string, number>;
  ring: UnknownFrame[];
  loggedTypes: string[];
}

export interface SparkPoint {
  at: number;
  tokens: number;
}

export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface SessionStats {
  sessionFile: string | null;
  sessionId: string | null;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  messageCount: number;
  tokens: UsageSnapshot;
  cost: number;
  premiumRequests: number;
  contextUsage: ContextUsage | null;
}

export interface HydrationState {
  state: boolean;
  messages: boolean;
  stats: boolean;
  levels: boolean;
  models: boolean;
  commands: boolean;
  busy: boolean;
  busyRetries: number;
  lastError: string | null;
}

export interface RetryState {
  attempt: number;
  maxAttempts: number;
  message: string;
  delayMs: number | null;
}

export interface ThreadRuntime {
  id: string;
  meta: ThreadInfo | null;
  rows: string[];
  messages: Record<string, MessageRecord>;
  /** callId -> {key, index} for the tool block that owns it */
  toolOwners: Record<string, { key: string; index: number }>;
  queue: { steering: QueueItem[]; followUp: QueueItem[]; liveSteered: number };
  dialogs: DialogRecord[];
  notifications: { id: string; message: string; level: string }[];
  statuses: ExtensionStatus[];
  widgets: WidgetState[];
  commands: CommandInfo[];
  models: ModelInfo[];
  levels: string[];
  model: ModelInfo | null;
  thinkingLevel: string | null;
  sessionName: string | null;
  sessionFile: string | null;
  sessionId: string | null;
  title: string | null;
  autoCompaction: boolean | null;
  todoPhases: TodoPhase[];
  stats: SessionStats;
  tokens: UsageSnapshot;
  cost: number;
  tokensPerSecond: number | null;
  messageCount: number;
  contextUsage: ContextUsage | null;
  spark: SparkPoint[];
  streaming: boolean;
  compacting: boolean;
  agentActive: boolean;
  settled: boolean;
  turn: number;
  retry: RetryState | null;
  unknown: UnknownEvidence;
  protocolLog: ProtocolLogEntry[];
  simulator: string[];
  hydration: HydrationState;
  seq: number;
  lastError: string | null;
  lastPrompt: { status: string; agentInvoked: boolean } | null;
  editorText: string | null;
  activeCompaction: string | null;
  activeRetry: string | null;
  fieldAnswers: { question: string; answer: string }[];
  restoredInput: { id: number; text: string; images: { mimeType: string; data: string }[] } | null;
  turnStamps: number[];
}

export interface AppState {
  connection: ConnectionState;
  version: string | null;
  protocol: number | null;
  threads: Record<string, ThreadInfo>;
  threadOrder: string[];
  sessions: Record<string, ThreadRuntime>;
  selected: string | null;
  notices: AppNotice[];
  info: InfoResponse | null;
  recent: RecentSession[];
  helpRequested: boolean;
}

/* -------------------------------- envelopes ------------------------------- */

export type Envelope =
  | { op: "hello"; version: string; protocol: number; threads: ThreadInfo[] }
  | { op: "thread"; thread: ThreadInfo }
  | { op: "thread_removed"; id: string }
  | { op: "frame"; thread: string; frame: RawFrame }
  | { op: "lagged"; thread: string; skipped: number }
  | { op: "notice"; thread: string | null; level: "info" | "warn" | "error"; message: string }
  | { op: "pong" };

export type UiCommand =
  | { type: "prompt"; message: string; images?: QueueImage[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string; images?: QueueImage[] }
  | { type: "follow_up"; message: string; images?: QueueImage[] }
  | { type: "remove_queued_message"; message: string; queue?: "steering" | "followUp" }
  | { type: "promote_queued_message"; message: string }
  | { type: "abort" }
  | { type: "abort_and_restore_queue" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "set_session_name"; name: string }
  | { type: "new_session" }
  | { type: "fork" }
  | { type: "export_html" }
  | { type: "compact" }
  | { type: "set_auto_compaction"; enabled: boolean }
  | { type: "get_state" }
  | { type: "get_session_stats" }
  | { type: "get_messages" }
  | { type: "get_available_models" }
  | { type: "get_available_thinking_levels" }
  | { type: "get_available_commands" }
  | { type: "extension_ui_response"; id: string; value?: string; confirmed?: boolean; answers?: unknown[]; cancelled?: boolean };
