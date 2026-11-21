import { useState } from "react";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { StoreProvider } from "../store/hooks";
import { ConsoleStore } from "../store/store";
import { makeThread, loadFixture } from "../test/fixtures";
import { Dialogs } from "./Dialogs";
import { Composer } from "./Composer";
import { PlanPanel } from "./PlanPanel";
import { SettingsSheet } from "./SettingsSheet";
import { useTheme } from "./hooks";
import type { DialogRecord, ThreadRuntime } from "../protocol/types";
import { emptyThread } from "../protocol/state";

function storeWith(frames: import("../protocol/types").RawFrame[] = []) {
  const store = new ConsoleStore({ coalesce: false });
  store.dispatch({ op: "hello", version: "1.0.0", protocol: 1, threads: [makeThread()] });
  if (frames.length > 0) store.pushFrames("thread-1", frames);
  return store;
}

function renderApp(store: ConsoleStore) {
  return render(
    <StoreProvider store={store}>
      <App clientOverride={null} />
    </StoreProvider>,
  );
}

const TOOL_FRAMES: import("../protocol/types").RawFrame[] = [
  { type: "turn_start" },
  { type: "message_start", messageId: "u1", message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1000 } },
  { type: "message_end", messageId: "u1", message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1000 } },
  { type: "message_start", messageId: "a1", message: { role: "assistant", content: [] } },
  {
    type: "message_update",
    messageId: "a1",
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  },
  {
    type: "message_update",
    messageId: "a1",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Running the command." },
  },
  {
    type: "message_update",
    messageId: "a1",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Running the command." },
  },
  {
    type: "message_update",
    messageId: "a1",
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 1,
      block: { type: "toolCall", id: "call-1", name: "bash", arguments: {}, partialArgs: "" },
    },
  },
  {
    type: "message_update",
    messageId: "a1",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" }, partialArgs: '{"command":"echo hi"}' },
    },
  },
  { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo hi" } },
  { type: "tool_execution_update", toolCallId: "call-1", partialResult: { content: [{ type: "text", text: "hi" }] } },
  { type: "tool_execution_end", toolCallId: "call-1", result: { content: [{ type: "text", text: "hi" }], details: { wallTimeMs: 12 } } },
];

describe("transcript lanes", () => {
  it("renders lanes and expands a tool row", async () => {
    const user = userEvent.setup();
    renderApp(storeWith(TOOL_FRAMES));
    expect(screen.getByText("you")).toBeInTheDocument();
    expect(screen.getByText("omp")).toBeInTheDocument();
    expect(screen.getByText("Running the command.")).toBeInTheDocument();
    const tool = screen.getByRole("button", { name: /bash/ });
    await user.click(tool);
    expect(screen.getByText("arguments")).toBeInTheDocument();
    expect(screen.getByText("output")).toBeInTheDocument();
    expect(screen.getAllByText("hi").length).toBeGreaterThan(0);
    expect(screen.getByText("12ms")).toBeInTheDocument();
  });

  it("surfaces unknown frames as a protocol row and opens the evidence drawer", async () => {
    const user = userEvent.setup();
    const store = storeWith([{ type: "future_thing", payload: { a: 1 } }]);
    const { container } = renderApp(store);
    expect(screen.getAllByText("protocol").length).toBeGreaterThan(0);
    expect(screen.getByText(/unknown frame/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /protocol/ }));
    const drawer = container.querySelector(".protocol-drawer");
    expect(drawer).not.toBeNull();
    expect(drawer?.textContent).toContain("future_thing");
    expect(drawer?.textContent).toContain("payload");
  });
});

describe("session rail", () => {
  it("drops a saved entry when hydration reveals it is the open session", () => {
    const thread = makeThread({ sessionFile: null, resume: null, sessionId: null });
    const store = new ConsoleStore({ coalesce: false });
    store.dispatch({ op: "hello", version: "1.0.0", protocol: 1, threads: [thread] });
    store.setRecent([
      { path: "/sessions/session-fixture.jsonl", id: null, title: "Fixture session", cwd: "/work/project", updatedAt: 1 },
    ]);
    const { container } = renderApp(store);
    expect(container.querySelectorAll('.rail-row[data-saved="true"]')).toHaveLength(1);
    act(() => {
      store.dispatchFrame("thread-1", {
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionFile: "/sessions/session-fixture.jsonl", sessionId: "ses_fixture_0001" },
      });
    });
    expect(container.querySelectorAll('.rail-row[data-saved="true"]')).toHaveLength(0);
  });

  it("does not list the currently-open session under saved history", () => {
    const store = storeWith();
    store.setRecent([
      { path: "/sessions/session-fixture.jsonl", id: null, title: "Fixture session", cwd: "/work/project", updatedAt: 1 },
      { path: "/sessions/other.jsonl", id: "ses_other", title: "Other session", cwd: "/work/other", updatedAt: 2 },
    ]);
    const { container } = renderApp(store);
    const saved = container.querySelectorAll('.rail-row[data-saved="true"]');
    expect(saved).toHaveLength(1);
    expect(saved[0].textContent).toContain("Other session");
  });
});

