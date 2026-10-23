import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BlockInputSchema, MutationRequestSchema, MutationSchema, type Block, type MutationInput, type MutationResult, type RecurrenceRuleInput } from '../shared/contracts';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from './planner';
import { collectReminders } from './reminders';
import { buildCalendar } from './calendar';

const roots: string[] = [];
const repositories: Repository[] = [];
const rule: RecurrenceRuleInput = { frequency: 'weekly', fromDate: '2026-11-03', untilDate: '2026-11-24', weekday: 2, time: '20:40' };
afterEach(() => { vi.useRealTimers(); for (const repository of repositories.splice(0)) repository.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T18:00:00+08:00'));
  const root = mkdtempSync(join(tmpdir(), 'recurring-edits-')); roots.push(root);
  const repository = createRepository(join(root, 'planner.sqlite')); repositories.push(repository);
  const planner = createPlanner(repository); let count = 0;
  const mutate = (...mutations: MutationInput[]) => planner.mutate(MutationRequestSchema.parse({ operationId: `series-${++count}`, origin: 'manual', mutations }));
  const confirm = (result: MutationResult) => {
    if (result.status !== 'preview') throw new Error(`Expected preview: ${result.message}`);
    return planner.mutate({ ...result.proposedRequest, confirmed: true, confirmationToken: result.confirmationToken });
  };
  mutate({ type: 'create', entity: 'task', values: { title: '值班', reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null } } });
  const task = planner.snapshot().tasks[0]!;
  const schedule = (nextRule: RecurrenceRuleInput = rule) => mutate({ type: 'scheduleRecurringTask', id: task.id, expectedVersion: task.version, rule: nextRule, location: '活动室' });
  confirm(schedule());
  const blocks = () => planner.snapshot().blocks.sort((a, b) => (a.recurrence?.occurrenceStart ?? a.start).localeCompare(b.recurrence?.occurrenceStart ?? b.start));
  const update = (block: Block, values: Extract<MutationInput, { type: 'updateRecurringEvent' }>['values'], scope: 'single' | 'this-and-following' = 'single') => mutate({ type: 'updateRecurringEvent', id: block.id, expectedVersion: block.version, scope, values });
  const cancel = (block: Block, scope: 'single' | 'this-and-following' = 'single') => mutate({ type: 'cancelRecurringEvent', id: block.id, expectedVersion: block.version, scope });
  return { repository, planner, mutate, confirm, task, schedule, blocks, update, cancel, root };
}

