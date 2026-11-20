#!/usr/bin/env node
/**
 * Live capture recorder for the omp RPC protocol. NEVER run in CI.
 *
 * Spawns a real `omp --mode rpc-ui`, drives one scripted turn (bash + ask +
 * DONE), answers every dialog automatically, then stops the child and
 * re-spawns it with `--resume` to record the rehydration sequence.
 *
 * Everything the child writes is recorded verbatim. The output is raw and
 * unsanitized: prompts, tool payloads, absolute paths, session ids, account
 * metadata and credentials can all appear in it. It goes only to
 * `.omp-fixtures/raw/<run-id>/` (gitignored). This tool never writes
 * `docs/fixtures/`; the committed fixtures are constructed by
 * `tools/build-fixtures.mjs` from the observed shapes.
 *
 * Usage:
 *   node tools/capture-fixtures.mjs
 *   OMP_BIN=/path/to/omp OMP_FIXTURE_MODEL=provider/model \
 *     node tools/capture-fixtures.mjs
 *
 * Output per run: frames.jsonl (one raw line per child frame), meta.json and stderr.log.
 * Exit 0 when the resume capture completes, 1 on timeout/failure.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, ".omp-fixtures", "raw");
const OVERALL_TIMEOUT_MS = 180_000;
const PROMPT_DELAY_MS = 2_000;

const ompBin = process.env.OMP_BIN || "omp";
const model = process.env.OMP_FIXTURE_MODEL || "opencode-go/deepseek-v4.1-flash";
const PROMPT = [
  "Complete this fixture task exactly, in order, with no extra commentary:",
  "1) Use the bash tool to run `echo omp-console-fixture`.",
  "2) Use the ask tool with exactly one question that offers the options Red and Blue.",
  "3) After both complete, reply with exactly DONE and nothing else.",
].join(" ");

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid.toString(36)}`;
const runDir = path.join(FIXTURE_ROOT, runId);
// Guard against ever writing the sanitized fixture directory.
if (runDir.startsWith(path.join(REPO_ROOT, "docs"))) {
  throw new Error("refusing to write raw frames under docs/");
}
fs.mkdirSync(runDir, { recursive: true });

const framesPath = path.join(runDir, "frames.jsonl");
const metaPath = path.join(runDir, "meta.json");
const stderrPath = path.join(runDir, "stderr.log");
const framesFd = fs.openSync(framesPath, "w"), stderrFd = fs.openSync(stderrPath, "w");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fixtures-"));
const workDir = path.join(tmpRoot, "work");
const sessionsDir = path.join(tmpRoot, "sessions");
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });

const meta = {
  tool: "tools/capture-fixtures.mjs",
  note: "Raw, unsanitized live capture. Do not commit; never copy into docs/fixtures.",
  runId,
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  ompBin,
  model,
  prompt: PROMPT,
  tmpRoot,
  workDir,
  sessionsDir,
  phases: [],
  commands: [],
  responses: [],
  countsByType: {},
  messageUpdateEvents: {},
  frameCount: 0,
  stderrLines: 0,
  sessionFile: null,
  errors: [],
  status: "running",
  exitCode: null,
  reason: null,
  endedAt: null,
};

const state = {
  child: null,
  phase: null,
  livePhase: null,
  liveReadyHandled: false,
  readyTimer: null,
  promptSent: false,
  promptResultSeen: false,
  resumeStatsCommandId: null,
  resumeStarted: false,
  sessionFile: null,
  phase2Pending: null,
  transitioning: false,
  commandSeq: 0,
};

let finished = false;
let stderrPrinted = 0;

function log(line) {
  process.stdout.write(`${line}\n`);
}

function writeMeta() {
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

function baseArgs() {
  return [
    "--mode",
    "rpc-ui",
    "--cwd",
    workDir,
    "--session-dir",
    sessionsDir,
    `--model=${model}`,
    "--thinking=off",
    "--no-title",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-context-files",
    "--approval-mode=always-ask",
  ];
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code);
      }
    });
  });
}

function send(type, payload = {}) {
  const id = `cap-${++state.commandSeq}`;
  const frame = { type, ...payload, id };
  const child = state.child;
  if (!child || child.stdin.destroyed || !child.stdin.writable) {
    meta.errors.push(`cannot send ${type}: child stdin is closed`);
    writeMeta();
    return null;
  }
  try {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  } catch (error) {
    meta.errors.push(`send ${type} failed: ${error.message}`);
    writeMeta();
    return null;
  }
  meta.commands.push({ phase: state.phase?.name ?? "?", id, type, payload });
  log(`>> ${type} (${id})`);
  return id;
}

function respond(payload) {
  const frame = { type: "extension_ui_response", ...payload };
  const child = state.child;
  if (!child || child.stdin.destroyed || !child.stdin.writable) return;
  try {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  } catch (error) {
    meta.errors.push(`response ${payload.id} failed: ${error.message}`);
    return;
  }
  meta.responses.push({ phase: state.phase?.name ?? "?", ...payload });
  log(`>> extension_ui_response (${payload.id})`);
}

function optionLabel(option) {
  if (typeof option === "string") return option;
  if (option && typeof option === "object") {
    if (typeof option.label === "string") return option.label;
    if (typeof option.value === "string") return option.value;
  }
  return String(option ?? "");
}

/** Auto-answer one extension_ui_request. Methods absent from the protocol's
 * response set (cancel/notify/setStatus/setWidget/setTitle/set_editor_text/
 * open_url) are deliberately left unanswered. */
