import { describe, expect, it } from 'vitest';
import { BlockSchema, CandidateSchema, SourceSchema, TaskSchema, type Block, type Deadline, type Snapshot, type Task } from '../shared/contracts';
import { selectRailTasks } from './task-rail';

const metadata = { version: 1, createdAt: '2026-10-21T09:00:00+08:00', updatedAt: '2026-10-21T09:00:00+08:00' };
const now = Date.parse('2026-10-23T12:00:00+08:00');

function task(id: string, deadline: Deadline | null = null, status: Task['status'] = 'open'): Task {
  return TaskSchema.parse({ ...metadata, id, title: id, deadline, status });
}
const ids = (tasks: Task[]) => tasks.map(value => value.id);
type RailSnapshot = Pick<Snapshot, 'tasks' | 'blocks' | 'candidates' | 'sources'>;
function snapshot(tasks: Task[], extra: Partial<Omit<RailSnapshot, 'tasks'>> = {}): RailSnapshot {
  return { tasks, blocks: [], candidates: [], sources: [], ...extra };
}
function event(id: string, taskId: string, start: string, end: string | null = null, completed = false): Block {
  return BlockSchema.parse({ ...metadata, id, taskId, title: id, kind: 'event', start, end, completed });
}
function noticeSnapshot(start: string | null, end: string | null = null): RailSnapshot {
  const quote = '周四晚上九点半，活动室开个会哈';
  const meeting = TaskSchema.parse({ ...task('meeting'), title: '活动室周四晚上九点半开会', candidateId: 'notice' });
  return snapshot([meeting], {
    candidates: [CandidateSchema.parse({ ...metadata, id: 'notice', title: meeting.title, status: 'accepted', taskId: meeting.id,
      sourceIds: ['source'], eventStart: start, eventEnd: end, sourceQuote: quote,
      temporalEvidence: [{ field: 'eventStart', basis: 'relative', quote }] })],
    sources: [SourceSchema.parse({ ...metadata, id: 'source', kind: 'text', text: quote,
      importedAt: metadata.createdAt, sentAt: '2026-10-21T00:28:53+08:00' })],
  });
}

