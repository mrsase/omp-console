import { useRef, useState } from "react";
import type { RawFrame, ThreadRuntime } from "../protocol/types";
import { basename, formatCost, formatTokens, formatTokensPerSecond } from "../protocol/format";
import { assistantModelName, sessionTitle, statusLabel } from "../store/selectors";
import { useNow, useOutsideClick } from "./hooks";
import { Icon } from "./icons";

export function Header({
  session,
  connection,
  planOpen,
  theme,
  onTogglePlan,
  onSettings,
  onNewSession,
  onReadMode,
  onToggleTheme,
  onOpenRail,
  onCommand,
  onCloseSession,
}: {
  session: ThreadRuntime | undefined;
  connection: "connecting" | "open" | "closed";
  planOpen: boolean;
  theme: "light" | "dark";
  onTogglePlan: () => void;
  onSettings: () => void;
  onNewSession: () => void;
  onReadMode: () => void;
  onToggleTheme: () => void;
  onOpenRail: () => void;
  onCommand: (frame: RawFrame) => void;
  onCloseSession: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const moreRef = useRef<HTMLDivElement>(null);
  useOutsideClick(moreRef, moreOpen, () => setMoreOpen(false));
  const now = useNow(1000, session?.streaming === true);
  if (!session) {
    return (
      <header className="header" data-testid="header">
        <button type="button" className="icon-button" aria-label="Sessions" data-rail-toggle onClick={onOpenRail}>
          <Icon name="menu" />
        </button>
        <h1 className="header-title">omp console</h1>
        <span className="status-pill" data-status={connection === "open" ? "Idle" : "Ended"}>
          <i aria-hidden="true" />
          {connection === "open" ? "connected" : connection}
        </span>
      </header>
    );
  }
  const percent = session.contextUsage?.percent ?? 0;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.min(1, Math.max(0, percent / 100));
  const spark = session.spark.filter((point) => point.at >= now - 30_000);
  const rate =
    session.tokensPerSecond ??
    (spark.length > 0 ? spark.reduce((total, point) => total + point.tokens, 0) / 30 : null);
  const sparkPoints = (() => {
    if (spark.length < 2) return "";
    const max = Math.max(1, ...spark.map((point) => point.tokens));
    return spark
      .map((point, index) => {
        const x = (index / (spark.length - 1)) * 60;
        const y = 17 - (point.tokens / max) * 15;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  })();
  const status = statusLabel(session);
  const model = assistantModelName(session);
  const percentLabel = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;

  return (
    <header className="header" data-testid="header" ref={moreRef}>
      <button type="button" className="icon-button" aria-label="Sessions" data-rail-toggle onClick={onOpenRail}>
        <Icon name="menu" />
      </button>
      <h1 className="header-title truncate" title={sessionTitle(session)}>
        {sessionTitle(session)}
      </h1>
      <span className="status-pill" data-status={status}>
        <i aria-hidden="true" />
        {status}
      </span>
      <div className="header-chips">
        {session.statuses.map((entry) => (
          <span className="chip" key={entry.key} title={entry.text}>
            {entry.text}
          </span>
        ))}
        {session.meta?.protocol && session.meta.protocol.degraded ? (
          <span className="chip" data-tone="warn" title={session.meta.protocol.degraded}>
            degraded protocol
          </span>
        ) : null}
        {session.unknown.total > 0 ? (
          <span className="chip" data-tone="warn" title="Unknown frames are retained as evidence">
            unknown {session.unknown.total}
          </span>
        ) : null}
      </div>
      <div className="header-meta">
        <div className="header-meta-cell">
          <span>cwd</span>
          <span className="truncate" title={session.meta?.cwd ?? ""}>
            {basename(session.meta?.cwd ?? "") || "—"}
          </span>
        </div>
        <div className="header-meta-cell" data-optional="true">
          <span>model</span>
          <span className="truncate" title={model}>
            {model || "—"}
          </span>
        </div>
        <div className="header-meta-cell" data-optional="true">
          <span>think</span>
          <span>{session.thinkingLevel ?? "—"}</span>
        </div>
        <div className="context-ring" title={`${percentLabel} of context used`}>
          <svg viewBox="0 0 22 22" aria-hidden="true">
            <circle className="ring-track" cx="11" cy="11" r={radius} fill="none" strokeWidth="2" />
            <circle
              className="ring-arc"
              cx="11"
              cy="11"
              r={radius}
              strokeWidth="2"
              strokeDasharray={`${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
            />
          </svg>
          <span className="context-ring-label">{percentLabel}</span>
        </div>
        <div className="header-meta-cell" data-optional="true">
          <span>cost</span>
          <span>{formatCost(session.cost)}</span>
        </div>
        <div className="header-meta-cell" data-optional="true">
          <span>tokens</span>
          <span>{formatTokens(session.tokens.total)}</span>
        </div>
        {session.streaming ? (
          <div className="header-meta-cell" data-optional="true">
            <span>{formatTokensPerSecond(rate)}</span>
            <svg className="sparkline" viewBox="0 0 60 18" aria-hidden="true">
              <polyline
                points={
                  sparkPoints ||
                  Array.from({ length: 30 }, (_, index) => `${(index / 29) * 60},9`).join(" ")
                }
              />
            </svg>
          </div>
        ) : null}
      </div>
      <div className="header-actions">
        <button
          type="button"
          className="icon-button"
          aria-pressed={planOpen}
          aria-label="Plan"
          title="Plan"
          onClick={onTogglePlan}
        >
          <Icon name="plan" />
        </button>
        <button type="button" className="icon-button" aria-label="Settings" title="Settings" onClick={onSettings}>
          <Icon name="settings" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="More"
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          onClick={() => setMoreOpen((value) => !value)}
        >
          <Icon name="more" />
        </button>
      </div>
      {moreOpen ? (
        <div className="header-menu" role="menu">
          {renaming ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) onCommand({ type: "set_session_name", name: name.trim() });
                setRenaming(false);
              }}
            >
              <input
                className="sheet-input"
                autoFocus
                aria-label="Session name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </form>
          ) : (
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setName(sessionTitle(session));
                setRenaming(true);
              }}
            >
              Rename session
            </button>
          )}
          <button type="button" className="menu-item" role="menuitem" onClick={() => onCommand({ type: "new_session" })}>
            New session in place
          </button>
          <button type="button" className="menu-item" role="menuitem" onClick={() => onCommand({ type: "compact" })}>
            Compact context
          </button>
          <button type="button" className="menu-item" role="menuitem" onClick={() => onCommand({ type: "fork" })}>
            Fork session
          </button>
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            onClick={() => onCommand({ type: "export_html" })}
          >
            Export HTML
          </button>
          <div className="menu-sep" />
          <button type="button" className="menu-item" role="menuitem" onClick={onNewSession}>
            New session
          </button>
          <button type="button" className="menu-item" role="menuitem" onClick={onReadMode}>
            Read mode
          </button>
          <button type="button" className="menu-item" role="menuitem" onClick={onToggleTheme}>
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
          <div className="menu-sep" />
          <button type="button" className="menu-item" role="menuitem" onClick={onCloseSession}>
            Close session
          </button>
        </div>
      ) : null}
    </header>
  );
}
