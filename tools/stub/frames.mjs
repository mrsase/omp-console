/**
 * Wire output and the small frame vocabulary the scenarios share:
 * one JSON object per line, flushed, with backpressure respected.
 */
import { assistantMessage, state } from "./state.mjs";

let chain = Promise.resolve();
export function emit(frame) {
  const line = JSON.stringify(frame) + "\n";
  chain = chain.then(
    () =>
      new Promise((resolve) => {
        if (process.stdout.write(line)) resolve();
        else process.stdout.once("drain", resolve);
      }),
  );
  return chain;
}
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const startMsg = (id, message) => emit({ type: "message_start", messageId: id, message });
export const endMsg = (id, message) => emit({ type: "message_end", messageId: id, message });
export const update = (id, assistantMessageEvent) =>
  emit({ type: "message_update", messageId: id, message: { role: "assistant" }, assistantMessageEvent });
export const toolStart = (id, name, args, intent) =>
  emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args, intent });
export const toolUpdate = (id, name, args, text, details = {}) =>
  emit({
    type: "tool_execution_update",
    toolCallId: id,
    toolName: name,
    args,
    partialResult: { content: [{ type: "text", text }], details },
  });
export const toolEnd = (id, name, result, isError = false) =>
  emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError });
export const respond = (id, command, data) =>
  emit({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
export const respondError = (id, command, error) =>
  emit({ id, type: "response", command, success: false, error });

export async function textStream(messageId, content) {
  await startMsg(messageId, assistantMessage([{ type: "text", text: "" }]));
  await update(messageId, { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } });
  let text = "";
  for (const word of content.split(/(?<=\s)/)) {
    if (state.aborted) return false;
    text += word;
    await update(messageId, { type: "text_delta", contentIndex: 0, delta: word });
    if (state.stepDelay) await sleep(state.stepDelay);
  }
  await update(messageId, { type: "text_end", contentIndex: 0, content, block: { type: "text" } });
  return true;
}

/* -------------------------------- dialogs --------------------------------- */

const pending = new Map();

export function askDialog(request, id) {
  const dialogId = id || request.id || `ui-${++state.seq}`;
  return new Promise((resolve) => {
    pending.set(dialogId, resolve);
    emit({ type: "extension_ui_request", ...request, id: dialogId });
  });
}

export function resolveDialog(frame) {
  if (frame.cancelled) {
    for (const resolve of pending.values()) resolve({ cancelled: true });
    pending.clear();
    return;
  }
  const resolve = pending.get(frame.id);
  if (resolve) {
    pending.delete(frame.id);
    resolve(frame);
  }
}

export function abortCurrent() {
  state.aborted = true;
  state.generation += 1;
  state.streaming = false;
  for (const resolve of pending.values()) resolve({ cancelled: true });
  pending.clear();
}

export async function finishAborted() {
  state.streaming = false;
  await emit({ type: "agent_end", messages: state.history.slice(-20) });
  await emit({
    id: state.currentPromptId ?? "cmd-abort",
    type: "prompt_result",
    agentInvoked: true,
    status: "aborted",
    sessionSettled: true,
  });
  await emit({ type: "session_settled" });
  state.currentPromptId = null;
}
