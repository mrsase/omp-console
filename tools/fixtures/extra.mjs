/**
 * Fixture streams that are shape-exact but partly synthetic: the committed
 * dialog catalog covers every extension UI method, and the command catalog is
 * the outbound allowlist. Kept separate from the observed capture shapes so
 * both files stay readable.
 */

export function dialogs(SESSION_ID) {
  return [
    { type: "extension_ui_request", id: "ui-select-1", method: "select", title: "Pick a target", options: ["One", "Two"], optionDetails: [{ description: "The first one" }, { description: "The second one" }], timeout: 30000 },
    { type: "extension_ui_request", id: "ui-confirm-1", method: "confirm", title: "Delete the draft?", message: "This cannot be undone.", timeout: 15000 },
    { type: "extension_ui_request", id: "ui-input-1", method: "input", title: "API key", placeholder: "sk-…", secret: true, timeout: 60000 },
    { type: "extension_ui_request", id: "ui-editor-1", method: "editor", title: "Edit the prompt", prefill: "Draft text", promptStyle: true },
    {
      type: "extension_ui_request",
      id: "ui-ask-1",
      method: "ask",
      timeout: 60000,
      questions: [
        {
          id: "store",
          question: "Where should sessions live?",
          header: "Storage",
          options: [
            { label: "SQLite", description: "One file, no new service" },
            { label: "Redis", description: "Shared across instances" },
          ],
          multi: false,
          recommended: 0,
        },
        {
          id: "extras",
          question: "Which extras?",
          options: [{ label: "Search", preview: "Full-text search" }, { label: "Export", description: "Bulk CSV" }],
          multi: true,
        },
      ],
    },
    { type: "extension_ui_request", id: "ui-cancel-1", method: "cancel", targetId: "ui-select-1" },
    { type: "extension_ui_request", id: "ui-notify-1", method: "notify", message: "Compaction finished", notifyType: "info" },
    { type: "extension_ui_request", id: "ui-status-1", method: "setStatus", statusKey: "lint", statusText: "Running…" },
    { type: "extension_ui_request", id: "ui-widget-2", method: "setWidget", widgetKey: "jobs", widgetLines: ["build   running", "test    queued"], widgetPlacement: "aboveEditor" },
    { type: "extension_ui_request", id: "ui-title-1", method: "setTitle", title: "Renamed session" },
    { type: "extension_ui_request", id: "ui-editor-text-1", method: "set_editor_text", text: "Prefilled draft" },
    { type: "extension_ui_request", id: "ui-url-1", method: "open_url", url: "https://example.test/authorize", launchUrl: "http://127.0.0.1:9000/r/abc", instructions: "Finish sign-in" },
    { type: "session_info_update", title: "Fixture session", sessionId: SESSION_ID },
  ];
}


export function failuresAndUnknowns() {
  return [
    { type: "future_frame_kind", payload: { shape: "not yet negotiated" }, nested: [1, 2, 3] },
    { type: "rpc_frame_error", originalType: "agent_end", error: "RPC frame exceeded the transport limit" },
    { id: "cmd-busy", type: "response", command: "get_messages", success: false, error: "session is busy", code: "session_busy" },
    { id: "cmd-cap", type: "response", command: "prompt", success: false, error: "cost cap reached", code: "cost_cap" },
    { type: "subagent_lifecycle", payload: { id: "sub-1", index: 0, agent: "explore", agentSource: "bundled", status: "started", description: "Reading the tree" } },
  ];
}


export function commandsOut(MODEL) {
  return [
    { id: "cmd-1", type: "prompt", message: "Run the fixture command.", images: [{ type: "image", mimeType: "image/jpeg", data: "ZmFrZQ==" }], streamingBehavior: "steer" },
    { id: "cmd-2", type: "steer", message: "Also check the log." },
    { id: "cmd-3", type: "follow_up", message: "Then summarize." },
    { id: "cmd-4", type: "remove_queued_message", message: "Then summarize.", queue: "followUp" },
    { id: "cmd-5", type: "promote_queued_message", message: "Then summarize." },
    { id: "cmd-6", type: "abort" },
    { id: "cmd-7", type: "abort_and_restore_queue" },
    { id: "cmd-8", type: "set_model", provider: MODEL.provider, modelId: MODEL.id },
    { id: "cmd-9", type: "set_thinking_level", level: "high" },
    { id: "cmd-10", type: "set_session_name", name: "Fixture session" },
    { id: "cmd-11", type: "new_session" },
    { id: "cmd-12", type: "fork" },
    { id: "cmd-13", type: "export_html" },
    { id: "cmd-14", type: "compact" },
    { id: "cmd-15", type: "set_auto_compaction", enabled: true },
    { id: "cmd-16", type: "get_state" },
    { id: "cmd-17", type: "get_session_stats" },
    { id: "cmd-18", type: "get_messages" },
    { id: "cmd-19", type: "get_available_models" },
    { id: "cmd-20", type: "get_available_thinking_levels" },
    { id: "cmd-21", type: "get_available_commands" },
    { type: "extension_ui_response", id: "ui-select-1", value: "One" },
    { type: "extension_ui_response", id: "ui-confirm-1", confirmed: true },
    { type: "extension_ui_response", id: "ui-ask-1", answers: [{ id: "store", selectedOptions: ["SQLite"], customInput: "WAL mode" }] },
    { type: "extension_ui_response", id: "ui-input-1", cancelled: true, timedOut: false },
  ];
}
