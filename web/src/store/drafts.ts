const KEY = "omp-console.drafts.v1";
const MAX_SESSIONS = 20;
const MAX_DRAFT_BYTES = 64 * 1024;

interface DraftEntry {
  text: string;
  at: number;
}

type DraftMap = Record<string, DraftEntry>;

function read(): DraftMap {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: DraftMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as { text?: unknown; at?: unknown };
      if (typeof entry.text !== "string") continue;
      map[id] = { text: entry.text, at: typeof entry.at === "number" ? entry.at : 0 };
    }
    return map;
  } catch {
    return {};
  }
}

function write(map: DraftMap): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Storage full or unavailable: drafts are best-effort by design.
  }
}

export function loadDraft(sessionId: string): string {
  return read()[sessionId]?.text ?? "";
}

export function saveDraft(sessionId: string, text: string): void {
  if (!sessionId) return;
  const map = read();
  if (!text) {
    delete map[sessionId];
    write(map);
    return;
  }
  const bounded = text.length > MAX_DRAFT_BYTES ? text.slice(0, MAX_DRAFT_BYTES) : text;
  map[sessionId] = { text: bounded, at: Date.now() };
  const ids = Object.keys(map);
  if (ids.length > MAX_SESSIONS) {
    ids
      .sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0))
      .slice(0, ids.length - MAX_SESSIONS)
      .forEach((id) => delete map[id]);
  }
  write(map);
}

export function clearDraft(sessionId: string): void {
  if (!sessionId) return;
  const map = read();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  write(map);
}

export function listDrafts(): string[] {
  return Object.keys(read());
}

export const DRAFT_LIMITS = { MAX_SESSIONS, MAX_DRAFT_BYTES };
