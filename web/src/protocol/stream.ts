import type {
  AssistantEvent,
  Block,
  ContentBlock,
  MessageRecord,
  RawFrame,
  ThreadRuntime,
  ToolBlock,
  WireMessage,
} from "./types";
import {
  addUsage,
  blocksFromContent,
  contentText,
  imagesFromContent,
  putRecord,
  safeJson,
  textBlock,
  thinkingBlock,
  toolBlock,
  updateRecord,
  usageSnapshot,
  wireQueueImages,
} from "./records";

type Frame = RawFrame & { [key: string]: unknown };

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function messageRecordId(frame: Frame): string | null {
  const id = frame.messageId;
  return typeof id === "string" && id ? id : null;
}

export function ensureMessageRecord(t: ThreadRuntime, id: string | null, wire?: WireMessage): MessageRecord {
  const key = id ?? `live:${t.seq + 1}`;
  const existing = t.messages[key];
  const role = (wire?.role as MessageRecord["role"]) ?? existing?.role ?? "assistant";
  const lane = role === "user" ? "you" : role === "toolResult" ? "tool" : role === "system" ? "system" : "assistant";
  if (existing) return existing;
  const record: MessageRecord = {
    key,
    id,
    role,
    lane,
    turn: t.turn || 1,
    seq: t.seq + 1,
    timestamp: typeof wire?.timestamp === "number" ? wire.timestamp : null,
    version: 0,
    streaming: role === "assistant",
    blocks: blocksFromContent(wire?.content),
    images: imagesFromContent(wire?.content),
    source: "live",
  };
  t.seq += 1;
  applyWireMeta(record, wire);
  putRecord(t, record);
  registerToolOwners(t, record);
  return record;
}

function applyWireMeta(record: MessageRecord, wire?: WireMessage): void {
  if (!wire) return;
  if (typeof wire.model === "string") record.model = wire.model;
  if (typeof wire.provider === "string") record.provider = wire.provider;
  if (typeof wire.timestamp === "number") record.timestamp = wire.timestamp;
  if (wire.usage) record.usage = usageSnapshot(wire.usage);
  if (typeof wire.stopReason === "string") record.stopReason = wire.stopReason;
  if (typeof wire.duration === "number") record.durationMs = wire.duration;
  if (typeof wire.ttft === "number") record.ttftMs = wire.ttft;
  if (typeof wire.toolCallId === "string") record.toolCallId = wire.toolCallId;
  if (typeof wire.toolName === "string") record.toolName = wire.toolName;
  if (typeof wire.isError === "boolean") record.isError = wire.isError;
  if (wire.details !== undefined) record.details = wire.details;
}

function registerToolOwners(t: ThreadRuntime, record: MessageRecord): void {
  record.blocks.forEach((block, index) => {
    if (block.kind === "tool" && block.callId) t.toolOwners[block.callId] = { key: record.key, index };
  });
}

export function mergeFullContent(record: MessageRecord, wire: WireMessage): MessageRecord {
  const images = imagesFromContent(wire.content);
  if (images.length > 0) record = { ...record, images };
  const incoming = blocksFromContent(wire.content);
  if (incoming.length === 0 && record.blocks.length > 0) return record;
  const merged: Block[] = [];
  const used = new Set<number>();
  incoming.forEach((block, index) => {
    const candidateIndex = record.blocks.findIndex((current, currentIndex) => {
      if (used.has(currentIndex)) return false;
      if (current.kind !== block.kind) return false;
      if (block.kind === "tool" && current.kind === "tool") return current.callId === block.callId;
      return currentIndex === index;
    });
    if (candidateIndex < 0) {
      merged.push(block);
      return;
    }
    used.add(candidateIndex);
    const current = record.blocks[candidateIndex];
    if (current.kind === "text" && block.kind === "text") {
      const text = block.text.length >= current.text.length ? block.text : current.text;
      merged.push({ ...current, text, chunks: [], streaming: current.streaming && current.text === block.text });
    } else if (current.kind === "thinking" && block.kind === "thinking") {
      const text = block.text.length >= current.text.length ? block.text : current.text;
      merged.push({ ...current, text, chunks: [], streaming: current.streaming && current.text === block.text });
    } else if (current.kind === "tool" && block.kind === "tool") {
      merged.push({
        ...current,
        name: block.name || current.name,
        args: Object.keys(block.args).length > 0 || block.argsText ? block.args : current.args,
        partialArgs: block.partialArgs || current.partialArgs,
        argsText: block.partialArgs || block.argsText || current.argsText,
        streaming: current.streaming,
      });
    }
  });
  record.blocks.forEach((block, index) => {
    if (!used.has(index)) merged.push(block);
  });
  return { ...record, blocks: merged };
}

