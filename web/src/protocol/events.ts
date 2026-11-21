import type {
  DialogRequest,
  ModelInfo,
  RawFrame,
  ThreadRuntime,
  TodoPhase,
  WireMessage,
  WireUsage,
} from "./types";
import { parseApproval } from "./dialogs";
import {
  nextSeq,
  pushSystemRow,
  queueList,
  updateSystemRow,
  usageSnapshot,
} from "./records";
import { formatDuration, formatTokens } from "./format";

type Frame = RawFrame & { [key: string]: unknown };

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function handleReady(t: ThreadRuntime, frame: Frame): void {
  const version = typeof frame.protocolVersion === "number" ? frame.protocolVersion : 1;
  t.protocolLog.push({ id: "ready", level: "info", message: `child ready · protocol v${version}` });
}

export function handleAgentStart(t: ThreadRuntime): void {
  t.agentActive = true;
  t.streaming = true;
  t.settled = false;
}

export function handleAgentEnd(t: ThreadRuntime, frame: Frame): void {
  t.agentActive = false;
  t.streaming = false;
  const messages = Array.isArray(frame.messages) ? frame.messages : null;
  if (messages) {
    t.messageCount = messages.length;
    t.stats.messageCount = messages.length;
    t.stats.totalMessages = Math.max(t.stats.totalMessages, messages.length);
  }
  const last = [...t.rows].reverse().map((key) => t.messages[key]).find((record) => record?.role === "assistant");
  if (last?.usage && last.usage.total > t.tokens.total) {
    t.tokens = { ...last.usage };
    t.cost = last.usage.cost;
  }
}

export function handleTurnStart(t: ThreadRuntime): void {
  t.turn += 1;
  t.streaming = true;
  t.settled = false;
}

export function handleTurnEnd(t: ThreadRuntime, frame: Frame): void {
  const wire = frame.message as WireMessage | undefined;
  const duration = typeof wire?.duration === "number" ? wire.duration : null;
  const stopReason = typeof wire?.stopReason === "string" ? wire.stopReason : null;
  const summary = duration !== null ? formatDuration(duration) : "";
  const body = stopReason ? `stop reason: ${stopReason}` : "";
  const stamp = typeof wire?.timestamp === "number" ? wire.timestamp : null;
  if (stamp !== null && t.turnStamps.includes(stamp)) {
    // A replayed ring sends the same turn again: drop the extra rule and undo the increment.
    const key = `sys:turn:${t.turn}`;
    delete t.messages[key];
    t.rows = t.rows.filter((row) => row !== key);
    t.turn = Math.max(0, t.turn - 1);
    t.streaming = false;
    return;
  }
  if (stamp !== null) t.turnStamps.push(stamp);
  pushSystemRow(
    t,
    { label: "turn", summary, body, tone: "info", kind: "turn" },
    { key: `sys:turn:${t.turn}`, timestamp: stamp },
  );
  t.streaming = false;
}

export function handleSettled(t: ThreadRuntime): void {
  t.settled = true;
  t.streaming = false;
  t.agentActive = false;
  pushSystemRow(
    t,
    { label: "settled", summary: "waiting for input", tone: "ok", kind: "settled" },
    { key: "sys:settled" },
  );
}

export function handlePromptResult(t: ThreadRuntime, frame: Frame): void {
  const status = str(frame.status) ?? "unknown";
  t.lastPrompt = { status, agentInvoked: frame.agentInvoked === true };
  if (status !== "completed") {
    pushSystemRow(
      t,
      {
        label: "prompt",
        summary: `prompt ${status}`,
        body: str(frame.error) ?? undefined,
        tone: status === "aborted" ? "warn" : "err",
        kind: "prompt",
      },
      { key: `sys:prompt:${nextSeq(t)}` },
    );
  }
}

export function handleQueueUpdate(t: ThreadRuntime, frame: Frame): void {
  const queued = rec(frame.queuedMessages) ?? frame;
  const steeringRaw = queued.steering;
  const followRaw = queued.followUp;
  t.queue = {
    steering: queueList("steer", steeringRaw),
    followUp: queueList("followUp", followRaw),
    liveSteered: typeof queued.liveSteered === "number" ? queued.liveSteered : t.queue.liveSteered,
  };
}

export function handleModelChanged(t: ThreadRuntime, frame: Frame): void {
  const model = rec(frame.model);
  if (model && typeof model.id === "string") {
    t.model = {
      id: model.id,
      provider: typeof model.provider === "string" ? model.provider : (t.model?.provider ?? ""),
      name: typeof model.name === "string" ? model.name : model.id,
      reasoning: model.reasoning === true,
      contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
    };
  } else {
    const id = str(frame.model);
    const name = str(frame.modelName);
    if (id) {
      t.model = {
        id,
        provider: str(frame.provider) ?? t.model?.provider ?? "",
        name: name ?? id,
        reasoning: t.model?.reasoning,
        contextWindow: t.model?.contextWindow,
      };
    }
  }
  if (typeof frame.thinkingLevel === "string") t.thinkingLevel = frame.thinkingLevel;
}

