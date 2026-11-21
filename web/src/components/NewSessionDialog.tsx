import { useEffect, useRef, useState } from "react";
import type { FsListing, RecentSession } from "../protocol/types";
import { relativeAge } from "../protocol/format";
import { useFocusTrap } from "./hooks";
import { Icon } from "./icons";

export function NewSessionDialog({
  sessionRoot,
  defaultCwd,
  recent,
  browse,
  onClose,
  onStart,
}: {
  sessionRoot: string;
  defaultCwd: string;
  recent: RecentSession[];
  browse: (path?: string) => Promise<FsListing>;
  onClose: () => void;
  onStart: (body: { cwd: string; resume?: string; model?: string; thinking?: string }) => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [cwd, setCwd] = useState(defaultCwd || sessionRoot);
  const [resume, setResume] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  useFocusTrap(sheetRef, true, onClose);

  const load = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await browse(path);
      setListing(result);
      setCwd(result.path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "could not list this folder");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(defaultCwd || sessionRoot || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = () => {
    if (!cwd.trim()) {
      setError("Choose a working folder.");
      return;
    }
    onStart({
      cwd: cwd.trim(),
      resume,
      model: model.trim() || undefined,
      thinking: thinking || undefined,
    });
  };

  const now = Date.now();
  return (
    <div className="dialog-scrim">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="new-session-title" ref={sheetRef}>
        <div className="sheet-head">
          <div className="sheet-meta">
            <span className="kind">new session</span>
            <span>one omp process</span>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="sheet-body">
          <h2 className="sheet-title" id="new-session-title">
            Start a session
          </h2>
          <div className="folder-path">
            <button
              type="button"
              className="icon-button"
              aria-label="Parent folder"
              disabled={!listing?.parent}
              onClick={() => listing?.parent && void load(listing.parent)}
            >
              <Icon name="up" size={14} />
            </button>
            <code title={cwd}>{cwd}</code>
            <button type="button" className="control" onClick={() => void load(cwd)}>
              Go
            </button>
          </div>
          {error ? <p className="composer-error" role="alert">{error}</p> : null}
          <div className="folder-list" aria-label="Folders" data-testid="folder-list">
            {loading ? <div className="rail-empty">loading…</div> : null}
            {!loading && listing?.entries.filter((entry) => entry.isDir).length === 0 ? (
              <div className="rail-empty">No subfolders</div>
            ) : null}
            {listing?.entries
              .filter((entry) => entry.isDir)
              .map((entry) => (
                <button
                  type="button"
                  className="folder-row"
                  key={entry.path}
                  onClick={() => {
                    setResume(undefined);
                    void load(entry.path);
                  }}
                >
                  <span className="folder-glyph" aria-hidden="true">
                    <Icon name="folder" size={14} />
                  </span>
                  <span className="folder-name">{entry.name}</span>
                  {entry.symlink ? <span className="recent-meta">link</span> : null}
                </button>
              ))}
          </div>
          <div className="sheet-section-title">saved sessions</div>
          <div className="recent-list">
            {recent.length === 0 ? <div className="rail-empty">No saved sessions in this folder</div> : null}
            {recent.map((entry) => (
              <button
                type="button"
                className="recent-row"
                key={entry.path}
                aria-pressed={resume === entry.path}
                onClick={() => {
                  setResume(entry.path);
                  setCwd(entry.cwd);
                }}
              >
                <span className="folder-glyph" aria-hidden="true">
                  ↺
                </span>
                <span className="truncate">{entry.title}</span>
                <span className="recent-meta">
                  {entry.cwd} · {relativeAge(entry.updatedAt, now)}
                </span>
              </button>
            ))}
          </div>
          <div className="sheet-section-title">optional</div>
          <div className="folder-path">
            <input
              className="sheet-input"
              placeholder="provider/model"
              aria-label="Model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <select
              className="sheet-input"
              aria-label="Thinking level"
              value={thinking}
              onChange={(event) => setThinking(event.target.value)}
            >
              <option value="">default thinking</option>
              <option value="off">off</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </div>
        </div>
        <div className="sheet-actions">
          <button type="button" className="control" onClick={onClose}>
            Cancel
          </button>
          <span className="spacer" />
          <span className="sheet-hint">{resume ? "resumes from disk (read-only)" : "new omp session"}</span>
          <button type="button" className="primary" onClick={start}>
            Start session
          </button>
        </div>
      </div>
    </div>
  );
}
