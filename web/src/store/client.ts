import type { Envelope, FsListing, InfoResponse, RawFrame, RecentSession, ThreadInfo } from "../protocol/types";
import type { ConsoleStore } from "./store";
import { HttpApi, type ConsoleApi, type CreateThreadBody } from "./api";
import { Hydrator } from "./hydrator";
import { ALLOWED_CLIENT_COMMANDS } from "./commands";

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface ClientOptions {
  store: ConsoleStore;
  url?: string;
  api?: ConsoleApi;
  socketFactory?: (url: string) => SocketLike;
  random?: () => number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

const OPEN = 1;

export class ConsoleClient {
  readonly store: ConsoleStore;
  private readonly api: ConsoleApi;
  private readonly url: string;
  private readonly socketFactory: (url: string) => SocketLike;
  private readonly random: () => number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly hydrator: Hydrator;
  private socket: SocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private attempt = 0;
  private stopped = false;
  private hydratedFor = new Set<string>();
  private pendingDeltas: Array<{ thread: string; frame: RawFrame }> = [];
  private flushHandle: ReturnType<typeof setTimeout> | number | null = null;
  private lastHydrate = new Map<string, number>();
  private hydrateTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: ClientOptions) {
    this.store = options.store;
    this.api = options.api ?? new HttpApi();
    this.url =
      options.url ??
      (typeof location !== "undefined"
        ? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`
        : "ws://127.0.0.1:8787/ws");
    this.socketFactory =
      options.socketFactory ??
      ((target) => new WebSocket(target) as unknown as SocketLike);
    this.random = options.random ?? Math.random;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 400;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 8000;
    this.hydrator = new Hydrator({
      send: (threadId, frame) => {
        this.sendCommand(threadId, frame);
      },
    });
    this.hydrator.onRetry = (threadId, attempt) => {
      if (attempt > 1) {
        this.store.addNotice("info", "omp is busy; retrying transcript hydration");
        void threadId;
      }
    };
  }

  async start(): Promise<void> {
    const tasks: Promise<unknown>[] = [this.loadInfo(), this.loadThreads(), this.loadRecent()];
    await Promise.allSettled(tasks);
    this.connect();
  }

  async loadInfo(): Promise<InfoResponse | null> {
    try {
      const info = await this.api.info();
      this.store.setInfo(info);
      return info;
    } catch {
      return null;
    }
  }

  async loadThreads(): Promise<ThreadInfo[]> {
    try {
      const threads = await this.api.threads();
      this.store.setThreads(threads);
      return threads;
    } catch {
      return [];
    }
  }

  async loadRecent(cwd?: string): Promise<RecentSession[]> {
    try {
      const recent = await this.api.recent(cwd, 50);
      this.store.setRecent(recent);
      return recent;
    } catch {
      return [];
    }
  }

  browseFs(path?: string): Promise<FsListing> {
    return this.api.fs(path);
  }

  async createThread(body: CreateThreadBody): Promise<ThreadInfo | null> {
    try {
      const thread = await this.api.createThread(body);
      this.store.dispatch({ op: "thread", thread });
      this.selectThread(thread.id);
      return thread;
    } catch (error) {
      this.store.addNotice("error", error instanceof Error ? error.message : "could not start session");
      return null;
    }
  }

  async deleteThread(id: string): Promise<void> {
    try {
      await this.api.deleteThread(id);
      this.store.dispatch({ op: "thread_removed", id });
    } catch (error) {
      this.store.addNotice("error", error instanceof Error ? error.message : "could not close session");
    }
  }

  selectThread(id: string): void {
    const alreadySelected = this.store.getState().selected === id;
    this.store.setSelected(id);
    if (alreadySelected) return;
    this.hydratedFor.delete(id);
    if (this.socket?.readyState === OPEN) {
      this.send({ op: "view", thread: id });
      const session = this.store.session(id);
      if (session?.meta?.status !== "starting") this.requestHydration(id);
    }
    void this.loadRecent(this.store.session(id)?.meta?.cwd);
  }

  sendCommand(threadId: string, frame: { type: string; [key: string]: unknown }): boolean {
    if (!ALLOWED_CLIENT_COMMANDS[frame.type]) {
      this.store.addNotice("error", `command not enabled in this console: ${frame.type}`);
      return false;
    }
    return this.send({ op: "command", thread: threadId, frame });
  }

  stopThread(threadId: string): void {
    this.sendCommand(threadId, { type: "abort" });
  }

  requestHydration(threadId: string, force = false): void {
    if (!force && this.hydratedFor.has(threadId)) return;
    this.hydratedFor.add(threadId);
    if (force) {
      const now = Date.now();
      const last = this.lastHydrate.get(threadId) ?? 0;
      if (this.hydrator.isPending(threadId) || now - last < 1000) {
        if (!this.hydrateTimers.has(threadId)) {
          const delay = Math.max(50, 1000 - (now - last));
          this.hydrateTimers.set(
            threadId,
            setTimeout(() => {
              this.hydrateTimers.delete(threadId);
              this.requestHydration(threadId, true);
            }, delay),
          );
        }
        return;
      }
      this.lastHydrate.set(threadId, now);
    }
    this.hydrator.hydrate(threadId);
  }

  connect(): void {
    if (this.stopped) return;
    this.store.setConnection("connecting");
    let socket: SocketLike;
    try {
      socket = this.socketFactory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.hydratedFor.clear();
      this.store.setConnection("open");
      this.startPing();
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onclose = () => {
      this.clearPing();
      this.store.setConnection("closed");
      this.socket = null;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      this.store.setConnection("closed");
    };
  }

  dispose(): void {
    this.stopped = true;
    this.clearPing();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.hydrator.dispose();
    for (const timer of this.hydrateTimers.values()) clearTimeout(timer);
    this.hydrateTimers.clear();
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = null;
  }

  private send(payload: unknown): boolean {
    if (this.socket?.readyState !== OPEN) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  private onMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : JSON.parse(String(data));
    } catch {
      this.store.addNotice("warn", "dropped a malformed server message");
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const envelope = parsed as Envelope;
    if (typeof envelope.op !== "string") return;
    if (envelope.op === "frame") {
      this.ingestFrame(envelope.thread, envelope.frame);
      return;
    }
    this.flushDeltas();
    this.store.dispatch(envelope);
    switch (envelope.op) {
      case "lagged": {
        this.requestHydration(envelope.thread, true);
        break;
      }
      case "thread_removed": {
        this.hydratedFor.delete(envelope.id);
        break;
      }
      case "hello": {
        const selected = this.store.getState().selected;
        if (selected) {
          this.send({ op: "view", thread: selected });
          if (envelope.threads.find((thread) => thread.id === selected)?.status !== "starting") {
            this.requestHydration(selected);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  /** Coalesce streaming deltas to at most one update per animation frame. */
  private ingestFrame(thread: string, frame: RawFrame): void {
    const event = frame.type === "message_update" ? (frame.assistantMessageEvent as { type?: string } | undefined) : undefined;
    const deltaType = event?.type;
    const coalescable =
      deltaType === "text_delta" || deltaType === "thinking_delta" || deltaType === "toolcall_delta";
    if (!coalescable) {
      this.flushDeltas();
      this.store.dispatchFrame(thread, frame);
      this.hydrator.observe(thread, frame);
      if (frame.type === "ready" && thread === this.store.getState().selected) {
        this.requestHydration(thread);
      }
      return;
    }
    const last = this.pendingDeltas[this.pendingDeltas.length - 1];
    if (last && last.thread === thread && last.frame.messageId === frame.messageId) {
      const lastEvent = last.frame.assistantMessageEvent as { type?: string; contentIndex?: number; delta?: string };
      if (
        lastEvent.type === deltaType &&
        lastEvent.contentIndex === (event as { contentIndex?: number }).contentIndex
      ) {
        last.frame = {
          ...last.frame,
          assistantMessageEvent: {
            ...(last.frame.assistantMessageEvent as Record<string, unknown>),
            delta: `${lastEvent.delta ?? ""}${String((event as { delta?: string }).delta ?? "")}`,
          },
        };
        return;
      }
    }
    this.pendingDeltas.push({ thread, frame });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== null) return;
    const run = () => {
      this.flushHandle = null;
      this.flushDeltas();
    };
    if (typeof requestAnimationFrame === "function") {
      this.flushHandle = requestAnimationFrame(run);
    } else {
      this.flushHandle = setTimeout(run, 16);
    }
  }

  private flushDeltas(): void {
    if (this.flushHandle !== null) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.flushHandle as number);
      else clearTimeout(this.flushHandle as ReturnType<typeof setTimeout>);
      this.flushHandle = null;
    }
    if (this.pendingDeltas.length === 0) return;
    const pending = this.pendingDeltas;
    this.pendingDeltas = [];
    for (const entry of pending) this.store.dispatchFrame(entry.thread, entry.frame);
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      this.send({ op: "ping" });
    }, 25_000);
  }

  private clearPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const raw = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.attempt);
    const delay = Math.round(raw * (0.5 + this.random() * 0.5));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
