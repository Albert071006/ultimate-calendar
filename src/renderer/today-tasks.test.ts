import { describe, expect, it } from 'vitest';
import { BlockSchema, CandidateSchema, SourceSchema, TaskSchema, type Snapshot, type Task } from '../shared/contracts';
import { groupTodayTasks } from './today-tasks';
import { selectRailTasks } from './task-rail';

const metadata = { version: 1, createdAt: '2026-10-23T09:00:00+08:00', updatedAt: '2026-10-23T09:00:00+08:00' };
const today = '2026-10-23', now = Date.parse(`${today}T11:00:00+08:00`);
const task = (id: string, extra: Partial<Task> = {}) => TaskSchema.parse({ ...metadata, id, title: id, ...extra });
type Data = Pick<Snapshot, 'tasks' | 'blocks' | 'candidates' | 'sources'>;
const data = (tasks: Task[]): Data => ({ tasks, blocks: [], candidates: [], sources: [SourceSchema.parse({ ...metadata, id: 'source', kind: 'text', text: '活动通知', importedAt: metadata.createdAt })] });
const event = (id: string, taskId: string, start: string) => BlockSchema.parse({ ...metadata, id, title: id, taskId, kind: 'event', start, end: null });
const groups = (saved: Data, time = now, date = today) => groupTodayTasks(saved, selectRailTasks(saved, time), date, time).map(([key, tasks]) => [key, tasks.map(t => t.id)]);

describe('today task time grouping', () => {
  it('places a noon activity and a grounded notice before a distant deadline, leaving untimed tasks stable at the end', () => {
    const saved = data([task('untimed'), task('exam', { deadline: { date: '2026-11-26', time: null } }), task('noon'), task('notice', { candidateId: 'candidate' }), task('untimed-2')]);
    saved.blocks.push(event('noon-event', 'noon', `${today}T12:00:00+08:00`));
    saved.candidates.push(CandidateSchema.parse({ ...metadata, id: 'candidate', title: 'notice', sourceIds: ['source'], status: 'accepted', taskId: 'notice', eventStart: `${today}T13:00:00+08:00` }));
    const before = structuredClone(saved);
    expect(groups(saved)).toEqual([['today', ['noon', 'notice']], ['later', ['exam']], ['none', ['untimed', 'untimed-2']]]);
    expect(saved).toEqual(before);
  });

  it('sorts date-only deadlines at the end of their Shanghai day and expires them at the next midnight', () => {
    const saved = data([task('whole-day', { deadline: { date: today, time: null } }), task('midnight'), task('late', { deadline: { date: today, time: '23:59' } })]);
    saved.blocks.push(event('next-day', 'midnight', '2026-10-24T00:00:00+08:00'));
    expect(groups(saved)).toEqual([['today', ['late', 'whole-day']], ['week', ['midnight']]]);
    expect(groups(saved, Date.parse('2026-10-24T00:00:00+08:00'), '2026-10-24')).toEqual([['over', ['late', 'whole-day']], ['today', ['midnight']]]);
  });

  it('uses the current or next unfinished saved slot, ignoring stale notices, completed slots and cancelled slots', () => {
    const saved = data([task('series', { candidateId: 'old' }), task('tomorrow', { deadline: { date: '2026-10-24', time: '10:00' } })]);
    saved.candidates.push(CandidateSchema.parse({ ...metadata, id: 'old', title: 'old', sourceIds: ['source'], status: 'accepted', taskId: 'series', eventStart: '2026-10-21T12:00:00+08:00' }));
    saved.blocks.push(
      { ...event('finished', 'series', '2026-10-22T12:00:00+08:00'), completed: true },
      { ...event('cancelled', 'series', `${today}T09:00:00+08:00`), cancelled: true },
      event('missed', 'series', `${today}T10:00:00+08:00`),
      event('next', 'series', '2026-10-25T12:00:00+08:00'),
    );
    expect(groups(saved)).toEqual([['week', ['tomorrow', 'series']]]);
    saved.blocks[3]!.start = `${today}T10:50:00+08:00`;
    expect(groups(saved)).toEqual([['today', ['series']], ['week', ['tomorrow']]]);
  });

  it('uses an earlier deadline independently and keeps ongoing overnight activities in today', () => {
    const saved = data([task('overnight'), task('report', { deadline: { date: today, time: '12:00' } })]);
    saved.blocks.push({ ...event('overnight-event', 'overnight', '2026-10-22T23:00:00+08:00'), end: `${today}T12:30:00+08:00` }, event('work', 'report', '2026-10-24T12:00:00+08:00'));
    expect(groups(saved)).toEqual([['today', ['overnight', 'report']]]);
  });

  it('preserves explicit completion/cancellation filtering and never revives a superseded notice', () => {
    const saved = data([task('done', { status: 'done' }), task('cancelled', { candidateId: 'old' }), task('attended'), task('unfinished-work', { candidateId: 'work-notice' })]);
    saved.candidates.push(...['cancelled', 'unfinished-work'].map((id, index) => CandidateSchema.parse({ ...metadata, id: index ? 'work-notice' : 'old', title: id, sourceIds: ['source'], status: 'accepted', taskId: id, eventStart: `${today}T12:00:00+08:00` })));
    saved.blocks.push({ ...event('cancel', 'cancelled', `${today}T12:00:00+08:00`), cancelled: true }, { ...event('attend', 'attended', `${today}T13:00:00+08:00`), completed: true }, { ...event('work-slot', 'unfinished-work', `${today}T10:00:00+08:00`), kind: 'work', completed: true });
    expect(groups(saved)).toEqual([['none', ['unfinished-work']]]);
    expect(groupTodayTasks(saved, saved.tasks.filter(t => t.status === 'open'), today, now).flatMap(([, tasks]) => tasks.map(t => t.id))).toEqual(['cancelled', 'attended', 'unfinished-work']);
  });
});
