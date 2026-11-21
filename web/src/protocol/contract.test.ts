// @vitest-environment node
import { describe, expect, it } from "vitest";
import { reduceEnvelope, replay } from "../protocol/reduce";
import { visibleRows } from "../store/selectors";
import { OTHER_OPTION } from "../protocol/dialogs";
import { ALLOWED_CLIENT_COMMANDS } from "../store/commands";
import { loadFixture, bootState } from "../test/fixtures";

function run(name: string) {
  const frames = loadFixture(name);
  let state = bootState();
  for (const frame of frames) {
    state = reduceEnvelope(state, { op: "frame", thread: "thread-1", frame });
  }
  return { state, session: state.sessions["thread-1"], frames };
}

describe("fixture replay — stream.jsonl", () => {
  it("renders the lanes, folds tool results, and keeps the dialogs", () => {
    const { session } = run("stream");
    const rows = visibleRows(session);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "system", "assistant", "system", "system"]);
    expect(session.turn).toBe(2);
    expect(session.streaming).toBe(false);
    expect(session.settled).toBe(true);

    const assistant = session.messages["msg-2"];
    expect(assistant).toBeDefined();
    const text = assistant.blocks.find((block) => block.kind === "text");
    expect(text?.kind === "text" && text.text).toBe("I'll run the command and ask the question.");
    const tools = assistant.blocks.filter((block) => block.kind === "tool");
    expect(tools).toHaveLength(2);
    const bash = tools.find((block) => block.kind === "tool" && block.callId === "call_fixture_1");
    expect(bash?.kind === "tool" && bash.state).toBe("done");
    expect(bash?.kind === "tool" && bash.output).toBe("omp-console-fixture\n");
    expect(bash?.kind === "tool" && bash.durationMs).toBe(277.8);

    const open = session.dialogs.filter((dialog) => dialog.status === "open");
    expect(open.map((dialog) => dialog.request.id)).toEqual(["ui-approval-1", "ui-field-1"]);
    const approval = open[0].request;
    expect(approval.approval).toEqual({ tool: "bash", command: "echo omp-console-fixture", heading: "Allow bash?" });
    expect(open[1].request.options).toContain(OTHER_OPTION);
    expect(open[1].request.field?.previous).toEqual([]);

    const final = session.messages["msg-5"];
    const finalText = final.blocks.find((block) => block.kind === "text");
    expect(finalText?.kind === "text" && finalText.text).toBe("DONE");
    expect(finalText?.kind === "text" && finalText.chunks).toEqual([]);

    const turnRows = session.rows.filter((key) => session.messages[key]?.system?.label === "turn");
    expect(turnRows).toHaveLength(2);
    expect(session.stats.assistantMessages).toBe(2);
    expect(session.stats.userMessages).toBe(1);
    expect(session.agentActive).toBe(false);
  });

  it("stays idempotent when the ring is replayed twice (duplicate view)", () => {
    const frames = loadFixture("stream");
    const once = replay(bootState(), "thread-1", frames);
    const twice = replay(once, "thread-1", frames);
    const session = twice.sessions["thread-1"];
    const turnRows = session.rows.filter((key) => session.messages[key]?.system?.label === "turn");
    expect(turnRows).toHaveLength(2);
    expect(session.turn).toBe(2);
    expect(session.rows.filter((key) => session.messages[key]?.role === "assistant")).toHaveLength(2);
  });

  it("is deterministic when replayed twice", () => {
    const a = run("stream").session;
    const b = run("stream").session;
    expect(JSON.stringify(visibleRows(b))).toBe(JSON.stringify(visibleRows(a)));
  });
});

