import type { CommandInfo, QueueItem, RawFrame } from "../protocol/types";
import { toWireImages, type Attachment } from "./attachments";

/** Local console commands that never reach the child. */
export const LOCAL_COMMANDS: CommandInfo[] = [
  { name: "plan", description: "Show or hide the plan panel", source: "console" },
  { name: "settings", description: "Model, thinking and compaction", source: "console" },
  { name: "theme", description: "Switch light / dark", source: "console" },
  { name: "read", description: "Enter read mode", source: "console" },
  { name: "new", description: "Start a new session", source: "console" },
];

/** Aliases from the catalog (short forms people type in a console). */
const ALIASES: Record<string, string> = {
  m: "model",
  c: "compact",
  t: "theme",
  p: "plan",
  s: "settings",
};

export interface PaletteRow {
  command: CommandInfo;
  alias: string | null;
}

export function paletteRows(commands: CommandInfo[], query: string): PaletteRow[] {
  const all = [...commands, ...LOCAL_COMMANDS.filter((local) => !commands.some((command) => command.name === local.name))];
  const normalized = query.trim().toLowerCase();
  const rows: PaletteRow[] = [];
  for (const command of all) {
    const alias = Object.entries(ALIASES).find(([, target]) => target === command.name)?.[0] ?? null;
    if (!normalized) {
      rows.push({ command, alias });
      continue;
    }
    const name = command.name.toLowerCase();
    if (name.startsWith(normalized) || name.includes(normalized) || alias === normalized || alias?.startsWith(normalized)) {
      rows.push({ command, alias });
    }
  }
  return rows.slice(0, 9);
}

export function slashQuery(input: string): { active: boolean; query: string } {
  if (!input.startsWith("/")) return { active: false, query: "" };
  const firstLine = input.split("\n")[0] ?? "";
  if (firstLine.includes(" ")) return { active: false, query: "" };
  return { active: true, query: firstLine.slice(1) };
}

export type SendMode = "send" | "steer" | "queue";

export function deriveSessionTitle(text: string): string {
  const printable = Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  return printable.replace(/\s+/g, " ").trim().slice(0, 72);
}

export function firstPromptTitle(text: string): RawFrame | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return null;
  const title = deriveSessionTitle(trimmed);
  return title ? { type: "set_session_name", name: title } : null;
}

export function promptFrame(text: string, attachments: Attachment[], mode: SendMode = "send"): RawFrame {
  const images = toWireImages(attachments);
  if (mode === "steer") {
    return { type: "steer", message: text, ...(images.length > 0 ? { images } : {}) };
  }
  if (mode === "queue") {
    return { type: "follow_up", message: text, ...(images.length > 0 ? { images } : {}) };
  }
  return { type: "prompt", message: text, ...(images.length > 0 ? { images } : {}) };
}

export function removeQueuedFrame(item: QueueItem): RawFrame {
  const queue = item.kind === "followUp" ? "followUp" : "steering";
  return { type: "remove_queued_message", message: item.text, queue };
}

export function promoteQueuedFrame(item: QueueItem): RawFrame {
  return { type: "promote_queued_message", message: item.text };
}

export function answerFrame(dialogId: string, answer: Record<string, unknown>): RawFrame {
  return { type: "extension_ui_response", id: dialogId, ...answer };
}

export function commandFrame(
  command:
    | "abort"
    | "abort_and_restore_queue"
    | "new_session"
    | "fork"
    | "export_html"
    | "compact"
    | "get_state"
    | "get_session_stats"
    | "get_messages"
    | "get_available_models"
    | "get_available_thinking_levels"
    | "get_available_commands",
): RawFrame {
  return { type: command };
}

export function setModelFrame(provider: string, modelId: string): RawFrame {
  return { type: "set_model", provider, modelId };
}

export function setThinkingFrame(level: string): RawFrame {
  return { type: "set_thinking_level", level };
}

export function setAutoCompactionFrame(enabled: boolean): RawFrame {
  return { type: "set_auto_compaction", enabled };
}

export function renameSessionFrame(name: string): RawFrame {
  return { type: "set_session_name", name };
}

/** Keep frame construction in one place; the server allowlist rejects the rest. */
export const ALLOWED_CLIENT_COMMANDS: Record<string, true> = {
  prompt: true,
  steer: true,
  follow_up: true,
  remove_queued_message: true,
  promote_queued_message: true,
  abort: true,
  abort_and_restore_queue: true,
  set_model: true,
  set_thinking_level: true,
  set_session_name: true,
  new_session: true,
  fork: true,
  export_html: true,
  compact: true,
  set_auto_compaction: true,
  get_state: true,
  get_session_stats: true,
  get_messages: true,
  get_available_models: true,
  get_available_thinking_levels: true,
  get_available_commands: true,
  extension_ui_response: true,
};
