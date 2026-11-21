import { useRef, useState } from "react";
import type { RawFrame, ThreadRuntime } from "../protocol/types";
import { setAutoCompactionFrame, setModelFrame, setThinkingFrame } from "../store/commands";
import { formatCost } from "../protocol/format";
import { useFocusTrap } from "./hooks";
import { Icon } from "./icons";

export function SettingsSheet({
  session,
  onClose,
  onCommand,
  theme,
  onToggleTheme,
}: {
  session: ThreadRuntime;
  onClose: () => void;
  onCommand: (frame: RawFrame) => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  useFocusTrap(sheetRef, true, onClose);
  const levels = session.levels.length > 0 ? session.levels : ["off", "low", "medium", "high", "max"];
  const filtered = session.models.filter((model) =>
    `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const providers = new Map<string, typeof session.models>();
  for (const model of filtered) {
    const list = providers.get(model.provider) ?? [];
    list.push(model);
    providers.set(model.provider, list);
  }

  return (
    <div className="dialog-scrim">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={sheetRef}>
        <div className="sheet-head">
          <div className="sheet-meta">
            <span className="kind">settings</span>
            <span>{session.model?.name ?? "no model"}</span>
          </div>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="sheet-body">
          <h2 className="sheet-title" id="settings-title">
            Session settings
          </h2>
          <section className="settings-section">
            <div className="settings-label">model</div>
            <input
              className="model-search"
              placeholder="Search models"
              aria-label="Search models"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="model-list">
              {[...providers.entries()].map(([provider, models]) => (
                <div key={provider}>
                  <div className="model-provider">{provider || "unknown"}</div>
                  {models.map((model) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={session.model?.id === model.id}
                      className="model-row"
                      key={`${model.provider}:${model.id}`}
                      onClick={() => onCommand(setModelFrame(model.provider, model.id))}
                    >
                      <span className="option-hint">{session.model?.id === model.id ? "✓" : ""}</span>
                      <span className="model-name">{model.name}</span>
                      <span className="model-cost">
                        {model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : ""}
                        {model.cost ? ` · ${formatCost(model.cost.input)}/M` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              {filtered.length === 0 ? <div className="rail-empty">No models advertised</div> : null}
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-label">thinking level</div>
            <div className="thinking-row">
              {levels.map((level) => (
                <button
                  type="button"
                  className="thinking-option"
                  aria-pressed={session.thinkingLevel === level}
                  key={level}
                  onClick={() => onCommand(setThinkingFrame(level))}
                >
                  {level}
                </button>
              ))}
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-label">compaction</div>
            <div className="toggle-row">
              <span>Automatic compaction</span>
              <button
                type="button"
                className="toggle"
                aria-pressed={session.autoCompaction === true}
                aria-label="Automatic compaction"
                onClick={() => onCommand(setAutoCompactionFrame(!(session.autoCompaction === true)))}
              />
            </div>
            <div className="toggle-row">
              <span>Theme</span>
              <button type="button" className="control" onClick={onToggleTheme}>
                {theme === "dark" ? "Light" : "Dark"}
              </button>
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-label">context</div>
            <div className="toggle-row">
              <span>Used</span>
              <span className="mono">
                {session.contextUsage
                  ? `${Math.round(session.contextUsage.percent)}% of ${Math.round((session.contextUsage.contextWindow ?? 0) / 1000)}k`
                  : "—"}
              </span>
            </div>
            <div className="toggle-row">
              <span>Session file</span>
              <span className="mono truncate" title={session.sessionFile ?? ""}>
                {session.sessionFile ?? "—"}
              </span>
            </div>
          </section>
        </div>
        <div className="sheet-actions">
          <button type="button" className="control" onClick={onClose}>
            Close
          </button>
          <span className="spacer" />
          <span className="sheet-hint">changes apply from the next turn</span>
        </div>
      </div>
    </div>
  );
}