export function handleThinkingChanged(t: ThreadRuntime, frame: Frame): void {
  const level = str(frame.level) ?? str(frame.thinkingLevel);
  if (level) t.thinkingLevel = level;
}

export function handleSessionInfo(t: ThreadRuntime, frame: Frame): void {
  if (typeof frame.title === "string") t.title = frame.title;
  if (typeof frame.sessionId === "string") t.sessionId = frame.sessionId;
  if (typeof frame.sessionName === "string") t.sessionName = frame.sessionName;
}

export function handleCommands(t: ThreadRuntime, frame: Frame): void {
  const commands = Array.isArray(frame.commands) ? frame.commands : [];
  t.commands = commands.filter((entry): entry is ThreadRuntime["commands"][number] => {
    const item = rec(entry);
    return !!item && typeof item.name === "string";
  }) as ThreadRuntime["commands"];
}

export function handleConfig(t: ThreadRuntime, frame: Frame): void {
  if (typeof frame.autoCompactionEnabled === "boolean") t.autoCompaction = frame.autoCompactionEnabled;
  if (typeof frame.thinkingLevel === "string") t.thinkingLevel = frame.thinkingLevel;
  const model = rec(frame.model);
  if (model && typeof model.id === "string") {
    t.model = {
      id: model.id,
      provider: str(model.provider) ?? t.model?.provider ?? "",
      name: str(model.name) ?? model.id,
      reasoning: model.reasoning === true,
      contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : t.model?.contextWindow,
    };
  }
}

export function handleNotice(t: ThreadRuntime, frame: Frame): void {
  const level = str(frame.level) ?? "info";
  const message = str(frame.message) ?? "";
  pushSystemRow(
    t,
    {
      label: "notice",
      summary: message,
      tone: level === "error" ? "err" : level === "warn" ? "warn" : "info",
      kind: "notice",
    },
    { key: `sys:notice:${nextSeq(t)}` },
  );
}

export function handleRetryStart(t: ThreadRuntime, frame: Frame): void {
  const attempt = typeof frame.attempt === "number" ? frame.attempt : 1;
  const max = typeof frame.maxAttempts === "number" ? frame.maxAttempts : 5;
  const delay = typeof frame.delayMs === "number" ? frame.delayMs : null;
  const error = str(frame.errorMessage) ?? str(frame.error) ?? "provider error";
  const key = `sys:retry:${nextSeq(t)}`;
  pushSystemRow(
    t,
    {
      label: "retry",
      summary: `retry ${attempt}/${max} · ${error}${delay ? ` · in ${Math.round(delay / 1000)}s` : ""}`,
      body: error,
      tone: "warn",
      kind: "retry",
    },
    { key },
  );
  t.retry = { attempt, maxAttempts: max, message: error, delayMs: delay };
  t.activeRetry = key;
}

export function handleRetryEnd(t: ThreadRuntime, frame: Frame): void {
  const attempt = typeof frame.attempt === "number" ? frame.attempt : t.retry?.attempt ?? 1;
  const success = frame.success !== false && !str(frame.errorMessage);
  if (t.activeRetry) {
    updateSystemRow(t, t.activeRetry, {
      summary: success ? `retry ${attempt} succeeded` : `retry ${attempt} failed`,
      tone: success ? "ok" : "err",
      body: str(frame.errorMessage) ?? undefined,
    });
  }
  t.retry = null;
  t.activeRetry = null;
}

function compactionStart(t: ThreadRuntime, frame: Frame, label: string, title: string): void {
  const key = `sys:${label}:${nextSeq(t)}`;
  pushSystemRow(
    t,
    {
      label,
      summary: `${title}…`,
      body: str(frame.reason) ?? undefined,
      tone: "warn",
      kind: "compaction",
    },
    { key },
  );
  t.compacting = true;
  t.activeCompaction = key;
}

function compactionEnd(t: ThreadRuntime, frame: Frame, label: string): void {
  const key = t.activeCompaction ?? `sys:${label}:${nextSeq(t)}`;
  const before = typeof frame.tokensBefore === "number" ? frame.tokensBefore : null;
  const after = typeof frame.tokensAfter === "number" ? frame.tokensAfter : null;
  const error = str(frame.errorMessage);
  let summary = "compaction finished";
  if (before !== null && after !== null) {
    summary = `compacted · ${formatTokens(before)} → ${formatTokens(after)} tokens`;
  } else if (typeof frame.duration === "number") {
    summary = `compacted in ${formatDuration(frame.duration)}`;
  }
  if (error) summary = `compaction failed · ${error}`;
  if (t.messages[key]) {
    updateSystemRow(t, key, { summary, body: error ?? undefined, tone: error ? "err" : "ok" });
  } else {
    pushSystemRow(t, { label, summary, tone: error ? "err" : "ok", kind: "compaction" }, { key });
  }
  t.compacting = false;
  t.activeCompaction = null;
}