describe("read mode", () => {
  it("enters read mode and Escape restores it", async () => {
    const user = userEvent.setup();
    const { container } = renderApp(storeWith());
    const app = container.querySelector(".app");
    expect(app?.getAttribute("data-read")).toBe("false");
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Read mode" }));
    expect(app?.getAttribute("data-read")).toBe("true");
    expect(screen.getByRole("button", { name: "exit read" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(app?.getAttribute("data-read")).toBe("false");
    expect(screen.queryByRole("button", { name: "exit read" })).not.toBeInTheDocument();
  });
});

describe("approval sheet", () => {
  it("parses the title, numbers the options and answers with a number key", async () => {
    const store = storeWith(loadFixture("stream"));
    renderApp(store);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Allow bash?" })).toBeInTheDocument();
    expect(within(dialog).getByText("echo omp-console-fixture")).toBeInTheDocument();
    expect(within(dialog).getByText("1")).toBeInTheDocument();
    expect(within(dialog).getByText("2")).toBeInTheDocument();
    expect(within(dialog).getByText("3")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("option")[0]).toHaveFocus();
    fireEvent.keyDown(document, { key: "2" });
    await waitFor(() => {
      const dialogs = store.session("thread-1")?.dialogs ?? [];
      expect(dialogs.find((dialog) => dialog.request.id === "ui-approval-1")?.status).toBe("answered");
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Which color?" })).toBeInTheDocument();
    });
  });
});

function askSession(): ThreadRuntime {
  const session = emptyThread("thread-1");
  session.dialogs = [
    {
      status: "open",
      request: {
        id: "ask-1",
        method: "ask",
        title: "Setup",
        timeout: null,
        questions: [
          {
            id: "store",
            question: "Where should sessions live?",
            header: "Storage",
            options: [
              { label: "SQLite", description: "One file" },
              { label: "Redis", description: "Shared" },
            ],
            multi: false,
            recommended: 0,
          },
          {
            id: "extras",
            question: "Which extras?",
            options: [{ label: "Search" }, { label: "Export" }],
            multi: true,
          },
        ],
      },
    },
  ];
  return session;
}

describe("ask dialog", () => {
  it("sends rich answers in order and clears free text on single select", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Dialogs session={askSession()} onAnswer={onAnswer} />);
    await user.type(screen.getByLabelText(/Where should sessions live\? free text/), "custom");
    await user.click(screen.getByRole("option", { name: /SQLite/ }));
    await user.click(screen.getByRole("option", { name: /Search/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    const answer = onAnswer.mock.calls[0][1];
    expect(answer.answers).toEqual([
      { id: "store", selectedOptions: ["SQLite"] },
      { id: "extras", selectedOptions: ["Search"] },
    ]);
  });

  it("renders the field-by-field fallback with a real free-text field", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    const session = emptyThread("thread-1");
    session.dialogs = [
      {
        status: "open",
        request: {
          id: "field-1",
          method: "select",
          title: "Which color?",
          options: ["Red", "Blue", "Other (type your own)"],
          timeout: null,
          field: { index: 2, total: 5, previous: [{ question: "Size?", answer: "large" }] },
        },
      },
    ];
    render(<Dialogs session={session} onAnswer={onAnswer} />);
    expect(screen.getByText("field 2 of 5")).toBeInTheDocument();
    expect(screen.getByText("Size?: large")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Other \(type your own\)/ })).not.toBeInTheDocument();
    const free = screen.getByPlaceholderText("Other (type your own)");
    expect(free).toHaveFocus();
    await user.type(free, "Green{Enter}");
    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), { value: "Green" }, "Green");
  });
});

