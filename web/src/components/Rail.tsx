import { useEffect, useRef, useState } from "react";
import type { RecentSession, ThreadInfo, ThreadRuntime } from "../protocol/types";
import { basename, relativeAge } from "../protocol/format";
import { sessionTitle } from "../store/selectors";
import { useFocusTrap, useMediaQuery } from "./hooks";
import { Icon } from "./icons";

function tickState(thread: ThreadInfo | undefined, session: ThreadRuntime | undefined): string {
  if (!thread) return "idle";
  if (thread.status === "starting") return "starting";
  if (thread.status === "exited") return "exited";
  if (session?.streaming || session?.agentActive) return "working";
  return "ready";
}

export function Rail({
  threads,
  sessions,
  recent,
  selected,
  connection,
  version,
  open,
  onClose,
  onSelect,
  onNew,
  onCloseThread,
  onResume,
  resuming,
}: {
  threads: ThreadInfo[];
  sessions: Record<string, ThreadRuntime>;
  recent: RecentSession[];
  selected: string | null;
  connection: "connecting" | "open" | "closed";
  version: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onCloseThread: (id: string) => void;
  onResume: (session: RecentSession) => void;
  resuming: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const railRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mobile = useMediaQuery("(max-width: 899px)");
  useFocusTrap(railRef, open && mobile, onClose);
  const now = Date.now();
  const normalized = query.trim().toLowerCase();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const openThreads = threads.filter((thread) => {
    if (!normalized) return true;
    const session = sessions[thread.id];
    return `${session ? sessionTitle(session) : thread.title} ${thread.cwd}`.toLowerCase().includes(normalized);
  });
  const openPaths = new Set<string>();
  const openIds = new Set<string>();
  const normalize = (path: string) => path.replace(/[\\/]+$/, "");
  for (const thread of threads) {
    if (thread.sessionFile) openPaths.add(normalize(thread.sessionFile));
    if (thread.resume) openPaths.add(normalize(thread.resume));
    if (thread.sessionId) openIds.add(thread.sessionId);
    const session = sessions[thread.id];
    if (session?.sessionFile) openPaths.add(normalize(session.sessionFile));
    if (session?.sessionId) openIds.add(session.sessionId);
  }
  const saved = recent.filter((entry) => {
    if (openPaths.has(normalize(entry.path))) return false;
    if (entry.id && openIds.has(entry.id)) return false;
    if (!normalized) return true;
    return `${entry.title} ${entry.cwd}`.toLowerCase().includes(normalized);
  });

  return (
    <nav className="rail" aria-label="Sessions" ref={railRef} data-testid="rail">
      <div className="rail-brand">
        <span className="rail-mark" aria-hidden="true">
          <Icon name="traces" size={20} />
        </span>
        <span className="rail-brand-text">
          <span className="rail-name">omp console</span>
          <span className="rail-connection" aria-live="polite">
            <span className="led" data-state={connection === "open" ? "open" : connection === "connecting" ? "connecting" : "closed"} />
            {connection === "open" ? "connected" : connection}
            {version ? ` · ${version}` : ""}
          </span>
        </span>
      </div>

      <div className="rail-actions">
        <button type="button" className="new-session" onClick={onNew}>
          <Icon name="plus" />
          New session
        </button>
        <div className="rail-search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            value={query}
            placeholder="Search sessions"
            aria-label="Search sessions"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                searchRef.current?.blur();
              }
            }}
          />
          <kbd>/</kbd>
        </div>
      </div>

      <div className="rail-section">
        <span className="rail-section-label">open</span>
        <span className="rail-section-rule" />
        <span className="rail-section-count">{openThreads.length}</span>
      </div>
      <div className="rail-scroll">
        {openThreads.length === 0 ? <div className="rail-empty">No open sessions</div> : null}
        {openThreads.map((thread) => {
          const session = sessions[thread.id];
          const state = tickState(thread, session);
          return (
            <div className="rail-row" key={thread.id} aria-current={selected === thread.id ? "true" : "false"}>
              <span className="tick" data-state={state} role="img" aria-label={state}>
                <i />
                <i />
              </span>
              <button
                type="button"
                className="rail-row-main"
                onClick={() => {
                  onSelect(thread.id);
                  if (mobile) onClose();
                }}
              >
                <span className="rail-title truncate">{session ? sessionTitle(session) : thread.title}</span>
                <span className="rail-meta">
                  <span>{basename(thread.cwd)}</span>
                  <span>{state}</span>
                </span>
              </button>
              <span className="rail-row-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="View session"
                  title="View session"
                  onClick={() => {
                    onSelect(thread.id);
                    if (mobile) onClose();
                  }}
                >
                  <Icon name="panel" size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close session"
                  title="Close session"
                  onClick={() => onCloseThread(thread.id)}
                >
                  <Icon name="close" size={14} />
                </button>
              </span>
            </div>
          );
        })}

        <div className="rail-section">
          <span className="rail-section-label">saved</span>
          <span className="rail-section-rule" />
          <span className="rail-section-count">{saved.length}</span>
        </div>
        {saved.length === 0 ? <div className="rail-empty">No saved sessions</div> : null}
        {saved.map((entry) => {
          const busy = resuming.has(entry.path);
          return (
            <button
              type="button"
              className="rail-row"
              data-saved="true"
              key={entry.path}
              disabled={busy}
              title={entry.cwd}
              onClick={() => {
                onResume(entry);
                if (mobile) onClose();
              }}
            >
              <span className="rail-resume-glyph" aria-hidden="true">
                {busy ? "…" : "↺"}
              </span>
              <span className="rail-row-main">
                <span className="rail-title truncate">{entry.title}</span>
                <span className="rail-meta">
                  <span>{basename(entry.cwd)}</span>
                  <span>{relativeAge(entry.updatedAt, now)}</span>
                </span>
              </span>
              <span className="rail-row-actions" aria-hidden="true">
                <span className="icon-button">
                  <Icon name="resume" size={14} />
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="rail-footer">
        <span>{connection === "open" ? "connected" : connection}</span>
        <span>{version ?? ""}</span>
      </div>
    </nav>
  );
}
