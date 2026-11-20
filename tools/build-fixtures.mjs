#!/usr/bin/env node
/**
 * Builds the committed golden protocol fixtures from the shapes observed in a
 * real omp 18.18.8 `--mode rpc-ui` session (2026-11-21).
 *
 * Sanitization is explicit and structural: every fixture is constructed here,
 * not copied. User prompts, tool arguments that came from the model, session
 * paths, session ids, credential ids, response ids and account metadata never
 * leave this builder. Model/provider names, token counts, durations and costs
 * are kept because the UI formats them and they are not identifying.
 *
 * Run: node tools/build-fixtures.mjs
 * Output: docs/fixtures/*.jsonl (one JSON object per line, exactly as omp writes)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandsOut, dialogs, failuresAndUnknowns } from "./fixtures/extra.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "fixtures");
const T0 = 1767225600000; // 2026-01-01T00:00:00Z
const SESSION_FILE = "/sessions/session-fixture.jsonl";
const SESSION_ID = "ses_fixture_0001";
const CWD = "/work/project";
const MODEL = {
  id: "deepseek-v4.1-flash",
  provider: "opencode-go",
  name: "DeepSeek V4.1 Flash",
  reasoning: true,
  contextWindow: 1000000,
  cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
  input: ["text", "image"],
};
const OTHER_MODEL = {
  id: "claude-sonnet-5",
  provider: "anthropic",
  name: "Claude Sonnet 5",
  reasoning: true,
  contextWindow: 200000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  input: ["text", "image"],
};
const USAGE = {
  input: 9154,
  output: 181,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 9335,
  cost: { input: 0.0013731, output: 0.0001086, cacheRead: 0, cacheWrite: 0, total: 0.0014817 },
};
const TOOL_RESULT_CONTENT = [{ type: "text", text: "omp-console-fixture\n" }];
const ASK_HTML =
  '<form><fieldset><legend>Pick</legend><p>Which color?</p>' +
  '<label><input type="radio" name="color" value="Red" checked> Red</label>' +
  '<label><input type="radio" name="color" value="Blue"> Blue</label></fieldset></form>';

const lines = (items) => `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;

function ready() {
  return {
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1048576,
    maxReassembledFrameBytes: 67108864,
    supportsBashExcludeFromContext: true,
  };
}

function state() {
  return {
    model: MODEL,
    thinkingLevel: "off",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    interruptMode: "immediate",
    sessionFile: SESSION_FILE,
    sessionId: SESSION_ID,
    sessionName: "Fixture session",
    autoCompactionEnabled: true,
    fastModeEnabled: false,
    fastModeActive: false,
    slowModeSupported: false,
    slowModeEnabled: false,
    tokensPerSecond: null,
    messageCount: 5,
    queuedMessageCount: 0,
    hasPendingAsyncWork: false,
    isSettled: true,
    queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
    todoPhases: [
      {
        name: "Fixture plan",
        tasks: [
          { content: "Run the fixture command", status: "completed" },
          { content: "Ask one question", status: "in_progress" },
          { content: "Report done", status: "pending" },
        ],
      },
    ],
    contextUsage: { tokens: 8020, contextWindow: 1000000, percent: 0.802 },
    goal: null,
  };
}

function stats() {
  return {
    sessionFile: SESSION_FILE,
    sessionId: SESSION_ID,
    userMessages: 1,
    assistantMessages: 2,
    toolCalls: 2,
    toolResults: 2,
    totalMessages: 5,
    tokens: {
      input: 9437,
      output: 185,
      reasoning: 0,
      cacheRead: 9088,
      cacheWrite: 0,
      total: 18710,
    },
    cost: 0.001553814,
    premiumRequests: 0,
    contextUsage: { tokens: 9371, contextWindow: 1000000, percent: 0.9371 },
  };
}

const commands = {
  commands: [
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
    {
      name: "skill:commit",
      description: "Write a conventional commit",
      input: { hint: "[scope]" },
      source: "skill",
    },
  ],
};

function handshake() {
  return [
    ready(),
    { type: "extension_ui_request", id: "ui-widget-1", method: "setWidget", widgetKey: "autoresearch" },
    { type: "advisor_cost_changed" },
    {
      type: "available_commands_update",
      commands: commands.commands,
    },
    { id: "cmd-neg", type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } },
    {
      id: "cmd-filter",
      type: "response",
      command: "set_event_filter",
      success: true,
      data: { events: null, messageUpdates: "delta" },
    },
    { id: "cmd-ask", type: "response", command: "set_ask_dialog", success: true, data: { enabled: true } },
    { id: "cmd-state", type: "response", command: "get_state", success: true, data: state() },
    { id: "cmd-stats", type: "response", command: "get_session_stats", success: true, data: stats() },
    {
      id: "cmd-levels",
      type: "response",
      command: "get_available_thinking_levels",
      success: true,
      data: { levels: ["off", "low", "high", "max"] },
    },
    {
      id: "cmd-models",
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models: [MODEL, OTHER_MODEL] },
    },
    { id: "cmd-commands", type: "response", command: "get_available_commands", success: true, data: commands },
  ];
}

function userMessage() {
  return {
    role: "user",
    content: [{ type: "text", text: "Run the fixture command and ask one question." }],
    timestamp: T0,
  };
}

function emptyAssistant() {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: "openai-completions",
    provider: MODEL.provider,
    model: MODEL.id,
    usage: { ...USAGE, input: 0, output: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: T0 + 40,
  };
}

function finalAssistant() {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "I'll run the command and ask the question." },
      {
        type: "toolCall",
        id: "call_fixture_1",
        name: "bash",
        arguments: { command: "echo omp-console-fixture", i: "Running fixture command" },
        partialArgs: '{"command":"echo omp-console-fixture"}',
        streamIndex: 0,
      },
      {
        type: "toolCall",
        id: "call_fixture_2",
        name: "ask",
        arguments: { html: ASK_HTML, i: "Asking color preference" },
        partialArgs: JSON.stringify({ html: ASK_HTML }),
        streamIndex: 1,
      },
    ],
    api: "openai-completions",
    provider: MODEL.provider,
    model: MODEL.id,
    usage: USAGE,
    stopReason: "toolUse",
    timestamp: T0 + 40,
    duration: 4199.98,
    ttft: 2831.5,
    completedAt: T0 + 4245,
  };
}

function doneAssistant() {
  return {
    role: "assistant",
    content: [{ type: "text", text: "DONE" }],
    api: "openai-completions",
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 283,
      output: 4,
      cacheRead: 9088,
      cacheWrite: 0,
      totalTokens: 9375,
      cost: { input: 0.0000424, output: 0.0000024, cacheRead: 0.0000273, cacheWrite: 0, total: 0.0000721 },
    },
    stopReason: "stop",
    timestamp: T0 + 4300,
    duration: 1132.53,
    ttft: 700.2,
    completedAt: T0 + 5440,
  };
}

function toolResult(toolCallId, toolName, text, details) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details: details ?? {},
    isError: false,
    timestamp: T0 + (toolName === "bash" ? 2200 : 2600),
  };
}

function stream() {
  const frames = [
    { id: "cmd-prompt", type: "response", command: "prompt", success: true },
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", messageId: "msg-1", message: userMessage() },
    { type: "message_end", messageId: "msg-1", message: userMessage() },
    { type: "message_start", messageId: "msg-2", message: emptyAssistant() },
    {
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
    },
  ];
  for (const delta of ["I'll run the ", "command and ask ", "the question."]) {
    frames.push({
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    });
  }
  frames.push(
    {
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "I'll run the command and ask the question.",
        block: { type: "text" },
      },
    },
    {
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        block: {
          type: "toolCall",
          id: "call_fixture_1",
          name: "bash",
          arguments: {},
          partialArgs: "",
          streamIndex: 0,
        },
      },
    },
    {
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"command":' },
    },
    {
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: '"echo omp-console-fixture"}',
      },
    },
    {
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: {
          type: "toolCall",
          id: "call_fixture_1",
          name: "bash",
          arguments: { command: "echo omp-console-fixture", i: "Running fixture command" },
          partialArgs: '{"command":"echo omp-console-fixture"}',
          streamIndex: 0,
        },
      },
    },
    {
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 2,
        block: {
          type: "toolCall",
          id: "call_fixture_2",
          name: "ask",
          arguments: {},
          partialArgs: "",
          streamIndex: 1,
        },
      },
    },
    {
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"html":"<form>…' },
    },
    {
      type: "message_update",
      messageId: "msg-2",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: {
          type: "toolCall",
          id: "call_fixture_2",
          name: "ask",
          arguments: { html: ASK_HTML, i: "Asking color preference" },
          partialArgs: JSON.stringify({ html: ASK_HTML }),
          streamIndex: 1,
        },
      },
    },
    { type: "message_end", messageId: "msg-2", message: finalAssistant() },
    {
      type: "tool_execution_start",
      toolCallId: "call_fixture_1",
      toolName: "bash",
      args: { command: "echo omp-console-fixture" },
      intent: "Running fixture command",
    },
    {
      type: "extension_ui_request",
      id: "ui-approval-1",
      method: "select",
      title: "Allow tool: bash\nCommand: echo omp-console-fixture",
      options: ["Approve", "Approve bash for this session", "Deny"],
    },
    {
      type: "tool_execution_update",
      toolCallId: "call_fixture_1",
      toolName: "bash",
      args: { command: "echo omp-console-fixture" },
      partialResult: { content: [{ type: "text", text: "" }], details: {} },
    },
    {
      type: "tool_execution_update",
      toolCallId: "call_fixture_1",
      toolName: "bash",
      args: { command: "echo omp-console-fixture" },
      partialResult: { content: TOOL_RESULT_CONTENT, details: { wallTimeMs: 277.8 } },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call_fixture_1",
      toolName: "bash",
      result: { content: TOOL_RESULT_CONTENT, details: { wallTimeMs: 277.8, timeoutSeconds: 300 } },
      isError: false,
    },
    {
      type: "message_start",
      messageId: "msg-3",
      message: toolResult("call_fixture_1", "bash", "omp-console-fixture\n"),
    },
    { type: "message_end", messageId: "msg-3", message: toolResult("call_fixture_1", "bash", "omp-console-fixture\n") },
    {
      type: "extension_ui_request",
      id: "ui-field-1",
      method: "select",
      title: "Which color?",
      options: ["Red", "Blue", "Other (type your own)"],
    },
    {
      type: "tool_execution_start",
      toolCallId: "call_fixture_2",
      toolName: "ask",
      args: { html: ASK_HTML },
      intent: "Asking color preference",
    },
    {
      type: "tool_execution_end",
      toolCallId: "call_fixture_2",
      toolName: "ask",
      result: {
        content: [{ type: "text", text: 'User answers:\n{\n  "color": "Red"\n}' }],
        details: { answers: [{ name: "color", question: "Which color?", answer: "Red" }] },
      },
      isError: false,
    },
    {
      type: "message_start",
      messageId: "msg-4",
      message: toolResult("call_fixture_2", "ask", 'User answers:\n{\n  "color": "Red"\n}', {
        answers: [{ name: "color", question: "Which color?", answer: "Red" }],
      }),
    },
    {
      type: "message_end",
      messageId: "msg-4",
      message: toolResult("call_fixture_2", "ask", 'User answers:\n{\n  "color": "Red"\n}', {
        answers: [{ name: "color", question: "Which color?", answer: "Red" }],
      }),
    },
    {
      type: "turn_end",
      message: finalAssistant(),
      toolResults: [
        toolResult("call_fixture_1", "bash", "omp-console-fixture\n"),
        toolResult("call_fixture_2", "ask", 'User answers:\n{\n  "color": "Red"\n}'),
      ],
    },
    { type: "turn_start" },
    { type: "message_start", messageId: "msg-5", message: emptyAssistant() },
    {
      type: "message_update",
      messageId: "msg-5",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
    },
    {
      type: "message_update",
      messageId: "msg-5",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "DONE" },
    },
    {
      type: "message_update",
      messageId: "msg-5",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "DONE",
        block: { type: "text" },
      },
    },
    { type: "message_end", messageId: "msg-5", message: doneAssistant() },
    { type: "turn_end", message: doneAssistant(), toolResults: [] },
    {
      type: "agent_end",
      messages: [userMessage(), finalAssistant(), toolResult("call_fixture_1", "bash", "omp-console-fixture\n"), toolResult("call_fixture_2", "ask", "Red"), doneAssistant()],
      isTerminal: true,
      yielded: true,
    },
    {
      type: "prompt_result",
      id: "cmd-prompt",
      agentInvoked: true,
      status: "completed",
      sessionSettled: true,
    },
    { type: "session_settled" },
  );
  return frames;
}

function resume() {
  const hydrated = [
    userMessage(),
    finalAssistant(),
    toolResult("call_fixture_1", "bash", "omp-console-fixture\n", { wallTimeMs: 277.8 }),
    toolResult("call_fixture_2", "ask", 'User answers:\n{\n  "color": "Red"\n}', {
      answers: [{ name: "color", question: "Which color?", answer: "Red" }],
    }),
    doneAssistant(),
  ];
  return [
    ready(),
    { type: "available_commands_update", commands: commands.commands },
    { id: "cmd-neg", type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } },
    { id: "cmd-filter", type: "response", command: "set_event_filter", success: true, data: { events: null, messageUpdates: "delta" } },
    { id: "cmd-state", type: "response", command: "get_state", success: true, data: state() },
    { id: "cmd-messages", type: "response", command: "get_messages", success: true, data: { messages: hydrated } },
    { id: "cmd-stats", type: "response", command: "get_session_stats", success: true, data: stats() },
  ];
}

/*
 * Protocol-v2 chunking is not a committed fixture: a real chunk sequence only
 * exists for logical frames over 1 MiB, which would add a 1.4 MiB base64 file
 * to the repo. Both test suites build a 1.05 MiB logical frame deterministically
 * (see docs/fixtures/README.md) and feed it through the same rules.
 */

fs.mkdirSync(OUT, { recursive: true });
const files = {
  "handshake.jsonl": handshake(),
  "stream.jsonl": stream(),
  "dialogs.jsonl": dialogs(SESSION_ID),
  "resume.jsonl": resume(),
  "unknown.jsonl": failuresAndUnknowns(),
  "commands.jsonl": commandsOut(MODEL),
};
for (const [name, items] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), lines(items));
  console.log(`${name}: ${items.length} frames, ${fs.statSync(path.join(OUT, name)).size} bytes`);
}