function composerSession(overrides: Partial<ThreadRuntime> = {}): ThreadRuntime {
  const session = emptyThread("thread-1");
  session.commands = [
    { name: "model", description: "Choose the active model", input: { hint: "<provider/model>" } },
    { name: "compact", description: "Compact the conversation context" },
  ];
  return Object.assign(session, overrides);
}

describe("composer", () => {
  it("sends on Enter but not during IME composition or Shift+Enter", () => {
    const onSend = vi.fn();
    render(
      <Composer
        threadId="thread-1"
        session={composerSession()}
        connected
        onSend={onSend}
        onStop={() => undefined}
        onLocalCommand={() => undefined}
        onEditorConsumed={() => undefined}
        onRestoredConsumed={() => undefined}
        restoredInput={null}
      />,
    );
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith({ type: "prompt", message: "hello" });
  });

  it("opens the slash palette, moves with arrows and accepts with Enter", () => {
    const onSend = vi.fn();
    render(
      <Composer
        threadId="thread-1"
        session={composerSession()}
        connected
        onSend={onSend}
        onStop={() => undefined}
        onLocalCommand={() => undefined}
        onEditorConsumed={() => undefined}
        onRestoredConsumed={() => undefined}
        restoredInput={null}
      />,
    );
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value.startsWith("/")).toBe(true);
  });

  it("stops the turn on Escape only when the draft is empty", () => {
    const onStop = vi.fn();
    render(
      <Composer
        threadId="thread-1"
        session={composerSession({ streaming: true })}
        connected
        onSend={() => undefined}
        onStop={onStop}
        onLocalCommand={() => undefined}
        onEditorConsumed={() => undefined}
        onRestoredConsumed={() => undefined}
        restoredInput={null}
      />,
    );
    const input = screen.getByTestId("composer-input");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("promotes a queued follow-up", () => {
    const onSend = vi.fn();
    const session = composerSession();
    session.queue = {
      steering: [],
      followUp: [{ id: "q2", kind: "followUp", text: "next up", images: [] }],
      liveSteered: 0,
    };
    render(
      <Composer
        threadId="thread-1"
        session={session}
        connected
        onSend={onSend}
        onStop={() => undefined}
        onLocalCommand={() => undefined}
        onEditorConsumed={() => undefined}
        onRestoredConsumed={() => undefined}
        restoredInput={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote queued message" }));
    expect(onSend).toHaveBeenCalledWith({ type: "promote_queued_message", message: "next up" });
  });

  it("restores withdrawn queued text and images into the draft", () => {
    const session = composerSession({ streaming: true });
    const onConsumed = vi.fn();
    const { rerender } = render(
      <Composer
        threadId="thread-1"
        session={session}
        connected
        onSend={() => undefined}
        onStop={() => undefined}
        onLocalCommand={() => undefined}
        onEditorConsumed={() => undefined}
        onRestoredConsumed={onConsumed}
        restoredInput={null}
      />,
    );
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "draft" } });
    rerender(
      <Composer
        threadId="thread-1"
        session={session}
        connected
        onSend={() => undefined}
        onStop={() => undefined}
        onLocalCommand={() => undefined}
        onEditorConsumed={() => undefined}
        onRestoredConsumed={onConsumed}
        restoredInput={{ id: 1, text: "queued text", images: [{ mimeType: "image/jpeg", data: "abc" }] }}
      />,
    );
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("draft\n\nqueued text");
    expect(screen.getByLabelText("Attachments")).toBeInTheDocument();
    expect(onConsumed).toHaveBeenCalled();
    rerender(
      <Composer
        threadId="thread-1"
        session={session}
        connected
        onSend={() => undefined}
        onStop={() => undefined}
        onLocalCommand={() => undefined}
        onEditorConsumed={() => undefined}
        onRestoredConsumed={onConsumed}
        restoredInput={{ id: 1, text: "queued text", images: [{ mimeType: "image/jpeg", data: "abc" }] }}
      />,
    );
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("draft\n\nqueued text");
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it("shows queue chips with a remove control", () => {
    const onSend = vi.fn();
    const session = composerSession();
    session.queue = {
      steering: [{ id: "q1", kind: "steer", text: "steer me", images: [] }],
      followUp: [{ id: "q2", kind: "followUp", text: "next up", images: [] }],
      liveSteered: 0,
    };
    render(
      <Composer
        threadId="thread-1"
        session={session}
        connected
        onSend={onSend}
        onStop={() => undefined}
        onLocalCommand={() => undefined}
        onEditorConsumed={() => undefined}
        onRestoredConsumed={() => undefined}
        restoredInput={null}
      />,
    );
    expect(screen.getByText("steer me")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove queued message" })[0]);
    expect(onSend).toHaveBeenCalledWith({ type: "remove_queued_message", message: "steer me", queue: "steering" });
  });
});

describe("first prompt titling", () => {
  it("sends set_session_name before the first prompt", () => {
    const store = new ConsoleStore({ coalesce: false });
    store.dispatch({
      op: "hello",
      version: "1.0.0",
      protocol: 1,
      threads: [makeThread({ sessionName: null })],
    });
    const sendCommand = vi.fn(() => true);
    const stub = {
      sendCommand,
      selectThread: vi.fn(),
      deleteThread: vi.fn(),
      browseFs: vi.fn(),
      createThread: vi.fn(),
      start: vi.fn(),
      dispose: vi.fn(),
    } as unknown as import("../store/client").ConsoleClient;
    render(
      <StoreProvider store={store}>
        <App clientOverride={stub} />
      </StoreProvider>,
    );
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "Fix the build please" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendCommand).toHaveBeenNthCalledWith(1, "thread-1", { type: "set_session_name", name: "Fix the build please" });
    expect(sendCommand).toHaveBeenNthCalledWith(2, "thread-1", { type: "prompt", message: "Fix the build please" });
  });
});

describe("settings sheet", () => {
  it("groups models by provider and sends set_model", async () => {
    const user = userEvent.setup();
    const store = storeWith(loadFixture("handshake"));
    const session = store.session("thread-1")!;
    const onCommand = vi.fn();
    render(
      <SettingsSheet
        session={session}
        onClose={() => undefined}
        onCommand={onCommand}
        theme="dark"
        onToggleTheme={() => undefined}
      />,
    );
    expect(screen.getByText("opencode-go")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Claude Sonnet 5/ }));
    expect(onCommand).toHaveBeenCalledWith({ type: "set_model", provider: "anthropic", modelId: "claude-sonnet-5" });
    await user.click(screen.getByRole("button", { name: "high" }));
    expect(onCommand).toHaveBeenCalledWith({ type: "set_thinking_level", level: "high" });
  });
});

