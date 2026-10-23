import type { Candidate } from '../../shared/contracts';
import { candidateDisplay } from '../candidate-display';
import { displayInstant } from '../calendar-layout';
import { candidateExpiry } from '../../domain/candidate-eligibility';
import './Inbox.css';

export function CandidateTiming({ candidate }: { candidate: Candidate }) {
  const { timeNotes } = candidateDisplay(candidate);
  const validity = candidateExpiry(candidate);
  return <section className="candidate-timing" aria-label="事项时间">
    <div><span>活动时间</span><strong>{candidate.eventStart ? `${displayInstant(candidate.eventStart)}${candidate.eventEnd ? ` — ${displayInstant(candidate.eventEnd)}` : ' · 结束未提供'}` : '未明确'}</strong></div>
    <div><span>截止 / DDL</span><strong>{candidate.deadline ? `${candidate.deadline.date} ${candidate.deadline.time ?? '（时刻未提供，按当天结束判断过期）'}` : '未提供'}</strong></div>
    {timeNotes.length > 0 && <div className="candidate-time-notes"><span>原文时间补充</span>{timeNotes.map((note, index) => <p key={index}>{note}</p>)}</div>}
    {!validity.expired && validity.reason && <p className="warning">{validity.reason}</p>}
  </section>;
}
