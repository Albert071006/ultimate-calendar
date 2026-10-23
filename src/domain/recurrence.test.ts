import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MutationRequestSchema, RecurrenceRuleSchema, type MutationInput, type MutationResult, type RecurrenceRuleInput } from '../shared/contracts';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from './planner';
import { expandRecurrence } from './recurrence';
import { collectReminders } from './reminders';

const evenRule: RecurrenceRuleInput = { frequency: 'even-weeks', fromDate: '2026-10-23', untilDate: '2026-12-01', weekday: 2, time: '20:40', termStart: '2026-08-31' };
const starts = (rule: RecurrenceRuleInput) => expandRecurrence(rule).map(value => value.start.slice(0, 10));
const roots: string[] = [];
const repositories: Repository[] = [];
afterEach(() => { vi.useRealTimers(); for (const repository of repositories.splice(0)) repository.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T18:00:00+08:00'));
  const root = mkdtempSync(join(tmpdir(), 'recurrence-')); roots.push(root);
  const repository = createRepository(join(root, 'planner.sqlite')); repositories.push(repository);
  const planner = createPlanner(repository); let count = 0;
  const mutate = (...mutations: MutationInput[]) => planner.mutate(MutationRequestSchema.parse({ operationId: `recurring-${++count}`, origin: 'manual', mutations }));
  const confirm = (result: MutationResult) => {
    if (result.status !== 'preview') throw new Error(`Expected preview: ${result.message}`);
    return planner.mutate({ ...result.proposedRequest, confirmed: true, confirmationToken: result.confirmationToken });
  };
  mutate({ type: 'create', entity: 'task', values: { title: '双周周二晚活动室值班检查', description: '去活动室查看', reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null } } });
  const task = planner.snapshot().tasks[0]!;
  const schedule = (rule: RecurrenceRuleInput = evenRule, extra: Partial<Extract<MutationInput, { type: 'scheduleRecurringTask' }>> = {}) => mutate({ type: 'scheduleRecurringTask', id: task.id, expectedVersion: task.version, rule, location: '活动室', ...extra });
  return { repository, planner, mutate, confirm, task, schedule, root };
}

describe('bounded activity recurrence', () => {
  it('uses academic even weeks: after Friday of week 8, the next Tuesday is in week 10', () => {
    expect(starts(evenRule)).toEqual(['2026-11-03', '2026-11-17', '2026-12-01']);
    expect(starts({ ...evenRule, frequency: 'odd-weeks' })).toEqual(['2026-10-27', '2026-11-10', '2026-11-24']);
  });
  it('anchors biweekly to the first matching weekday on or after fromDate instead of academic parity', () => {
    expect(starts({ ...evenRule, frequency: 'biweekly', termStart: null })).toEqual(['2026-10-27', '2026-11-10', '2026-11-24']);
    expect(starts({ ...evenRule, fromDate: '2026-10-26', frequency: 'biweekly', termStart: null })).toEqual(['2026-10-27', '2026-11-10', '2026-11-24']);
    expect(starts({ ...evenRule, fromDate: '2026-10-26' })).toEqual(['2026-11-03', '2026-11-17', '2026-12-01']);
  });
  it('includes boundary days, stops at the requested date and never generates pre-term academic weeks', () => {
    expect(starts({ ...evenRule, frequency: 'weekly', fromDate: '2026-11-03', untilDate: '2026-11-17' })).toEqual(['2026-11-03', '2026-11-10', '2026-11-17']);
    expect(starts({ ...evenRule, frequency: 'odd-weeks', fromDate: '2026-08-17', untilDate: '2026-09-02' })).toEqual(['2026-09-01']);
  });
  it('defaults to 30 minutes and permits an explicit duration crossing midnight', () => {
    expect(expandRecurrence(evenRule)[0]).toEqual({ start: '2026-11-03T20:40:00+08:00', end: '2026-11-03T21:10:00+08:00' });
    expect(expandRecurrence({ ...evenRule, time: '23:50' })[0]).toEqual({ start: '2026-11-03T23:50:00+08:00', end: '2026-11-04T00:20:00+08:00' });
    expect(expandRecurrence({ ...evenRule, durationMinutes: 1440 })[0]!.end).toBe('2026-11-04T20:40:00+08:00');
  });
  it('validates a finite date range, real dates, Monday term anchors and positive bounded durations', () => {
    for (const invalid of [
      { untilDate: '2027-10-24' }, { untilDate: '2026-10-22' }, { fromDate: '2026-02-30' },
      { termStart: null }, { termStart: '2026-09-01' }, { durationMinutes: 0 }, { durationMinutes: 1441 },
    ]) expect(RecurrenceRuleSchema.safeParse({ ...evenRule, ...invalid }).success).toBe(false);
    expect(RecurrenceRuleSchema.safeParse({ ...evenRule, frequency: 'weekly', termStart: null }).success).toBe(true);
  });
});

