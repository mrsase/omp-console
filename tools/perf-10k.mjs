#!/usr/bin/env node
/**
 * A10 performance proof: drive the real console with the stub in `events`
 * mode, render 10k transcript events, scroll top→bottom, and measure.
 *
 *   node tools/perf-10k.mjs            (needs web/node_modules + a built binary)
 *   OMP_CONSOLE_BIN=target/debug/omp-console node tools/perf-10k.mjs
 *
 * Exits 1 when any long task exceeds 100 ms or JS heap grows more than 50 MB.
 * Writes web/test-results/perf-10k.json (or PERF_OUT) and prints exact numbers.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const events = Number(process.env.STUB_OMP_EVENTS || 10000);
const longTaskLimitMs = 100;
const heapGrowthLimit = 50 * 1024 * 1024;

const serverBin = [
  process.env.OMP_CONSOLE_BIN,
  join(root, "target", "debug", "omp-console"),
  join(root, "target", "release", "omp-console"),
].find((path) => path && existsSync(path));
if (!serverBin) {
  console.error("perf-10k: no omp-console binary found; run `cargo build` first");
  process.exit(2);
}
let chromium;
try {
  ({ chromium } = createRequire(join(root, "web", "package.json"))("playwright"));
} catch {
  console.error("perf-10k: playwright is not installed; run `make web-install` first");
  process.exit(2);
}

const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const chosen = typeof address === "object" && address ? address.port : 0;
    probe.close(() => resolvePort(chosen));
  });
});
const base = `http://127.0.0.1:${port}`;
const sessions = mkdtempSync(join(tmpdir(), "omp-perf-sessions-"));
const cwd = mkdtempSync(join(tmpdir(), "omp-perf-cwd-"));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (typeof WebSocket !== "function") {
  console.error("perf-10k: this Node build has no global WebSocket; use Node 22 or newer");
  process.exit(2);
}

const server = spawn(serverBin, [], {
  env: {
    ...process.env,
    OMP_BIN: join(root, "tools", "stub-omp.mjs"),
    OMP_CONSOLE_ADDR: `127.0.0.1:${port}`,
    OMP_CONSOLE_SESSIONS: sessions,
    OMP_CONSOLE_DEV: "0",
    STUB_OMP_SCENARIO: "events",
    STUB_OMP_EVENTS: String(events),
    STUB_OMP_STEP_DELAY_MS: "0",
  },
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
process.on("exit", () => {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
});
process.on("unhandledRejection", (error) => {
  console.error(`perf-10k: ${error?.stack ?? error}`);
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  process.exit(2);
});
let serverLog = "";
server.stdout.on("data", (chunk) => {
  serverLog += String(chunk);
});
server.stderr.on("data", (chunk) => {
  serverLog += String(chunk);
});

async function waitHealthy(timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error(`server did not become healthy\n${serverLog.slice(-2000)}`);
}

function stopServer() {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 1500);
}

async function composerVisible(page) {
  return page
    .locator("textarea")
    .first()
    .isVisible()
    .catch(() => false);
}

async function clickThread(page) {
  const title = /stub session|Stub/i;
  const target = page.getByText(title).first();
  if (await target.isVisible().catch(() => false)) {
    await target.click().catch(() => undefined);
    return;
  }
  const anyRow = page.locator("[data-thread-id], [data-session-id]").first();
  if (await anyRow.isVisible().catch(() => false)) await anyRow.click().catch(() => undefined);
}

async function waitSettled(socket, timeout) {
  const { promise, resolve: done, reject } = Promise.withResolvers();
  const timer = setTimeout(() => reject(new Error("timed out waiting for session_settled")), timeout);
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.op === "frame" && message.frame && message.frame.type === "session_settled") {
      clearTimeout(timer);
      done();
    }
  });
  return promise;
}

async function heapSize(cdp) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0;
}

await waitHealthy();
const created = await fetch(`${base}/api/threads`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ cwd }),
});
if (!created.ok) throw new Error(`create thread failed: ${created.status} ${await created.text()}`);
const thread = await created.json();

const readyDeadline = Date.now() + 15_000;
while (Date.now() < readyDeadline) {
  const listed = await (await fetch(`${base}/api/threads`)).json();
  const entry = listed.find((item) => item.id === thread.id);
  if (entry?.status === "ready") break;
  await sleep(100);
}

const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "darwin" ? "chrome" : undefined),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.addInitScript(() => {
  window.__perfLongTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__perfLongTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {
    /* the browser lacks Long Tasks */
  }
});
await page.goto(base);
await page.getByText(/new session/i).first().waitFor({ timeout: 25_000 });
await page.getByText(/stub session/i).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
await clickThread(page);
if (!(await composerVisible(page))) await clickThread(page);
await page.locator("textarea").first().waitFor({ timeout: 20_000 });
await page.waitForLoadState("networkidle");
await sleep(800);

