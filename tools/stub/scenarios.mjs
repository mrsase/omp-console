/**
 * The five stub scenarios. Each one ends with the completion frames the real
 * child emits, so the server and UI see a realistic turn.
 */
import {
  assistantMessage,
  fixtureHistory,
  nextSeq,
  queued,
  record,
  state,
  userMessage,
} from "./state.mjs";
import {
  askDialog,
  emit,
  endMsg,
  finishAborted,

  sleep,
  startMsg,
  textStream,
  toolEnd,
  toolStart,
  toolUpdate,
  update,
} from "./frames.mjs";

const queueUpdate = () => emit({ type: "queue_update", ...queued() });
const stringify = (value) => JSON.stringify(value);

function callBlock(name, args, index) {
  return {
    type: "toolCall",
    id: `call_${name}_${nextSeq()}`,
    name,
    arguments: args,
    partialArgs: stringify(args),
    streamIndex: index,
  };
}

async function toolCallEvents(messageId, call, contentIndex) {
  await update(messageId, {
    type: "toolcall_start",
    contentIndex,
    block: { ...call, arguments: {}, partialArgs: "", streamIndex: contentIndex - 1 },
  });
  await update(messageId, { type: "toolcall_delta", contentIndex, delta: call.partialArgs });
  await update(messageId, { type: "toolcall_end", contentIndex, toolCall: call });
}

async function userTurn(text) {
  const message = userMessage(text, state.pendingImages);
  state.pendingImages = [];
  const id = `msg-${nextSeq()}`;
  await startMsg(id, message);
  await endMsg(id, message);
  record(message);
}

async function resultMessage(call, text, details = {}) {
  const message = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    details,
    isError: false,
    timestamp: Date.now(),
  };
  const id = `msg-${nextSeq()}`;
  await startMsg(id, message);
  await endMsg(id, message);
  record(message);
}

/* --------------------------------- queue ---------------------------------- */

export async function drainQueue(gen) {
  while ((state.queue.steering.length || state.queue.followUp.length) && !state.aborted && gen === state.generation) {
    const kind = state.queue.steering.length ? "steering" : "followUp";
    const text = state.queue[kind].shift();
    await queueUpdate();
    await emit({ type: "turn_start" });
    await userTurn(text);
    const id = `msg-${nextSeq()}`;
    const answer = `Acknowledged the ${kind === "steering" ? "steer" : "follow-up"}: ${text}`;
    await textStream(id, answer);
    if (state.aborted) return;
    const message = assistantMessage([{ type: "text", text: answer }]);
    await endMsg(id, message);
    record(message);
    await emit({ type: "turn_end", message, toolResults: [] });
  }
}

/* -------------------------------- journey --------------------------------- */

