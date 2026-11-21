import type { AskQuestion, DialogRecord, MessageRecord, ThreadRuntime, TodoPhase } from "../protocol/types";

export interface TranscriptRow {
  record: MessageRecord;
  key: string;
}

/** Rows that render at top level: tool results nested in a tool call are folded in. */
export function visibleRows(session: ThreadRuntime): MessageRecord[] {
  const rows: MessageRecord[] = [];
  for (const key of session.rows) {
    const record = session.messages[key];
    if (!record) continue;
    if (record.role === "toolResult") {
      const owner = record.toolCallId ? session.toolOwners[record.toolCallId] : undefined;
      if (owner && owner.key !== record.key) continue;
    }
    if (record.role === "assistant" && record.blocks.length === 0 && !record.error) continue;
    rows.push(record);
  }
  return rows;
}

export function promptOutline(session: ThreadRuntime): { key: string; turn: number; text: string; timestamp: number | null }[] {
  const outline: { key: string; turn: number; text: string; timestamp: number | null }[] = [];
  for (const key of session.rows) {
    const record = session.messages[key];
    if (record?.role !== "user") continue;
    const text = record.blocks
      .map((block) => (block.kind === "text" ? block.text : ""))
      .join(" ")
      .trim();
    outline.push({ key: record.key, turn: record.turn, text: text || "(prompt)", timestamp: record.timestamp });
  }
  return outline;
}

export function openDialogs(session: ThreadRuntime): DialogRecord[] {
  return session.dialogs.filter((dialog) => dialog.status === "open");
}

export function planProgress(phases: TodoPhase[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      total += 1;
      if (task.status === "completed") done += 1;
    }
  }
  return { done, total };
}

export function allQuestions(record: DialogRecord | undefined): AskQuestion[] {
  return record?.request.questions ?? [];
}

export function assistantModelName(session: ThreadRuntime): string {
  return session.model?.name || session.model?.id || session.meta?.modelName || session.meta?.model || "";
}

export function sessionTitle(session: ThreadRuntime): string {
  return session.title || session.sessionName || session.meta?.title || "New session";
}

export function isRunning(session: ThreadRuntime): boolean {
  return session.streaming || session.agentActive || session.meta?.status === "starting";
}

export function composerMode(session: ThreadRuntime | undefined): "idle" | "starting" | "steer" | "followUp" {
  if (!session) return "idle";
  if (session.meta?.status === "starting") return "starting";
  if (isRunning(session)) return "steer";
  return "idle";
}

export function statusLabel(session: ThreadRuntime | undefined): "Starting" | "Working" | "Idle" | "Ended" {
  if (!session) return "Idle";
  if (session.meta?.status === "starting") return "Starting";
  if (session.meta?.status === "exited") return "Ended";
  if (isRunning(session)) return "Working";
  return "Idle";
}

export function relativeRecent(session: ThreadRuntime): string {
  return session.sessionFile ? session.sessionFile.split("/").pop() ?? "" : "";
}

export function blockText(record: MessageRecord): string {
  return record.blocks.map((block) => (block.kind === "text" ? block.text || block.chunks.join("") : "")).join("");
}
