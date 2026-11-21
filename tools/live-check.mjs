#!/usr/bin/env node
/**
 * Manual live check against a running omp-console and the real `omp`.
 *
 * Spends one cheap model turn. This is the validation-phase live smoke, never
 * a CI gate. It asserts the guards, creates a session, waits for ready,
 * inspects state, runs one tool, and deletes the session.
 *
 *   node tools/live-check.mjs --cwd /tmp/project [--model provider/model]
 *   OMP_CONSOLE_URL=http://127.0.0.1:8787 node tools/live-check.mjs
 */
import http from "node:http";

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const base = new URL(process.env.OMP_CONSOLE_URL ?? "http://127.0.0.1:8787");
const cwd = value("--cwd", process.cwd());
const model = value("--model", process.env.OMP_FIXTURE_MODEL ?? "opencode-go/deepseek-v4.1-flash");
const wsUrl = `${base.protocol === "https:" ? "wss" : "ws"}://${base.host}/ws`;

const waiters = [];
const waitFor = (test, label, timeout = 120_000) =>
  new Promise((resolve, reject) => {
    const waiter = { test, resolve, reject };
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
      { host: base.hostname, port: base.port || 80, path, method, headers, setHost: false },
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

async function guards() {
  const info = await rawStatus({ method: "GET", path: "/api/info", headers: { Host: base.host } });
  if (info !== 200) throw new Error(`allowed Host: expected 200, got ${info}`);
  const rebound = await rawStatus({
    method: "GET",
    path: "/api/info",
    headers: { Host: "evil.example:8787" },
  });
  if (rebound !== 421) throw new Error(`foreign Host: expected 421, got ${rebound}`);
  const body = JSON.stringify({ cwd: "/" });
  const cross = await rawStatus({
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
  if (cross !== 403) throw new Error(`cross-site Origin: expected 403, got ${cross}`);
  console.log("guards ok");
}

async function main() {
  await guards();
  const info = await (await fetch(`${base.origin}/api/info`)).json();
  console.log(`console ${info.version}; omp ${info.omp?.version} supported=${info.omp?.supported}`);

  const created = await fetch(`${base.origin}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, model, thinking: "off" }),
  });
  if (!created.ok) throw new Error(`create failed: ${created.status} ${await created.text()}`);
  const thread = await created.json();
  console.log(`session ${thread.id} in ${thread.cwd}`);

  const socket = new WebSocket(wsUrl);
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    for (const waiter of [...waiters]) {
      if (waiter.test(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error(`cannot connect ${wsUrl}`)));
  });
  socket.send(JSON.stringify({ op: "view", thread: thread.id }));

  const id = "live-state";
  socket.send(JSON.stringify({ op: "command", thread: thread.id, frame: { id, type: "get_state" } }));
  const state = await waitFor(
    (message) => message.op === "frame" && message.frame?.id === id,
    "get_state",
  );
  if (!state.frame.success) throw new Error(`get_state failed: ${state.frame.error}`);
  console.log(
    `model ${state.frame.data?.model?.provider}/${state.frame.data?.model?.id}; ` +
      `thinking ${state.frame.data?.thinkingLevel}`,
  );

  const promptId = "live-prompt";
  socket.send(
    JSON.stringify({
      op: "command",
      thread: thread.id,
      frame: {
        id: promptId,
        type: "prompt",
        message:
          "Use the bash tool to run `echo omp-console-live`, then reply with exactly LIVE-OK and nothing else.",
      },
    }),
  );
  let sawTool = false;
  const result = await waitFor((message) => {
    if (message.op === "frame" && message.frame?.type === "tool_execution_end") sawTool = true;
    return message.op === "frame" && message.frame?.type === "prompt_result" && message.frame.id === promptId;
  }, "prompt_result");
  if (result.frame.status !== "completed") {
    throw new Error(`prompt ${result.frame.status}: ${JSON.stringify(result.frame.error)}`);
  }
  if (!sawTool) throw new Error("no tool execution observed");
  console.log("prompt completed and a tool ran");

  const removed = await fetch(`${base.origin}/api/threads/${thread.id}`, { method: "DELETE" });
  if (!removed.ok) throw new Error(`delete failed: ${removed.status}`);
  socket.close();
  console.log("PASS");
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
