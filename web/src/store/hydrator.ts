import type { RawFrame } from "../protocol/types";

type Sender = (threadId: string, frame: RawFrame) => void;

interface HydratorOptions {
  send: Sender;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

const HYDRATE_COMMANDS = [
  "get_state",
  "get_messages",
  "get_session_stats",
  "get_available_thinking_levels",
] as const;

/** Owns post-handshake hydration and the `session_busy` retry for get_messages. */
export class Hydrator {
  private readonly send: Sender;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly onceSent = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly pendingMessages = new Set<string>();
  onRetry: ((threadId: string, attempt: number, delayMs: number) => void) | null = null;

  constructor(options: HydratorOptions) {
    this.send = options.send;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 8000;
    this.random = options.random ?? Math.random;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  hydrate(threadId: string): void {
    for (const command of HYDRATE_COMMANDS) {
      this.request(threadId, command);
    }
    for (const command of ["get_available_commands", "get_available_models"] as const) {
      const onceKey = `${threadId}:${command}`;
      if (!this.onceSent.has(onceKey)) {
        this.onceSent.add(onceKey);
        this.request(threadId, command);
      }
    }
  }

  /** Reset once-flags for a thread that was restarted. */
  reset(threadId: string): void {
    for (const command of ["get_available_commands", "get_available_models"]) {
      this.onceSent.delete(`${threadId}:${command}`);
    }
    this.cancelRetry(threadId);
  }

  /** Inspect every child frame for a hydration response. */
  observe(threadId: string, frame: RawFrame): void {
    if (frame.type !== "response") return;
    const command = frame.command;
    if (command !== "get_messages" || !this.pendingMessages.has(threadId)) return;
    if (frame.success !== false) {
      this.pendingMessages.delete(threadId);
      this.retryAttempts.delete(threadId);
      this.cancelRetry(threadId);
      return;
    }
    if (frame.code !== "session_busy" && frame.error !== "session is busy") return;
    this.scheduleRetry(threadId);
  }

  isPending(threadId: string): boolean {
    return this.pendingMessages.has(threadId);
  }

  retryCount(threadId: string): number {
    return this.retryAttempts.get(threadId) ?? 0;
  }

  dispose(): void {
    for (const timer of this.retryTimers.values()) this.clearTimeoutImpl(timer);
    this.retryTimers.clear();
  }

  private request(threadId: string, command: string): void {
    if (command === "get_messages") this.pendingMessages.add(threadId);
    this.send(threadId, { type: command } as RawFrame);
  }

  private scheduleRetry(threadId: string): void {
    if (this.retryTimers.has(threadId)) return;
    const attempt = (this.retryAttempts.get(threadId) ?? 0) + 1;
    this.retryAttempts.set(threadId, attempt);
    const raw = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    const delay = Math.round(raw * (0.75 + this.random() * 0.5));
    this.onRetry?.(threadId, attempt, delay);
    const timer = this.setTimeoutImpl(() => {
      this.retryTimers.delete(threadId);
      this.pendingMessages.add(threadId);
      this.send(threadId, { type: "get_messages" });
    }, delay);
    this.retryTimers.set(threadId, timer);
  }

  private cancelRetry(threadId: string): void {
    const timer = this.retryTimers.get(threadId);
    if (timer) this.clearTimeoutImpl(timer);
    this.retryTimers.delete(threadId);
  }
}
