#!/usr/bin/env node
/**
 * Minimal child fixture for the server's lifecycle tests. Not the full e2e
 * stub: it speaks just enough rpc-ui to become ready, answer get_state, and
 * expose a grandchild that must not survive teardown.
 *
 * Invoked through a generated shell wrapper so the server can use it as OMP_BIN
 * with its normal argv. `--pid-file` is the only argument it reads.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const pidIndex = args.indexOf("--pid-file");
const pidFile = pidIndex >= 0 ? args[pidIndex + 1] : null;
const ignoreTerm = args.includes("--ignore-term");
if (pidFile) fs.writeFileSync(pidFile, `${process.pid}\n`);

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
if (pidFile && grandchild.pid) fs.appendFileSync(pidFile, `grandchild=${grandchild.pid}\n`);

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
  supportsBashExcludeFromContext: true,
});

const state = {
  model: { provider: "stub", id: "stub-model", name: "Stub" },
  thinkingLevel: "off",
  isStreaming: false,
  isCompacting: false,
  sessionFile: pidFile ? `${pidFile}.jsonl` : "/tmp/stub.jsonl",
  sessionId: "stub-session",
  autoCompactionEnabled: false,
  tokensPerSecond: null,
  messageCount: 0,
  queuedMessageCount: 0,
  hasPendingAsyncWork: false,
  isSettled: true,
  queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
  todoPhases: [],
  contextUsage: { tokens: 10, contextWindow: 1000, percent: 1 },
  goal: null,
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.type === "abort") {
      setTimeout(() => process.exit(0), 10);
      continue;
    }
    const id = frame.id;
    const reply = (command, data, success = true) => {
      const body = { id, type: "response", command, success };
      if (data !== undefined) body.data = data;
      if (!success) body.error = "stub failure";
      send(body);
    };
    switch (frame.type) {
      case "negotiate_protocol":
        reply("negotiate_protocol", { protocolVersion: 2 });
        break;
      case "set_event_filter":
        reply("set_event_filter", { events: null, messageUpdates: "delta" });
        break;
      case "set_ask_dialog":
        reply("set_ask_dialog", { enabled: true });
        break;
      case "get_state":
        reply("get_state", state);
        break;
      case "get_session_stats":
        reply("get_session_stats", {
          sessionFile: state.sessionFile,
          sessionId: state.sessionId,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
          contextUsage: state.contextUsage,
        });
        break;
      case "get_messages":
        reply("get_messages", { messages: [] });
        break;
      case "get_available_models":
        reply("get_available_models", { models: [state.model] });
        break;
      case "get_available_thinking_levels":
        reply("get_available_thinking_levels", { levels: ["off", "high"] });
        break;
      case "get_available_commands":
        reply("get_available_commands", { commands: [] });
        break;
      default:
        reply(frame.type, undefined, true);
    }
  }
});
process.stdin.on("end", () => process.exit(0));

process.on("SIGTERM", () => {
  if (!ignoreTerm) process.exit(0);
});
setInterval(() => {}, 1000);
