import type { ReactNode } from "react";
import type { CalendarItem, Snapshot } from "../../../shared/contracts";
import type { PlannerUI } from "../../hooks/usePlanner";
import { taskArrangements, taskArrangementSummary } from "../../task-schedule";
import "./DaySidebar.css";

/**
 * The day view's right column: that day's deadlines, notices still waiting for a decision,
 * then the unscheduled drawer, so a day can be planned without leaving it.
 */
export function DaySidebar({ snapshot, day, today, items, now, ui, open, openCandidate, drawer }: {
  snapshot: Snapshot;
  day: string;
  today: string;
  /** Calendar items of this day, including pending notices. */
  items: CalendarItem[];
  now: number;
  ui: PlannerUI;
  open: (item: CalendarItem) => void;
  openCandidate?: (id: string) => void;
  drawer: ReactNode;
}) {
  const deadlines = items.filter(item => item.category === "deadline" && item.date === day);
  const seen = new Set<string>();
  const pending = items.filter(item => item.category === "candidate" && !seen.has(item.refId) && seen.add(item.refId))
    .flatMap(item => { const candidate = snapshot.candidates.find(value => value.id === item.refId); return candidate ? [{ item, candidate }] : []; });
  const decide = (id: string, version: number, type: "acceptCandidate" | "ignoreCandidate") =>
    void ui.mutate([{ type, id, expectedVersion: version, reason: "" }]);
  const label = day === today ? "今天" : "当天";
  return (
    <aside className="a2-day-side" aria-label={`${label}概览`}>
      <section className="a2-side-sec" aria-label={`${label}截止`}>
        <h4>{label}截止</h4>
        {deadlines.length ? deadlines.map(item => {
          const arrangements = taskArrangements(snapshot, item.refId);
          return <button className="a2-side-item" key={item.id} onClick={() => open(item)}>
            <span className="tm">{item.start ? item.start.slice(11, 16) : "全天"}</span>
            <span><span className="tt">{item.title}</span><span className="tx">{arrangements.length ? taskArrangementSummary(arrangements, now) : "未安排"}</span></span>
          </button>;
        }) : <p className="a2-side-none">没有截止</p>}
      </section>
      {pending.length > 0 && <section className="a2-side-sec" aria-label="待决定">
        <h4>待决定</h4>
        {pending.map(({ item, candidate }) => (
          <div className="a2-side-pend" key={candidate.id}>
            <button className="tt" onClick={() => open(item)}>{candidate.title}</button>
            <div className="tx">{[candidate.eventStart ? `${candidate.eventStart.slice(11, 16)}${candidate.eventEnd ? `–${candidate.eventEnd.slice(11, 16)}` : ""}` : candidate.deadline ? `截止 ${candidate.deadline.time ?? "当天"}` : "", candidate.location].filter(Boolean).join(" · ")}</div>
            <div className="acts">
              <button className="ui-btn sm primary" disabled={ui.busy} onClick={() => decide(candidate.id, candidate.version, "acceptCandidate")}>参加</button>
              <button className="ui-btn sm" disabled={ui.busy} onClick={() => decide(candidate.id, candidate.version, "ignoreCandidate")}>忽略</button>
              {openCandidate && <button className="ui-btn sm ghost" onClick={() => openCandidate(candidate.id)}>稍后</button>}
            </div>
          </div>
        ))}
      </section>}
      {drawer}
    </aside>
  );
}
