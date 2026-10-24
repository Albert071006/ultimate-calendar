import { Check, X } from "lucide-react";
import type { Candidate, Snapshot } from "../../../shared/contracts";
import { arrival, dayWord } from "./format";

export interface Toast { text: string; transactionId: string; id: string }

/** Time chips for a notice: its deadline, its activity, or that no time was given. */
function Chips({ candidate, today }: { candidate: Candidate; today: string }) {
  const chips = [];
  if (candidate.deadline) chips.push(<span className="ui-chip pending" key="d">截止 {dayWord(candidate.deadline.date, today)}{candidate.deadline.time && <b>{candidate.deadline.time}</b>}</span>);
  if (candidate.eventStart) chips.push(<span className="ui-chip event" key="e">{dayWord(candidate.eventStart.slice(0, 10), today)} <b>{candidate.eventStart.slice(11, 16)}{candidate.eventEnd && candidate.eventEnd.slice(0, 10) === candidate.eventStart.slice(0, 10) ? `–${candidate.eventEnd.slice(11, 16)}` : ""}</b></span>);
  if (!chips.length) chips.push(<span className="ui-chip unknown" key="u">时间未说明</span>);
  return <div className="when">{chips}</div>;
}

export function sourceLine(snapshot: Snapshot, candidate: Candidate, today: string) {
  const source = candidate.sourceIds.map(id => snapshot.sources.find(value => value.id === id)).find(Boolean);
  if (!source) return { label: "原文已删除", at: "" };
  return { label: source.label || (source.kind === "image" ? "截图" : "粘贴的消息"), at: arrival(source.sentAt ?? source.importedAt, today) };
}

export function InboxList({ snapshot, items, selectedId, today, quick, busy, select, decide, toast, undo }: {
  snapshot: Snapshot;
  items: Candidate[];
  selectedId: string | undefined;
  today: string;
  /** Whether rows carry the quick ✓ / ✕ (only while a decision is still open). */
  quick: boolean;
  busy: boolean;
  select: (id: string) => void;
  decide: (candidate: Candidate, type: "acceptCandidate" | "ignoreCandidate") => void;
  toast: Toast | null;
  undo: () => void;
}) {
  return (
    <section className="a2-ib-list" aria-label="通知列表">
      {items.map(candidate => {
        const source = sourceLine(snapshot, candidate, today), on = candidate.id === selectedId;
        return (
          <article key={candidate.id} aria-current={on || undefined} className={`a2-ib-item${on ? " on" : ""}${quick ? " quick" : ""}`} data-candidate-id={candidate.id}
            onClick={() => select(candidate.id)}>
            <div className="src"><span>{source.label}</span><span>{source.at}</span></div>
            <h3><button className="pick" onClick={() => select(candidate.id)}>{candidate.title}</button></h3>
            <Chips candidate={candidate} today={today} />
            {quick && <div className="qa" onClick={event => event.stopPropagation()}>
              <button className="ok" disabled={busy} aria-label={`接受 ${candidate.title}`} title="接受（A）" onClick={() => decide(candidate, "acceptCandidate")}><Check aria-hidden="true" /></button>
              <button className="no" disabled={busy} aria-label={`忽略 ${candidate.title}`} title="忽略（I）" onClick={() => decide(candidate, "ignoreCandidate")}><X aria-hidden="true" /></button>
            </div>}
          </article>
        );
      })}
      {toast && <div className="ui-toast a2-ib-toast" role="status">{toast.text}<button onClick={undo}>撤销</button></div>}
      {items.length > 0 && quick && <p className="a2-ib-keys">上下键切换 · A 接受 · I 忽略 · L 稍后</p>}
    </section>
  );
}