function indexFor(blocks: Block[], contentIndex: number | null): number {
  if (contentIndex === null || contentIndex < 0) return blocks.length - 1;
  return Math.min(contentIndex, blocks.length);
}

function blockAt(blocks: Block[], index: number): Block | undefined {
  return blocks[index];
}

function replaceBlock(blocks: Block[], index: number, block: Block): Block[] {
  const next = [...blocks];
  if (index >= next.length) next.push(block);
  else next[index] = block;
  return next;
}

function toolAt(blocks: Block[], callId: string | null, index: number): number {
  if (callId) {
    const found = blocks.findIndex((block) => block.kind === "tool" && block.callId === callId);
    if (found >= 0) return found;
  }
  return index;
}

function eventBlock(event: AssistantEvent): Partial<ToolBlock> & { callId?: string } {
  const raw = (event.block ?? event.toolCall) as Record<string, unknown> | undefined;
  if (!raw) return {};
  return {
    callId: typeof raw.id === "string" ? raw.id : undefined,
    name: typeof raw.name === "string" ? raw.name : undefined,
    args: (raw.arguments && typeof raw.arguments === "object" ? raw.arguments : {}) as Record<string, unknown>,
    partialArgs: typeof raw.partialArgs === "string" ? raw.partialArgs : undefined,
  };
}

export function handleMessageStart(t: ThreadRuntime, frame: Frame): void {
  const wire = frame.message as WireMessage | undefined;
  const id = messageRecordId(frame);
  const role = wire?.role;
  if (!role) return;
  const existing = id ? t.messages[id] : undefined;
  if (role === "user") t.turn = Math.max(t.turn, 1);
  if (existing) {
    updateRecord(t, existing.key, (record) => {
      const next = mergeFullContent(record, wire);
      applyWireMeta(next, wire);
      next.role = role as MessageRecord["role"];
      next.lane = role === "user" ? "you" : role === "toolResult" ? "tool" : role === "system" ? "system" : "assistant";
      next.streaming = role === "assistant";
      return next;
    });
    registerToolOwners(t, t.messages[existing.key]);
    return;
  }
  const record = ensureMessageRecord(t, id, wire);
  record.role = role as MessageRecord["role"];
  record.lane = role === "user" ? "you" : role === "toolResult" ? "tool" : role === "system" ? "system" : "assistant";
  record.turn = t.turn || 1;
  record.streaming = role === "assistant";
  record.version += 1;
  if (role === "assistant") t.streaming = true;
}

