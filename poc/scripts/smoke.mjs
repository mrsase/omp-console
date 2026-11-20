#!/usr/bin/env node
/**
 * End-to-end smoke test for omp-web.
 *
 * Requires a running server (default http://127.0.0.1:8787), `omp` on PATH,
 * and Node 22+ (global WebSocket). One model turn is spent unless --no-prompt.
 *
 *   node scripts/smoke.mjs [--cwd /path/to/project] [--no-prompt]
 */

import http from "node:http";

const args = process.argv.slice(2);
const cwdFlag = args.indexOf("--cwd");
const cwd = cwdFlag >= 0 ? args[cwdFlag + 1] : process.cwd();
const noPrompt = args.includes("--no-prompt");
const base = new URL(process.env.OMP_WEB_URL ?? "http://127.0.0.1:8787");
const wsUrl = `${base.protocol === "https:" ? "wss" : "ws"}://${base.host}/ws`;
const deadline = setTimeout(() => fail("timed out"), 180_000);

let threadId = null;
let promptId = null;
let sawTool = false;
const waiters = [];
const fail = (reason) => {
  console.error(`FAIL: ${reason}`);
  void cleanup().finally(() => process.exit(1));
};

const waitFor = (test, label, timeout = 60_000) =>
  new Promise((resolve, reject) => {
    const waiter = {
      test,
      resolve: (value) => {
        clearTimeout(waiter.timer);
        resolve(value);
      },
    };
    waiter.timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeout);
    waiters.push(waiter);
  });

function rawStatus({ method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: base.hostname,
        port: base.port || 80,
        path,
        method,
        headers,
        setHost: false,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function assertGuards() {
  const info = await rawStatus({
    method: "GET",
    path: "/api/info",
    headers: { Host: base.host },
  });
  if (info !== 200) throw new Error(`expected 200 for allowed Host, got ${info}`);
  const rebound = await rawStatus({
    method: "GET",
    path: "/api/info",
    headers: { Host: "evil.example:8787" },
  });
  if (rebound !== 421) throw new Error(`expected 421 for foreign Host, got ${rebound}`);
  const body = JSON.stringify({ cwd: "/" });
  const crossSite = await rawStatus({
    method: "POST",
    path: "/api/threads",
    headers: {
      Host: base.host,
      Origin: "http://evil.example",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
    body,
  });
  if (crossSite !== 403) throw new Error(`expected 403 for cross-site Origin, got ${crossSite}`);
  console.log("host/origin guards ok");
}

async function cleanup() {
  if (!threadId) return;
  try {
    await fetch(`${base.origin}/api/threads/${threadId}`, { method: "DELETE" });
  } catch {
    // Best effort.
  }
  threadId = null;
}

async function main() {
  await assertGuards();

  // Attach the message listener before awaiting `open`: the server sends
  // `hello` immediately and that frame must not race the listener.
  const socket = new WebSocket(wsUrl);
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error(`cannot connect to ${wsUrl}`)));
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.op === "frame") {
      const frame = message.frame;
      if (frame.type === "tool_execution_end") sawTool = true;
      if (frame.type === "prompt_result" && frame.id === promptId) {
        if (frame.status !== "completed") fail(`prompt ${frame.status}: ${frame.error ?? ""}`);
      }
    }
    for (const waiter of [...waiters]) {
      if (waiter.test(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });

  await opened;
  const hello = await waitFor((m) => m.op === "hello", "hello frame", 10_000);
  if (!hello.version) throw new Error("hello frame has no server version");

  const response = await fetch(`${base.origin}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!response.ok) throw new Error(`create failed: ${response.status} ${await response.text()}`);
  const info = await response.json();
  threadId = info.id;
  console.log(`session ${threadId} created in ${info.cwd}`);

  socket.send(JSON.stringify({ op: "view", thread: threadId }));
  await waitFor(
    (m) => m.op === "thread" && m.thread?.id === threadId && m.thread.status === "ready",
    "session ready",
    30_000,
  );

  socket.send(
    JSON.stringify({
      op: "command",
      thread: threadId,
      frame: { type: "get_state", id: "smoke-state" },
    }),
  );
  const state = await waitFor(
    (m) => m.op === "frame" && m.frame?.type === "response" && m.frame.command === "get_state",
    "get_state response",
  );
  if (!state.frame.success) throw new Error(`get_state failed: ${state.frame.error}`);
  const active = state.frame.data?.model;
  if (!active) throw new Error("no active model");
  console.log(`model ${active.provider}/${active.id}, thinking ${state.frame.data.thinkingLevel}`);

  if (!noPrompt) {
    promptId = "smoke-prompt";
    socket.send(
      JSON.stringify({
        op: "command",
        thread: threadId,
        frame: {
          type: "prompt",
          id: promptId,
          message: "Use the bash tool to run `echo omp-web-smoke`, then reply with exactly: SMOKE-OK",
        },
      }),
    );
    await waitFor(
      (m) => m.op === "frame" && m.frame?.type === "prompt_result" && m.frame.id === promptId,
      "prompt result",
      120_000,
    );
    if (!sawTool) throw new Error("the model never executed the bash tool");
    console.log("prompt completed and a tool ran");
  }

  await cleanup();
  clearTimeout(deadline);
  console.log("PASS");
  socket.close();
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
