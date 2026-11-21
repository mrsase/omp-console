import type {
  Block,
  ContentBlock,
  MessageRecord,
  QueueImage,
  QueueItem,
  QueueKind,
  SystemRow,
  TextBlock,
  ThinkingBlock,
  ThreadRuntime,
  ToolBlock,
  WireUsage,
  UsageSnapshot,
} from "./types";

export function cloneThread(t: ThreadRuntime): ThreadRuntime {
  return {
    ...t,
    rows: [...t.rows],
    messages: { ...t.messages },
    toolOwners: { ...t.toolOwners },
    queue: { steering: [...t.queue.steering], followUp: [...t.queue.followUp], liveSteered: t.queue.liveSteered },
    dialogs: [...t.dialogs],
    notifications: [...t.notifications],
    statuses: [...t.statuses],
    widgets: [...t.widgets],
    commands: [...t.commands],
    models: [...t.models],
    levels: [...t.levels],
    todoPhases: t.todoPhases.map((phase) => ({ ...phase, tasks: phase.tasks.map((task) => ({ ...task })) })),
    stats: { ...t.stats, tokens: { ...t.stats.tokens } },
    tokens: { ...t.tokens },
    spark: [...t.spark],
    unknown: { ...t.unknown, counts: { ...t.unknown.counts }, ring: [...t.unknown.ring], loggedTypes: [...t.unknown.loggedTypes] },
    protocolLog: [...t.protocolLog],
    hydration: { ...t.hydration },
    fieldAnswers: t.fieldAnswers.map((entry) => ({ ...entry })),
    restoredInput: t.restoredInput ? { ...t.restoredInput, images: t.restoredInput.images.map((image) => ({ ...image })) } : null,
    turnStamps: [...t.turnStamps],
    meta: t.meta ? { ...t.meta } : null,
    model: t.model ? { ...t.model } : null,
    activeCompaction: t.activeCompaction,
    activeRetry: t.activeRetry,
  };
}

export function bump(record: MessageRecord): MessageRecord {
  return { ...record, version: record.version + 1 };
}

export function putRecord(t: ThreadRuntime, record: MessageRecord): void {
  if (!t.messages[record.key]) t.rows.push(record.key);
  t.messages[record.key] = record;
}

export function updateRecord(
  t: ThreadRuntime,
  key: string,
  update: (record: MessageRecord) => MessageRecord,
): void {
  const current = t.messages[key];
  if (!current) return;
  const next = update(current);
  if (next !== current) {
    next.version = current.version + 1;
    t.messages[key] = next;
  }
}

export function nextSeq(t: ThreadRuntime): number {
  t.seq += 1;
  return t.seq;
}

export function systemKey(t: ThreadRuntime, prefix: string): string {
  return `sys:${prefix}:${nextSeq(t)}`;
}

export function pushSystemRow(
  t: ThreadRuntime,
  row: SystemRow,
  options: { key?: string; timestamp?: number | null } = {},
): string {
  const key = options.key ?? systemKey(t, row.label);
  const existing = t.messages[key];
  if (existing) {
    updateRecord(t, key, (record) => ({
      ...record,
      system: row,
      timestamp: options.timestamp ?? record.timestamp,
      streaming: row.tone === "warn" && !row.summary.endsWith("…") ? false : record.streaming,
    }));
    return key;
  }
  const record: MessageRecord = {
    key,
    id: null,
    role: "system",
    lane: "system",
    turn: t.turn,
    seq: nextSeq(t),
    timestamp: options.timestamp ?? null,
    version: 0,
    streaming: row.tone === "warn",
    blocks: [],
    source: "system",
    system: row,
  };
  putRecord(t, record);
  return key;
}

export function updateSystemRow(t: ThreadRuntime, key: string, row: Partial<SystemRow>): void {
  const current = t.messages[key];
  if (!current?.system) return;
  updateRecord(t, key, (record) => ({
    ...record,
    streaming: row.tone === "warn" && !!row.summary?.endsWith("…"),
    system: { ...record.system!, ...row },
  }));
}

export function textBlock(text = "", streaming = false): TextBlock {
  return { kind: "text", text, chunks: [], streaming, started: true };
}

export function thinkingBlock(text = "", streaming = false): ThinkingBlock {
  return { kind: "thinking", text, chunks: [], streaming, started: true };
}