export function applyAssistantEvent(t: ThreadRuntime, key: string, event: AssistantEvent): void {
  updateRecord(t, key, (record) => {
    const contentIndex = num(event.contentIndex);
    let blocks = record.blocks;
    switch (event.type) {
      case "text_start": {
        const index = indexFor(blocks, contentIndex);
        const existing = blockAt(blocks, index);
        if (existing?.kind === "text") {
          blocks = replaceBlock(blocks, index, { ...existing, started: true, streaming: true });
        } else {
          const initial = (event.block as { text?: unknown } | undefined)?.text;
          blocks = replaceBlock(blocks, index, textBlock(typeof initial === "string" ? initial : "", true));
        }
        break;
      }
      case "text_delta": {
        const index = indexFor(blocks, contentIndex);
        const existing = blockAt(blocks, index);
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (existing?.kind === "text") {
          blocks = replaceBlock(blocks, index, {
            ...existing,
            chunks: [...existing.chunks, delta],
            streaming: true,
            started: true,
          });
        } else {
          blocks = replaceBlock(blocks, index, textBlock(delta, true));
        }
        break;
      }
      case "text_end": {
        const index = indexFor(blocks, contentIndex);
        const existing = blockAt(blocks, index);
        const content = typeof event.content === "string" ? event.content : "";
        if (existing?.kind === "text") {
          const streamed = existing.chunks.join("");
          const text = content || existing.text || streamed;
          blocks = replaceBlock(blocks, index, { ...existing, text, chunks: [], streaming: false, started: true });
        } else {
          blocks = replaceBlock(blocks, index, textBlock(content, false));
        }
        break;
      }
      case "thinking_start": {
        const index = indexFor(blocks, contentIndex);
        const existing = blockAt(blocks, index);
        blocks =
          existing?.kind === "thinking"
            ? replaceBlock(blocks, index, { ...existing, started: true, streaming: true })
            : replaceBlock(blocks, index, thinkingBlock("", true));
        break;
      }
      case "thinking_delta": {
        const index = indexFor(blocks, contentIndex);
        const existing = blockAt(blocks, index);
        const delta = typeof event.delta === "string" ? event.delta : "";
        blocks =
          existing?.kind === "thinking"
            ? replaceBlock(blocks, index, { ...existing, chunks: [...existing.chunks, delta], streaming: true, started: true })
            : replaceBlock(blocks, index, thinkingBlock(delta, true));
        break;
      }
      case "thinking_end": {
        const index = indexFor(blocks, contentIndex);
        const existing = blockAt(blocks, index);
        const content = typeof event.content === "string" ? event.content : "";
        if (existing?.kind === "thinking") {
          const streamed = existing.chunks.join("");
          blocks = replaceBlock(blocks, index, {
            ...existing,
            text: content || existing.text || streamed,
            chunks: [],
            streaming: false,
            started: true,
          });
        } else {
          blocks = replaceBlock(blocks, index, thinkingBlock(content, false));
        }
        break;
      }
      case "toolcall_start": {
        const detail = eventBlock(event);
        const callId = detail.callId ?? `pending:${record.key}:${contentIndex ?? blocks.length}`;
        const name = detail.name ?? "tool";
        const index = toolAt(blocks, detail.callId ?? null, contentIndex ?? blocks.length);
        const existing = blockAt(blocks, index);
        if (existing?.kind === "tool" && existing.callId === callId) {
          blocks = replaceBlock(blocks, index, { ...existing, streaming: true, name: name || existing.name });
        } else {
          const created = toolBlock(callId, name);
          created.args = detail.args ?? {};
          created.partialArgs = detail.partialArgs ?? "";
          created.argsText = created.partialArgs;
          blocks = replaceBlock(blocks, index, created);
        }
        if (detail.callId) {
          t.toolOwners[detail.callId] = { key, index };
          adoptSynthetic(t, detail.callId, key, index);
        }
        break;
      }
      case "toolcall_delta": {
        const index = toolAt(blocks, null, contentIndex ?? blocks.length - 1);
        const existing = blockAt(blocks, index);
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (existing?.kind === "tool") {
          blocks = replaceBlock(blocks, index, {
            ...existing,
            partialArgs: existing.partialArgs + delta,
            argsText: existing.partialArgs + delta,
            streaming: true,
          });
        }
        break;
      }
      case "toolcall_end": {
        const detail = eventBlock(event);
        const index = toolAt(blocks, detail.callId ?? null, contentIndex ?? blocks.length - 1);
        const existing = blockAt(blocks, index);
        if (existing?.kind === "tool") {
          blocks = replaceBlock(blocks, index, {
            ...existing,
            callId: detail.callId ?? existing.callId,
            name: detail.name ?? existing.name,
            args: detail.args && Object.keys(detail.args).length > 0 ? detail.args : existing.args,
            partialArgs: detail.partialArgs ?? existing.partialArgs,
            argsText: detail.partialArgs || existing.argsText,
            streaming: false,
          });
          if (detail.callId) {
            t.toolOwners[detail.callId] = { key, index };
            adoptSynthetic(t, detail.callId, key, index);
          }
        }
        break;
      }
      case "done": {
        blocks = blocks.map((block) => (block.kind === "tool" ? { ...block, streaming: false } : block));
        break;
      }
      case "error": {
        const message = typeof event.error === "string" ? event.error : "assistant error";
        const retryable = "retryable" in event && event.retryable === true;
        record = { ...record, error: message, retryable };
        break;
      }
      default:
        break;
    }
    const next = { ...record, blocks, streaming: true };
    if (event.message && typeof event.message === "object") {
      const partial = mergeFullContent(next, event.message as WireMessage);
      if (partial.usage) {
        next.usage = partial.usage;
      }
      return { ...partial, version: next.version };
    }
    return next;
  });
  const record = t.messages[key];
  if (record && record.blocks.length > 0 && record.lane === "assistant") {
    t.streaming = true;
  }
}