describe("plan panel", () => {
  it("shows progress, tasks and blockers, then the empty state", () => {
    const phases = [
      {
        name: "Build",
        tasks: [
          { content: "Run the fixture", status: "completed" },
          { content: "Ask one question", status: "in_progress" },
          { content: "Report done", status: "blocked", blocked: "waiting for approval" },
        ],
      },
    ];
    const { rerender } = render(<PlanPanel phases={phases} onClose={() => undefined} />);
    expect(screen.getByText("1/3 done")).toBeInTheDocument();
    expect(screen.getByText("Run the fixture")).toBeInTheDocument();
    expect(screen.getByText(/blocked · waiting for approval/)).toBeInTheDocument();
    rerender(<PlanPanel phases={[]} onClose={() => undefined} />);
    expect(screen.getByText("No plan yet")).toBeInTheDocument();
  });
});

describe("theme and focus", () => {
  it("toggles the theme attribute and persists it", async () => {
    function Harness() {
      const { theme, toggle } = useTheme();
      return (
        <button type="button" onClick={toggle}>
          {theme}
        </button>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByRole("button", { name: "dark" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("omp-console.theme")).toBe("light");
  });

  it("traps focus in a sheet and restores it on close", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            open settings
          </button>
          {open ? (
            <SettingsSheet
              session={composerSession()}
              onClose={() => setOpen(false)}
              onCommand={() => undefined}
              theme="dark"
              onToggleTheme={() => undefined}
            />
          ) : null}
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "open settings" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });
});

describe("dialog answers", () => {
  it("returns the safe default for confirm and never focuses Yes first", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    const session = emptyThread("thread-1");
    session.dialogs = [
      {
        status: "open",
        request: { id: "confirm-1", method: "confirm", title: "Delete the draft?", message: "Cannot be undone.", timeout: null },
      },
    ];
    render(<Dialogs session={session} onAnswer={onAnswer} />);
    expect(screen.getByRole("button", { name: "No" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(onAnswer).toHaveBeenCalledWith(expect.anything(), { confirmed: false }, "no");
  });
});

export type { DialogRecord };
