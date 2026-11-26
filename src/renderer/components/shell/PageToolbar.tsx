import type { ReactNode } from "react";
import { Undo2 } from "lucide-react";
import type { PlannerUI } from "../../hooks/usePlanner";

/** Page header with persistent access to planner undo. */
export function PageToolbar({ title, sub, ui, undo = true, lead, children, secondary }: {
  title: ReactNode; sub?: ReactNode; ui?: PlannerUI; undo?: boolean; lead?: ReactNode; children?: ReactNode;
  secondary?: ReactNode;
}) {
  const snapshot = ui?.snapshot;
  return (
    <header className="a2-toolbar">
      {lead}
      <h1 className="a2-title">{title}{sub && <small>{sub}</small>}</h1>
      <div className="a2-toolbar-actions">
        {children}
        {undo && ui && snapshot && (
          <button className="ui-btn ghost icon" aria-label="撤销上次操作" title="撤销上次操作"
            disabled={ui.busy || !snapshot.journal.some(entry => entry.undoable && !entry.undoneAt)} onClick={() => void ui.undo()}>
            <Undo2 aria-hidden="true" />
          </button>
        )}
      </div>
      {secondary && <div className="a2-toolbar-secondary">{secondary}</div>}
    </header>
  );
}