export async function journeyTurn(promptId, promptText) {
  const gen = state.generation;
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await userTurn(promptText);
  const mid = `msg-${nextSeq()}`;
  const lead = "I'll run the command and ask the question.";
  if (!(await textStream(mid, lead)) || gen !== state.generation) return;
  const bash = callBlock("bash", { command: "echo omp-console-fixture", i: "Running stub command" }, 0);
  const ask = callBlock(
    "ask",
    {
      html: '<form><fieldset><legend>Pick</legend><p>Which color?</p><label><input type="radio" name="color" value="Red" checked> Red</label><label><input type="radio" name="color" value="Blue"> Blue</label></fieldset></form>',
      i: "Asking color preference",
    },
    1,
  );
  await toolCallEvents(mid, bash, 1);
  await toolCallEvents(mid, ask, 2);
  const assistant = assistantMessage([{ type: "text", text: lead }, bash, ask], { stopReason: "toolUse" });
  await endMsg(mid, assistant);
  record(assistant);

  await toolStart(bash.id, "bash", bash.arguments, "Running stub command");
  const approvalDelay = Number(process.env.STUB_OMP_APPROVAL_DELAY_MS || 0);
  if (approvalDelay > 0) await sleep(approvalDelay);
  if (state.aborted || gen !== state.generation) return;
  const approval = await askDialog({
    method: "select",
    title: "Allow tool: bash\nCommand: echo omp-console-fixture",
    options: ["Approve", "Approve bash for this session", "Deny"],
  });
  if (state.aborted || gen !== state.generation) return;
  const denied = approval.cancelled || approval.value === "Deny";
  if (!denied) {
    await toolUpdate(bash.id, "bash", bash.arguments, "");
    await toolUpdate(bash.id, "bash", bash.arguments, "omp-console-fixture\n", { wallTimeMs: 12.4 });
  }
  await toolEnd(
    bash.id,
    "bash",
    {
      content: [{ type: "text", text: denied ? "Denied by the user." : "omp-console-fixture\n" }],
      details: denied ? {} : { wallTimeMs: 12.4, timeoutSeconds: 300 },
    },
    denied,
  );
  await resultMessage(bash, denied ? "Denied by the user." : "omp-console-fixture\n");

  await toolStart(ask.id, "ask", ask.arguments, "Asking color preference");
  const answer = await askDialog({
    method: "select",
    title: "Which color?",
    options: ["Red", "Blue", "Other (type your own)"],
  });
  if (state.aborted || gen !== state.generation) return;
  const color = answer.cancelled ? "Red" : answer.value || "Red";
  const answerText = `User answers:\n{\n  "color": "${color}"\n}`;
  const answerDetails = { answers: [{ name: "color", question: "Which color?", answer: color }] };
  await toolEnd(ask.id, "ask", { content: [{ type: "text", text: answerText }], details: answerDetails });
  await resultMessage(ask, answerText, answerDetails);

  await emit({ type: "turn_end", message: assistant, toolResults: [] });
  await emit({ type: "turn_start" });
  const doneMid = `msg-${nextSeq()}`;
  if (!(await textStream(doneMid, "DONE")) || gen !== state.generation) return;
  const done = assistantMessage([{ type: "text", text: "DONE" }]);
  await endMsg(doneMid, done);
  record(done);
  await emit({ type: "turn_end", message: done, toolResults: [] });
  await drainQueue(gen);
  if (state.aborted || gen !== state.generation) return;
  await emit({ type: "agent_end", messages: state.history.slice(-40) });
  await emit({ id: promptId, type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
  await emit({ type: "session_settled" });
}

/* ---------------------------------- ask ----------------------------------- */

export async function askTurn(promptId, promptText) {
  const gen = state.generation;
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await userTurn(promptText);
  const mid = `msg-${nextSeq()}`;
  const call = callBlock("ask", { html: "<form><p>Where should sessions live?</p></form>", i: "Asking storage" }, 0);
  await startMsg(mid, assistantMessage([{ type: "text", text: "" }]));
  await toolCallEvents(mid, call, 0);
  const assistant = assistantMessage([call], { stopReason: "toolUse" });
  await endMsg(mid, assistant);
  record(assistant);
  await toolStart(call.id, "ask", call.arguments, "Asking storage");
  const answer = await askDialog({
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
        options: [
          { label: "Search", preview: "Full-text search" },
          { label: "Export", description: "Bulk CSV" },
        ],
        multi: true,
      },
    ],
  });
  if (state.aborted || gen !== state.generation) return;
  const answers = Array.isArray(answer.answers) ? answer.answers : [];
  const summary =
    answers.map((item) => `${item.id}: ${(item.selectedOptions || []).join(", ")}`).join("\n") || "No answer";
  await toolEnd(call.id, "ask", { content: [{ type: "text", text: `User answers:\n${summary}` }], details: { answers } });
  await resultMessage(call, `User answers:\n${summary}`, { answers });
  await emit({ type: "turn_end", message: assistant, toolResults: [] });
  await emit({ type: "agent_end", messages: state.history.slice(-40) });
  await emit({ id: promptId, type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
  await emit({ type: "session_settled" });
}

/* --------------------------------- events --------------------------------- */

export async function eventsTurn(promptId, promptText) {
  const gen = state.generation;
  const total = Math.max(1, Number(process.env.STUB_OMP_EVENTS || 10000));
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await userTurn(promptText);
  let emitted = 0;
  let index = 0;
  while (emitted < total && !state.aborted && gen === state.generation) {
    const mid = `ev-${index}`;
    await startMsg(mid, assistantMessage([{ type: "text", text: "" }]));
    emitted += 1;
    let text = "";
    for (let delta = 0; delta < 3 && emitted < total; delta += 1) {
      const piece = `event ${index}.${delta} `;
      text += piece;
      await update(mid, { type: "text_delta", contentIndex: 0, delta: piece });
      emitted += 1;
    }
    if (index % 5 === 4 && emitted + 3 < total) {
      const callId = `call_perf_${index}`;
      await emit({
        type: "tool_execution_start",
        toolCallId: callId,
        toolName: "bash",
        args: { command: `echo event-${index}` },
      });
      await emit({
        type: "tool_execution_update",
        toolCallId: callId,
        toolName: "bash",
        args: { command: `echo event-${index}` },
        partialResult: { content: [{ type: "text", text: `event-${index}\n` }], details: {} },
      });
      await emit({
        type: "tool_execution_end",
        toolCallId: callId,
        toolName: "bash",
        result: { content: [{ type: "text", text: `event-${index}\n` }], details: {} },
        isError: false,
      });
      emitted += 3;
    }
    if (emitted < total) {
      const message = assistantMessage([{ type: "text", text }]);
      await endMsg(mid, message);
      record(message);
      emitted += 1;
    }
    index += 1;
  }
  if (state.aborted || gen !== state.generation) return;
  await emit({ type: "turn_end", message: assistantMessage([{ type: "text", text: "DONE" }]), toolResults: [] });
  await emit({ type: "agent_end", messages: state.history.slice(-20) });
  await emit({ id: promptId, type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
  await emit({ type: "session_settled" });
}

/* ------------------------------ small turns ------------------------------- */

export async function errorTurn(promptId) {
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await emit({ type: "agent_end", messages: [] });
  await emit({
    id: promptId,
    type: "prompt_result",
    agentInvoked: true,
    status: "error",
    error: { message: "stub provider refused the request: quota exhausted", retryable: true },
    sessionSettled: true,
  });
  await emit({ type: "session_settled" });
}

export async function simpleTurn(promptId, promptText) {
  const gen = state.generation;
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await userTurn(promptText);
  const mid = `msg-${nextSeq()}`;
  if (!(await textStream(mid, "DONE")) || gen !== state.generation) return;
  const done = assistantMessage([{ type: "text", text: "DONE" }]);
  await endMsg(mid, done);
  record(done);
  await emit({ type: "turn_end", message: done, toolResults: [] });
  await emit({ type: "agent_end", messages: state.history.slice(-20) });
  await emit({ id: promptId, type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
  await emit({ type: "session_settled" });
}

export async function startTurn(promptId, promptText) {
  state.streaming = true;
  state.aborted = false;
  state.generation += 1;
  state.currentPromptId = promptId;
  try {
    if (state.scenario === "ask") await askTurn(promptId, promptText);
    else if (state.scenario === "error") await errorTurn(promptId);
    else if (state.scenario === "events") await eventsTurn(promptId, promptText);
    else if (state.scenario === "chunk") await simpleTurn(promptId, promptText);
    else await journeyTurn(promptId, promptText);
  } catch (error) {
    await emit({
      id: promptId,
      type: "prompt_result",
      agentInvoked: true,
      status: "error",
      error: { message: `stub crashed: ${error?.message ?? error}`, retryable: false },
      sessionSettled: true,
    });
  }
  if (state.aborted) await finishAborted();
  state.streaming = false;
  state.currentPromptId = null;
}

/* ------------------------------ chunked frame ----------------------------- */

export async function chunkedMessages(id) {
  const target = 1_101_005;
  const seed = "omp-console-chunk-fixture-v1:";
  const base = {
    id: id ?? "cmd-messages",
    type: "response",
    command: "get_messages",
    success: true,
    data: { messages: state.history.length ? state.history : fixtureHistory(), padding: "" },
  };
  let padLength = target;
  let payload = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    base.data.padding = seed.repeat(Math.ceil(padLength / seed.length)).slice(0, Math.max(0, padLength));
    payload = JSON.stringify(base);
    const delta = target - Buffer.byteLength(payload);
    if (delta === 0) break;
    padLength += delta;
  }
  const bytes = Buffer.from(payload, "utf8");
  const chunkSize = 262_144;
  const count = Math.ceil(bytes.length / chunkSize);
  const chunkId = `chunk-${process.pid}-${nextSeq()}`;
  for (let index = 0; index < count; index += 1) {
    const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
    await emit({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.length, data: slice.toString("base64") });
  }
}