export function handleCompactionStart(t: ThreadRuntime, frame: Frame, manual: boolean): void {
  compactionStart(t, frame, manual ? "compaction" : "compaction", manual ? "compacting context" : "auto-compacting context");
}

export function handleCompactionEnd(t: ThreadRuntime, frame: Frame, manual: boolean): void {
  compactionEnd(t, frame, manual ? "compaction" : "compaction");
}

export function handleBranchSummary(t: ThreadRuntime, frame: Frame): void {
  pushSystemRow(
    t,
    {
      label: "branch",
      summary: str(frame.summary) ?? "branch summarized",
      body: str(frame.details) ?? undefined,
      tone: "info",
      kind: "branch",
    },
    { key: `sys:branch:${nextSeq(t)}` },
  );
}

/* -------------------------------- dialogs -------------------------------- */

function parseFieldInfo(t: ThreadRuntime, frame: Frame, options: string[] | undefined): DialogRequest["field"] {
  if (!options || !options.some((option) => /^other \(type your own\)$/i.test(option.trim()))) return undefined;
  const total = typeof frame.total === "number" ? frame.total : null;
  const index = typeof frame.index === "number" ? frame.index : t.fieldAnswers.length + 1;
  return { index, total, previous: t.fieldAnswers.map((entry) => ({ ...entry })) };
}

export function handleExtensionUi(t: ThreadRuntime, frame: Frame): void {
  const method = str(frame.method) ?? "unknown";
  const id = str(frame.id) ?? `ui:${nextSeq(t)}`;
  const normalized = method.replace(/_/g, "").toLowerCase();
  if (normalized === "select" || normalized === "confirm" || normalized === "input" || normalized === "editor" || normalized === "ask") {
    const options = Array.isArray(frame.options)
      ? frame.options.filter((option): option is string => typeof option === "string")
      : undefined;
    const optionDetails = Array.isArray(frame.optionDetails)
      ? frame.optionDetails.filter((entry): entry is { description?: string; preview?: string } => !!rec(entry))
      : undefined;
    const questions = Array.isArray(frame.questions)
      ? (frame.questions.filter((entry) => !!rec(entry)) as DialogRequest["questions"])
      : undefined;
    const request: DialogRequest = {
      id,
      method,
      title: str(frame.title) ?? undefined,
      message: str(frame.message) ?? undefined,
      options,
      optionDetails,
      placeholder: str(frame.placeholder) ?? undefined,
      secret: frame.secret === true,
      prefill: str(frame.prefill) ?? undefined,
      promptStyle: frame.promptStyle === true,
      questions,
      timeout: typeof frame.timeout === "number" ? frame.timeout : null,
      field: parseFieldInfo(t, frame, options),
    };
    request.approval = parseApproval(request) ?? undefined;
    t.dialogs.push({ request, status: "open" });
    return;
  }
  switch (normalized) {
    case "cancel": {
      const target = str(frame.targetId);
      t.dialogs = t.dialogs.map((dialog) =>
        dialog.request.id === target ? { ...dialog, status: "resolved" } : dialog,
      );
      return;
    }
    case "notify": {
      const message = str(frame.message) ?? "";
      t.notifications.push({ id, message, level: str(frame.notifyType) ?? "info" });
      if (t.notifications.length > 20) t.notifications.splice(0, t.notifications.length - 20);
      pushSystemRow(
        t,
        {
          label: "notice",
          summary: message,
          tone: frame.notifyType === "error" ? "err" : frame.notifyType === "warning" ? "warn" : "info",
          kind: "extension",
        },
        { key: `sys:notify:${id}` },
      );
      return;
    }
    case "setstatus": {
      const key = str(frame.statusKey) ?? id;
      t.statuses = [...t.statuses.filter((entry) => entry.key !== key), { key, text: str(frame.statusText) ?? "" }];
      return;
    }
    case "setwidget": {
      const key = str(frame.widgetKey) ?? id;
      const lines = Array.isArray(frame.widgetLines)
        ? frame.widgetLines.filter((line): line is string => typeof line === "string")
        : [];
      t.widgets = [
        ...t.widgets.filter((entry) => entry.key !== key),
        ...(lines.length > 0 ? [{ key, lines, placement: str(frame.widgetPlacement) ?? "aboveEditor" }] : []),
      ];
      return;
    }
    case "settitle": {
      t.title = str(frame.title) ?? t.title;
      return;
    }
    case "seteditortext": {
      t.editorText = typeof frame.text === "string" ? frame.text : null;
      return;
    }
    case "openurl": {
      const url = str(frame.url) ?? "";
      pushSystemRow(
        t,
        {
          label: "link",
          summary: str(frame.instructions) ?? url,
          body: [url, str(frame.launchUrl) ? `launch ${str(frame.launchUrl)}` : ""].filter(Boolean).join("\n"),
          tone: "info",
          kind: "url",
        },
        { key: `sys:url:${id}` },
      );
      return;
    }
    default: {
      t.protocolLog.push({ id: `ui:${id}`, level: "warn", message: `unhandled extension method “${method}”` });
      return;
    }
  }
}