function answerDialog(frame) {
  const method = frame.method;
  const id = frame.id;
  if (typeof id !== "string") return;

  if (method === "ask") {
    const questions = Array.isArray(frame.questions) ? frame.questions : [];
    const answers = questions.map((question) => {
      const options = Array.isArray(question?.options) ? question.options : [];
      const first = options.length ? optionLabel(options[0]) : "";
      return {
        id: typeof question?.id === "string" ? question.id : String(question?.name ?? ""),
        selectedOptions: first ? [first] : [],
      };
    });
    respond({ id, answers });
    return;
  }
  if (method === "confirm") {
    respond({ id, confirmed: true });
    return;
  }
  if (method === "select") {
    const options = Array.isArray(frame.options) ? frame.options.map(optionLabel) : [];
    if (options.length === 0) return;
    const preferred = options.findIndex((option) => /approve|allow|yes/i.test(option));
    respond({ id, value: options[preferred >= 0 ? preferred : 0] });
    return;
  }
  if (method === "input" || method === "editor") {
    respond({ id, value: "yes" });
  }
}

function handleLine(lineBuf, phase) {
  if (finished) return;
  fs.writeSync(framesFd, lineBuf);
  fs.writeSync(framesFd, Buffer.from("\n"));

  if (lineBuf.length === 0) return;

  phase.frameCount += 1;
  meta.frameCount += 1;

  let frame = null;
  let type = "<invalid-json>";
  try {
    frame = JSON.parse(lineBuf.toString("utf8"));
    if (frame && typeof frame === "object" && !Array.isArray(frame)) {
      type = typeof frame.type === "string" ? frame.type : "<no-type>";
    } else {
      type = "<non-object>";
    }
  } catch {
    type = "<invalid-json>";
  }
  meta.countsByType[type] = (meta.countsByType[type] ?? 0) + 1;

  let label = type;
  if (type === "message_update") {
    const event = frame?.assistantMessageEvent?.type ?? "<none>";
    meta.messageUpdateEvents[event] = (meta.messageUpdateEvents[event] ?? 0) + 1;
    label = `message_update/${event}`;
  } else if (type === "response" && typeof frame?.command === "string") {
    label = `response/${frame.command}`;
  }
  log(`[${phase.name}] #${phase.frameCount} ${label}`);

  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
  onFrame(frame, phase);
}

function onStderr(chunk, phase) {
  if (finished) return;
  fs.writeSync(stderrFd, chunk);
  const text = chunk.toString("utf8");
  meta.stderrLines += (text.match(/\n/g) ?? []).length;
  for (const line of text.split("\n")) {
    if (!line || stderrPrinted >= 200) continue;
    stderrPrinted += 1;
    log(`[stderr:${phase.name}] ${line}`);
  }
}

