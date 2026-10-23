import { expect, it } from 'vitest';
import { BlockSchema, CourseSchema, GoalSchema, TaskSchema } from '../shared/contracts';
import { belongingColor } from './belonging';
import { unscheduledTasks } from './unscheduled';

const meta = { version: 1, createdAt: '2026-10-01T08:00:00+08:00', updatedAt: '2026-10-01T08:00:00+08:00' };
const task = (id: string, extra: Record<string, unknown> = {}) => TaskSchema.parse({ ...meta, id, title: id, ...extra });
const block = (id: string, taskId: string, start: string, end: string, extra: Record<string, unknown> = {}) =>
  BlockSchema.parse({ ...meta, id, title: id, kind: 'work', taskId, start, end, ...extra });
const physics = CourseSchema.parse({ ...meta, id: 'physics', title: '大学物理', weekday: 1, startTime: '10:05', endTime: '11:40', firstWeek: 1, lastWeek: 16, termStart: '2026-08-31', color: '#7b4fa0' });
const cet = GoalSchema.parse({ ...meta, id: 'cet', title: '通过四级', color: '#b4416a' });

it('colors a task by its course first, then its goal, otherwise not at all', () => {
  const data = { courses: [physics], goals: [cet] };
  expect(belongingColor(task('a', { courseId: 'physics', goalId: 'cet' }), data)).toBe('#7b4fa0');
  expect(belongingColor(task('b', { goalId: 'cet' }), data)).toBe('#b4416a');
  expect(belongingColor(task('c'), data)).toBeNull();
  expect(belongingColor(task('d', { courseId: 'missing' }), data)).toBeNull();
});

it('lists unfinished tasks without an unfinished future arrangement, ordered by deadline; resolved fixed activities stay out', () => {
  const now = Date.parse('2026-10-22T14:20:00+08:00');
  const tasks = [
    task('no-deadline'),
    task('report', { deadline: { date: '2026-10-21', time: '23:59' } }),
    task('ended-session', { deadline: { date: '2026-10-25', time: null } }),
    task('arranged', { deadline: { date: '2026-10-23', time: '22:00' } }),
    task('done', { status: 'done' }),
    task('cancelled-only', { deadline: { date: '2026-10-30', time: null } }),
    task('lecture-attended'),
  ];
  const blocks = [
    block('s1', 'ended-session', '2026-10-20T19:00:00+08:00', '2026-10-20T21:00:00+08:00'),
    block('s2', 'arranged', '2026-10-22T15:00:00+08:00', '2026-10-22T16:30:00+08:00'),
    block('s3', 'cancelled-only', '2026-10-24T09:00:00+08:00', '2026-10-24T10:00:00+08:00', { kind: 'event', cancelled: true }),
    block('s4', 'lecture-attended', '2026-10-19T19:00:00+08:00', '2026-10-19T20:00:00+08:00', { kind: 'event', completed: true }),
  ];
  expect(unscheduledTasks({ tasks, blocks }, now).map(t => t.id)).toEqual(['report', 'ended-session', 'no-deadline']);
});
