import { describe, expect, it, vi } from "vitest";
import type { AppState, RawFrame } from "./types";
import { bootState, makeThread } from "../test/fixtures";
import { hydrateMessages } from "../protocol/hydrate";
import { reduceFrame } from "../protocol/reduce";
import { cloneThread } from "../protocol/records";
import { removeQueuedFrame, promoteQueuedFrame, promptFrame, firstPromptTitle, deriveSessionTitle } from "../store/commands";
import { ConsoleStore } from "../store/store";
import { Hydrator } from "../store/hydrator";

function apply(state: AppState, frames: RawFrame[]): AppState {
  let next = state;
  for (const frame of frames) next = reduceFrame(next, frame, "thread-1");
  return next;
}

function session(state: AppState) {
  return state.sessions["thread-1"];
}

describe("stream reduction", () => {
  it("appends text deltas to chunks and only materializes on text_end", () => {
    const state = apply(bootState(), [
      { type: "turn_start" },
      { type: "message_start", messageId: "a1", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
      { type: "message_update", messageId: "a1", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      { type: "message_update", messageId: "a1", assistantMessageEvent: { type: "text_delta", delta: "hello " } },
      { type: "message_update", messageId: "a1", assistantMessageEvent: { type: "text_delta", delta: "world" } },
    ]);
    const block = session(state).messages["a1"].blocks[0];
    expect(block.kind).toBe("text");
    if (block.kind !== "text") throw new Error("expected text");
    expect(block.text).toBe("");
    expect(block.chunks).toEqual(["hello ", "world"]);
    expect(block.streaming).toBe(true);

    const ended = apply(state, [
      { type: "message_update", messageId: "a1", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hello world" } },
    ]);
    const final = session(ended).messages["a1"].blocks[0];
    if (final.kind !== "text") throw new Error("expected text");
    expect(final.text).toBe("hello world");
    expect(final.chunks).toEqual([]);
    expect(final.streaming).toBe(false);
  });

  it("handles a re-start without losing or duplicating text", () => {
    const state = apply(bootState(), [
      { type: "turn_start" },
      { type: "message_start", messageId: "a2", message: { role: "assistant", content: [] } },
      { type: "message_update", messageId: "a2", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      { type: "message_update", messageId: "a2", assistantMessageEvent: { type: "text_delta", delta: "abc" } },
      { type: "message_update", messageId: "a2", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "abc" } },
      { type: "message_update", messageId: "a2", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      { type: "message_update", messageId: "a2", assistantMessageEvent: { type: "text_delta", delta: "def" } },
      { type: "message_update", messageId: "a2", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "abcdef" } },
    ]);
    const block = session(state).messages["a2"].blocks[0];
    if (block.kind !== "text") throw new Error("expected text");
    expect(block.text).toBe("abcdef");
    expect(block.chunks).toEqual([]);
  });

  it("merges full message updates as a fallback", () => {
    const state = apply(bootState(), [
      { type: "turn_start" },
      { type: "message_start", messageId: "a3", message: { role: "assistant", content: [] } },
      {
        type: "message_update",
        messageId: "a3",
        message: { role: "assistant", content: [{ type: "text", text: "full text" }] },
      },
    ]);
    const blocks = session(state).messages["a3"].blocks;
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "text") throw new Error("expected text");
    expect(blocks[0].text).toBe("full text");
  });

  it("accumulates tool partials and execution output", () => {
    const state = apply(bootState(), [
      { type: "turn_start" },
      { type: "message_start", messageId: "t1", message: { role: "assistant", content: [] } },
      {
        type: "message_update",
        messageId: "t1",
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          block: { type: "toolCall", id: "call-1", name: "bash", arguments: {}, partialArgs: "" },
        },
      },
      {
        type: "message_update",
        messageId: "t1",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":' },
      },
      {
        type: "message_update",
        messageId: "t1",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '"ls"}' },
      },
      {
        type: "message_update",
        messageId: "t1",
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" }, partialArgs: '{"command":"ls"}' },
        },
      },
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } },
      { type: "tool_execution_update", toolCallId: "call-1", partialResult: { content: [{ type: "text", text: "a" }] } },
      { type: "tool_execution_update", toolCallId: "call-1", partialResult: { content: [{ type: "text", text: "a\nb" }] } },
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        result: { content: [{ type: "text", text: "a\nb" }], details: { wallTimeMs: 12 } },
        isError: false,
      },
    ]);
    const block = session(state).messages["t1"].blocks[0];
    if (block.kind !== "tool") throw new Error("expected tool");
    expect(block.args).toEqual({ command: "ls" });
    expect(block.partialArgs).toBe('{"command":"ls"}');
    expect(block.output).toBe("a\nb");
    expect(block.state).toBe("done");
    expect(block.durationMs).toBe(12);
    expect(block.streaming).toBe(false);
  });

  it("compacts the message count from agent_end", () => {
    const state = apply(bootState(), [
      {
        type: "agent_end",
        messages: [{ role: "user" }, { role: "assistant" }, { role: "toolResult" }, { role: "assistant" }],
      },
    ]);
    expect(session(state).messageCount).toBe(4);
    expect(session(state).stats.totalMessages).toBe(4);
  });
});