describe('recurring event edits and cancellations', () => {
  it('links generated occurrences and previews a single edit without changing its siblings or task', () => {
    const { planner, blocks, update, confirm, task } = setup(); const original = blocks(); const selected = original[1]!;
    expect(new Set(original.map(block => block.recurrence!.seriesId)).size).toBe(1);
    expect(original.every(block => block.recurrence!.occurrenceStart === block.start && !block.cancelled)).toBe(true);
    const preview = update(selected, { start: '2026-11-11T22:10:00+08:00', title: '临时值班' });
    expect(preview).toMatchObject({ status: 'preview', details: [{ id: selected.id }] }); expect(blocks()).toEqual(original);
    const applied = confirm(preview); expect(applied).toMatchObject({ status: 'applied', message: '已修改1次重复活动，可撤销' });
    expect(blocks().find(block => block.id === selected.id)).toMatchObject({ start: '2026-11-11T22:10:00+08:00', end: '2026-11-11T22:40:00+08:00', recurrence: selected.recurrence });
    expect(blocks().filter(block => block.id !== selected.id)).toEqual(original.filter(block => block.id !== selected.id));
    expect(planner.snapshot().tasks).toEqual([task]);
    if (applied.status !== 'applied') throw Error('Expected apply');
    expect(planner.undo(applied.transactionId).status).toBe('applied');
    expect(blocks().find(block => block.id === selected.id)).toMatchObject({ start: selected.start, end: selected.end, recurrence: selected.recurrence });
  });

  it('keeps the original occurrence boundary after exceptions move across it and does not merge different series', () => {
    const { blocks, update, confirm, schedule } = setup(); const original = blocks();
    confirm(update(original[0]!, { start: '2026-12-03T20:40:00+08:00' }));
    confirm(update(original[2]!, { start: '2026-10-17T20:40:00+08:00' }));
    confirm(schedule({ ...rule, fromDate: '2026-12-01', untilDate: '2026-12-08' }));
    const before = blocks(); const anchor = before.find(block => block.id === original[1]!.id)!;
    const preview = update(anchor, { location: '新活动室' }, 'this-and-following');
    if (preview.status !== 'preview') throw Error(preview.message);
    expect(preview.details.map(detail => detail.id).sort()).toEqual(original.slice(1).map(block => block.id).sort());
    confirm(preview);
    const untouched = before.filter(block => !original.slice(1).some(value => value.id === block.id));
    expect(blocks().filter(block => untouched.some(value => value.id === block.id))).toEqual(untouched);
    expect(blocks().filter(block => original.slice(1).some(value => value.id === block.id)).every(block => block.location === '新活动室')).toBe(true);
  });

  it('shifts following dates relative to their current dates and preserves each duration unless an end is specified', () => {
    const { blocks, update, confirm } = setup();
    confirm(update(blocks()[2]!, { end: '2026-11-17T21:40:00+08:00' }));
    confirm(update(blocks()[3]!, { end: null }));
    confirm(update(blocks()[1]!, { start: '2026-11-11T23:50:00+08:00' }, 'this-and-following'));
    expect(blocks().slice(1).map(block => [block.start, block.end])).toEqual([
      ['2026-11-11T23:50:00+08:00', '2026-11-12T00:20:00+08:00'],
      ['2026-11-18T23:50:00+08:00', '2026-11-19T00:50:00+08:00'],
      ['2026-11-25T23:50:00+08:00', null],
    ]);
    confirm(update(blocks()[1]!, { end: '2026-11-12T01:20:00+08:00' }, 'this-and-following'));
    expect(blocks().slice(1).map(block => Date.parse(block.end!) - Date.parse(block.start))).toEqual([90 * 60000, 90 * 60000, 90 * 60000]);
  });

  it('changes reminders without moving times, previews overlaps, and rejects invalid explicit durations atomically', () => {
    const { blocks, update, confirm, mutate, planner } = setup(); const initial = blocks();
    confirm(update(initial[1]!, { reminders: { enabled: true, leadMinutes: [5], dateOnlyTime: null } }, 'this-and-following'));
    expect(blocks().map(block => [block.start, block.end])).toEqual(initial.map(block => [block.start, block.end]));
    mutate({ type: 'create', entity: 'block', values: { title: '冲突会议', kind: 'event', start: '2026-11-10T22:00:00+08:00', end: '2026-11-10T23:00:00+08:00' } });
    const preview = update(blocks().find(block => block.id === initial[1]!.id)!, { start: '2026-11-10T22:10:00+08:00' });
    expect(preview).toMatchObject({ status: 'preview', conflicts: [{ kind: 'time' }] });
    const before = planner.snapshot();
    expect(update(blocks()[0]!, { end: '2026-11-03T20:00:00+08:00' }, 'this-and-following').status).toBe('clarification');
    expect(planner.snapshot()).toEqual(before);
  });

  it('cancels only selected and following active members, removes calendar/reminders, and preserves completed history', () => {
    const { blocks, cancel, confirm, mutate, planner, update } = setup(); const original = blocks();
    confirm(cancel(original[2]!));
    mutate({ type: 'finishBlock', id: original[3]!.id, expectedVersion: original[3]!.version, completed: true });
    const preview = cancel(original[1]!, 'this-and-following');
    if (preview.status !== 'preview') throw Error(preview.message);
    expect(preview.details.map(detail => detail.id)).toEqual([original[1]!.id]);
    const applied = confirm(preview); expect(applied.status).toBe('applied');
    expect(blocks().map(block => [block.cancelled, block.completed])).toEqual([[false, false], [true, false], [true, false], [false, true]]);
    expect(buildCalendar(planner.snapshot(), '2026-11-03', '2026-11-30', false).map(item => item.refId)).toEqual([original[0]!.id, original[3]!.id]);
    expect(collectReminders(planner.snapshot(), '2026-11-10T20:09:00+08:00', '2026-11-10T20:10:00+08:00')).toEqual([]);
    expect(collectReminders(planner.snapshot(), '2026-11-24T20:09:00+08:00', '2026-11-24T20:10:00+08:00')).toEqual([]);
    expect(update(blocks()[1]!, { location: '不复活' }).status).toBe('clarification');
    if (applied.status !== 'applied') throw Error('Expected apply');
    expect(planner.undo(applied.transactionId).status).toBe('applied');
    expect(blocks().map(block => block.cancelled)).toEqual([false, false, true, false]);
  });

  it('does not recreate cancelled or moved occurrences when the same rule is scheduled again or extended', () => {
    const { blocks, cancel, update, confirm, schedule } = setup(); const original = blocks();
    confirm(cancel(original[1]!));
    confirm(update(original[2]!, { start: '2026-11-18T22:00:00+08:00' }));
    expect(schedule()).toMatchObject({ status: 'clarification', message: '这些重复活动已经全部安排，无需重复添加' });
    const before = blocks(); const preview = schedule({ ...rule, untilDate: '2026-12-01' });
    if (preview.status !== 'preview') throw Error(preview.message);
    expect(preview.details).toHaveLength(1); confirm(preview);
    expect(blocks().slice(0, 4)).toEqual(before);
    expect(blocks()[4]!.recurrence!.seriesId).toBe(original[0]!.recurrence!.seriesId);
  });

  it('rejects stale anchors and previews if a following member changes, without partial writes', () => {
    const { blocks, update, confirm, planner } = setup(); const original = blocks();
    const preview = update(original[1]!, { location: '全体变更' }, 'this-and-following');
    confirm(update(original[3]!, { location: '单次变更' }));
    const before = planner.snapshot(); expect(confirm(preview).status).toBe('clarification'); expect(planner.snapshot()).toEqual(before);
    expect(update(original[3]!, { title: '旧版本' })).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'version' }] });
  });

  it('retains cancellation tombstones and undo across restart', () => {
    const { repository, cancel, blocks, confirm, root } = setup(); const original = blocks();
    const applied = confirm(cancel(original[1]!, 'this-and-following')); if (applied.status !== 'applied') throw Error('Expected apply');
    repository.close(); const reopened = createRepository(join(root, 'planner.sqlite')); repositories.push(reopened); const planner = createPlanner(reopened);
    expect(planner.snapshot().blocks.filter(block => block.cancelled)).toHaveLength(3);
    expect(planner.undo(applied.transactionId).status).toBe('applied');
    expect(planner.snapshot().blocks.every(block => !block.cancelled && block.recurrence)).toBe(true);
  });

  it('undoes cancellation across restart when an already confirmed overlap remains exactly unchanged', () => {
    const { repository, planner, mutate, cancel, blocks, confirm, root } = setup(); const anchor = blocks()[0]!;
    confirm(mutate({ type: 'create', entity: 'block', values: { title: '已确认的重叠会议', kind: 'event', start: '2026-11-03T20:30:00+08:00', end: '2026-11-03T21:30:00+08:00' } }));
    const cancelled = confirm(cancel(anchor)); if (cancelled.status !== 'applied') throw Error('Expected apply');
    expect(repository.read().journal.at(-1)!.cancellationUndoBaseline).toHaveLength(1);
    expect(planner.snapshot().journal[0]).not.toHaveProperty('cancellationUndoBaseline');
    repository.close(); const reopened = createRepository(join(root, 'planner.sqlite')); repositories.push(reopened);
    const restarted = createPlanner(reopened);
    expect(restarted.undo(cancelled.transactionId).status).toBe('applied');
    expect(restarted.snapshot().blocks.find(block => block.id === anchor.id)!.cancelled).toBe(false);
  });

  it('does not use an old-overlap baseline to permit a new overlapping activity introduced after cancellation', () => {
    const { planner, mutate, cancel, blocks, confirm } = setup(); const anchor = blocks()[0]!;
    confirm(mutate({ type: 'create', entity: 'block', values: { title: '旧冲突', kind: 'event', start: '2026-11-03T20:30:00+08:00', end: '2026-11-03T20:50:00+08:00' } }));
    const cancelled = confirm(cancel(anchor)); if (cancelled.status !== 'applied') throw Error('Expected apply');
    mutate({ type: 'create', entity: 'block', values: { title: '取消后新安排', kind: 'event', start: '2026-11-03T21:00:00+08:00', end: '2026-11-03T21:30:00+08:00' } });
    const before = planner.snapshot();
    expect(planner.undo(cancelled.transactionId)).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'time' }] });
    expect(planner.snapshot()).toEqual(before);
  });

  it('refuses cancellation undo if the other original conflict participant has since changed, even with identical times', () => {
    const { planner, mutate, cancel, blocks, confirm } = setup(); const anchor = blocks()[0]!;
    confirm(mutate({ type: 'create', entity: 'block', values: { title: '旧冲突', kind: 'event', start: '2026-11-03T20:30:00+08:00', end: '2026-11-03T20:50:00+08:00' } }));
    const other = blocks().find(block => block.title === '旧冲突')!;
    const cancelled = confirm(cancel(anchor)); if (cancelled.status !== 'applied') throw Error('Expected apply');
    mutate({ type: 'update', entity: 'block', id: other.id, expectedVersion: other.version, values: { location: '后来修改' } });
    const before = planner.snapshot();
    expect(planner.undo(cancelled.transactionId)).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'time' }] });
    expect(planner.snapshot()).toEqual(before);
  });

  it('allows a following cancellation undo to restore overlaps between its own affected occurrences', () => {
    const { planner, cancel, update, blocks, confirm } = setup(); const first = blocks()[0]!;
    confirm(update(blocks()[1]!, { start: '2026-11-03T20:50:00+08:00' }));
    const cancelled = confirm(cancel(first, 'this-and-following')); if (cancelled.status !== 'applied') throw Error('Expected apply');
    expect(blocks().every(block => block.cancelled)).toBe(true);
    expect(planner.undo(cancelled.transactionId).status).toBe('applied');
    expect(blocks().every(block => !block.cancelled)).toBe(true);
  });

  it('fingerprints course exceptions as well as the course for cancellation undo', () => {
    const { planner, mutate, cancel, blocks, confirm } = setup(); const anchor = blocks()[0]!;
    confirm(mutate({ type: 'create', entity: 'course', values: { title: '晚课', weekday: 2, startTime: '20:30', endTime: '21:30', firstWeek: 10, lastWeek: 10, termStart: '2026-08-31' } }));
    const course = planner.snapshot().courses[0]!;
    const cancelled = confirm(cancel(anchor)); if (cancelled.status !== 'applied') throw Error('Expected apply');
    confirm(mutate({ type: 'create', entity: 'courseException', values: { courseId: course.id, originalDate: '2026-11-03', cancelled: false, replacement: { title: '晚课', start: '2026-11-03T20:30:00+08:00', end: '2026-11-03T21:30:00+08:00', location: '后来调换教室' } } }));
    const before = planner.snapshot();
    expect(planner.undo(cancelled.transactionId)).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'time' }] });
    expect(planner.snapshot()).toEqual(before);
  });

  it('requires semantic series edits and prevents metadata, completion, kind and task changes through the series boundary', () => {
    const { blocks, mutate, planner } = setup(); const block = blocks()[0]!; const before = planner.snapshot();
    expect(mutate({ type: 'update', entity: 'block', id: block.id, expectedVersion: block.version, values: { title: '绕过范围' } }).status).toBe('clarification');
    expect(mutate({ type: 'delete', entity: 'block', id: block.id, expectedVersion: block.version }).status).toBe('clarification');
    for (const values of [{ completed: true }, { kind: 'work' }, { taskId: null }, { recurrence: null }, { cancelled: false }]) {
      expect(MutationSchema.safeParse({ type: 'updateRecurringEvent', id: block.id, expectedVersion: block.version, scope: 'single', values }).success).toBe(false);
    }
    expect(BlockInputSchema.safeParse({ title: '伪造', start: block.start, end: block.end, kind: 'event', recurrence: block.recurrence }).success).toBe(false);
    expect(planner.snapshot()).toEqual(before);
  });
});
