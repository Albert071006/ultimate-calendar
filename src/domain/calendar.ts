import { DateOnlySchema, toShanghaiInstant, type BuildCalendar, type CalendarItem } from '../shared/contracts';
import { expandCourse } from './courses';
import { intersectsDays } from './time';
import { isPendingCandidate } from './candidate-eligibility';
import { effectiveActivityEnd } from './activity-duration';
export const buildCalendar: BuildCalendar = (snapshot, from, to, showPending) => {
  DateOnlySchema.parse(from); DateOnlySchema.parse(to); if (from > to) throw Error('日期范围无效');
  const items: CalendarItem[] = [];
  for (const task of snapshot.tasks) if (task.status === 'open' && task.deadline && task.deadline.date >= from && task.deadline.date <= to) items.push({ id: `deadline:${task.id}`, refId: task.id, refKind: 'task', title: task.title, date: task.deadline.date, start: task.deadline.time ? toShanghaiInstant(task.deadline.date, task.deadline.time) : null, end: null, busy: false, pending: false, category: 'deadline', location: '' });
  const now = Date.now();
  if (showPending) for (const candidate of snapshot.candidates) {
    if (!isPendingCandidate(candidate, now)) continue;
    if (candidate.deadline && candidate.deadline.date >= from && candidate.deadline.date <= to) items.push({ id: `candidate:${candidate.id}`, refId: candidate.id, refKind: 'candidate', title: candidate.title, date: candidate.deadline.date, start: candidate.deadline.time ? toShanghaiInstant(candidate.deadline.date, candidate.deadline.time) : null, end: null, busy: false, pending: true, category: 'candidate', location: candidate.location });
    if (candidate.eventStart && intersectsDays(candidate.eventStart, candidate.eventEnd, from, to)) items.push({ id: `candidate-event:${candidate.id}`, refId: candidate.id, refKind: 'candidate', title: candidate.title, date: candidate.eventStart.slice(0, 10), start: candidate.eventStart, end: candidate.eventEnd, busy: false, pending: true, category: 'candidate', location: candidate.location });
  }
  for (const b of snapshot.blocks) {
    if (b.cancelled) continue;
    const end = b.kind === 'event' ? effectiveActivityEnd(b.start, b.end) : b.end;
    if (intersectsDays(b.start, end, from, to)) items.push({ id: b.id, refId: b.id, refKind: 'block', title: b.title, start: b.start, end, date: b.start.slice(0, 10), busy: end !== null, pending: false, category: b.kind, location: b.location });
  }
  for (const c of snapshot.courses) items.push(...expandCourse(c, snapshot.courseExceptions, from, to));
  return items.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? '').localeCompare(b.start ?? '') || a.id.localeCompare(b.id));
};
