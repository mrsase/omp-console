import type { MessageRecord, RawFrame, ThreadRuntime, WireMessage } from "./types";
import { blocksFromContent, imagesFromContent, usageSnapshot } from "./records";
import { noteProtocol } from "./known";
import { applyState, applyStats, modelInfo } from "./events";

type Frame = RawFrame & { [key: string]: unknown };

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function hydratedRecord(wire: WireMessage, index: number, turn: number): MessageRecord {
  const role = wire.role === "user" || wire.role === "toolResult" || wire.role === "system" ? wire.role : "assistant";
  const timestamp = typeof wire.timestamp === "number" ? wire.timestamp : null;
  const key = `h:${index}:${role}:${timestamp ?? "t"}`;
  return {
    key,
    id: null,
    role,
    lane: role === "user" ? "you" : role === "toolResult" ? "tool" : role === "system" ? "system" : "assistant",
    turn,
    seq: index,
    timestamp,
    version: 0,
    streaming: false,
    blocks: blocksFromContent(wire.content),
    images: imagesFromContent(wire.content),
    source: "hydrated",
    model: typeof wire.model === "string" ? wire.model : undefined,
    provider: typeof wire.provider === "string" ? wire.provider : undefined,
    usage: wire.usage ? usageSnapshot(wire.usage) : undefined,
    stopReason: typeof wire.stopReason === "string" ? wire.stopReason : undefined,
    durationMs: typeof wire.duration === "number" ? wire.duration : null,
    ttftMs: typeof wire.ttft === "number" ? wire.ttft : null,
    toolCallId: typeof wire.toolCallId === "string" ? wire.toolCallId : undefined,
    toolName: typeof wire.toolName === "string" ? wire.toolName : undefined,
    isError: wire.isError === true,
    details: wire.details,
  };
}

function mergeToolBlocks(history: MessageRecord, live: MessageRecord): MessageRecord {
  const blocks = history.blocks.map((block) => {
    if (block.kind === "tool") {
      const match = live.blocks.find((entry) => entry.kind === "tool" && entry.callId === block.callId);
      if (match && match.kind === "tool") {
        return {
          ...block,
          output: match.output || block.output,
          details: match.details ?? block.details,
          images: match.images.length > 0 ? match.images : block.images,
          state: match.state,
          isError: match.isError,
          durationMs: match.durationMs ?? block.durationMs,
          startedAt: match.startedAt ?? block.startedAt,
          endedAt: match.endedAt ?? block.endedAt,
        };
      }
      return block;
    }
    if (block.kind === "text") {
      const match = live.blocks.find((entry) => entry.kind === "text");
      if (match && match.kind === "text" && match.text.length > block.text.length) {
        return { ...block, text: match.text };
      }
    }
    return block;
  });
  for (const block of live.blocks) {
    if (block.kind === "tool" && !blocks.some((entry) => entry.kind === "tool" && entry.callId === block.callId)) {
      blocks.push(block);
    }
  }
  return {
    ...history,
    key: live.key,
    id: live.id ?? history.id,
    seq: live.seq,
    turn: Math.max(history.turn, live.turn),
    blocks,
    source: "live",
    timestamp: history.timestamp ?? live.timestamp,
    usage: history.usage ?? live.usage,
    usageApplied: true,
    version: live.version,
  };
}

export interface HydrateOutcome {
  replaced: number;
  added: number;
}

/**
 * Merge an authoritative `get_messages` snapshot without losing rows that share
 * a timestamp. Live records win identity, history wins content, and a one-to-one
 * role+timestamp match prevents duplicate rows.
 */
