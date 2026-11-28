import { describe, expect, it } from 'vitest';
import { BlockSchema, CourseSchema, FocusSessionSchema, GoalSchema, TaskSchema, type FocusSession } from '../shared/contracts';
import { focusSessionBelonging, summarizeFocusSessions, type FocusRange } from './focus';

const meta = { version: 1, createdAt: '2024-02-01T08:00:00+08:00', updatedAt: '2024-02-01T08:00:00+08:00' };
const course = CourseSchema.parse({
  ...meta, id: 'shared-id', title: '示例课程', color: '#7b4fa0', weekday: 1, startTime: '08:00', endTime: '09:00',
  firstWeek: 1, lastWeek: 12, termStart: '2024-02-05',
});
const goal = GoalSchema.parse({ ...meta, id: 'shared-id', title: '示例目标', color: '#b4416a' });
const otherCourse = { ...course, id: 'other-course', title: '另一门课程', color: null };
const task = TaskSchema.parse({ ...meta, id: 'trial-task', title: '模拟任务', courseId: course.id, goalId: goal.id });
const otherTask = { ...task, id: 'other-task', courseId: otherCourse.id };
const block = BlockSchema.parse({
  ...meta, id: 'trial-block', title: '模拟计划', kind: 'work', taskId: task.id,
  start: '2024-03-01T09:00:00+08:00', end: '2024-03-01T10:00:00+08:00',
});
const snapshot = { courses: [course, otherCourse], goals: [goal], tasks: [task, otherTask], blocks: [block] };
const session = (id: string, fields: Partial<FocusSession> = {}) => FocusSessionSchema.parse({
  ...meta, id, title: '模拟专注', mode: 'stopwatch', start: '2024-03-01T00:05:00+08:00',
  end: '2024-03-01T00:35:00+08:00', durationSeconds: 90, ...fields,
});

describe('focusSessionBelonging', () => {
  const resolve = (fields: Partial<FocusSession>) => focusSessionBelonging(session('sample', fields), snapshot);
  const courseBelonging = { kind: 'course', id: course.id, name: course.title, color: course.color };
  it('resolves live courses before goals, including courses inherited from a task or its scheduled block', () => {
    expect(resolve({ courseId: course.id, goalId: goal.id })).toEqual(courseBelonging);
    expect(resolve({ taskId: task.id, goalId: goal.id })).toEqual(courseBelonging);
    expect(resolve({ blockId: block.id, goalId: goal.id })).toEqual(courseBelonging);
  });
  it('prefers direct links within a kind, then the direct task, then the task attached to the block', () => {
    expect(resolve({ courseId: otherCourse.id, taskId: task.id })).toMatchObject({ kind: 'course', id: otherCourse.id, color: null });
    expect(resolve({ taskId: otherTask.id, blockId: block.id })).toMatchObject({ kind: 'course', id: otherCourse.id });
    expect(resolve({ courseId: 'removed', taskId: 'removed', blockId: block.id })).toEqual(courseBelonging);
  });
  it('falls back to a live goal or the unassigned group when links are absent or stale', () => {
    const goalBelonging = { kind: 'goal', id: goal.id, name: goal.title, color: goal.color };
    expect(resolve({ courseId: 'removed', goalId: goal.id })).toEqual(goalBelonging);
    const goalTask = { ...task, courseId: null };
    expect(focusSessionBelonging(session('linked', { blockId: block.id }), { ...snapshot, tasks: [goalTask] })).toEqual(goalBelonging);
    expect(resolve({ courseId: 'removed', blockId: 'removed' })).toEqual({ kind: 'unassigned', id: null, name: '未归属', color: null });
  });
});