describe("hydration", () => {
  it("keeps duplicate-timestamp rows distinct and merges live identity", () => {
    const state = bootState();
    const thread = cloneThread(state.sessions["thread-1"]);
    hydrateMessages(thread, [
      { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "two" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: 2000 },
    ]);
    expect(thread.rows).toHaveLength(3);
    expect(new Set(thread.rows).size).toBe(3);
  });

  it("does not duplicate a streamed message that also appears in history", () => {
    let state = apply(bootState(), [
      { type: "turn_start" },
      {
        type: "message_start",
        messageId: "live-1",
        message: { role: "assistant", content: [{ type: "text", text: "hel" }], timestamp: 2000 },
      },
      { type: "message_end", messageId: "live-1", message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2000 } },
    ]);
    const before = session(state).rows.length;
    state = apply(state, [
      {
        type: "response",
        command: "get_messages",
        success: true,
        data: {
          messages: [
            { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1000 },
            { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2000 },
          ],
        },
      },
    ]);
    const rows = session(state).rows;
    expect(rows).toHaveLength(before + 1);
    expect(session(state).messages["live-1"]).toBeDefined();
    expect(rows.filter((key) => session(state).messages[key].role === "assistant")).toHaveLength(1);
  });
});

describe("queue control", () => {
  it("builds removal without image payloads and keeps queue parsing", () => {
    const item = {
      id: "q1",
      kind: "followUp" as const,
      text: "next",
      images: [{ mimeType: "image/jpeg", data: "abc" }],
    };
    const removal = removeQueuedFrame(item);
    expect(removal).toEqual({ type: "remove_queued_message", message: "next", queue: "followUp" });
    expect("images" in removal).toBe(false);
    expect(promoteQueuedFrame(item)).toEqual({ type: "promote_queued_message", message: "next" });
  });

  it("aborts and restores the queue into the composer", () => {
    const store = new ConsoleStore({ coalesce: false });
    store.dispatch({ op: "hello", version: "1.0.0", protocol: 1, threads: [makeThread()] });
    store.dispatchFrame("thread-1", {
      type: "queue_update",
      steering: [{ message: "first", images: [{ type: "image", mimeType: "image/jpeg", data: "a" }] }],
      followUp: [{ message: "second" }],
    });
    const send = vi.fn();
    const restored = store.abortAndRestoreQueue("thread-1", send);
    expect(send).toHaveBeenCalledWith({ type: "abort_and_restore_queue" });
    expect(restored.text).toBe("first\n\nsecond");
    expect(restored.images).toEqual([{ mimeType: "image/jpeg", data: "a" }]);
    expect(store.session("thread-1")?.queue.steering).toEqual([]);
    expect(store.session("thread-1")?.queue.followUp).toEqual([]);
  });

  it("removes queued images when the child reports the new queue", () => {
    const store = new ConsoleStore({ coalesce: false });
    store.dispatch({ op: "hello", version: "1.0.0", protocol: 1, threads: [makeThread()] });
    store.dispatchFrame("thread-1", {
      type: "queue_update",
      steering: [{ message: "with image", images: [{ type: "image", mimeType: "image/jpeg", data: "a" }] }],
      followUp: [],
    });
    expect(store.session("thread-1")?.queue.steering[0]?.images).toHaveLength(1);
    store.dispatchFrame("thread-1", { type: "queue_update", steering: [], followUp: [] });
    expect(store.session("thread-1")?.queue.steering).toHaveLength(0);
  });

  it("derives a 72-character session title for the first prompt", () => {
    const long = "  Fix   the   thing\n" + "x".repeat(100);
    expect(deriveSessionTitle(long).length).toBe(72);
    expect(deriveSessionTitle("  hello\n\tworld ")).toBe("hello world");
    expect(firstPromptTitle("  Fix the build  ")).toEqual({ type: "set_session_name", name: "Fix the build" });
    expect(firstPromptTitle("/model")).toBeNull();
    expect(firstPromptTitle("   ")).toBeNull();
  });

  it("builds prompt, steer and follow-up frames", () => {
    expect(promptFrame("hi", [], "send")).toEqual({ type: "prompt", message: "hi" });
    expect(promptFrame("hi", [], "steer")).toEqual({ type: "steer", message: "hi" });
    expect(promptFrame("hi", [], "queue")).toEqual({ type: "follow_up", message: "hi" });
  });
});

describe("session_busy hydration retry", () => {
  it("retries get_messages with backoff instead of dropping it", () => {
    vi.useFakeTimers();
    const sent: { threadId: string; frame: RawFrame }[] = [];
    const hydrator = new Hydrator({ send: (threadId, frame) => sent.push({ threadId, frame }), random: () => 0.5 });
    hydrator.hydrate("thread-1");
    const initial = sent.filter((entry) => entry.frame.type === "get_messages");
    expect(initial).toHaveLength(1);
    hydrator.observe("thread-1", {
      type: "response",
      command: "get_messages",
      success: false,
      code: "session_busy",
      error: "session is busy",
    });
    expect(hydrator.retryCount("thread-1")).toBe(1);
    vi.advanceTimersByTime(300);
    expect(sent.filter((entry) => entry.frame.type === "get_messages")).toHaveLength(2);
    hydrator.observe("thread-1", { type: "response", command: "get_messages", success: true });
    expect(hydrator.isPending("thread-1")).toBe(false);
    expect(hydrator.retryCount("thread-1")).toBe(0);
    vi.useRealTimers();
  });

  it("still sends the full hydration set exactly once for catalog commands", () => {
    const sent: RawFrame[] = [];
    const hydrator = new Hydrator({ send: (_thread, frame) => sent.push(frame) });
    hydrator.hydrate("t");
    hydrator.hydrate("t");
    const commands = sent.map((frame) => frame.type);
    expect(commands.filter((type) => type === "get_available_models")).toHaveLength(1);
    expect(commands.filter((type) => type === "get_available_commands")).toHaveLength(1);
    expect(commands.filter((type) => type === "get_state")).toHaveLength(2);
  });
});