export function adoptSynthetic(t: ThreadRuntime, callId: string, ownerKey: string, ownerIndex: number): void {
  const synthKey = `exec:${callId}`;
  const synthetic = t.messages[synthKey];
  if (!synthetic) return;
  const owner = t.messages[ownerKey];
  const block = owner?.blocks[ownerIndex];
  if (owner && block?.kind === "tool") {
    const syntheticBlock = synthetic.blocks.find((entry): entry is ToolBlock => entry.kind === "tool");
    if (syntheticBlock) {
      const blocks = [...owner.blocks];
      blocks[ownerIndex] = {
        ...block,
        output: syntheticBlock.output || block.output,
        details: syntheticBlock.details ?? block.details,
        images: syntheticBlock.images.length > 0 ? syntheticBlock.images : block.images,
        state: syntheticBlock.state === "done" ? "done" : block.state,
        durationMs: syntheticBlock.durationMs ?? block.durationMs,
      };
      t.messages[ownerKey] = { ...owner, blocks, version: owner.version + 1 };
    }
  }
  delete t.messages[synthKey];
  t.rows = t.rows.filter((row) => row !== synthKey);
}

export function handleMessageUpdate(t: ThreadRuntime, frame: Frame): void {
  const id = messageRecordId(frame);
  const event = frame.assistantMessageEvent as AssistantEvent | undefined;
  const wire = frame.message as WireMessage | undefined;
  const record = ensureMessageRecord(t, id, wire);
  const key = record.key;
  if (event && typeof event.type === "string") {
    applyAssistantEvent(t, key, event);
  } else if (wire && Array.isArray(wire.content)) {
    updateRecord(t, key, (current) => {
      const merged = mergeFullContent(current, wire);
      applyWireMeta(merged, wire);
      return { ...merged, streaming: true };
    });
  }
  if (wire?.timestamp) {
    updateRecord(t, key, (current) => ({ ...current, timestamp: current.timestamp ?? wire.timestamp! }));
  }
  if (t.messages[key]?.usage) {
    const usage = t.messages[key].usage!;
    t.spark.push({ at: t.seq, tokens: Math.max(1, Math.round((event?.delta?.length ?? 0) / 4)) });
    if (t.spark.length > 240) t.spark.splice(0, t.spark.length - 240);
    if (usage.total > t.tokens.total) t.tokens = { ...usage };
  }
}

export function handleMessageEnd(t: ThreadRuntime, frame: Frame): void {
  const wire = frame.message as WireMessage | undefined;
  const id = messageRecordId(frame);
  const record = ensureMessageRecord(t, id, wire);
  const wasStreaming = record.streaming;
  updateRecord(t, record.key, (current) => {
    let next = wire ? mergeFullContent(current, wire) : current;
    applyWireMeta(next, wire);
    next = { ...next, streaming: false, timestamp: next.timestamp ?? (wire?.timestamp ?? null) };
    if (next.role === "toolResult") {
      next.blocks = [];
      next.toolName = next.toolName ?? wire?.toolName;
      next.toolCallId = next.toolCallId ?? wire?.toolCallId;
      next.isError = wire?.isError ?? next.isError ?? false;
      next.details = wire?.details ?? next.details;
      next.blocks = [{ kind: "text", text: contentText(wire?.content), chunks: [], streaming: false, started: true }];
    }
    return next;
  });
  const final = t.messages[record.key];
  if (id) t.toolOwners[id] = t.toolOwners[id] ?? { key: record.key, index: 0 };
  if (final?.role === "assistant") {
    if (wasStreaming && final.usage) {
      t.tokens = addUsage(t.tokens, final.usage);
      t.cost = t.tokens.cost;
      t.stats.tokens = { ...t.tokens };
      t.stats.cost = t.cost;
      const window = t.model?.contextWindow ?? t.contextUsage?.contextWindow ?? 0;
      const used = final.usage.input + final.usage.output + final.usage.cacheRead;
      if (window > 0 && used > 0) {
        t.contextUsage = { tokens: used, contextWindow: window, percent: (used / window) * 100 };
      }
    }
    t.streaming = false;
    t.settled = false;
    t.messageCount += 1;
    t.stats.assistantMessages += 1;
    t.stats.totalMessages += 1;
  } else if (final?.role === "toolResult") {
    t.stats.toolResults += 1;
  } else if (final?.role === "user") {
    t.stats.userMessages += 1;
  }
  t.stats.messageCount = t.messageCount;
}

export function findTool(t: ThreadRuntime, callId: string): { key: string; index: number } | null {
  const owner = t.toolOwners[callId];
  if (owner && t.messages[owner.key]) return owner;
  return null;
}