function attach(child, phase) {
  let buffered = Buffer.alloc(0);

  child.stdout.on("data", (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    let newline;
    while ((newline = buffered.indexOf(0x0a)) !== -1) {
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      handleLine(line, phase);
    }
  });

  child.stdout.on("close", () => {
    if (finished || buffered.length === 0) return;
    // A partial trailing line is recorded byte-for-byte; meta explains it.
    fs.writeSync(framesFd, buffered);
    phase.partialTrailingBytes = buffered.length;
    log(`[${phase.name}] partial trailing frames bytes flushed: ${buffered.length}`);
    buffered = Buffer.alloc(0);
  });

  child.stdout.on("error", (error) => {
    meta.errors.push(`stdout ${phase.name}: ${error.message}`);
  });
  child.stderr.on("data", (chunk) => onStderr(chunk, phase));

  child.on("error", (error) => {
    meta.errors.push(`spawn ${phase.name}: ${error.message}`);
    if (!state.transitioning) fail(`spawn failed: ${error.message}`, phase);
  });

  child.on("exit", (code, signal) => {
    phase.exit = { code, signal, at: new Date().toISOString() };
    phase.endedAt = phase.exit.at;
    if (!state.transitioning && !finished) {
      fail(`omp exited before capture completed (code=${code} signal=${signal})`, phase);
    } else {
      writeMeta();
    }
  });
}

function startPhase(name, extraArgs) {
  const args = [...baseArgs(), ...extraArgs];
  const phase = {
    name,
    startedAt: new Date().toISOString(),
    args,
    frameCount: 0,
    pid: null,
    ready: false,
    commandsSent: false,
    exit: null,
    partialTrailingBytes: 0,
    endedAt: null,
  };
  meta.phases.push(phase);
  state.phase = phase;

  const child = spawn(ompBin, args, {
    cwd: workDir,
    env: { ...process.env, PI_NO_TITLE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  phase.pid = child.pid ?? null;
  state.child = child;
  if (name === "live") state.livePhase = phase;

  child.stdin.on("error", (error) => {
    meta.errors.push(`stdin ${name}: ${error.message}`);
  });

  attach(child, phase);
  log(`[${name}] spawned pid=${child.pid ?? "?"}: ${ompBin} ${args.join(" ")}`);
  writeMeta();
  return phase;
}

function sendPrompt() {
  if (finished || state.promptSent) return;
  state.promptSent = true;
  send("prompt", { message: PROMPT });
  writeMeta();
}

async function terminate(child, label, graceMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
    log(`[${label}] sent SIGTERM`);
  } catch (error) {
    meta.errors.push(`${label} SIGTERM: ${error.message}`);
  }
  if ((await waitForExit(child, graceMs)) !== null) return;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      meta.errors.push(`${label} SIGKILL: ${error.message}`);
    }
    await waitForExit(child, 2_000);
  }
}

async function beginResume() {
  if (finished || state.resumeStarted) return;
  state.resumeStarted = true;
  state.transitioning = true;
  clearTimeout(state.readyTimer);

  const phase = state.livePhase;
  await terminate(state.child, "live", 5_000);
  state.transitioning = false;
  if (finished) return;

  if (phase && !phase.endedAt) phase.endedAt = new Date().toISOString();

  const sessionFile = state.sessionFile;
  if (!sessionFile) {
    fail("get_session_stats returned no sessionFile");
    return;
  }
  if (!fs.existsSync(sessionFile)) {
    meta.errors.push(`sessionFile does not exist: ${sessionFile}`);
    log(`[resume] warning: sessionFile does not exist: ${sessionFile}`);
  }
  log(`[resume] resuming from ${sessionFile}`);
  startPhase("resume", ["--resume", sessionFile]);
}

async function completeResume() {
  if (finished || state.transitioning) return;
  state.transitioning = true;
  await terminate(state.child, "resume", 3_000);
  finish(0, "resume capture complete");
}

