import { describe, expect, it } from 'vitest';
import { BlockSchema, CandidateSchema, SourceSchema, TaskSchema, type Block, type Deadline, type Snapshot, type Task } from '../shared/contracts';
import { selectRailTasks, taskAttention } from './task-rail';

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

describe('unfinished task visibility and attention', () => {
  it('retains overdue tasks before upcoming deadlines, hides only confirmed done tasks, and preserves stable ties', () => {
    const tasks = [task('none'), task('later', { date: '2026-10-24', time: '09:00' }), task('done', null, 'done'),
      task('expired', { date: '2026-10-22', time: null }), task('soon', { date: '2026-10-23', time: '14:00' }),
      task('same', { date: '2026-10-23', time: '14:00' }), task('none-2')];
    expect(ids(selectRailTasks(snapshot(tasks), now))).toEqual(['expired', 'soon', 'same', 'later', 'none', 'none-2']);
    expect(taskAttention(snapshot(tasks), tasks[3]!, now)).toMatchObject({ kind: 'overdue', actionLabel: '修改 DDL' });
    expect(taskAttention(snapshot(tasks), tasks[2]!, now)).toBeNull();
  });

  it('changes a timed deadline to overdue after the instant, without removing or completing it', () => {
    const t = task('noon', { date: '2026-10-23', time: '12:00' }); const saved = snapshot([t]);
    expect(taskAttention(saved, t, now)).toBeNull();
    expect(taskAttention(saved, t, now + 1)?.kind).toBe('overdue');
    expect(selectRailTasks(saved, now + 1)).toEqual([t]);
    expect(t.status).toBe('open');
  });

  it.each([
    ['2026-10-23', '2026-10-24'], ['2026-12-31', '2027-01-01'], ['2028-02-29', '2028-03-01'],
  ])('marks the date-only deadline %s overdue at the following Beijing midnight', (date, next) => {
    const t = task('date-only', { date, time: null }); const saved = snapshot([t]);
    expect(taskAttention(saved, t, Date.parse(`${date}T23:59:59.999+08:00`))).toBeNull();
    expect(taskAttention(saved, t, Date.parse(`${next}T00:00:00+08:00`))?.kind).toBe('overdue');
    expect(selectRailTasks(saved, Date.parse(`${next}T00:00:00+08:00`))).toEqual([t]);
  });

  it('uses the default thirty minutes across midnight and preserves the ended activity', () => {
    const t = task('meeting'); const saved = snapshot([t], { blocks: [event('slot', t.id, '2026-10-22T23:50:00+08:00')] });
    expect(taskAttention(saved, t, Date.parse('2026-10-23T00:19:59.999+08:00'))).toBeNull();
    const ended = Date.parse('2026-10-23T00:20:00+08:00');
    expect(taskAttention(saved, t, ended)).toEqual({ kind: 'ended', label: '已结束 · 待处理', blockId: 'slot', actionLabel: '调整时间' });
    expect(selectRailTasks(saved, ended)).toEqual([t]);
  });

  it('honors explicit activity end times and retains unfinished recurring occurrences even with a future one', () => {
    const t = task('series'); const saved = snapshot([t], { blocks: [
      event('past', t.id, '2026-10-22T21:30:00+08:00', '2026-10-23T13:00:00+08:00'),
      event('future', t.id, '2026-11-03T20:40:00+08:00'),
    ] });
    expect(taskAttention(saved, t, now)).toBeNull();
    expect(taskAttention(saved, t, Date.parse('2026-10-23T13:00:00+08:00'))?.blockId).toBe('past');
    expect(selectRailTasks(saved, Date.parse('2026-12-01T00:00:00+08:00'))).toEqual([t]);
    saved.blocks[0]!.completed = true;
    expect(taskAttention(saved, t, Date.parse('2026-10-23T13:00:00+08:00'))).toBeNull();
  });

  it('hides explicitly completed/cancelled fixed activities, but never equates a completed work slot with a completed task', () => {
    const t = task('activity'), work = task('work');
    const saved = snapshot([t, work], { blocks: [
      event('complete', t.id, '2026-10-24T09:00:00+08:00', null, true),
      { ...event('cancelled', t.id, '2026-10-22T09:00:00+08:00'), cancelled: true },
      { ...event('work-slot', work.id, '2026-10-22T09:00:00+08:00', '2026-10-22T10:00:00+08:00', true), kind: 'work' },
    ] });
    expect(selectRailTasks(saved, now)).toEqual([work]);
    expect(taskAttention(saved, work, now)).toBeNull();
    expect(work.status).toBe('open');
    saved.blocks[2]!.completed = false;
    expect(taskAttention(saved, work, now)).toMatchObject({ blockId: 'work-slot', actionLabel: '重新安排' });
    // Adding a work session to an otherwise resolved event task keeps its unfinished result visible.
    saved.blocks.push({ ...saved.blocks[2]!, id: 'mixed', taskId: t.id });
    expect(selectRailTasks(saved, now)).toEqual([t, work]);
  });

  it('recovers grounded old notice time and flags it without writing an inferred calendar block', () => {
    const saved = noticeSnapshot(null), t = saved.tasks[0]!; const before = structuredClone(saved);
    expect(taskAttention(saved, t, now)).toEqual({ kind: 'ended', label: '已结束 · 待处理', actionLabel: '调整时间' });
    expect(selectRailTasks(saved, now)).toEqual([t]);
    expect(saved).toEqual(before);
    saved.sources = [];
    expect(taskAttention(saved, t, now)).toBeNull();
  });

  it('uses rescheduled blocks instead of original notice times and clears attention after moving the actual slot', () => {
    const saved = noticeSnapshot('2026-10-22T21:30:00+08:00'), t = saved.tasks[0]!;
    saved.blocks.push(event('moved', t.id, '2026-10-24T21:30:00+08:00'));
    expect(taskAttention(saved, t, now)).toBeNull();
    saved.blocks[0]!.start = '2026-10-22T21:30:00+08:00';
    expect(taskAttention(saved, t, now)?.blockId).toBe('moved');
    saved.blocks[0]!.cancelled = true;
    expect(taskAttention(saved, t, now)).toBeNull();
    expect(selectRailTasks(saved, now)).toEqual([]);
  });

  it('keeps deadline independent from arrangements and prioritizes a genuine overdue deadline', () => {
    const t = task('work', { date: '2026-10-22', time: null });
    const saved = snapshot([t], { blocks: [{ ...event('session', t.id, '2026-10-22T09:00:00+08:00', '2026-10-22T10:00:00+08:00'), kind: 'work' }] });
    expect(taskAttention(saved, t, now)?.kind).toBe('overdue');
    t.deadline = { date: '2026-10-25', time: null };
    expect(taskAttention(saved, t, now)).toMatchObject({ kind: 'ended', blockId: 'session' });
    const end = t.deadline;
    saved.blocks[0]!.start = '2026-10-24T09:00:00+08:00'; saved.blocks[0]!.end = '2026-10-24T10:00:00+08:00';
    expect(taskAttention(saved, t, now)).toBeNull();
    expect(t.deadline).toBe(end);
  });

  it('does not assign time-derived warnings when the clock is invalid', () => {
    const t = task('task', { date: '2026-10-22', time: null }); const saved = snapshot([t]);
    for (const time of [NaN, Infinity]) {
      expect(taskAttention(saved, t, time)).toBeNull(); expect(selectRailTasks(saved, time)).toEqual([t]);
    }
  });

  it('never mutates input, order, sources or task state while deriving attention', () => {
    const saved = noticeSnapshot(null); saved.tasks.unshift(task('future', { date: '2026-10-24', time: null }));
    const before = structuredClone(saved);
    function freeze(value: unknown): void { if (!value || typeof value !== 'object') return; Object.values(value).forEach(freeze); Object.freeze(value); }
    freeze(saved);
    const selected = selectRailTasks(saved, now);
    expect(selected[0]).toBe(saved.tasks[0]);
    expect(taskAttention(saved, saved.tasks[1]!, now)?.kind).toBe('ended');
    expect(saved).toEqual(before);
  });
});