/* ------------------------------ apply state ------------------------------ */

export function modelInfo(raw: unknown): ModelInfo | null {
  const model = rec(raw);
  if (!model || typeof model.id !== "string") return null;
  return {
    id: model.id,
    provider: str(model.provider) ?? "",
    name: str(model.name) ?? model.id,
    reasoning: model.reasoning === true,
    contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
    cost: rec(model.cost) as ModelInfo["cost"],
    input: Array.isArray(model.input) ? model.input.filter((entry): entry is string => typeof entry === "string") : undefined,
  };
}

export function applyState(t: ThreadRuntime, raw: unknown): void {
  const data = rec(raw);
  if (!data) return;
  const model = modelInfo(data.model);
  if (model) t.model = model;
  if (typeof data.thinkingLevel === "string") t.thinkingLevel = data.thinkingLevel;
  if (typeof data.sessionFile === "string") t.sessionFile = data.sessionFile;
  if (typeof data.sessionId === "string") t.sessionId = data.sessionId;
  if (typeof data.sessionName === "string") t.sessionName = data.sessionName;
  if (typeof data.autoCompactionEnabled === "boolean") t.autoCompaction = data.autoCompactionEnabled;
  if (typeof data.isStreaming === "boolean") t.streaming = data.isStreaming;
  if (typeof data.isCompacting === "boolean") t.compacting = data.isCompacting;
  if (typeof data.tokensPerSecond === "number") t.tokensPerSecond = data.tokensPerSecond;
  if (typeof data.messageCount === "number") {
    t.messageCount = data.messageCount;
    t.stats.messageCount = data.messageCount;
  }
  if (Array.isArray(data.todoPhases)) {
    t.todoPhases = data.todoPhases.filter((phase) => !!rec(phase)) as TodoPhase[];
  }
  const queued = rec(data.queuedMessages);
  if (queued) handleQueueUpdate(t, { type: "queue_update", ...queued });
  const context = rec(data.contextUsage);
  if (context && typeof context.percent === "number") {
    t.contextUsage = {
      tokens: typeof context.tokens === "number" ? context.tokens : 0,
      contextWindow: typeof context.contextWindow === "number" ? context.contextWindow : t.model?.contextWindow ?? 0,
      percent: context.percent,
    };
  }
}

export function applyStats(t: ThreadRuntime, raw: unknown): void {
  const data = rec(raw);
  if (!data) return;
  if (typeof data.sessionFile === "string") t.sessionFile = data.sessionFile;
  if (typeof data.sessionId === "string") t.sessionId = data.sessionId;
  t.stats = {
    ...t.stats,
    sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : t.stats.sessionFile,
    sessionId: typeof data.sessionId === "string" ? data.sessionId : t.stats.sessionId,
    userMessages: typeof data.userMessages === "number" ? data.userMessages : t.stats.userMessages,
    assistantMessages: typeof data.assistantMessages === "number" ? data.assistantMessages : t.stats.assistantMessages,
    toolCalls: typeof data.toolCalls === "number" ? data.toolCalls : t.stats.toolCalls,
    toolResults: typeof data.toolResults === "number" ? data.toolResults : t.stats.toolResults,
    totalMessages: typeof data.totalMessages === "number" ? data.totalMessages : t.stats.totalMessages,
    tokens: usageSnapshot(data.tokens as WireUsage),
    cost: typeof data.cost === "number" ? data.cost : t.stats.cost,
    premiumRequests: typeof data.premiumRequests === "number" ? data.premiumRequests : 0,
    contextUsage:
      rec(data.contextUsage) &&
      typeof (rec(data.contextUsage) as Record<string, unknown>).percent === "number"
        ? (data.contextUsage as ThreadRuntime["stats"]["contextUsage"])
        : t.stats.contextUsage,
  };
  t.tokens = { ...t.stats.tokens };
  t.cost = t.stats.cost;
  if (t.stats.contextUsage) t.contextUsage = t.stats.contextUsage;
  if (typeof data.totalMessages === "number") t.messageCount = data.totalMessages;
}
