import { Check, X } from "lucide-react";
import type { Candidate } from "../../../shared/contracts";
import { dayWord, fullDay, sourceLine, type InboxNotice } from "./format";
import { useMobile } from '../../mobile/layout';
import { dayDistance } from "../../../domain/time";
import { friendlyReplyText } from '../shell/AssistantText';

export interface Toast { text: string; transactionId: string; id: string }

/** Time chips for a notice: its deadline, its activity, or that no time was given. */
function Chips({ notice, today }: { notice: InboxNotice; today: string }) {
  const { candidate, activityDay: dateOnly } = notice;
  const chips = [];
  if (dateOnly) chips.push(<span className="ui-chip unknown" key="date">{fullDay(dateOnly)} · 钟点待核对</span>);
  if (candidate.deadline) chips.push(<span className="ui-chip pending" key="d">截止 {dayWord(candidate.deadline.date, today)}{candidate.deadline.time && <b>{candidate.deadline.time}</b>}</span>);
  if (candidate.eventStart) chips.push(<span className="ui-chip event" key="e">{dayWord(candidate.eventStart.slice(0, 10), today)} <b>{candidate.eventStart.slice(11, 16)}{candidate.eventEnd && candidate.eventEnd.slice(0, 10) === candidate.eventStart.slice(0, 10) ? `–${candidate.eventEnd.slice(11, 16)}` : ""}</b></span>);
  if (!chips.length) chips.push(<span className="ui-chip unknown" key="u">时间未说明</span>);
  return <div className="when">{chips}</div>;
}

/** The phone's one time line; a deadline due by tomorrow is the only red. */
function TimeLine({ notice, today }: { notice: InboxNotice; today: string }) {
  const { candidate, activityDay: dateOnly } = notice;
  const { deadline, eventStart, eventEnd } = candidate, parts = [];
  if (dateOnly) parts.push(<span key="date">{fullDay(dateOnly)} · 钟点待核对</span>);
  if (deadline) parts.push(<span key="d" className={dayDistance(today, deadline.date) <= 1 ? "due" : undefined}>截止 {dayWord(deadline.date, today)}{deadline.time && ` ${deadline.time}`}</span>);
  if (eventStart) parts.push(<span key="e">{dayWord(eventStart.slice(0, 10), today)} {eventStart.slice(11, 16)}{eventEnd && eventEnd.slice(0, 10) === eventStart.slice(0, 10) ? `–${eventEnd.slice(11, 16)}` : ""}</span>);
  return <small>{parts.length ? parts : "时间未说明"}</small>;
}

export function InboxList({ items, selectedId, today, quick, busy, pending, select, decide, toast, undo, page, pageCount, changePage }: {
  items: InboxNotice[];
  page: number;
  pageCount: number;
  changePage: (page: number) => void;
  selectedId: string | undefined;
  today: string;
  /** Whether rows carry the quick ✓ / ✕ (only while a decision is still open). */
  quick: boolean;
  busy: boolean;
  pending?: (id: string) => boolean;
  select: (id: string) => void;
  decide: (candidate: Candidate, type: "acceptCandidate" | "ignoreCandidate") => void;
  toast: Toast | null;
  undo: () => void;
}) {
  const mobile = useMobile();
  // The phone row keeps only what decides it: the title, one time line, and 忽略 / 接受 as text.
  if (mobile) return (
    <section className="m-ib-list" aria-label="通知列表">
      {items.map(notice => {
        const { candidate } = notice;
        return (
        <article key={candidate.id} className="m-ib-row" data-candidate-id={candidate.id} onClick={() => select(candidate.id)}>
          <div className="m-ib-main">
            <button className="pick" onClick={event => { event.stopPropagation(); select(candidate.id); }}>{candidate.title}</button>
            <TimeLine notice={notice} today={today} />
          </div>
          {quick && <div className="m-ib-acts" onClick={event => event.stopPropagation()}>
            <button className="m-text-btn quiet" disabled={pending?.(candidate.id) ?? busy} aria-label={`忽略 ${candidate.title}`} onClick={() => decide(candidate, "ignoreCandidate")}>忽略</button>
            <button className="m-text-btn" disabled={pending?.(candidate.id) ?? busy} aria-label={`接受 ${candidate.title}`} onClick={() => decide(candidate, "acceptCandidate")}>{(pending?.(candidate.id) ?? busy) ? '正在保存…' : '接受'}</button>
          </div>}
        </article>
      ); })}
    </section>
  );
  return (
    <section className="a2-ib-list" aria-label="通知列表">
      {items.map(notice => {
        const { candidate } = notice;
        const source = sourceLine(notice, today), on = candidate.id === selectedId;
        return (
          <article key={candidate.id} aria-current={on || undefined} className={`a2-ib-item${on ? " on" : ""}${quick ? " quick" : ""}`} data-candidate-id={candidate.id}
            onClick={() => select(candidate.id)}>
            <div className="src"><span>{source.label}</span><span>{source.at}</span></div>
            <h3><button className="pick" onClick={() => select(candidate.id)}>{candidate.title}</button></h3>
            <Chips notice={notice} today={today} />
            {quick && <div className="qa" onClick={event => event.stopPropagation()}>
              <button className="ok" disabled={pending?.(candidate.id) ?? busy} aria-label={`接受 ${candidate.title}`} title="接受（A）" onClick={() => decide(candidate, "acceptCandidate")}><Check aria-hidden="true" /></button>
              <button className="no" disabled={pending?.(candidate.id) ?? busy} aria-label={`忽略 ${candidate.title}`} title="忽略（I）" onClick={() => decide(candidate, "ignoreCandidate")}><X aria-hidden="true" /></button>
            </div>}
            {(pending?.(candidate.id) ?? busy) && <small role="status">正在保存…</small>}
          </article>
        );
      })}
      {pageCount > 1 && <nav className="ui-seg" aria-label="通知分页">
        <button disabled={page === 0} onClick={() => changePage(page - 1)}>上一页</button>
        <span>{page + 1} / {pageCount}</span>
        <button disabled={page + 1 === pageCount} onClick={() => changePage(page + 1)}>下一页</button>
      </nav>}
      {toast && <div className="ui-toast a2-ib-toast" role="status">{friendlyReplyText(toast.text)}<button onClick={undo}>撤销</button></div>}
      {items.length > 0 && quick && <p className="a2-ib-keys">上下键切换 · A 接受 · I 忽略 · L 稍后</p>}
    </section>
  );
}