export function toolBlock(id: string, name: string): ToolBlock {
  return {
    kind: "tool",
    callId: id,
    name: name || "tool",
    args: {},
    partialArgs: "",
    argsText: "",
    state: "running",
    output: "",
    details: null,
    isError: false,
    images: [],
    startedAt: null,
    endedAt: null,
    durationMs: null,
    streaming: true,
  };
}

export function imagesFromContent(
  content: ContentBlock[] | string | undefined,
): { mimeType: string; data: string; width?: number; height?: number }[] {
  if (!Array.isArray(content)) return [];
  const images: { mimeType: string; data: string; width?: number; height?: number }[] = [];
  for (const block of content) {
    if (block?.type !== "image" || typeof block.data !== "string") continue;
    images.push({
      mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/jpeg",
      data: block.data,
      width: typeof block.width === "number" ? block.width : undefined,
      height: typeof block.height === "number" ? block.height : undefined,
    });
  }
  return images;
}

export function blocksFromContent(content: ContentBlock[] | string | undefined): Block[] {
  if (typeof content === "string") return [textBlock(content)];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      blocks.push(textBlock(typeof block.text === "string" ? block.text : ""));
    } else if (block.type === "thinking") {
      const text = typeof block.thinking === "string" ? block.thinking : typeof block.text === "string" ? block.text : "";
      blocks.push(thinkingBlock(text));
    } else if (block.type === "toolCall") {
      const args = (block.arguments && typeof block.arguments === "object" ? block.arguments : {}) as Record<string, unknown>;
      const tool = toolBlock(typeof block.id === "string" ? block.id : "", typeof block.name === "string" ? block.name : "");
      tool.args = args;
      tool.partialArgs = typeof block.partialArgs === "string" ? block.partialArgs : "";
      tool.argsText = tool.partialArgs || safeJson(args);
      tool.streaming = !block.id;
      blocks.push(tool);
    } else {
      blocks.push(textBlock(safeJson(block)));
    }
  }
  return blocks;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function usageSnapshot(usage: WireUsage | undefined): UsageSnapshot {
  if (!usage) return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  const total =
    usage.totalTokens ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const cost = usage.cost
    ? usage.cost.total ??
      (usage.cost.input ?? 0) + (usage.cost.output ?? 0) + (usage.cost.cacheRead ?? 0) + (usage.cost.cacheWrite ?? 0)
    : 0;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    reasoning: usage.reasoning ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    total,
    cost,
  };
}

export function addUsage(base: UsageSnapshot, delta: UsageSnapshot): UsageSnapshot {
  return {
    input: base.input + delta.input,
    output: base.output + delta.output,
    reasoning: base.reasoning + delta.reasoning,
    cacheRead: base.cacheRead + delta.cacheRead,
    cacheWrite: base.cacheWrite + delta.cacheWrite,
    total: base.total + delta.total,
    cost: base.cost + delta.cost,
  };
}

export function contentText(content: ContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

export function wireQueueImages(value: unknown): QueueImage[] {
  if (!Array.isArray(value)) return [];
  const images: QueueImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; mimeType?: unknown; data?: unknown };
    if (record.type !== "image") continue;
    if (typeof record.mimeType !== "string" || typeof record.data !== "string") continue;
    images.push({ mimeType: record.mimeType, data: record.data });
  }
  return images;
}

export function queueItem(kind: QueueKind, raw: unknown, index: number): QueueItem | null {
  if (typeof raw === "string") {
    return raw.trim() ? { id: `${kind}:${index}:${raw}`, kind, text: raw, images: [] } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as {
    message?: unknown;
    text?: unknown;
    content?: unknown;
    images?: unknown;
    id?: unknown;
  };
  let text = "";
  if (typeof record.message === "string") text = record.message;
  else if (typeof record.text === "string") text = record.text;
  else if (typeof record.content === "string") text = record.content;
  else if (Array.isArray(record.content)) text = contentText(record.content as ContentBlock[]);
  const images = wireQueueImages(record.images);
  if (!text.trim() && images.length === 0) return null;
  const id = typeof record.id === "string" ? record.id : `${kind}:${index}:${text}`;
  return { id, kind, text, images };
}

export function queueList(kind: QueueKind, raw: unknown): QueueItem[] {
  if (!Array.isArray(raw)) return [];
  const items: QueueItem[] = [];
  raw.forEach((entry, index) => {
    const item = queueItem(kind, entry, index);
    if (item) items.push(item);
  });
  return items;
}
