import type { MessageRecord, RawFrame, ThreadRuntime } from "./types";
import { pushSystemRow } from "./records";

/** Known to omp 18.18.x; unhandled known types are ignored, never "unknown". */
export const KNOWN_TYPES: Record<string, true> = {
  ready: true,
  response: true,
  prompt_result: true,
  session_settled: true,
  agent_start: true,
  agent_end: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  queue_update: true,
  model_changed: true,
  thinking_level_changed: true,
  session_info_update: true,
  available_commands_update: true,
  config_update: true,
  notice: true,
  extension_ui_request: true,
  auto_retry_start: true,
  auto_retry_end: true,
  auto_compaction_start: true,
  auto_compaction_end: true,
  manual_compaction_start: true,
  manual_compaction_end: true,
  compaction_start: true,
  compaction_end: true,
  branch_summary: true,
  advisor_cost_changed: true,
  cache_warming_start: true,
  cache_warming_end: true,
  subagent_lifecycle: true,
  subagent_start: true,
  subagent_end: true,
  subagent_update: true,
};

/** Handled in the reducer; the rest of KNOWN_TYPES are counted as ignored. */
export const HANDLED_TYPES: Record<string, true> = {
  ready: true,
  response: true,
  prompt_result: true,
  session_settled: true,
  agent_start: true,
  agent_end: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  queue_update: true,
  model_changed: true,
  thinking_level_changed: true,
  session_info_update: true,
  available_commands_update: true,
  config_update: true,
  notice: true,
  extension_ui_request: true,
  auto_retry_start: true,
  auto_retry_end: true,
  auto_compaction_start: true,
  auto_compaction_end: true,
  manual_compaction_start: true,
  manual_compaction_end: true,
  compaction_start: true,
  compaction_end: true,
  branch_summary: true,
};

export const PROTOCOL_ROW_KEY = "sys:protocol";

export function noteUnknown(t: ThreadRuntime, frame: RawFrame): void {
  const type = typeof frame.type === "string" ? frame.type : "unknown";
  t.unknown.total += 1;
  t.unknown.counts[type] = (t.unknown.counts[type] ?? 0) + 1;
  let raw: string;
  try {
    raw = JSON.stringify(frame);
  } catch {
    raw = String(frame.type);
  }
  t.unknown.ring.push({ type, raw });
  if (t.unknown.ring.length > 50) t.unknown.ring.splice(0, t.unknown.ring.length - 50);
  if (!t.unknown.loggedTypes.includes(type)) {
    t.unknown.loggedTypes.push(type);
    t.protocolLog.push({
      id: `unknown:${type}`,
      level: "warn",
      message: `unknown frame type “${type}” (first seen)`,
    });
  }
  const kinds = Object.keys(t.unknown.counts);
  pushSystemRow(
    t,
    {
      label: "protocol",
      summary: `${t.unknown.total} unknown frame${t.unknown.total === 1 ? "" : "s"} · ${kinds.join(", ")}`,
      body: kinds.map((kind) => `${kind} × ${t.unknown.counts[kind]}`).join("\n"),
      tone: "warn",
      kind: "unknown",
      count: t.unknown.total,
    },
    { key: PROTOCOL_ROW_KEY },
  );
}

export function noteProtocol(t: ThreadRuntime, message: string, level: "info" | "warn" = "warn"): void {
  t.protocolLog.push({ id: `log:${t.seq}:${t.protocolLog.length}`, level, message });
  if (t.protocolLog.length > 50) t.protocolLog.splice(0, t.protocolLog.length - 50);
}

export function isKnownFrame(type: string): boolean {
  return KNOWN_TYPES[type] === true;
}

export function sortRows(t: ThreadRuntime): void {
  const seen = new Set<string>();
  t.rows = t.rows.filter((key) => {
    if (!t.messages[key] || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function removeRow(t: ThreadRuntime, key: string): MessageRecord | null {
  const record = t.messages[key];
  if (!record) return null;
  delete t.messages[key];
  t.rows = t.rows.filter((entry) => entry !== key);
  return record;
}