function onFrame(frame, phase) {
  if (finished) return;
  const type = frame.type;

  if (type === "extension_ui_request") {
    answerDialog(frame);
    return;
  }

  if (type === "ready") {
    phase.ready = true;
    if (phase.name === "live" && !state.liveReadyHandled) {
      state.liveReadyHandled = true;
      send("negotiate_protocol", { protocolVersion: 2 });
      send("set_event_filter", { events: null, messageUpdates: "delta" });
      send("set_ask_dialog", { enabled: true });
      send("get_state");
      send("get_session_stats");
      send("get_available_models");
      send("get_available_commands");
      writeMeta();
      state.readyTimer = setTimeout(sendPrompt, PROMPT_DELAY_MS);
    } else if (phase.name === "resume" && !phase.commandsSent) {
      phase.commandsSent = true;
      const ids = [send("get_state"), send("get_messages"), send("get_session_stats")];
      state.phase2Pending = new Set(ids.filter((id) => typeof id === "string"));
      log(`[resume] rehydration commands sent (${ids.length})`);
      writeMeta();
    }
    return;
  }

  if (type === "response") {
    const data = frame.data ?? {};
    if (frame.command === "get_state" && typeof data.sessionFile === "string") {
      state.sessionFile = data.sessionFile;
    }
    if (frame.command === "get_session_stats" && typeof data.sessionFile === "string") {
      state.sessionFile = data.sessionFile;
    }

    if (phase.name === "resume" && state.phase2Pending?.has(frame.id)) {
      state.phase2Pending.delete(frame.id);
      if (frame.success === false) {
        meta.errors.push(`resume ${frame.command}: ${frame.error ?? "unknown error"}`);
      }
      if (state.phase2Pending.size === 0) {
        log("[resume] rehydration responses complete");
        void completeResume();
      }
      return;
    }

    if (
      phase.name === "live" &&
      frame.command === "get_session_stats" &&
      frame.id === state.resumeStatsCommandId
    ) {
      log("[live] session stats captured for resume");
      void beginResume();
    }
    return;
  }

  if (type === "prompt_result" && phase.name === "live" && !state.promptResultSeen) {
    state.promptResultSeen = true;
    clearTimeout(state.readyTimer);
    phase.promptResult = {
      status: frame.status ?? null,
      agentInvoked: frame.agentInvoked ?? null,
      sessionSettled: frame.sessionSettled ?? null,
    };
    log(`[live] prompt_result status=${frame.status ?? "?"}`);
    state.resumeStatsCommandId = send("get_session_stats");
    writeMeta();
  }
}

function formatCounts(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}=${count}`).join(", ");
}

function printSummary(reason) {
  const elapsed = Date.now() - Date.parse(meta.startedAt);
  log("");
  log(`capture ${meta.status}: ${reason}`);
  for (const phase of meta.phases) {
    log(`  ${phase.name}: frames=${phase.frameCount} pid=${phase.pid ?? "?"} exit=${JSON.stringify(phase.exit)}`);
  }
  log(`  frame types: ${formatCounts(meta.countsByType) || "none"}`);
  log(`  message_update events: ${formatCounts(meta.messageUpdateEvents) || "none"}`);
  log(`  commands=${meta.commands.length} responses=${meta.responses.length} stderrLines=${meta.stderrLines}`);
  log(`  sessionFile: ${meta.sessionFile ?? "unknown"}`);
  if (meta.errors.length) log(`  errors: ${meta.errors.length}`);
  log(`  elapsed: ${elapsed}ms`);
  log(`  raw: ${runDir}`);
}

function finish(code, reason) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearTimeout(state.readyTimer);

  meta.status = code === 0 ? "ok" : "error";
  meta.exitCode = code;
  meta.reason = reason;
  meta.endedAt = new Date().toISOString();
  for (const phase of meta.phases) {
    if (!phase.endedAt) phase.endedAt = meta.endedAt;
  }

  const child = state.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  try {
    writeMeta();
  } catch (error) {
    log(`[meta] write failed: ${error.message}`);
  }
  for (const fd of [framesFd, stderrFd]) {
    try {
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch {
      // already closed
    }
  }
  printSummary(reason);
  process.exit(code);
}

function fail(message, phase = state.phase) {
  meta.errors.push(message);
  if (phase) phase.error = message;
  finish(1, message);
}

const deadline = setTimeout(() => {
  fail(`overall timeout after ${OVERALL_TIMEOUT_MS}ms`);
}, OVERALL_TIMEOUT_MS);

process.once("SIGINT", () => finish(130, "interrupted (SIGINT)"));
process.once("SIGTERM", () => finish(143, "terminated (SIGTERM)"));
process.once("uncaughtException", (error) => {
  meta.errors.push(`uncaught: ${error?.stack ?? error}`);
  finish(1, "uncaught exception");
});
process.once("unhandledRejection", (error) => {
  meta.errors.push(`unhandled rejection: ${error?.stack ?? error}`);
  finish(1, "unhandled rejection");
});

log("omp fixture capture (live, raw, unsanitized)");
log(`  omp:   ${ompBin}`);
log(`  model: ${model}`);
log(`  raw:   ${runDir}`);
log("  approval: auto-approve; dialogs: auto-answer; do not commit the raw output");

writeMeta();
startPhase("live", []);
