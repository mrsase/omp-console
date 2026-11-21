/**
 * Command dispatch for the stub: every allowlisted console command answers
 * with a correlated `response`, and state-changing ones emit their event.
 */
import {
  COMMANDS,
  LEVELS,
  MODELS,
  getState,
  getStats,
  queued,
  state,
  writeHeader,
} from "./state.mjs";
import {
  abortCurrent,
  emit,
  respond,
  respondError,
  resolveDialog,
} from "./frames.mjs";
import { chunkedMessages, drainQueue, startTurn } from "./scenarios.mjs";

const queueUpdate = () => emit({ type: "queue_update", ...queued() });

export async function onCommand(command) {
  const id = command.id;
  switch (command.type) {
    case "negotiate_protocol":
      return respond(id, "negotiate_protocol", { protocolVersion: 2 });
    case "set_event_filter":
      return respond(id, "set_event_filter", {
        events: command.events ?? null,
        messageUpdates: command.messageUpdates === "delta" ? "delta" : "full",
      });
    case "set_ask_dialog":
      return respond(id, "set_ask_dialog", { enabled: command.enabled !== false });
    case "get_state":
      return respond(id, "get_state", getState());
    case "get_session_stats":
      return respond(id, "get_session_stats", getStats());
    case "get_available_models":
      return respond(id, "get_available_models", { models: MODELS });
    case "get_available_thinking_levels":
      return respond(id, "get_available_thinking_levels", { levels: LEVELS });
    case "get_available_commands":
      return respond(id, "get_available_commands", { commands: COMMANDS });
    case "get_messages":
      return state.scenario === "chunk"
        ? chunkedMessages(id)
        : respond(id, "get_messages", { messages: state.history });
    case "prompt": {
      const text = typeof command.message === "string" ? command.message : "";
      if (state.streaming) {
        const kind = command.streamingBehavior === "followUp" ? "followUp" : "steering";
        state.queue[kind].push(text);
        await respond(id, "prompt", { queued: true });
        return queueUpdate();
      }
      await respond(id, "prompt", {});
      state.pendingImages = Array.isArray(command.images) ? command.images : [];
      void startTurn(id, text);
      return undefined;
    }
    case "steer": {
      const text = typeof command.message === "string" ? command.message : "";
      state.queue.steering.push(text);
      await respond(id, "steer", { queued: true });
      await queueUpdate();
      if (!state.streaming) {
        const gen = ++state.generation;
        state.streaming = true;
        state.aborted = false;
        state.currentPromptId = id;
        await emit({ type: "agent_start" });
        await drainQueue(gen);
        await emit({ type: "agent_end", messages: state.history.slice(-20) });
        await emit({ id, type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
        await emit({ type: "session_settled" });
        state.streaming = false;
        state.currentPromptId = null;
      }
      return undefined;
    }
    case "follow_up":
      state.queue.followUp.push(typeof command.message === "string" ? command.message : "");
      await respond(id, "follow_up", { queued: true });
      return queueUpdate();
    case "remove_queued_message": {
      const kind = command.queue === "steering" ? "steering" : "followUp";
      const before = state.queue[kind].length;
      state.queue[kind] = state.queue[kind].filter((message) => message !== command.message);
      await respond(id, "remove_queued_message", { removed: state.queue[kind].length !== before, images: [] });
      return queueUpdate();
    }
    case "promote_queued_message": {
      const message = state.queue.followUp.shift();
      if (message !== undefined) state.queue.steering.push(message);
      await respond(id, "promote_queued_message", { promoted: message !== undefined });
      return queueUpdate();
    }
    case "abort":
      abortCurrent();
      return respond(id, "abort", {});
    case "abort_and_restore_queue": {
      const restore = { steering: [...state.queue.steering], followUp: [...state.queue.followUp] };
      state.queue = { steering: [], followUp: [] };
      abortCurrent();
      await respond(id, "abort_and_restore_queue", restore);
      return queueUpdate();
    }
    case "set_model": {
      const found = MODELS.find((item) => item.provider === command.provider && item.id === command.modelId);
      if (!found) return respondError(id, "set_model", "unknown model");
      state.model = found;
      await respond(id, "set_model", { model: found });
      return emit({ type: "model_changed", model: found, thinkingLevel: state.thinkingLevel });
    }
    case "set_thinking_level":
      if (!LEVELS.includes(command.level)) return respondError(id, "set_thinking_level", "unknown thinking level");
      state.thinkingLevel = command.level;
      await emit({ type: "thinking_level_changed", level: state.thinkingLevel });
      return respond(id, "set_thinking_level", { level: state.thinkingLevel });
    case "set_session_name":
      if (typeof command.name === "string" && command.name.trim()) state.sessionName = command.name.trim();
      await respond(id, "set_session_name", { name: state.sessionName });
      return emit({ type: "session_info_update", title: state.sessionName, sessionId: state.sessionId });
    case "new_session":
      state.history = [];
      state.queue = { steering: [], followUp: [] };
      state.sessionId = `ses_stub_${process.pid}_${++state.seq}`;
      if (state.sessionFile && !state.resumePath) {
        state.sessionFile = state.sessionFile.replace(/[^/]+\.jsonl$/, `${state.sessionId}.jsonl`);
        writeHeader();
      }
      await respond(id, "new_session", { sessionId: state.sessionId, sessionFile: state.sessionFile });
      return emit({ type: "session_info_update", title: state.sessionName, sessionId: state.sessionId });
    case "fork":
      state.sessionId = `ses_stub_${process.pid}_fork_${++state.seq}`;
      await respond(id, "fork", { sessionId: state.sessionId, sessionFile: state.sessionFile });
      return emit({ type: "session_info_update", title: state.sessionName, sessionId: state.sessionId });
    case "export_html":
      return respond(id, "export_html", {
        path: state.sessionFile ? state.sessionFile.replace(/\.jsonl$/, ".html") : null,
      });
    case "compact":
      state.compacting = true;
      await emit({ type: "manual_compaction_start" });
      if (state.stepDelay) await new Promise((resolve) => setTimeout(resolve, state.stepDelay));
      state.compacting = false;
      await emit({ type: "manual_compaction_end", success: true });
      return respond(id, "compact", {});
    case "set_auto_compaction":
      state.autoCompaction = command.enabled !== false;
      return respond(id, "set_auto_compaction", { enabled: state.autoCompaction });
    case "extension_ui_response":
      resolveDialog(command);
      return undefined;
    default:
      return respondError(id, command.type || "unknown", `command not supported by stub: ${command.type}`);
  }
}
