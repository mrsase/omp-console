import { useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { Dialogs, useOverlay } from "./components/Dialogs";
import { Icon } from "./components/Icons";
import { NewSession } from "./components/NewSession";
import { Transcript } from "./components/Transcript";
import {
  abortThread,
  cancelConfirm,
  closeThread,
  compactThread,
  confirmAction,
  contextPercent,
  exportThread,
  forkThread,
  newSessionInThread,
  openNewSession,
  refreshRecent,
  renameThread,
  runConfirm,
  resumeSession,
  resumeThread,
  selectThread,
  setModel,
  setThinking,
  toggleAutoCompaction,
  toggleSidebar,
  toggleTheme,
  toggleTodos,
  useApp,
} from "./lib/store";
import {
  basename,
  formatCost,
  formatTokens,
  relativeTime,
  shortModel,
} from "./lib/format";
import type {
  AppState,
  ModelInfo,
  RecentSession,
  ThreadState,
  Toast,
  TodoPhase,
} from "./lib/types";

const THINKING = ["off", "low", "medium", "high", "xhigh", "max"];

export function App() {
  const app = useApp();
  const thread = app.view ? app.threads[app.view] : null;

  useEffect(() => {
    document.title = thread ? `${thread.info.title} · omp web` : "omp web";
  }, [thread?.info.title]);


  return (
    <div className="app">
      <Sidebar app={app} />
      {app.sidebarOpen && (
        <div
          className="sidebar-scrim"
          onClick={toggleSidebar}
          aria-hidden="true"
        />
      )}
      <main className="main">
        <div className="mobile-top">
          <button
            className="icon-btn"
            onClick={toggleSidebar}
            aria-label="Open sessions"
          >
            <Icon name="menu" />
          </button>
          <span className="mobile-title">omp web</span>
          <button
            className="icon-btn"
            onClick={openNewSession}
            aria-label="New session"
          >
            <Icon name="plus" />
          </button>
        </div>
        {thread ? (
          <ThreadView app={app} thread={thread} />
        ) : (
          <EmptyState app={app} />
        )}
      </main>
      <Toasts items={app.toasts} />
      <NewSession />
      <Dialogs />
      <ConfirmModal />
    </div>
  );
}

function ThreadView({ app, thread }: { app: AppState; thread: ThreadState }) {
  const showTodos = app.showTodos;
  return (
    <section className="thread" key={thread.info.id}>
      <ThreadHeader app={app} thread={thread} />
      <div className={`thread-body ${showTodos ? "with-aside" : ""}`}>
        <Transcript thread={thread} />
        {showTodos && <TodosPanel thread={thread} />}
      </div>
      <Composer thread={thread} />
    </section>
  );
}

function ThreadHeader({ app, thread }: { app: AppState; thread: ThreadState }) {
  const { info, activity } = thread;
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(info.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuScrollable, setMenuScrollable] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const settingsDialog = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  useOverlay(settingsDialog, settingsOpen, () => setSettingsOpen(false), 40);
  useOverlay(menuRef, menuOpen, () => setMenuOpen(false), 30, false);

  useEffect(() => {
    setDraftTitle(info.title);
  }, [info.title]);

  useEffect(() => {
    if (renaming) {
      titleInput.current?.focus();
      titleInput.current?.select();
    }
  }, [renaming]);

  useEffect(() => {
    if (!menuOpen) return;
    const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ) ?? [])];
    items()[0]?.focus();
    const menuItems = menuRef.current?.querySelector<HTMLElement>(".menu-items");
    const menuObserver = new ResizeObserver(() => {
      if (menuItems) setMenuScrollable(menuItems.scrollHeight > menuItems.clientHeight + 1);
    });
    if (menuItems) menuObserver.observe(menuItems);
    const onDown = (event: MouseEvent) => {
      if (
        menuRef.current &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if (!menuRef.current?.contains(document.activeElement)) return;
      const options = items();
      if (!options.length) return;
      event.preventDefault();
      const current = options.indexOf(document.activeElement as HTMLButtonElement);
      const index = event.key === "Home" ? 0
        : event.key === "End" ? options.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[index]?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      menuObserver.disconnect();
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const saveTitle = () => {
    setRenaming(false);
    if (draftTitle.trim() && draftTitle.trim() !== info.title) {
      renameThread(info.id, draftTitle);
    } else {
      setDraftTitle(info.title);
    }
  };

  const statusLabel =
    info.status === "starting"
      ? "Starting"
      : info.status === "exited"
        ? "Ended"
        : activity.running
          ? "Working"
          : "Idle";
  const statusClass =
    info.status === "starting"
      ? "starting"
      : info.status === "exited"
        ? "exited"
        : activity.running
          ? "working"
          : "idle";

  const todoCount = thread.todos.reduce(
    (sum, phase) => sum + phase.tasks.length,
    0,
  );

  const requestClose = () => {
    setMenuOpen(false);
    confirmAction({
      title: "Close this session?",
      message:
        info.status === "exited"
          ? "This removes the ended session from the open list. Its transcript stays on disk in Saved history."
          : "The omp process stops. The transcript stays on disk and can be resumed from Saved history.",
      confirmLabel: "Close session",
      danger: true,
      onConfirm: () => void closeThread(info.id),
    });
  };

  return (
    <>
      <header className="thread-header">
        <div className="thread-title-row">
          <button className="icon-btn mobile-session-toggle" onClick={toggleSidebar} aria-label="Open sessions">
            <Icon name="menu" />
          </button>
          <div className="thread-identity">
          <div className="thread-title-block">
            {renaming ? (
              <input
                className="input title-input"
                ref={titleInput}
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={saveTitle}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveTitle();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setRenaming(false);
                    setDraftTitle(info.title);
                  }
                }}
              />
            ) : (
              <h1 className="session-heading" title={info.title}>{info.title}</h1>
            )}
            <span className={`status-pill ${statusClass}`} title={statusLabel}>
              <span className="status-dot" />
              {statusLabel}
            </span>
            {Object.entries(thread.statuses).map(([key, text]) => (
              <span className="status-chip" key={key}>
                {text}
              </span>
            ))}
          </div>
          <div className="thread-workspace" title={info.cwd}>
            {basename(info.cwd) || info.cwd} · {shortModel(thread.session?.model?.id ?? info.model)}
          </div>
          </div>

          <div className="thread-actions">
            <button
              className="settings-toggle header-settings-action header-action btn btn-ghost"
              onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}
              aria-expanded={settingsOpen}
              aria-controls={`session-settings-${info.id}`}
              aria-haspopup="dialog"
              aria-label="Session settings"
            >
              <span className="header-action-label">Settings</span>
            </button>
            <button
              className={`header-plan header-action btn btn-ghost ${app.showTodos ? "active" : ""}`}
              onClick={toggleTodos}
              title={todoCount ? `Plan (${todoCount} tasks)` : "Plan"}
              aria-label="Toggle plan"
              aria-pressed={app.showTodos}
            >
              <Icon name="plan" size={14} />
              <span className="header-action-label">Plan</span>
              {todoCount > 0 && <span className="badge">{todoCount}</span>}
            </button>
            <div className="menu-wrap" ref={menuRef}>
              <button
                className={`header-more header-action btn btn-ghost ${menuOpen ? "active" : ""}`}
                onClick={() => setMenuOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setMenuOpen(true);
                  }
                }}
                aria-label="More session actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <Icon name="more" />
                <span className="header-action-label">More</span>
              </button>
              {menuOpen && (
                <div className="menu" role="menu" onBlur={(event) => {
                  if (!menuRef.current?.contains(event.relatedTarget)) setMenuOpen(false);
                }}>
                  <div className="menu-items">
                  <MenuItem
                    icon="plan"
                    label="Rename session"
                    onClick={() => {
                      setMenuOpen(false);
                      setRenaming(true);
                    }}
                  />
                  <MenuItem
                    icon="archive"
                    label="Compact context"
                    disabled={activity.running || info.status !== "ready"}
                    onClick={() => {
                      setMenuOpen(false);
                      compactThread(info.id);
                    }}
                  />
                  <MenuItem
                    icon="branch"
                    label="Fork conversation"
                    onClick={() => {
                      setMenuOpen(false);
                      forkThread(info.id);
                    }}
                  />
                  <MenuItem
                    icon="plus"
                    label="New session in this folder"
                    onClick={() => {
                      setMenuOpen(false);
                      confirmAction({
                        title: "Start a fresh session?",
                        message:
                          `This replaces the current conversation with a fresh session in ${info.cwd}. The existing transcript stays on disk in Saved history.`,
                        confirmLabel: "Start fresh",
                        onConfirm: () => newSessionInThread(info.id),
                      });
                    }}
                  />
                  <MenuItem
                    icon="download"
                    label="Export HTML"
                    onClick={() => {
                      setMenuOpen(false);
                      exportThread(info.id);
                    }}
                  />
                  <div className="menu-sep" />
                  <MenuItem
                    icon="stop"
                    label="Abort turn"
                    onClick={() => {
                      setMenuOpen(false);
                      abortThread(info.id);
                    }}
                    disabled={!activity.running}
                  />
                  <MenuItem
                    icon="x"
                    label="Close session"
                    danger
                    onClick={requestClose}
                  />
                  </div>
                  {menuScrollable && <div className="menu-scroll-hint">↓ Scroll for more actions</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      {settingsOpen && (
        <div className="modal-backdrop settings-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <div
            ref={settingsDialog}
            id={`session-settings-${info.id}`}
            className="modal settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Session settings"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="ns-head">
              <h3>Session settings</h3>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
                <Icon name="x" />
              </button>
            </div>
            <div className="session-identity">
              <span className="control-label">Session</span>
              <p className="session-full-title">{info.title}</p>
              <span className="session-sub">ID {info.id.slice(0, 8)}</span>
            </div>
            <SessionControls thread={thread} />
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => setSettingsOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {info.status === "exited" && (
        <div className="exit-banner">
          <Icon name="alert" size={14} />
          <span>
            Session ended
            {info.exitCode !== null && info.exitCode !== undefined
              ? ` (code ${info.exitCode})`
              : ""}
            .
          </span>
          <button className="btn btn-small" onClick={() => resumeThread(info.id)}>
            <Icon name="play" size={12} />
            Resume
          </button>
          <button className="btn btn-small btn-ghost" onClick={requestClose}>
            Dismiss
          </button>
        </div>
      )}

      {thread.activity.retry && (
        <div className="thread-banner warning">
          <span className="spinner" />
          Retry {thread.activity.retry.attempt}/{thread.activity.retry.maxAttempts}{" "}
          — {thread.activity.retry.message}
        </div>
      )}
      {thread.activity.compaction && (
        <div className="thread-banner info">
          <span className="spinner" />
          {thread.activity.compaction.kind === "manual"
            ? "Compacting conversation"
            : "Auto-compacting context"}
        </div>
      )}
    </>
  );
}

function SessionControls({ thread }: { thread: ThreadState }) {
  const { info, activity } = thread;
  const usage = thread.session?.contextUsage ?? thread.stats?.contextUsage;
  return (
    <div className="thread-subrow">
      <div className="settings-workspace">
        <span className="control-label">Workspace</span>
        <span className="cwd" title={info.cwd}>{info.cwd}</span>
      </div>
      <label className="control">
        <span className="control-label">Model</span>
        <ModelPicker thread={thread} />
      </label>
      <label className="control">
        <span className="control-label">Thinking</span>
        <ThinkingPicker thread={thread} />
      </label>
      <label className="settings-compaction">
        <input type="checkbox" checked={thread.session?.autoCompactionEnabled ?? false}
          disabled={info.status !== "ready"} onChange={() => toggleAutoCompaction(info.id)} />
        Automatically compact context
      </label>
      <div className="thread-stats">
        {usage && (
          <ContextRing percent={contextPercent(thread)}
            title={`${formatTokens(usage.tokens)} of ${formatTokens(usage.contextWindow)} context tokens`} />
        )}
        <span title="Billed cost for this session">{formatCost(thread.stats?.cost ?? 0)}</span>
        <span title="Total tokens">{formatTokens(thread.stats?.tokens.total ?? usage?.tokens ?? 0)} tok</span>
        {activity.running && thread.session?.tokensPerSecond ? (
          <span className="tps">{Math.round(thread.session.tokensPerSecond)} tok/s</span>
        ) : null}
      </div>
    </div>
  );
}

function ModelPicker({ thread }: { thread: ThreadState }) {
  const current = thread.session?.model
    ? `${thread.session.model.provider}/${thread.session.model.id}`
    : (thread.info.model ?? "");
  const models = thread.models;
  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const model of models) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }
    return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models]);

  if (!models.length) {
    return (
      <span className="control-static" title={current || "default model"}>
        {shortModel(current)}
      </span>
    );
  }

  const known = models.some((m) => `${m.provider}/${m.id}` === current);
  return (
    <select
      className="select"
      value={current}
      onChange={(event) => {
        const picked = models.find(
          (m) => `${m.provider}/${m.id}` === event.target.value,
        );
        if (picked) setModel(thread.info.id, picked.provider, picked.id);
      }}
      title="Model"
      aria-label="Model"
    >
      {!known && current && <option value={current}>{shortModel(current)}</option>}
      {groups.map(([provider, list]) => (
        <optgroup key={provider} label={provider}>
          {list.map((model) => (
            <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
              {model.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function ThinkingPicker({ thread }: { thread: ThreadState }) {
  const current = thread.session?.thinkingLevel ?? thread.info.thinking ?? "off";
  const levels = thread.levels.length ? thread.levels : THINKING;
  const options = levels.includes(current) ? levels : [current, ...levels];
  return (
    <select
      className="select select-sm"
      value={current}
      onChange={(event) => setThinking(thread.info.id, event.target.value)}
      title="Thinking level"
      aria-label="Thinking level"
    >
      {options.map((level) => (
        <option key={level} value={level}>
          {level}
        </option>
      ))}
    </select>
  );
}

function ContextRing({ percent, title }: { percent: number; title: string }) {
  const pct = Math.max(0, Math.min(100, percent));
  const circumference = 2 * Math.PI * 7;
  return (
    <span className="ctx" title={title}>
      <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
        <circle className="ctx-track" cx="10" cy="10" r="7" />
        <circle
          className="ctx-fill"
          cx="10"
          cy="10"
          r="7"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          transform="rotate(-90 10 10)"
        />
      </svg>
      <span className="ctx-label">{Math.round(pct)}%</span>
    </span>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`menu-item ${danger ? "danger" : ""}`}
      onClick={onClick}
      role="menuitem"
      disabled={disabled}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
    </button>
  );
}

function TodosPanel({ thread }: { thread: ThreadState }) {
  const tasks = thread.todos.flatMap((phase) => phase.tasks);
  const done = tasks.filter((task) => task.status === "completed").length;
  const percent = tasks.length ? (done / tasks.length) * 100 : 0;
  const [focused, setFocused] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(() => matchMedia("(max-width: 980px)").matches);
  useEffect(() => {
    const media = matchMedia("(max-width: 980px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useOverlay(panel, true, toggleTodos, 20, compact || focused);

  return (
    <aside className={`aside ${focused ? "plan-focused" : ""}`} ref={panel} aria-label="Session plan" tabIndex={-1}>
      <div className="aside-head">
        <h3>Plan</h3>
        <button className="btn btn-small btn-ghost plan-expand"
          aria-label={focused ? "Restore plan size" : "Expand plan"}
          aria-pressed={focused} onClick={() => setFocused((value) => !value)}>
          {focused ? "Restore" : "Expand"}
        </button>
        <button
          className="icon-btn"
          onClick={toggleTodos}
          aria-label="Close plan"
          title="Close plan"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="aside-content" role="region" aria-label="Plan tasks" tabIndex={0}>
        {tasks.length > 0 ? (
          <>
            <div className="progress"><span style={{ width: `${percent}%` }} /></div>
            <div className="aside-meta">{done}/{tasks.length} tasks complete</div>
            {thread.todos.map((phase) => <TodoPhaseView key={phase.name} phase={phase} />)}
          </>
        ) : (
          <div className="plan-empty">
            <Icon name="plan" size={24} />
            <h4>No plan yet</h4>
            <p>Ask omp to break the work into tasks. Its plan and progress will appear here.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

function TodoPhaseView({ phase }: { phase: TodoPhase }) {
  return (
    <div className="todo-phase">
      <div className="todo-phase-name">{phase.name}</div>
      <ul className="todo-list">
        {phase.tasks.map((task, index) => (
          <li className={`todo-item ${task.status}`} key={`${task.content}-${index}`}>
            <span className="todo-mark">
              {task.status === "completed" ? (
                <Icon name="check" size={12} />
              ) : task.status === "in_progress" ? (
                <span className="spinner tiny" />
              ) : task.status === "blocked" ? (
                <Icon name="alert" size={12} />
              ) : (
                <span className="todo-empty" />
              )}
            </span>
            <span className="todo-text">{task.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sidebar({ app }: { app: AppState }) {
  const [filter, setFilter] = useState("");
  const [resuming, setResuming] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const sidebar = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(() => matchMedia("(max-width: 980px)").matches);
  useOverlay(sidebar, app.sidebarOpen && compact, toggleSidebar, 25);
  useEffect(() => {
    const media = matchMedia("(max-width: 980px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const threads = app.order
    .map((id) => app.threads[id])
    .filter((thread): thread is ThreadState => !!thread);
  const query = filter.trim().toLowerCase();
  const visibleThreads = threads.filter((thread) =>
    `${thread.info.title} ${thread.info.cwd} ${thread.info.model ?? ""}`.toLowerCase().includes(query),
  );
  const openPaths = new Set(threads.flatMap((thread) => {
    const path = thread.info.sessionFile ?? thread.info.resume;
    return path ? [path] : [];
  }));
  const recent = app.recent.filter((session) => !openPaths.has(session.path) &&
    `${session.title} ${session.cwd}`.toLowerCase().includes(query),
  );

  const startRecent = (session: RecentSession) => {
    if (resuming) return;
    setResuming(session.path);
    void resumeSession(session)
      .catch(() => undefined)
      .finally(() => setResuming(null));
  };

  const requestClose = (thread: ThreadState) => {
    confirmAction({
      title: "Close this session?",
      message: thread.info.status === "exited"
        ? `${thread.info.title} will leave the open list. Its transcript stays on disk in Saved history.`
        : `${thread.info.title} will stop. Its transcript stays on disk in Saved history.`,
      confirmLabel: "Close",
      danger: true,
      onConfirm: () => void closeThread(thread.info.id),
    });
  };

  return (
    <nav ref={sidebar} tabIndex={-1} aria-label="Sessions" className={`sidebar ${app.sidebarOpen ? "open" : ""}`}>
      <div className="brand">
        <div className="brand-mark">o</div>
        <div>
          <div className="brand-name">
            omp <span>web</span>
          </div>
          <div className="brand-sub">session console</div>
        </div>
        <button
          className="icon-btn theme-toggle"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          title="Toggle theme"
        >
          <Icon name={app.theme === "dark" ? "sun" : "moon"} size={15} />
        </button>
        <button className="icon-btn drawer-close" onClick={toggleSidebar} aria-label="Close sessions">
          <Icon name="x" />
        </button>
      </div>

      <button className="btn btn-primary new-btn" onClick={openNewSession}>
        <Icon name="plus" size={14} />
        New session
      </button>
      <div className="search-box sidebar-search">
        <Icon name="search" size={13} />
        <input className="search-input" placeholder="Search sessions or workspaces"
          aria-label="Search open and saved sessions" value={filter}
          onChange={(event) => setFilter(event.target.value)} />
      </div>

      <div className="sidebar-scroll">
        <div className="side-section">
          <div className="side-head">
            <span>Open sessions</span>
            <span className="count">{threads.length}</span>
          </div>
          {visibleThreads.length === 0 && (
            <p className="empty-note">{query ? "No open sessions match." : "No open sessions."}</p>
          )}
          {visibleThreads.map((thread) => (
            <div className={`session-item ${app.view === thread.info.id ? "selected" : ""}`} key={thread.info.id}>
              <button
                className="session-select"
                aria-current={app.view === thread.info.id ? "page" : undefined}
                title={`${thread.info.title}\n${thread.info.cwd}`}
                onClick={() => selectThread(thread.info.id)}
              >
                <span className={`status-dot ${thread.info.status === "exited" ? "exited" : thread.activity.running ? "working" : thread.info.status}`} aria-hidden="true" />
                <span className="session-text">
                  <span className="session-title">{thread.info.title || "Untitled session"}</span>
                  <span className="session-sub" title={thread.info.cwd}>
                    {basename(thread.info.cwd) || thread.info.cwd} · {thread.info.status === "exited" ? "Ended" : thread.activity.running ? "Working" : thread.info.status === "starting" ? "Starting" : "Idle"}
                    {app.view === thread.info.id ? " · Current" : ""}
                  </span>
                </span>
              </button>
              {thread.info.status === "exited" && (
                <button className="row-action" title="Resume session"
                  aria-label={`Resume ${thread.info.title}`} onClick={() => resumeThread(thread.info.id)}>
                  <Icon name="play" size={13} />
                </button>
              )}
              <button className="row-action" title="Close session"
                aria-label={`Close ${thread.info.title}`} onClick={() => requestClose(thread)}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>

        <div className="side-section">
          <div className="side-head">
            <span>Saved history</span>
            <button
              className="icon-btn tiny"
              onClick={() => void refreshRecent()}
              aria-label="Refresh recent sessions"
              title="Refresh"
            >
              <Icon name="refresh" size={13} />
            </button>
          </div>
          {!app.recentLoaded && <p className="empty-note">Loading…</p>}
          {app.recentLoaded && recent.length === 0 && (
            <p className="empty-note">{query ? "No saved sessions match." : "No other saved sessions."}</p>
          )}
          {recent.map((session) => (
            <button
              className={`recent-item ${resuming === session.path ? "busy" : ""}`}
              key={session.path}
              title={`Resume ${session.title}\n${session.cwd}`}
              aria-label={`Resume ${session.title || "Untitled session"} in ${session.cwd}`}
              disabled={resuming !== null}
              onClick={() => startRecent(session)}
            >
              <span className="recent-glyph" aria-hidden="true">
                {resuming === session.path ? <span className="spinner tiny" /> : "↺"}
              </span>
              <span className="session-text">
                <span className="session-title">{session.title || "Untitled session"}</span>
                <span className="session-sub">
                  {basename(session.cwd) || session.cwd} · {relativeTime(session.updatedAt)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-foot">
        <span className={`conn ${app.connected ? "on" : "off"}`}>
          <span className="status-dot" />
          {app.connected ? "Connected" : "Reconnecting"}
        </span>
        {app.info && <span className="version">v{app.info.version}</span>}
      </div>
    </nav>
  );
}

function EmptyState({ app }: { app: AppState }) {
  const [resuming, setResuming] = useState<string | null>(null);
  const resume = (session: RecentSession) => {
    if (resuming) return;
    const existing = app.order.map((id) => app.threads[id]).find((thread) =>
      thread && (thread.info.sessionFile ?? thread.info.resume) === session.path,
    );
    if (existing) {
      selectThread(existing.info.id);
      return;
    }
    setResuming(session.path);
    void resumeSession(session).catch(() => undefined).finally(() => setResuming(null));
  };
  return (
    <div className="empty-state">
      <div className="empty-glow" />
      <div className="empty-card">
        <div className="empty-mark">o</div>
        <h1>Drive omp from your browser.</h1>
        <p className="empty-sub">
          Spawn real omp sessions in any folder, watch tools run, steer the turn,
          and pick up where you left off.
        </p>
        <div className="empty-actions">
          <button className="btn btn-primary btn-lg" onClick={openNewSession}>
            <Icon name="plus" size={15} />
            Start a session
          </button>
        </div>
        <div className="empty-recent">
          <div className="empty-recent-head">Saved sessions</div>
          {!app.recentLoaded && <p className="empty-note">Loading…</p>}
          {app.recentLoaded && app.recent.length === 0 && (
            <p className="empty-note">
              Nothing yet. Start a session and it will show up here.
            </p>
          )}
          {app.recent.slice(0, 4).map((session) => (
            <button
              className="empty-recent-row"
              key={session.path}
              disabled={resuming !== null}
              onClick={() => resume(session)}
            >
              <span className="session-title">{session.title}</span>
              <span className="session-sub">
                {basename(session.cwd)} · {relativeTime(session.updatedAt)}
              </span>
            </button>
          ))}
        </div>
        {!app.connected && (
          <p className="empty-warn">
            <span className="spinner tiny" /> Reconnecting to the omp-web server…
          </p>
        )}
      </div>
    </div>
  );
}


function Toasts({ items }: { items: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((toast) => (
        <div className={`toast ${toast.level}`} key={toast.id}>
          <span className="toast-mark">
            {toast.level === "error" || toast.level === "warning" ? (
              <Icon name="alert" size={13} />
            ) : toast.level === "success" ? (
              <Icon name="check" size={13} />
            ) : (
              <span className="toast-dot" />
            )}
          </span>
          <span>{toast.text}</span>
        </div>
      ))}
    </div>
  );
}

function ConfirmModal() {
  const app = useApp();
  const pending = app.confirmState;
  const shell = useRef<HTMLDivElement>(null);
  useOverlay(shell, Boolean(pending), cancelConfirm, 70);

  if (!pending) return null;
  return (
    <div className="modal-backdrop confirm-backdrop" onMouseDown={cancelConfirm}>
      <div
        className="modal confirm"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        ref={shell}
        aria-label={pending.title}
        tabIndex={-1}
      >
        <h3>{pending.title}</h3>
        <p>{pending.message}</p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={cancelConfirm}>
            Cancel
          </button>
          <button
            className={`btn ${pending.danger ? "btn-danger" : "btn-primary"}`}
            onClick={runConfirm}
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
