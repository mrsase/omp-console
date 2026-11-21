#!/usr/bin/env node
/**
 * Time-to-first-visible-token (TTFT) through the real stack.
 *
 *   node tools/measure-ttft.mjs            # stub, 5 runs, console overhead
 *   OMP_CONSOLE_BIN=... node tools/measure-ttft.mjs
 *
 * Starts a private server with the stub in a short `events` scenario, creates a
 * session, and measures from Enter to the first non-empty assistant text in the
 * DOM. This isolates console + transport + React overhead, not provider time.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(root, "web", "package.json"))("playwright");
const bin = [
  process.env.OMP_CONSOLE_BIN,
  join(root, "target", "debug", "omp-console"),
  join(root, "target", "release", "omp-console"),
].find((path) => path && existsSync(path));
if (!bin) {
  console.error("measure-ttft: build the server first");
  process.exit(2);
}
const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolvePort(address && typeof address === "object" ? address.port : 0));
  });
});
const base = `http://127.0.0.1:${port}`;
const sessions = mkdtempSync(join(tmpdir(), "omp-ttft-sessions-"));
const cwd = mkdtempSync(join(tmpdir(), "omp-ttft-cwd-"));
const server = spawn(bin, [], {
  env: {
    ...process.env,
    OMP_BIN: join(root, "tools", "stub-omp.mjs"),
    OMP_CONSOLE_ADDR: `127.0.0.1:${port}`,
    OMP_CONSOLE_SESSIONS: sessions,
    STUB_OMP_SCENARIO: "events",
    STUB_OMP_EVENTS: "5",
    STUB_OMP_STEP_DELAY_MS: "0",
  },
  detached: true,
  stdio: "ignore",
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
  rmSync(sessions, { recursive: true, force: true });
};

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    await sleep(100);
  }
  const thread = await (
    await fetch(`${base}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    })
  ).json();
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "darwin" ? "chrome" : undefined),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(base);
  await page.locator("textarea").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  const samples = [];
  for (let run = 0; run < 5; run += 1) {
    const marker = `ttft-${run}-${Date.now()}`;
    const box = page.locator("textarea").first();
    await box.fill(marker);
    const started = Date.now();
    await box.press("Enter");
    await page
      .locator(".assistant-text")
      .filter({ hasText: "event" })
      .first()
      .waitFor({ timeout: 20_000 });
    samples.push(Date.now() - started);
    await page.waitForTimeout(250);
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        samplesMs: samples,
        medianMs: samples[Math.floor(samples.length / 2)],
        p95Ms: samples[Math.floor(samples.length * 0.95)],
        note: "stub events, Enter to first rendered assistant text",
      },
      null,
      2,
    ),
  );
  await browser.close();
} finally {
  stop();
}