describe("fixture replay — handshake.jsonl", () => {
  it("applies state, stats, models, levels and commands", () => {
    const { session } = run("handshake");
    expect(session.model?.id).toBe("deepseek-v4.1-flash");
    expect(session.model?.contextWindow).toBe(1_000_000);
    expect(session.thinkingLevel).toBe("off");
    expect(session.models.map((model) => model.id)).toEqual(["deepseek-v4.1-flash", "claude-sonnet-5"]);
    expect(session.levels).toEqual(["off", "low", "high", "max"]);
    expect(session.commands).toHaveLength(3);
    expect(session.todoPhases[0]?.tasks.map((task) => task.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(session.stats.tokens.total).toBe(18_710);
    expect(session.stats.contextUsage?.percent).toBeCloseTo(0.9371);
    expect(session.hydration.state).toBe(true);
    expect(session.hydration.stats).toBe(true);
    expect(session.hydration.models).toBe(true);
    expect(session.hydration.levels).toBe(true);
    expect(session.hydration.commands).toBe(true);
    expect(session.autoCompaction).toBe(true);
    expect(session.sessionName).toBe("Fixture session");
    expect(session.protocolLog.some((entry) => entry.message.includes("child ready"))).toBe(true);
  });
});

describe("fixture replay — resume.jsonl", () => {
  it("hydrates history and keeps both same-role rows distinct", () => {
    const { session } = run("resume");
    expect(session.hydration.messages).toBe(true);
    expect(session.hydration.busy).toBe(false);
    const history = session.rows
      .map((key) => session.messages[key])
      .filter((record) => record.role !== "system");
    expect(history).toHaveLength(5);
    expect(history.map((record) => record.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "assistant",
    ]);
    expect(new Set(history.map((record) => record.key)).size).toBe(5);
    expect(visibleRows(session).map((record) => record.role)).toEqual(["user", "assistant", "assistant"]);
    expect(session.stats.cost).toBeCloseTo(0.001553814);
    expect(session.toolOwners["call_fixture_1"]?.key).toBe(history[1].key);
  });
});

describe("fixture replay — dialogs.jsonl", () => {
  it("stores every dialog method and applies extension side effects", () => {
    const { session } = run("dialogs");
    const byId = new Map(session.dialogs.map((dialog) => [dialog.request.id, dialog]));
    expect(byId.get("ui-select-1")?.request.options).toEqual(["One", "Two"]);
    expect(byId.get("ui-confirm-1")?.request.message).toBe("This cannot be undone.");
    expect(byId.get("ui-input-1")?.request.secret).toBe(true);
    expect(byId.get("ui-editor-1")?.request.prefill).toBe("Draft text");
    expect(byId.get("ui-ask-1")?.request.questions).toHaveLength(2);
    expect(byId.get("ui-ask-1")?.request.questions?.[1].multi).toBe(true);
    expect(byId.get("ui-select-1")?.status).toBe("resolved");
    expect(session.statuses).toEqual([{ key: "lint", text: "Running…" }]);
    expect(session.widgets[0]?.lines).toEqual(["build   running", "test    queued"]);
    expect(session.title).toBe("Fixture session");
    expect(session.editorText).toBe("Prefilled draft");
    expect(session.notifications[0]?.message).toBe("Compaction finished");
    const link = session.rows.map((key) => session.messages[key]).find((record) => record.system?.label === "link");
    expect(link?.system?.body).toContain("https://example.test/authorize");
    const open = session.dialogs.filter((dialog) => dialog.status === "open");
    expect(open.map((dialog) => dialog.request.method)).toEqual(["confirm", "input", "editor", "ask"]);
  });
});

describe("fixture replay — unknown.jsonl", () => {
  it("surfaces unknown evidence and never throws", () => {
    const { session } = run("unknown");
    expect(session.unknown.total).toBe(2);
    expect(session.unknown.counts.future_frame_kind).toBe(1);
    expect(session.unknown.counts.rpc_frame_error).toBe(1);
    expect(session.unknown.ring).toHaveLength(2);
    expect(session.unknown.loggedTypes).toEqual(["future_frame_kind", "rpc_frame_error"]);
    expect(session.protocolLog.length).toBeGreaterThanOrEqual(2);
    expect(session.protocolLog.filter((entry) => entry.message.includes("unknown frame type"))).toHaveLength(2);
    const row = session.messages["sys:protocol"];
    expect(row?.system?.label).toBe("protocol");
    expect(row?.system?.count).toBe(2);
    expect(session.hydration.busy).toBe(true);
    expect(session.hydration.busyRetries).toBe(1);
  });

  it("keeps the ring bounded at fifty raw lines", () => {
    const frames = Array.from({ length: 120 }, (_, index) => ({ type: `future_${index % 3}` }));
    const session = replay(bootState(), "thread-1", frames).sessions["thread-1"];
    expect(session.unknown.total).toBe(120);
    expect(session.unknown.ring).toHaveLength(50);
    expect(session.protocolLog).toHaveLength(3);
  });
});

describe("fixture replay — commands.jsonl", () => {
  it("uses only allowlisted command types", () => {
    const commands = loadFixture("commands");
    for (const command of commands) {
      expect(ALLOWED_CLIENT_COMMANDS[command.type], command.type).toBe(true);
    }
  });
});
