import { describe, expect, it, vi } from "vitest";
import { ConsoleStore } from "./store";
import { makeThread } from "../test/fixtures";

function makeStore() {
  const store = new ConsoleStore({ coalesce: false });
  store.dispatch({ op: "hello", version: "1.0.0", protocol: 1, threads: [makeThread()] });
  return store;
}

describe("normalized store subscriptions", () => {
  it("wakes only the streaming row, not the root or sibling rows", () => {
    const store = makeStore();
    store.dispatchFrame("thread-1", {
      type: "message_start",
      messageId: "m1",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    });
    store.dispatchFrame("thread-1", {
      type: "message_start",
      messageId: "m2",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    });
    store.flush();
    const root = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(root);
    store.subscribeRow("thread-1", "m1", first);
    store.subscribeRow("thread-1", "m2", second);
    store.dispatchFrame("thread-1", {
      type: "message_update",
      messageId: "m1",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tok" },
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(root).not.toHaveBeenCalled();
  });

  it("notifies the root when the row list changes", () => {
    const store = makeStore();
    const root = vi.fn();
    store.subscribe(root);
    store.dispatchFrame("thread-1", {
      type: "message_start",
      messageId: "m1",
      message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
    });
    expect(root).toHaveBeenCalledTimes(1);
    expect(store.row("thread-1", "m1")?.role).toBe("user");
  });

  it("coalesces many dispatches into one scheduled flush", () => {
    let scheduled: (() => void) | null = null;
    const store = new ConsoleStore({ coalesce: true, schedule: (callback) => (scheduled = callback) });
    store.dispatch({ op: "hello", version: "1.0.0", protocol: 1, threads: [makeThread()] });
    const root = vi.fn();
    store.subscribe(root);
    store.dispatchFrame("thread-1", { type: "turn_start" });
    store.dispatchFrame("thread-1", { type: "agent_start" });
    expect(root).not.toHaveBeenCalled();
    expect(scheduled).not.toBeNull();
    (scheduled as unknown as () => void)();
    expect(root).toHaveBeenCalledTimes(1);
  });

  it("tracks selection and thread removal", () => {
    const store = makeStore();
    expect(store.getState().selected).toBe("thread-1");
    store.dispatch({ op: "thread_removed", id: "thread-1" });
    expect(store.getState().selected).toBeNull();
    expect(store.getState().sessions["thread-1"]).toBeUndefined();
  });

  it("resolves dialogs and records field answers", () => {
    const store = makeStore();
    store.dispatchFrame("thread-1", {
      type: "extension_ui_request",
      id: "d1",
      method: "select",
      title: "Which color?",
      options: ["Red", "Blue", "Other (type your own)"],
    });
    store.resolveDialog("thread-1", "d1", "answered", "Red");
    store.recordFieldAnswer("thread-1", "Which color?", "Red");
    const session = store.session("thread-1");
    expect(session?.dialogs[0]?.status).toBe("answered");
    expect(session?.fieldAnswers).toEqual([{ question: "Which color?", answer: "Red" }]);
  });
});
