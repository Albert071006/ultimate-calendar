import type { ReactNode } from "react";
import { Undo2 } from "lucide-react";
import type { PlannerUI } from "../../hooks/usePlanner";

/** Page header: title, page actions, the latest save notice and planner undo. */
export function PageToolbar({ title, sub, ui, undo = true, lead, children }: {
  title: ReactNode; sub?: ReactNode; ui?: PlannerUI; undo?: boolean; lead?: ReactNode; children?: ReactNode;
}) {
  const snapshot = ui?.snapshot;
  const notice = !ui ? "" : ui.busy ? "正在处理…" : !ui.error ? ui.notice : "";
  return (
    <header className="a2-toolbar">
      {lead}
      <h1 className="a2-title">{title}{sub && <small>{sub}</small>}</h1>
      {notice && <span className="a2-notice" role="status" aria-live="polite" aria-atomic="true" title={notice}>{notice}</span>}
      <div className="a2-toolbar-actions">
        {children}
        {undo && ui && snapshot && (
          <button className="ui-btn ghost icon" aria-label="撤销上次操作" title="撤销上次操作"
            disabled={ui.busy || !snapshot.journal.some(entry => entry.undoable && !entry.undoneAt)} onClick={() => void ui.undo()}>
            <Undo2 aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  );
}