function toolPatch(
  t: ThreadRuntime,
  callId: string,
  patch: (block: ToolBlock) => ToolBlock,
): void {
  const owner = findTool(t, callId);
  if (!owner) return;
  const record = t.messages[owner.key];
  const block = record.blocks[owner.index];
  if (!block || block.kind !== "tool") return;
  const blocks = [...record.blocks];
  blocks[owner.index] = patch(block);
  t.messages[owner.key] = { ...record, blocks, version: record.version + 1 };
}

function ensureExecutionRecord(t: ThreadRuntime, callId: string, name: string, args: unknown): void {
  if (findTool(t, callId)) return;
  const key = `exec:${callId}`;
  if (t.messages[key]) return;
  const block = toolBlock(callId, name);
  block.args = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  block.argsText = safeJson(block.args);
  const record: MessageRecord = {
    key,
    id: callId,
    role: "toolResult",
    lane: "tool",
    turn: t.turn || 1,
    seq: t.seq + 1,
    timestamp: null,
    version: 0,
    streaming: true,
    blocks: [block],
    source: "live",
    toolCallId: callId,
    toolName: name,
  };
  t.seq += 1;
  putRecord(t, record);
}

export function handleToolStart(t: ThreadRuntime, frame: Frame): void {
  const callId = string(frame.toolCallId);
  if (!callId) return;
  const name = string(frame.toolName) ?? "tool";
  const args = frame.args;
  ensureExecutionRecord(t, callId, name, args);
  toolPatch(t, callId, (block) => ({
    ...block,
    name,
    args: (args && typeof args === "object" ? args : block.args) as Record<string, unknown>,
    argsText: safeJson(args ?? block.args),
    state: "running",
    streaming: true,
    startedAt: block.startedAt ?? t.seq,
  }));
}

export function handleToolUpdate(t: ThreadRuntime, frame: Frame): void {
  const callId = string(frame.toolCallId);
  if (!callId) return;
  const partial = frame.partialResult as { content?: ContentBlock[]; details?: unknown } | undefined;
  const output = contentText(partial?.content);
  const images = Array.isArray(partial?.content)
    ? wireQueueImages(
        partial.content
          .filter((block) => block.type === "image")
          .map((block) => ({ type: "image", mimeType: block.mimeType, data: block.data })),
      )
    : [];
  toolPatch(t, callId, (block) => ({
    ...block,
    output: output || block.output,
    details: partial?.details ?? block.details,
    images: images.length > 0 ? images : block.images,
    state: "running",
    streaming: true,
  }));
}

export function handleToolEnd(t: ThreadRuntime, frame: Frame): void {
  const callId = string(frame.toolCallId);
  if (!callId) return;
  const result = frame.result as { content?: ContentBlock[]; details?: unknown } | undefined;
  const output = contentText(result?.content);
  const details = (result?.details ?? {}) as { wallTimeMs?: unknown };
  const wall = num(details.wallTimeMs);
  const isError = frame.isError === true;
  const images = Array.isArray(result?.content)
    ? wireQueueImages(
        result.content
          .filter((block) => block.type === "image")
          .map((block) => ({ type: "image", mimeType: block.mimeType, data: block.data })),
      )
    : [];
  toolPatch(t, callId, (block) => ({
    ...block,
    output: output || block.output,
    details: result?.details ?? block.details,
    images: images.length > 0 ? images : block.images,
    state: isError ? "error" : "done",
    isError,
    streaming: false,
    endedAt: t.seq,
    durationMs: wall ?? block.durationMs,
  }));
  const owner = findTool(t, callId);
  if (owner) {
    const record = t.messages[owner.key];
    const block = record.blocks[owner.index];
    if (block && block.kind === "tool" && block.callId.startsWith("pending:")) {
      const blocks = [...record.blocks];
      blocks[owner.index] = { ...block, callId };
      t.messages[owner.key] = { ...record, blocks, version: record.version + 1 };
      t.toolOwners[callId] = owner;
    }
  }
  t.stats.toolCalls += 1;
}

export function hydrateAssistantFromWire(record: MessageRecord, wire: WireMessage): MessageRecord {
  const blocks = blocksFromContent(wire.content);
  const merged = { ...record, blocks: blocks.length > 0 ? blocks : record.blocks };
  applyWireMeta(merged, wire);
  merged.streaming = false;
  return merged;
}
