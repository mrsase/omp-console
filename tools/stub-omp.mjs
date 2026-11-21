#!/usr/bin/env node
/**
 * Scriptable `omp` stub for omp-console tests. One JSON object per stdout line,
 * no model, no network. Behaviour is selected by environment variables:
 *
 *   --version                  print `omp/18.18.8` and exit (server probe)
 *   --mode rpc-ui --cwd ...    accepted and ignored
 *   STUB_OMP_SCENARIO          journey | ask | error | chunk | events
 *   STUB_OMP_PID_FILE          pid file, with `grandchild=<pid>` when spawned
 *   STUB_OMP_GRANDCHILD=1      child that only leaves via process-group teardown
 *   STUB_OMP_IGNORE_SIGTERM=1  ignore SIGTERM (SIGKILL still works)
 *   STUB_OMP_EVENTS            event count for `events` (default 10000)
 *   STUB_OMP_STEP_DELAY_MS     delay between streamed steps (default 12)
 *   STUB_OMP_SESSION_FILE      explicit session file
 *   STUB_OMP_TITLE             session title
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { COMMANDS, state, initSession } from "./stub/state.mjs";
import { emit } from "./stub/frames.mjs";
import { onCommand } from "./stub/commands.mjs";

const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("omp/18.18.8\n");
  process.exit(0);
}
const argValue = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
};
const argPrefixed = (name) => {
  const prefix = `--${name}=`;
  const hit = argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

const pidFile = process.env.STUB_OMP_PID_FILE;
if (pidFile) {
  try {
    writeFileSync(pidFile, `${process.pid}\n`);
  } catch {
    /* the test owns the path */
  }
}
if (process.env.STUB_OMP_GRANDCHILD === "1") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  if (pidFile && grandchild.pid) {
    try {
      appendFileSync(pidFile, `grandchild=${grandchild.pid}\n`);
    } catch {
      /* ignore */
    }
  }
}
process.on("SIGTERM", () => {
  if (process.env.STUB_OMP_IGNORE_SIGTERM !== "1") process.exit(0);
});

initSession({
  cwd: argValue("cwd") || process.cwd(),
  resumePath: argValue("resume"),
  scenario: process.env.STUB_OMP_SCENARIO || "journey",
  stepDelay: Number(process.env.STUB_OMP_STEP_DELAY_MS ?? 12),
  requestedModel: argPrefixed("model"),
  requestedThinking: argPrefixed("thinking"),
});

await emit({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
  supportsBashExcludeFromContext: true,
});
await emit({ type: "available_commands_update", commands: COMMANDS });
if (state.scenario === "journey") {
  await emit({
    type: "extension_ui_request",
    id: "ui-notify-1",
    method: "notify",
    message: "Stub session ready",
    notifyType: "info",
  });
  // Unknown top-level type: the console must surface it as protocol evidence.
  await emit({ type: "notify", message: "stub unknown-frame evidence", level: "info" });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  if (!command || typeof command.type !== "string") return;
  onCommand(command).catch((error) => {
    emit({
      id: command.id,
      type: "response",
      command: command.type,
      success: false,
      error: `stub command handler failed: ${error?.message ?? error}`,
    });
  });
});
rl.on("close", () => {
  setTimeout(() => process.exit(0), 5);
});