describe('summarizeFocusSessions', () => {
  const completed = session('finished', {
    mode: 'pomodoro', plannedMinutes: 10, start: '2024-02-29T23:59:00+08:00', end: '2024-03-01T00:20:00+08:00',
    durationSeconds: 600, courseId: course.id,
  });
  const morning = session('morning', { taskId: task.id });
  const manual = session('entered', {
    mode: 'manual', start: '2024-03-01T12:00:00+08:00', end: '2024-03-01T12:02:00+08:00', goalId: goal.id,
  });
  const interrupted = session('interrupted', {
    mode: 'pomodoro', plannedMinutes: 25, completedTarget: false, start: '2024-03-01T13:00:00+08:00',
    end: '2024-03-01T13:04:00+08:00', durationSeconds: 61,
  });
  const before = session('before', { start: '2024-02-28T23:59:00+08:00', end: '2024-02-29T00:12:00+08:00' });
  const after = session('after', { start: '2024-03-03T00:00:00+08:00', end: '2024-03-03T01:00:00+08:00' });
  const records = [morning, before, interrupted, completed, manual, after];
  const range = { from: '2024-02-29', to: '2024-03-02' };

  it('credits active seconds to the Shanghai start day once and counts only completed pomodoros', () => {
    const result = summarizeFocusSessions(records, snapshot, range);
    expect(result).toMatchObject({ totalSeconds: 841, totalMinutes: 841 / 60, sessionCount: 4, completedPomodoros: 1 });
    expect(result.daily).toEqual([
      { date: '2024-02-29', durationSeconds: 600 }, { date: '2024-03-01', durationSeconds: 241 }, { date: '2024-03-02', durationSeconds: 0 },
    ]);
    expect(result.byBelonging.map(({ kind, durationSeconds, share }) => [kind, durationSeconds, share])).toEqual([
      ['course', 690, 690 / 841], ['goal', 90, 90 / 841], ['unassigned', 61, 61 / 841],
    ]);
    expect(result.details.map(({ date, entries }) => [date, entries.map(entry => entry.session.id)])).toEqual([
      ['2024-03-01', [interrupted.id, manual.id, morning.id]], ['2024-02-29', [completed.id]],
    ]);
  });
  it('filters rows by effective course, goal or unassigned, keeping whole-range chart shares', () => {
    for (const [filter, expected] of [
      [{ courseId: course.id }, [morning.id, completed.id]],
      [{ goalId: goal.id }, [manual.id]],
      [{ unassigned: true }, [interrupted.id]],
      [{ courseId: 'removed' }, []],
    ] as const) {
      const result = summarizeFocusSessions(records, snapshot, range, filter);
      expect(result.details.flatMap(day => day.entries.map(entry => entry.session.id))).toEqual(expected);
      expect(result.totalSeconds).toBe(841);
      expect(result.byBelonging).toHaveLength(3);
    }
  });
  it('resolves whole calendar days, Monday-based weeks and leap months, including zero days', () => {
    const cases: [FocusRange, string, string, number][] = [
      [{ period: 'day', date: '2024-03-01' }, '2024-03-01', '2024-03-01', 1],
      [{ period: 'week', date: '2025-01-05' }, '2024-12-30', '2025-01-05', 7],
      [{ period: 'month', date: '2024-02-29' }, '2024-02-01', '2024-02-29', 29],
      [{ period: 'month', date: '2025-12-01' }, '2025-12-01', '2025-12-31', 31],
    ];
    for (const [period, from, to, length] of cases) {
      const result = summarizeFocusSessions([], snapshot, period);
      expect(result).toMatchObject({ from, to, sessionCount: 0, totalSeconds: 0, totalMinutes: 0, completedPomodoros: 0, details: [], byBelonging: [] });
      expect(result.daily).toHaveLength(length);
      expect(result.daily[0]).toEqual({ date: from, durationSeconds: 0 });
      expect(result.daily.at(-1)).toEqual({ date: to, durationSeconds: 0 });
    }
  });
  it('rejects impossible dates and reversed custom ranges', () => {
    expect(() => summarizeFocusSessions([], snapshot, { period: 'day', date: '2025-02-29' })).toThrow();
    expect(() => summarizeFocusSessions([], snapshot, { from: range.to, to: range.from })).toThrow(/结束日期/);
  });
});
