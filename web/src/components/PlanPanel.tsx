import { useState } from "react";
import type { TodoPhase } from "../protocol/types";
import { planProgress } from "../store/selectors";
import { Icon } from "./icons";

export function PlanPanel({
  phases,
  onClose,
}: {
  phases: TodoPhase[];
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { done, total } = planProgress(phases);
  const tasks = phases.flatMap((phase) => phase.tasks);
  return (
    <aside className="plan-panel" aria-label="Plan" data-testid="plan" data-expanded={expanded ? "true" : "false"}>
      <div className="plan-head">
        <span className="plan-title">Plan</span>
        <span className="plan-count">
          {done}/{total} done
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="icon-button"
          aria-label={expanded ? "Restore plan" : "Expand plan"}
          title={expanded ? "Restore" : "Expand"}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name={expanded ? "close" : "panel"} size={14} />
        </button>
        <button type="button" className="icon-button" aria-label="Close plan" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="plan-body">
        {tasks.length === 0 ? (
          <div className="plan-empty">
            <span className="instrument" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <strong>No plan yet</strong>
            <p>The agent's todos appear here as phases and tasks, with blockers and progress.</p>
          </div>
        ) : (
          <>
            <div className="plan-progress" aria-hidden="true">
              {tasks.map((task, index) => (
                <i
                  key={index}
                  data-done={task.status === "completed" ? "true" : "false"}
                  data-active={task.status === "in_progress" ? "true" : "false"}
                />
              ))}
            </div>
            {phases.map((phase) => (
              <section className="plan-phase" key={phase.name}>
                <div className="plan-phase-name">{phase.name}</div>
                {phase.tasks.map((task, index) => {
                  const status = task.blocked ? "blocked" : task.status;
                  return (
                    <div className="plan-task" data-status={status} key={`${phase.name}:${index}`}>
                      <span className="plan-mark" aria-hidden="true">
                        {status === "completed" ? "✓" : status === "in_progress" ? "•" : status === "blocked" ? "!" : "·"}
                      </span>
                      <span className="plan-task-text">
                        {task.content}
                        {task.blocked ? <span className="plan-task-note">blocked · {task.blocked}</span> : null}
                      </span>
                    </div>
                  );
                })}
              </section>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