export function hydrateMessages(t: ThreadRuntime, rawMessages: unknown[]): HydrateOutcome {
  const hydrated: MessageRecord[] = [];
  let turn = 0;
  rawMessages.forEach((raw, index) => {
    const wire = rec(raw) as WireMessage | null;
    if (!wire || typeof wire.role !== "string") return;
    if (wire.role === "user") turn += 1;
    hydrated.push(hydratedRecord(wire, index, Math.max(1, turn)));
  });

  const previousRowKeys = [...t.rows];
  const liveByMatch = new Map<string, MessageRecord[]>();
  for (const key of previousRowKeys) {
    const record = t.messages[key];
    if (!record || record.source !== "live" || record.role === "system") continue;
    const matchKey = `${record.role}:${record.timestamp ?? "t"}`;
    const list = liveByMatch.get(matchKey) ?? [];
    list.push(record);
    liveByMatch.set(matchKey, list);
  }

  const usedLive = new Set<string>();
  const nextRows: string[] = [];
  const nextMessages: Record<string, MessageRecord> = {};
  let replaced = 0;
  let added = 0;

  for (const history of hydrated) {
    const matchKey = `${history.role}:${history.timestamp ?? "t"}`;
    const candidates = liveByMatch.get(matchKey);
    const live = candidates?.find((entry) => !usedLive.has(entry.key));
    if (live) {
      usedLive.add(live.key);
      nextMessages[live.key] = mergeToolBlocks(history, live);
      nextRows.push(live.key);
      replaced += 1;
    } else {
      nextMessages[history.key] = history;
      nextRows.push(history.key);
      added += 1;
    }
  }

  for (const key of previousRowKeys) {
    const record = t.messages[key];
    if (!record) continue;
    if (record.source === "hydrated") continue;
    if (usedLive.has(key)) continue;
    if (record.source === "live" && record.role !== "system") {
      // Live row absent from history: keep it (it streamed after the snapshot).
      if (!nextMessages[key]) {
        nextMessages[key] = { ...record, usageApplied: true };
        nextRows.push(key);
      }
      continue;
    }
    nextMessages[key] = record;
    nextRows.push(key);
  }

  t.messages = nextMessages;
  t.rows = nextRows;
  t.toolOwners = {};
  for (const key of nextRows) {
    const record = nextMessages[key];
    record.blocks.forEach((block, index) => {
      if (block.kind === "tool" && block.callId) t.toolOwners[block.callId] = { key, index };
    });
  }
  const counts = { user: 0, assistant: 0, tool: 0 };
  for (const key of nextRows) {
    const role = nextMessages[key]?.role;
    if (role === "user") counts.user += 1;
    else if (role === "assistant") counts.assistant += 1;
    else if (role === "toolResult") counts.tool += 1;
  }
  if (counts.user > 0) t.turn = Math.max(t.turn, counts.user);
  t.stats.userMessages = counts.user || t.stats.userMessages;
  t.stats.assistantMessages = counts.assistant || t.stats.assistantMessages;
  t.stats.toolResults = counts.tool || t.stats.toolResults;
  t.stats.totalMessages = nextRows.filter((key) => nextMessages[key]?.role !== "system").length;
  t.messageCount = t.stats.totalMessages;
  t.hydration.messages = true;
  t.hydration.busy = false;
  t.hydration.lastError = null;
  return { replaced, added };
}

export function handleResponse(t: ThreadRuntime, frame: Frame): void {
  const command = str(frame.command) ?? "unknown";
  const success = frame.success !== false;
  const data = rec(frame.data);
  if (!success) {
    const error = str(frame.error) ?? "unhandled error";
    const code = str(frame.code);
    t.hydration.lastError = error;
    t.lastError = error;
    if (command === "get_messages" && code === "session_busy") {
      t.hydration.busy = true;
      t.hydration.busyRetries += 1;
      noteProtocol(t, "get_messages deferred: session busy");
      return;
    }
    noteProtocol(t, `${command} failed: ${error}`);
    return;
  }
  t.hydration.lastError = null;
  switch (command) {
    case "get_state": {
      applyState(t, data);
      t.hydration.state = true;
      return;
    }
    case "get_session_stats": {
      applyStats(t, data);
      t.hydration.stats = true;
      return;
    }
    case "get_messages": {
      const messages = data && Array.isArray(data.messages) ? data.messages : [];
      hydrateMessages(t, messages);
      return;
    }
    case "get_available_models": {
      const models = data && Array.isArray(data.models) ? data.models : [];
      t.models = models.map((model) => modelInfo(model)).filter((model): model is NonNullable<typeof model> => !!model);
      t.hydration.models = true;
      return;
    }
    case "get_available_thinking_levels": {
      const levels = data && Array.isArray(data.levels) ? data.levels : [];
      t.levels = levels.filter((level): level is string => typeof level === "string");
      t.hydration.levels = true;
      return;
    }
    case "get_available_commands": {
      const commands = data && Array.isArray(data.commands) ? data.commands : [];
      t.commands = commands.filter((entry): entry is ThreadRuntime["commands"][number] => {
        const item = rec(entry);
        return !!item && typeof item.name === "string";
      }) as ThreadRuntime["commands"];
      t.hydration.commands = true;
      return;
    }
    case "set_model": {
      const model = modelInfo(data?.model);
      if (model) t.model = model;
      return;
    }
    case "set_thinking_level": {
      if (data && typeof data.level === "string") t.thinkingLevel = data.level;
      return;
    }
    case "set_auto_compaction": {
      if (data && typeof data.enabled === "boolean") t.autoCompaction = data.enabled;
      return;
    }
    case "new_session": {
      t.rows = [];
      t.messages = {};
      t.toolOwners = {};
      t.turn = 0;
      t.turnStamps = [];
      t.queue = { steering: [], followUp: [], liveSteered: 0 };
      t.dialogs = [];
      t.streaming = false;
      t.settled = false;
      t.agentActive = false;
      t.messageCount = 0;
      t.stats = {
        ...t.stats,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        messageCount: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
        cost: 0,
      };
      t.tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
      t.cost = 0;
      t.contextUsage = null;
      t.spark = [];
      if (data && typeof data.sessionId === "string") t.sessionId = data.sessionId;
      if (data && typeof data.sessionFile === "string") t.sessionFile = data.sessionFile;
      return;
    }
    case "abort":
    case "abort_and_restore_queue": {
      t.streaming = false;
      return;
    }
    default:
      return;
  }
}