describe('selectRailTasks', () => {
  it('hides completed and expired tasks while retaining open tasks without a deadline', () => {
    const tasks = [
      task('done', { date: '2026-10-24', time: '18:00' }, 'done'),
      task('done-no-deadline', null, 'done'),
      task('expired', { date: '2026-10-23', time: '11:59' }),
      task('yesterday', { date: '2026-10-22', time: null }),
      task('upcoming', { date: '2026-10-23', time: '12:01' }),
      task('no-deadline'),
    ];
    expect(ids(selectRailTasks(snapshot(tasks), now))).toEqual(['upcoming', 'no-deadline']);
  });

  it('keeps a task at its exact timed deadline and hides it once that instant passes', () => {
    const tasks = [task('at-noon', { date: '2026-10-23', time: '12:00' })];
    expect(ids(selectRailTasks(snapshot(tasks), now))).toEqual(['at-noon']);
    expect(selectRailTasks(snapshot(tasks), now + 1)).toEqual([]);
  });

  it('keeps a date-only task throughout its Beijing date and expires it at next midnight', () => {
    const tasks = [task('today', { date: '2026-10-23', time: null })];
    expect(ids(selectRailTasks(snapshot(tasks), Date.parse('2026-10-22T16:00:00Z')))).toEqual(['today']);
    expect(ids(selectRailTasks(snapshot(tasks), Date.parse('2026-10-23T15:59:59.999Z')))).toEqual(['today']);
    expect(selectRailTasks(snapshot(tasks), Date.parse('2026-10-23T16:00:00Z'))).toEqual([]);
  });

  it('orders nearest deadlines first, date-only at end of day, then no-deadline tasks with stable ties', () => {
    const tasks = [
      task('no-deadline-1'),
      task('tomorrow', { date: '2026-10-24', time: '08:30' }),
      task('end-of-today', { date: '2026-10-23', time: null }),
      task('afternoon-1', { date: '2026-10-23', time: '14:00' }),
      task('no-deadline-2'),
      task('afternoon-2', { date: '2026-10-23', time: '14:00' }),
      task('end-of-today-2', { date: '2026-10-23', time: null }),
    ];
    expect(ids(selectRailTasks(snapshot(tasks), now))).toEqual([
      'afternoon-1', 'afternoon-2', 'end-of-today', 'end-of-today-2', 'tomorrow', 'no-deadline-1', 'no-deadline-2',
    ]);
  });

  it('handles date-only expiry across year boundaries and leap days', () => {
    expect(selectRailTasks(snapshot([task('year-end', { date: '2026-12-31', time: null })]), Date.parse('2027-01-01T00:00:00+08:00'))).toEqual([]);
    const leapDay = [task('leap-day', { date: '2028-02-29', time: null })];
    expect(ids(selectRailTasks(snapshot(leapDay), Date.parse('2028-02-29T23:59:59+08:00')))).toEqual(['leap-day']);
    expect(selectRailTasks(snapshot(leapDay), Date.parse('2028-03-01T00:00:00+08:00'))).toEqual([]);
  });

  it('does not remove open tasks when the current clock is not finite', () => {
    const tasks = [task('with-deadline', { date: '2026-10-22', time: '09:00' }), task('no-deadline')];
    expect(ids(selectRailTasks(snapshot(tasks), NaN))).toEqual(['with-deadline', 'no-deadline']);
    expect(ids(selectRailTasks(snapshot(tasks), Infinity))).toEqual(['with-deadline', 'no-deadline']);
  });

  it('keeps a start-only activity until its default thirty-minute duration ends', () => {
    const saved = snapshot([task('yesterday'), task('today')], { blocks: [
      event('past-meeting', 'yesterday', '2026-10-22T21:30:00+08:00'),
      event('today-meeting', 'today', '2026-10-23T11:45:00+08:00'),
    ] });
    expect(ids(selectRailTasks(saved, now))).toEqual(['today']);
    expect(ids(selectRailTasks(saved, Date.parse('2026-10-23T12:14:59.999+08:00')))).toEqual(['today']);
    expect(selectRailTasks(saved, Date.parse('2026-10-23T12:15:00+08:00'))).toEqual([]);
  });

  it('lets the default duration cross midnight instead of expiring at the date boundary', () => {
    const saved = snapshot([task('overnight')], { blocks: [
      event('overnight-meeting', 'overnight', '2026-10-22T23:50:00+08:00'),
    ] });
    expect(ids(selectRailTasks(saved, Date.parse('2026-10-23T00:00:00+08:00')))).toEqual(['overnight']);
    expect(ids(selectRailTasks(saved, Date.parse('2026-10-23T00:19:59.999+08:00')))).toEqual(['overnight']);
    expect(selectRailTasks(saved, Date.parse('2026-10-23T00:20:00+08:00'))).toEqual([]);
  });

  it('retains a cross-midnight activity until its explicit end and hides it at that boundary', () => {
    const saved = snapshot([task('overnight')], { blocks: [
      event('overnight-event', 'overnight', '2026-10-22T21:30:00+08:00', '2026-10-23T13:00:00+08:00'),
    ] });
    expect(ids(selectRailTasks(saved, now))).toEqual(['overnight']);
    expect(selectRailTasks(saved, Date.parse('2026-10-23T13:00:00+08:00'))).toEqual([]);
  });

  it('counts completed fixed activities as ended even when their times are in the future', () => {
    const saved = snapshot([task('completed-event')], { blocks: [
      event('event', 'completed-event', '2026-10-24T21:30:00+08:00', null, true),
    ] });
    expect(selectRailTasks(saved, now)).toEqual([]);
  });

  it('keeps a task with any future or ongoing fixed activity and hides it when all are over', () => {
    const saved = snapshot([task('multi')], { blocks: [
      event('past', 'multi', '2026-10-22T21:30:00+08:00'),
      event('future', 'multi', '2026-10-24T09:00:00+08:00', '2026-10-24T10:00:00+08:00'),
    ] });
    expect(ids(selectRailTasks(saved, now))).toEqual(['multi']);
    expect(ids(selectRailTasks(saved, Date.parse('2026-10-24T09:30:00+08:00')))).toEqual(['multi']);
    expect(selectRailTasks(saved, Date.parse('2026-10-24T10:00:00+08:00'))).toEqual([]);
  });

  it('does not hide an unfinished task just because a work slot ended or was completed', () => {
    const saved = snapshot([task('work')], { blocks: [BlockSchema.parse({
      ...metadata, id: 'work-slot', taskId: 'work', title: '写报告', kind: 'work', completed: true,
      start: '2026-10-22T20:00:00+08:00', end: '2026-10-22T21:00:00+08:00',
    })] });
    expect(ids(selectRailTasks(saved, now))).toEqual(['work']);
    expect(saved.tasks[0]!.status).toBe('open');
  });

  it('recovers Thursday 21:30 from the Wednesday source and hides it on Friday without a saved calendar block', () => {
    const saved = noticeSnapshot(null);
    expect(selectRailTasks(saved, now)).toEqual([]);
    expect(ids(selectRailTasks(saved, Date.parse('2026-10-22T21:59:59+08:00')))).toEqual(['meeting']);
    expect(selectRailTasks(saved, Date.parse('2026-10-22T22:00:00+08:00'))).toEqual([]);
    expect(saved.candidates[0]!.eventStart).toBeNull();
    expect(saved.tasks[0]!.status).toBe('open');
  });

  it('uses explicit candidate end times when a calendar block has not been created', () => {
    const saved = noticeSnapshot('2026-10-22T21:30:00+08:00', '2026-10-23T13:00:00+08:00');
    expect(ids(selectRailTasks(saved, now))).toEqual(['meeting']);
    expect(selectRailTasks(saved, Date.parse('2026-10-23T13:00:00+08:00'))).toEqual([]);
  });

  it('respects calendar rescheduling over the original past notice', () => {
    const saved = noticeSnapshot('2026-10-22T21:30:00+08:00');
    saved.blocks.push(event('rescheduled', 'meeting', '2026-10-24T21:30:00+08:00'));
    expect(ids(selectRailTasks(saved, now))).toEqual(['meeting']);
  });

  it('does not let an original future notice keep already ended rescheduled events visible', () => {
    const saved = noticeSnapshot('2026-10-24T21:30:00+08:00');
    saved.blocks.push(event('rescheduled', 'meeting', '2026-10-22T21:30:00+08:00'));
    expect(selectRailTasks(saved, now)).toEqual([]);
  });

  it('never infers activity expiry from the title or an ungrounded notice', () => {
    const saved = noticeSnapshot(null);
    saved.sources = [];
    expect(ids(selectRailTasks(saved, now))).toEqual(['meeting']);
    saved.candidates = [];
    expect(ids(selectRailTasks(saved, now))).toEqual(['meeting']);
  });

  it('retains past activity times if the current clock is invalid', () => {
    const saved = noticeSnapshot(null);
    saved.blocks.push(event('past', 'meeting', '2026-10-22T21:30:00+08:00'));
    expect(ids(selectRailTasks(saved, NaN))).toEqual(['meeting']);
    expect(ids(selectRailTasks(saved, Infinity))).toEqual(['meeting']);
  });

  it('does not change records, linked blocks, source evidence, or candidate times while hiding activities', () => {
    const saved = noticeSnapshot(null);
    saved.tasks.push(task('active'));
    saved.blocks.push(event('future', 'active', '2026-10-24T09:00:00+08:00'));
    const before = structuredClone(saved);
    function freeze(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    freeze(saved);
    const selected = selectRailTasks(saved, now);
    expect(ids(selected)).toEqual(['active']);
    expect(selected[0]).toBe(saved.tasks[1]);
    expect(saved).toEqual(before);
  });

  it('does not mutate input order or records and returns the original task objects', () => {
    const later = task('later', { date: '2026-10-24', time: '09:00' });
    const sooner = task('sooner', { date: '2026-10-23', time: '15:00' });
    const tasks = [later, sooner];
    const before = structuredClone(tasks);
    Object.freeze(later.deadline);
    Object.freeze(later);
    Object.freeze(sooner.deadline);
    Object.freeze(sooner);
    Object.freeze(tasks);
    const selected = selectRailTasks(snapshot(tasks), now);
    expect(tasks).toEqual(before);
    expect(selected).not.toBe(tasks);
    expect(selected[0]).toBe(sooner);
    expect(selected[1]).toBe(later);
  });
});
