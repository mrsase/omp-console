/**
 * Shared state and fixture data for the scriptable omp stub.
 * No I/O beyond the session file the stub itself owns.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const MODELS = [
  {
    id: "deepseek-v4.1-flash",
    provider: "opencode-go",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    contextWindow: 1000000,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    input: ["text", "image"],
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    name: "Claude Sonnet 5",
    reasoning: true,
    contextWindow: 200000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    input: ["text", "image"],
  },
];
export const LEVELS = ["off", "low", "high", "max"];
export const COMMANDS = [
  {
    name: "model",
    description: "Choose the active model",
    input: { hint: "<provider/model>" },
    source: "builtin",
  },
  {
    name: "compact",
    description: "Compact the conversation context",
    subcommands: [{ name: "auto", description: "Toggle automatic compaction" }],
    source: "builtin",
  },
  { name: "skill:commit", description: "Write a conventional commit", input: { hint: "[scope]" }, source: "skill" },
];

export const state = {
  scenario: "journey",
  stepDelay: 12,
  cwd: process.cwd(),
  resumePath: null,
  model: MODELS[0],
  thinkingLevel: "off",
  sessionId: `ses_stub_${process.pid}`,
  sessionName: process.env.STUB_OMP_TITLE || "Stub session",
  history: [],
  seq: 0,
  queue: { steering: [], followUp: [] },
  streaming: false,
  aborted: false,
  generation: 0,
  currentPromptId: null,
  autoCompaction: true,
  compacting: false,
  sessionFile: null,
};

export const nextSeq = () => ++state.seq;

export const usage = () => ({
  input: 1200,
  output: 24,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1224,
  cost: { input: 0.0001, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00012 },
});
export const userMessage = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});
export const assistantMessage = (content, extra = {}) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: state.model.provider,
  model: state.model.id,
  usage: usage(),
  stopReason: "stop",
  timestamp: Date.now(),
  ...extra,
});
export const queued = () => ({
  steering: state.queue.steering.map((message) => ({ message })),
  followUp: state.queue.followUp.map((message) => ({ message })),
  liveSteered: 0,
});

/* ------------------------------ session file ------------------------------ */

export function initSession({ cwd, resumePath, scenario, stepDelay, requestedModel, requestedThinking }) {
  state.cwd = cwd;
  state.resumePath = resumePath;
  state.scenario = scenario;
  state.stepDelay = stepDelay;
  state.thinkingLevel = requestedThinking || "off";
  if (requestedModel) {
    const [provider, id] = requestedModel.split("/");
    state.model = MODELS.find((item) => item.provider === provider && item.id === id) ?? state.model;
  }
  state.sessionFile = process.env.STUB_OMP_SESSION_FILE || resumePath || null;
  if (resumePath && existsSync(resumePath)) {
    loadSession(resumePath);
    return;
  }
  const root = process.env.OMP_CONSOLE_SESSIONS;
  if (!state.sessionFile && root) {
    state.sessionFile = join(root, basename(cwd) || "project", `${state.sessionId}.jsonl`);
  }
  if (!state.sessionFile) return;
  try {
    mkdirSync(dirname(state.sessionFile), { recursive: true });
    if (!existsSync(state.sessionFile)) writeHeader();
  } catch {
    state.sessionFile = null;
  }
}

export function writeHeader() {
  try {
    writeFileSync(
      state.sessionFile,
      `${JSON.stringify({ type: "session", id: state.sessionId, cwd: state.cwd, timestamp: Date.now() })}\n` +
        `${JSON.stringify({ type: "title", title: state.sessionName })}\n`,
    );
  } catch {
    /* a read-only root is not fatal */
  }
}

function loadSession(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value.type === "session") {
        if (typeof value.id === "string") state.sessionId = value.id;
        if (typeof value.title === "string") state.sessionName = value.title;
      } else if (value.type === "title" && typeof value.title === "string") {
        state.sessionName = value.title;
      } else if (value.type === "stub_message" && value.message) {
        state.history.push(value.message);
      }
    }
  } catch {
    /* fall through to the fixture transcript */
  }
  if (!state.history.length) state.history = fixtureHistory();
}

export function persist(message) {
  if (!state.sessionFile || state.scenario === "events") return;
  try {
    appendFileSync(state.sessionFile, `${JSON.stringify({ type: "stub_message", message })}\n`);
  } catch {
    /* a read-only session root must not break the stream */
  }
}

export function record(message) {
  state.history.push(message);
  if (state.history.length > 200 && state.scenario === "events") {
    state.history.splice(0, state.history.length - 200);
  }
  persist(message);
}

export function fixtureHistory() {
  const bash = {
    type: "toolCall",
    id: "call_fixture_1",
    name: "bash",
    arguments: { command: "echo omp-console-fixture", i: "Running fixture command" },
    partialArgs: '{"command":"echo omp-console-fixture"}',
    streamIndex: 0,
  };
  return [
    {
      role: "user",
      content: [{ type: "text", text: "Run the fixture command and ask one question." }],
      timestamp: 1767225600000,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "I'll run the command and ask the question." }, bash],
      api: "openai-completions",
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      stopReason: "toolUse",
      timestamp: 1767225600040,
    },
    {
      role: "toolResult",
      toolCallId: "call_fixture_1",
      toolName: "bash",
      content: [{ type: "text", text: "omp-console-fixture\n" }],
      details: { wallTimeMs: 277.8 },
      isError: false,
      timestamp: 1767225602200,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "DONE" }],
      api: "openai-completions",
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      stopReason: "stop",
      timestamp: 1767225604300,
    },
  ];
}

/* --------------------------------- reports -------------------------------- */

export function getState() {
  const tokens = 8020 + state.history.length * 7;
  return {
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    isStreaming: state.streaming,
    isCompacting: state.compacting,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    interruptMode: "immediate",
    sessionFile: state.sessionFile,
    sessionId: state.sessionId,
    sessionName: state.sessionName,
    autoCompactionEnabled: state.autoCompaction,
    fastModeEnabled: false,
    fastModeActive: false,
    slowModeSupported: false,
    slowModeEnabled: false,
    tokensPerSecond: null,
    messageCount: state.history.length,
    queuedMessageCount: state.queue.steering.length + state.queue.followUp.length,
    hasPendingAsyncWork: state.streaming,
    isSettled: !state.streaming,
    queuedMessages: queued(),
    todoPhases: [
      {
        name: "Stub plan",
        tasks: [
          { content: "Stream a response", status: "completed" },
          { content: "Ask the console a question", status: "in_progress" },
          { content: "Report done", status: "pending" },
        ],
      },
    ],
    contextUsage: {
      tokens,
      contextWindow: state.model.contextWindow,
      percent: Number(((tokens / state.model.contextWindow) * 100).toFixed(3)),
    },
    goal: null,
  };
}

export function getStats() {
  const roles = state.history.map((message) => message.role);
  const toolCalls = state.history.reduce(
    (count, message) =>
      count +
      (Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "toolCall").length
        : 0),
    0,
  );
  return {
    sessionFile: state.sessionFile,
    sessionId: state.sessionId,
    userMessages: roles.filter((role) => role === "user").length,
    assistantMessages: roles.filter((role) => role === "assistant").length,
    toolCalls,
    toolResults: roles.filter((role) => role === "toolResult").length,
    totalMessages: state.history.length,
    tokens: { input: 9437, output: 185, reasoning: 0, cacheRead: 9088, cacheWrite: 0, total: 18710 },
    cost: 0.001553814,
    premiumRequests: 0,
    contextUsage: getState().contextUsage,
  };
}
