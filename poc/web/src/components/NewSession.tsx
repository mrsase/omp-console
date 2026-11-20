import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { basename, errorText, relativeTime } from "../lib/format";
import { browse, closeModal, createThread, resumeSession, selectThread, useApp } from "../lib/store";
import type { FsListing, RecentSession } from "../lib/types";
import { useOverlay } from "./Dialogs";

export function NewSession(): ReactElement | null {
  const app = useApp();
  const open = app.modal?.kind === "new";
  const [mode, setMode] = useState<"fresh" | "resume">("fresh");
  const [listing, setListing] = useState<FsListing | null>(null);
  const [path, setPath] = useState(() => app.info?.cwd ?? "~");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState("");
  const shell = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const wasOpen = useRef(false);
  const request = useRef(0);
  useOverlay(shell, open, closeModal, 50);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async (target: string) => {
    const current = ++request.current;
    setLoading(true);
    setListing(null);
    setError(null);
    try {
      const result = await browse(target);
      if (!alive.current || current !== request.current) return;
      setListing(result);
      setPath(result.path);
    } catch (caught) {
      if (alive.current && current === request.current) setError(errorText(caught));
    } finally {
      if (alive.current && current === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !wasOpen.current) {
      const target = app.info?.cwd ?? "~";
      setMode("fresh");
      setQuery("");
      setPath(target);
      void load(target);
    }
    wasOpen.current = open;
  }, [open, app.info?.cwd, load]);

  const workspaces = useMemo(() => [...new Set(app.recent.map((session) => session.cwd).filter(Boolean))].slice(0, 6), [app.recent]);
  const sessions = app.recent.filter((session) => `${session.title} ${session.cwd}`.toLowerCase().includes(query.trim().toLowerCase()));
  const folders = listing?.entries.filter((entry) => entry.isDir && (showHidden || !entry.name.startsWith("."))) ?? [];
  const hiddenFiles = listing?.entries.filter((entry) => !entry.isDir).length ?? 0;
  const selectedFolder = listing?.path;
  const canCreate = Boolean(selectedFolder && path.trim() === selectedFolder && !loading && !pending);

  const navigate = (target: string) => {
    if (target.trim() && !pending) void load(target.trim());
  };
  const start = async () => {
    if (!canCreate || !selectedFolder) return;
    setPending("fresh");
    setError(null);
    try {
      await createThread({ cwd: selectedFolder });
    } catch (caught) {
      if (alive.current) setError(errorText(caught));
    } finally {
      if (alive.current) setPending(null);
    }
  };
  const resume = async (session: RecentSession) => {
    if (pending) return;
    const existing = app.order.map((id) => app.threads[id]).find((thread) =>
      thread && (thread.info.sessionFile ?? thread.info.resume) === session.path,
    );
    if (existing) {
      closeModal();
      selectThread(existing.info.id);
      return;
    }
    setPending(session.path);
    setError(null);
    try {
      await resumeSession(session);
    } catch (caught) {
      if (alive.current) setError(errorText(caught));
    } finally {
      if (alive.current) setPending(null);
    }
  };

  if (!open) return null;
  return (
    <div className="modal-backdrop new-session-backdrop" onMouseDown={closeModal}>
      <div ref={shell} className="modal ns-modal" role="dialog" aria-modal="true" aria-label="Start a session" tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}>
        <div className="ns-head">
          <div>
            <h2 className="ns-title">Start a session</h2>
            <div className="ns-sub">Start fresh in a workspace or continue a saved conversation.</div>
          </div>
          <button type="button" className="ns-close btn btn-ghost" aria-label="Close new session dialog" onClick={closeModal}>×</button>
        </div>
        <div className="ns-tabs" role="tablist" aria-label="Session source">
          {(["fresh", "resume"] as const).map((tab) => (
            <button key={tab} type="button" role="tab" id={`session-tab-${tab}`} aria-controls={`session-panel-${tab}`}
              aria-selected={mode === tab} tabIndex={mode === tab ? 0 : -1} disabled={pending !== null}
              className={`btn ${mode === tab ? "btn-primary" : "btn-ghost"}`}
              onClick={() => { setMode(tab); setError(null); }}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? "fresh" : event.key === "End" ? "resume" : mode === "fresh" ? "resume" : "fresh";
                setMode(next);
                setError(null);
                document.getElementById(`session-tab-${next}`)?.focus();
              }}>
              {tab === "fresh" ? "Fresh session" : "Resume saved"}
            </button>
          ))}
        </div>
        {mode === "fresh" ? (
          <div className="ns-panel" role="tabpanel" id="session-panel-fresh" aria-labelledby="session-tab-fresh">
            {workspaces.length > 0 && (
              <div className="ns-sectional">
                <div className="ns-section-title">Recent workspaces</div>
                <div className="ns-chips">{workspaces.map((cwd) => (
                  <button type="button" key={cwd} className="ns-chip" title={cwd} disabled={pending !== null}
                    onClick={() => navigate(cwd)}>{basename(cwd) || cwd}</button>
                ))}</div>
              </div>
            )}
            <div className="ns-sectional">
              <div className="ns-section-title">Choose workspace</div>
              <div className="ns-pathrow">
                <input className="input ns-path" value={path} spellCheck={false} autoCapitalize="off" autoCorrect="off"
                  aria-label="Folder path" disabled={pending !== null} onChange={(event) => setPath(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); navigate(path); } }} />
                <button type="button" className="btn btn-ghost" disabled={pending !== null || loading} onClick={() => navigate(path)}>Browse</button>
                <button type="button" className="btn btn-ghost" disabled={!listing?.parent || loading || pending !== null}
                  onClick={() => { if (listing?.parent) navigate(listing.parent); }}>Up</button>
              </div>
              <div className="ns-list" aria-label="Workspace folders" aria-busy={loading}>
                {loading ? <div className="ns-entry"><span className="spinner" /> Loading folders…</div> : folders.length === 0 && !error ? <div className="empty">No subfolders. You can start in this workspace.</div> : null}
                {!loading && folders.map((entry) => (
                  <button type="button" key={entry.path} className="ns-entry" disabled={pending !== null} onClick={() => navigate(entry.path)}>
                    <span className="ns-dir" aria-hidden="true">▸</span><span className="ns-name">{entry.name}</span>
                  </button>
                ))}
              </div>
              <div className="ns-meta">
                <span>{hiddenFiles > 0 ? `${hiddenFiles} file${hiddenFiles === 1 ? "" : "s"} hidden · folders only` : "Folders only"}</span>
                <label className="ns-toggle"><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} />Show hidden folders</label>
              </div>
            </div>
          </div>
        ) : (
          <div className="ns-panel" role="tabpanel" id="session-panel-resume" aria-labelledby="session-tab-resume">
            <div className="ns-sectional">
              <input className="input" aria-label="Search saved sessions" placeholder="Search sessions or workspaces" value={query} onChange={(event) => setQuery(event.target.value)} />
              {!app.recentLoaded && <p className="empty-note">Loading saved sessions…</p>}
              {app.recentLoaded && sessions.length === 0 && <p className="empty-note">{query ? "No saved sessions match your search." : "No saved sessions yet. Start a fresh session to begin."}</p>}
              {sessions.map((session) => {
                const existing = app.order.some((id) => {
                  const thread = app.threads[id];
                  return thread && (thread.info.sessionFile ?? thread.info.resume) === session.path;
                });
                return (
                  <button type="button" key={session.path} className="ns-recent" disabled={pending !== null} title={session.cwd}
                    onClick={() => void resume(session)}>
                    <span className="ns-recent-title">{session.title || "Untitled session"}</span>
                    <span className="ns-recent-sub">{basename(session.cwd) || session.cwd} · {relativeTime(session.updatedAt)} · {existing ? "Already open — switch to session" : pending === session.path ? "Resuming…" : "Resume"}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {error && <div className="ns-error" role="alert">{error}</div>}
        <div className="ns-footer">
          <div className="ns-current-folder">
            {pending ? <span className="ns-pending" role="status"><span className="spinner tiny" />{pending === "fresh" ? "Starting session…" : "Resuming session…"}</span> : mode === "fresh" ? <><span className="control-label">New conversation in</span><span title={selectedFolder}>{selectedFolder ?? "Choose a workspace"}</span>{selectedFolder && path.trim() !== selectedFolder && <span className="empty-note">Browse to apply the typed path.</span>}</> : <span className="empty-note">Choose a saved session to continue its transcript.</span>}
          </div>
          <button type="button" className="btn btn-ghost" onClick={closeModal}>Cancel</button>
          {mode === "fresh" && <button type="button" className="btn btn-primary" disabled={!canCreate} onClick={() => void start()}>Create fresh session</button>}
        </div>
      </div>
    </div>
  );
}
