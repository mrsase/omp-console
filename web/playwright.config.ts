import { defineConfig, devices } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 8789;
const baseURL = `http://127.0.0.1:${port}`;
const stub = join(repoRoot, "tools", "stub-omp.mjs");
const sessionsDir = mkdtempSync(join(tmpdir(), "omp-console-e2e-"));

const candidates = [
  process.env.OMP_CONSOLE_BIN,
  join(repoRoot, "target", "release", "omp-console"),
  join(repoRoot, "target", "debug", "omp-console"),
].filter((value): value is string => Boolean(value));
const server = candidates.find((path) => existsSync(path)) ?? candidates[candidates.length - 1];

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "darwin" ? "chrome" : undefined),
    viewport: { width: 1440, height: 900 },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `if [ ! -x "${server}" ]; then echo "missing server binary ${server}; run make build first" >&2; exit 1; fi; exec "${server}"`,
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      OMP_BIN: stub,
      OMP_CONSOLE_ADDR: `127.0.0.1:${port}`,
      OMP_CONSOLE_SESSIONS: sessionsDir,
      OMP_CONSOLE_DEV: "0",
      OMP_CONSOLE_MAX_THREADS: "8",
      STUB_OMP_STEP_DELAY_MS: "30",
      STUB_OMP_APPROVAL_DELAY_MS: "4000",
    },
  },
});
