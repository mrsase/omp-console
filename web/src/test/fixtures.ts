import fs from "node:fs";
import path from "node:path";
import type { RawFrame, ThreadInfo } from "../protocol/types";
import { emptyState } from "../protocol/state";
import { reduceEnvelope } from "../protocol/reduce";
import type { AppState } from "../protocol/types";

const CANDIDATES = [
  path.resolve(process.cwd(), "../docs/fixtures"),
  path.resolve(process.cwd(), "docs/fixtures"),
  path.resolve(import.meta.dirname, "../../../docs/fixtures"),
];

export function fixtureDir(): string {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`fixture directory not found; tried ${CANDIDATES.join(", ")}`);
}

export function loadFixture(name: string): RawFrame[] {
  const file = path.join(fixtureDir(), `${name}.jsonl`);
  const text = fs.readFileSync(file, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RawFrame);
}

export function makeThread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "thread-1",
    cwd: "/work/project",
    status: "ready",
    pid: 1234,
    createdAt: 1767225600000,
    lastActivity: 1767225600000,
    exitCode: null,
    resume: null,
    title: "Fixture session",
    model: "deepseek-v4.1-flash",
    modelName: "DeepSeek V4.1 Flash",
    sessionName: "Fixture session",
    sessionFile: "/sessions/session-fixture.jsonl",
    sessionId: "ses_fixture_0001",
    thinking: "off",
    ready: { protocolVersion: 1, supportedProtocolVersions: [1, 2] },
    protocol: { version: 1, delta: true, eventFilter: true, degraded: null },
    unknownFrames: 0,
    unknownKinds: [],
    ...overrides,
  };
}

export function bootState(thread = makeThread()): AppState {
  return reduceEnvelope(emptyState(), {
    op: "hello",
    version: "1.0.0",
    protocol: 1,
    threads: [thread],
  });
}
