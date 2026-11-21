import { describe, expect, it, vi, afterEach } from "vitest";
import { ConsoleClient, type SocketLike } from "./client";
import { ConsoleStore } from "./store";
import { makeThread } from "../test/fixtures";

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.onopen?.();
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function setup() {
  const store = new ConsoleStore({ coalesce: false });
  store.dispatch({ op: "hello", version: "1.0.0", protocol: 1, threads: [makeThread()] });
  const sockets: FakeSocket[] = [];
  const client = new ConsoleClient({
    store,
    api: {
      info: async () => {
        throw new Error("not used");
      },
      threads: async () => [],
      createThread: async () => makeThread(),
      deleteThread: async () => undefined,
      stderr: async () => [],
      recent: async () => [],
      fs: async () => ({ path: "/", parent: null, entries: [] }),
    },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
    reconnectBaseMs: 100,
  });
  return { store, client, sockets };
}

function hello(socket: FakeSocket) {
  socket.receive({ op: "hello", version: "1.0.0", protocol: 1, threads: [makeThread()] });
}

function frames(socket: FakeSocket) {
  return socket.sent.map((entry) => JSON.parse(entry) as { op: string; thread?: string; frame?: { type: string } });
}

describe("console client", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("views the selected session and hydrates on open", () => {
    const { client, sockets } = setup();
    client.connect();
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    expect(frames(sockets[0])).toEqual([]);
    hello(sockets[0]);
    const sent = frames(sockets[0]);
    expect(sent[0]).toEqual({ op: "view", thread: "thread-1" });
    const commands = sent.filter((entry) => entry.op === "command").map((entry) => entry.frame?.type);
    expect(commands).toContain("get_state");
    expect(commands).toContain("get_messages");
    client.dispose();
  });

  it("reconnects with backoff and re-views", () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.connect();
    sockets[0].open();
    hello(sockets[0]);
    sockets[0].onclose?.();
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    hello(sockets[1]);
    expect(frames(sockets[1])[0]).toEqual({ op: "view", thread: "thread-1" });
    client.dispose();
  });

  it("sends allowlisted commands and rejects the rest", () => {
    const { client, sockets, store } = setup();
    client.connect();
    sockets[0].open();
    hello(sockets[0]);
    sockets[0].sent.length = 0;
    expect(client.sendCommand("thread-1", { type: "prompt", message: "hi" })).toBe(true);
    expect(client.sendCommand("thread-1", { type: "bash", command: "ls" })).toBe(false);
    expect(store.getState().notices.some((notice) => notice.message.includes("bash"))).toBe(true);
    expect(frames(sockets[0]).some((entry) => entry.op === "command" && entry.frame?.type === "prompt")).toBe(true);
    client.dispose();
  });

  it("retries hydration after a session_busy get_messages", () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.connect();
    sockets[0].open();
    hello(sockets[0]);
    sockets[0].receive({
      op: "frame",
      thread: "thread-1",
      frame: { type: "response", command: "get_messages", success: false, code: "session_busy", error: "session is busy" },
    });
    sockets[0].sent.length = 0;
    vi.advanceTimersByTime(400);
    const types = frames(sockets[0]).map((entry) => entry.frame?.type);
    expect(types).toContain("get_messages");
    client.dispose();
  });
});