describe('recurring task transactions', () => {
  it('previews without writing; confirms ordinary event blocks with inherited reminders and keeps the original task unchanged', () => {
    const { planner, task, schedule, confirm } = setup();
    const before = planner.snapshot(); const preview = schedule();
    expect(preview).toMatchObject({ status: 'preview', conflicts: [] });
    expect(planner.snapshot()).toEqual(before);
    if (preview.status !== 'preview') throw Error('Expected preview');
    expect(preview.details).toHaveLength(3);
    expect(preview.details.every(value => value.entity === 'block' && value.before === null)).toBe(true);
    const applied = confirm(preview);
    expect(applied).toMatchObject({ status: 'applied', message: '已安排3次重复活动，可撤销' });
    expect(planner.snapshot().tasks).toEqual([task]); expect(planner.snapshot().courses).toEqual([]);
    expect(planner.snapshot().blocks).toHaveLength(3);
    expect(planner.snapshot().blocks[0]).toMatchObject({ kind: 'event', title: task.title, taskId: task.id, location: '活动室', candidateId: null, start: '2026-11-03T20:40:00+08:00', end: '2026-11-03T21:10:00+08:00', reminders: task.reminders });
    expect(collectReminders(planner.snapshot(), '2026-11-03T20:09:00+08:00', '2026-11-03T20:10:00+08:00')).toMatchObject([{ refKind: 'block', scheduledAt: '2026-11-03T20:10:00+08:00', dueAt: '2026-11-03T20:40:00+08:00' }]);
    expect(confirm(preview)).toEqual(applied);
  });
  it('persists undo across a restart and removes only the generated occurrences', () => {
    const { repository, schedule, confirm, task, root } = setup();
    const applied = confirm(schedule()); if (applied.status !== 'applied') throw Error('Expected apply');
    repository.close();
    const reopened = createRepository(join(root, 'planner.sqlite')); repositories.push(reopened);
    const restarted = createPlanner(reopened);
    expect(restarted.snapshot().blocks).toHaveLength(3);
    expect(restarted.undo(applied.transactionId).status).toBe('applied');
    expect(restarted.snapshot().blocks).toEqual([]); expect(restarted.snapshot().tasks).toEqual([task]);
  });
  it('rejects duplicate arrangements, skips compatible old occurrences and creates only missing dates', () => {
    const { planner, schedule, confirm } = setup();
    confirm(schedule({ ...evenRule, untilDate: '2026-11-03' }));
    const existing = planner.snapshot().blocks[0]!;
    const next = schedule(); expect(next).toMatchObject({ status: 'preview' });
    if (next.status !== 'preview') throw Error('Expected preview');
    expect(next.details).toHaveLength(2); confirm(next);
    expect(planner.snapshot().blocks).toHaveLength(3); expect(planner.snapshot().blocks[0]).toEqual(existing);
    expect(schedule()).toMatchObject({ status: 'clarification', message: '这些重复活动已经全部安排，无需重复添加' });
    expect(planner.snapshot().blocks).toHaveLength(3);
  });
  it('treats an existing default-duration occurrence as compatible without rewriting its unknown end', () => {
    const { planner, task, mutate, schedule, confirm } = setup();
    mutate({ type: 'create', entity: 'block', values: { title: task.title, kind: 'event', taskId: task.id, start: '2026-11-03T20:40:00+08:00', end: null, location: '活动室', reminders: task.reminders } });
    confirm(schedule()); expect(planner.snapshot().blocks).toHaveLength(3);
    expect(planner.snapshot().blocks[0]!.end).toBeNull();
  });
  it('rejects conflicting existing data at the same start without partially creating other dates', () => {
    const { planner, task, mutate, schedule } = setup();
    mutate({ type: 'create', entity: 'block', values: { title: task.title, kind: 'event', taskId: task.id, start: '2026-11-17T20:40:00+08:00', end: '2026-11-17T22:00:00+08:00', location: '活动室', reminders: task.reminders } });
    const before = planner.snapshot();
    expect(schedule()).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'recurrence' }] });
    expect(planner.snapshot()).toEqual(before);
  });
  it('previews overlaps with other activities and applies only after explicit confirmation', () => {
    const { planner, mutate, schedule, confirm } = setup();
    mutate({ type: 'create', entity: 'block', values: { title: '已有会议', kind: 'event', start: '2026-11-03T20:30:00+08:00', end: '2026-11-03T21:00:00+08:00' } });
    const preview = schedule(); expect(preview).toMatchObject({ status: 'preview', conflicts: [{ kind: 'time' }] });
    expect(planner.snapshot().blocks).toHaveLength(1); confirm(preview); expect(planner.snapshot().blocks).toHaveLength(4);
  });
  it('protects task versions, rejects stale previews, completed tasks and ranges with no occurrence', () => {
    const { planner, mutate, schedule, confirm, task } = setup();
    expect(schedule(evenRule, { expectedVersion: 2 })).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'version' }] });
    expect(schedule({ ...evenRule, untilDate: '2026-10-24' })).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'recurrence' }] });
    const preview = schedule(); mutate({ type: 'finishTask', id: task.id, expectedVersion: 1 });
    expect(confirm(preview).status).toBe('clarification');
    expect(schedule(evenRule, { expectedVersion: 2 })).toMatchObject({ status: 'clarification', message: '已完成的任务不能新增重复活动，请先恢复任务' });
    expect(planner.snapshot().blocks).toEqual([]);
  });
  it('creates a new task and its occurrences in one previewable, undoable transaction with explicit event reminders', () => {
    const { planner, mutate, confirm, task } = setup();
    const preview = mutate({ type: 'createRecurringTask', values: { title: '每周复盘' }, rule: { ...evenRule, frequency: 'weekly', untilDate: '2026-11-03' }, reminders: { enabled: true, leadMinutes: [10], dateOnlyTime: null } });
    expect(planner.snapshot().tasks).toEqual([task]);
    const applied = confirm(preview); if (applied.status !== 'applied') throw Error('Expected applied');
    expect(planner.snapshot().tasks).toHaveLength(2); expect(planner.snapshot().blocks).toHaveLength(2);
    const createdTask = planner.snapshot().tasks.find(value => value.id !== task.id)!;
    expect(planner.snapshot().blocks.every(value => value.taskId === createdTask.id && value.reminders.leadMinutes?.[0] === 10)).toBe(true);
    expect(planner.undo(applied.transactionId).status).toBe('applied');
    expect(planner.snapshot().tasks).toEqual([task]); expect(planner.snapshot().blocks).toEqual([]);
  });
  it('rolls back new-task creation when its rule produces no occurrences', () => {
    const { planner, mutate } = setup(); const before = planner.snapshot();
    expect(mutate({ type: 'createRecurringTask', values: { title: '空范围' }, rule: { ...evenRule, untilDate: '2026-10-24' } }).status).toBe('clarification');
    expect(planner.snapshot()).toEqual(before);
  });
});