const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
// Start the long-task window after app boot: A10 measures the 10k render and
// scroll, not font loading or the first paint.
await page.evaluate(() => {
  window.__perfLongTasks = [];
});
const heapBefore = await heapSize(cdp);
const startedAt = Date.now();

const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener("open", resolveOpen, { once: true });
  socket.addEventListener("error", rejectOpen, { once: true });
});
let framesSeen = 0;
socket.addEventListener("message", (event) => {
  try {
    const message = JSON.parse(String(event.data));
    if (message.op === "frame") framesSeen += 1;
  } catch {
    /* ignore */
  }
});
const settled = waitSettled(socket, 180_000);
socket.send(JSON.stringify({ op: "view", thread: thread.id }));
socket.send(
  JSON.stringify({
    op: "command",
    thread: thread.id,
    frame: { id: "perf-prompt", type: "prompt", message: "Run the 10k event stream." },
  }),
);
await settled;
await sleep(500);
const streamedMs = Date.now() - startedAt;
socket.close();

const rowCount = await page.locator("[data-message-key]").count();
const scrollerHandle = await page.evaluateHandle(() => {
  const region = document.querySelector('[role="region"][aria-label="Conversation" i]');
  let node = region;
  while (node && node !== document.body) {
    if (node.scrollHeight > node.clientHeight + 20) return node;
    node = node.parentElement;
  }
  return region ?? document.scrollingElement;
});
const scroller = scrollerHandle.asElement();
let scrollSteps = 0;
if (scroller) {
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await sleep(200);
  for (; scrollSteps < 400; scrollSteps += 1) {
    const moved = await scroller.evaluate((element) => {
      const before = element.scrollTop;
      const step = Math.max(200, Math.floor(element.clientHeight * 0.9));
      element.scrollTop = Math.min(element.scrollHeight, before + step);
      return element.scrollTop !== before;
    });
    if (!moved) break;
    await sleep(50);
  }
}
await sleep(300);

const longTasks = await page.evaluate(() => window.__perfLongTasks || []);
const heapAfter = await heapSize(cdp);
const overLimit = longTasks.filter((task) => task.duration > longTaskLimitMs);
const growth = heapAfter - heapBefore;
const maxLongTask = longTasks.reduce((max, task) => Math.max(max, task.duration), 0);
const geometry = await page.evaluate(() => {
  const scroll = document.querySelector(".transcript-scroll");
  const virtual = document.querySelectorAll(".virtual-row");
  const rows = document.querySelectorAll("[data-message-key]");
  return {
    client: scroll?.clientHeight,
    scrollHeight: scroll?.scrollHeight,
    scrollTop: scroll?.scrollTop,
    rows: rows.length,
    virtual: virtual.length,
    col: document.querySelector(".transcript-column")?.getBoundingClientRect().height,
  };
});
const result = {
  generatedAt: new Date().toISOString(),
  geometry,
  eventsRequested: events,
  observerFrames: framesSeen,
  rows: rowCount,
  streamedMs,
  scrollSteps,
  longTasks: longTasks.map((task) => ({
    duration: Number(task.duration.toFixed(1)),
    startTime: Number(task.startTime.toFixed(1)),
    name: task.name,
  })),
  longTasksOver100ms: overLimit.length,
  maxLongTaskMs: Number(maxLongTask.toFixed(1)),
  heapBeforeBytes: heapBefore,
  heapAfterBytes: heapAfter,
  heapGrowthBytes: growth,
  heapGrowthMb: Number((growth / (1024 * 1024)).toFixed(2)),
  passed: overLimit.length === 0 && growth <= heapGrowthLimit,
};
const out = process.env.PERF_OUT || join(root, "web", "test-results", "perf-10k.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  `perf-10k: events=${events} observerFrames=${framesSeen} rows=${rowCount} longTasks>100ms=${overLimit.length} ` +
    `max=${result.maxLongTaskMs}ms heap=${(heapBefore / 1048576).toFixed(1)}MB→` +
    `${(heapAfter / 1048576).toFixed(1)}MB growth=${result.heapGrowthMb}MB ` +
    `scrollSteps=${scrollSteps} stream=${streamedMs}ms ${result.passed ? "PASS" : "FAIL"} (${out})`,
);

await browser.close();
stopServer();
await sleep(300);
rmSync(sessions, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
process.exit(result.passed ? 0 : 1);
