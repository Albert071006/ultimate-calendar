import {
  addCalendarDays, DateOnlySchema, mondayWeekday, shanghaiDate,
  type DateOnly, type FocusSession, type Snapshot,
} from '../shared/contracts';

type FocusContext = Pick<Snapshot, 'tasks' | 'blocks' | 'courses' | 'goals'>;
export type FocusBelonging =
  | { kind: 'course' | 'goal'; id: string; name: string; color: string | null }
  | { kind: 'unassigned'; id: null; name: '未归属'; color: null };
export type FocusRange = { period: 'day' | 'week' | 'month'; date: DateOnly } | { from: DateOnly; to: DateOnly };
export type FocusDetailFilter = { courseId: string } | { goalId: string } | { unassigned: true };

function indexById<T extends { id: string }>(records: readonly T[]) {
  return new Map(records.map(record => [record.id, record]));
}

export function createFocusBelongingResolver(snapshot: FocusContext) {
  const courses = indexById(snapshot.courses), goals = indexById(snapshot.goals);
  const tasks = indexById(snapshot.tasks), blocks = indexById(snapshot.blocks);

  return (session: FocusSession): FocusBelonging => {
    const blockTaskId = session.blockId ? blocks.get(session.blockId)?.taskId : null;
    const sources = [session, session.taskId ? tasks.get(session.taskId) : undefined, blockTaskId ? tasks.get(blockTaskId) : undefined];
    for (const source of sources) {
      const course = source?.courseId ? courses.get(source.courseId) : undefined;
      if (course) return { kind: 'course', id: course.id, name: course.title, color: course.color };
    }
    for (const source of sources) {
      const goal = source?.goalId ? goals.get(source.goalId) : undefined;
      if (goal) return { kind: 'goal', id: goal.id, name: goal.title, color: goal.color };
    }
    return { kind: 'unassigned', id: null, name: '未归属', color: null };
  };
}

/** Courses take precedence over goals. Within each kind prefer the session, its task, then its block's task. */
export function focusSessionBelonging(session: FocusSession, snapshot: FocusContext): FocusBelonging {
  return createFocusBelongingResolver(snapshot)(session);
}

function calendarRange(range: FocusRange): { from: DateOnly; to: DateOnly } {
  if ('from' in range) {
    const from = DateOnlySchema.parse(range.from), to = DateOnlySchema.parse(range.to);
    if (from > to) throw new RangeError('结束日期不能早于开始日期');
    return { from, to };
  }
  const date = DateOnlySchema.parse(range.date);
  if (range.period === 'day') return { from: date, to: date };
  if (range.period === 'week') {
    const from = addCalendarDays(date, 1 - mondayWeekday(date));
    return { from, to: addCalendarDays(from, 6) };
  }
  const from = `${date.slice(0, 7)}-01`;
  const last = new Date(`${from}T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return { from, to: last.toISOString().slice(0, 10) };
}

function matchesDetailFilter(belonging: FocusBelonging, filter?: FocusDetailFilter): boolean {
  if (!filter) return true;
  if ('courseId' in filter) return belonging.kind === 'course' && belonging.id === filter.courseId;
  if ('goalId' in filter) return belonging.kind === 'goal' && belonging.id === filter.goalId;
  return belonging.kind === 'unassigned';
}

/**
 * Credit all active seconds to the Shanghai date of the start. A paused session has no
 * per-second history with which to split it at midnight. The filter selects detail rows
 * only; the chart and the fractions (0..1) always describe the whole inclusive range.
 */
export function summarizeFocusSessions(
  sessions: readonly FocusSession[], snapshot: FocusContext, range: FocusRange, detailFilter?: FocusDetailFilter,
) {
  const { from, to } = calendarRange(range);
  const resolve = createFocusBelongingResolver(snapshot);
  const dailySeconds = new Map<DateOnly, number>();
  for (let date = from; ; date = addCalendarDays(date, 1)) {
    dailySeconds.set(date, 0);
    if (date === to) break;
  }
  const groups = new Map<string, { belonging: FocusBelonging; durationSeconds: number }>();
  const detailDays = new Map<DateOnly, { session: FocusSession; belonging: FocusBelonging }[]>();
  let totalSeconds = 0, sessionCount = 0, completedPomodoros = 0;
  for (const session of sessions) {
    const date = shanghaiDate(session.start);
    if (date < from || date > to) continue;
    const seconds = session.durationSeconds;
    totalSeconds += seconds;
    sessionCount++;
    if (session.mode === 'pomodoro' && session.completedTarget) completedPomodoros++;
    dailySeconds.set(date, dailySeconds.get(date)! + seconds);

    const belonging = resolve(session);
    const key = `${belonging.kind}:${belonging.id ?? ''}`;
    const group = groups.get(key) ?? { belonging, durationSeconds: 0 };
    group.durationSeconds += seconds;
    groups.set(key, group);

    if (matchesDetailFilter(belonging, detailFilter)) {
      const entries = detailDays.get(date) ?? [];
      entries.push({ session, belonging });
      detailDays.set(date, entries);
    }
  }
  const daily = Array.from(dailySeconds, ([date, durationSeconds]) => ({ date, durationSeconds }));
  const byBelonging = Array.from(groups.values(), ({ belonging, durationSeconds }) =>
    ({ ...belonging, durationSeconds, share: durationSeconds / totalSeconds }))
    .sort((a, b) => b.durationSeconds - a.durationSeconds || a.kind.localeCompare(b.kind) || (a.id ?? '').localeCompare(b.id ?? ''));
  const details = Array.from(detailDays, ([date, entries]) => ({
    date, entries: entries.sort((a, b) => Date.parse(b.session.start) - Date.parse(a.session.start) || a.session.id.localeCompare(b.session.id)),
  })).sort((a, b) => b.date.localeCompare(a.date));
  return { from, to, totalSeconds, totalMinutes: totalSeconds / 60, sessionCount, completedPomodoros, daily, byBelonging, details };
}
