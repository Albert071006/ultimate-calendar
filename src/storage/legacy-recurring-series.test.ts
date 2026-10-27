import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MutationRequestSchema, type MutationInput, type MutationResult, type RecurrenceRuleInput } from '../shared/contracts';
import { createPlanner } from '../domain/planner';
import { createRepository, parseState, records, type Repository } from './repository';

const roots: string[] = [];
const repositories: Repository[] = [];
const rule: RecurrenceRuleInput = { frequency: 'even-weeks', fromDate: '2026-10-23', untilDate: '2027-01-17', weekday: 2, time: '20:40', termStart: '2026-08-31' };
afterEach(() => { vi.useRealTimers(); for (const repository of repositories.splice(0)) repository.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T18:00:00+08:00'));
  const root = mkdtempSync(join(tmpdir(), 'legacy-series-')); roots.push(root);
  const repository = createRepository(join(root, 'planner.sqlite')); repositories.push(repository);
  const planner = createPlanner(repository); let sequence = 0;
  const mutate = (...mutations: MutationInput[]) => planner.mutate(MutationRequestSchema.parse({ operationId: `legacy-${++sequence}`, origin: 'manual', mutations }));
  const confirm = (result: MutationResult) => {
    if (result.status !== 'preview') throw Error(result.message);
    return planner.mutate({ ...result.proposedRequest, confirmed: true, confirmationToken: result.confirmationToken });
  };
  mutate({ type: 'create', entity: 'task', values: { title: '双周周二晚活动室值班检查' } });
  const task = planner.snapshot().tasks[0]!;
  const schedule = (nextRule: RecurrenceRuleInput = rule) => confirm(mutate({ type: 'scheduleRecurringTask', id: task.id, expectedVersion: planner.snapshot().tasks.find(value => value.id === task.id)!.version, rule: nextRule, location: '活动室' }));
  const legacy = () => JSON.parse(JSON.stringify(repository.read(), (key, value) => key === 'recurrence' || key === 'cancelled' ? undefined : value));
  return { repository, planner, mutate, confirm, task, schedule, legacy, root };
}

describe('legacy recurring series recovery', () => {
  it('recovers only proven old members, with stable identities and unchanged dates, versions, timestamps', () => {
    const { planner, mutate, task, schedule, legacy } = setup();
    mutate({ type: 'create', entity: 'block', values: { title: task.title, kind: 'event', taskId: task.id, start: '2026-11-04T20:40:00+08:00', end: '2026-11-04T21:10:00+08:00' } });
    const scheduled = schedule(); if (scheduled.status !== 'applied') throw Error(scheduled.message);
    const raw = legacy(); const restored = parseState(raw);
    const members = records(restored, 'block').filter(block => block.recurrence);
    expect(members).toHaveLength(6);
    expect(new Set(members.map(block => block.recurrence!.seriesId))).toEqual(new Set([`legacy-recurring:${scheduled.transactionId}:0`]));
    expect(records(restored, 'block').find(block => block.start.startsWith('2026-11-04'))!.recurrence).toBeNull();
    for (const block of records(restored, 'block')) {
      const original = planner.snapshot().blocks.find(value => value.id === block.id)!;
      expect([block.start, block.end, block.version, block.createdAt, block.updatedAt]).toEqual([original.start, original.end, original.version, original.createdAt, original.updatedAt]);
    }
    expect(parseState(raw)).toEqual(restored);
    expect(parseState(restored)).toEqual(restored);
  });

  it('recovers old createRecurringTask using its journal-created task, not a title match', () => {
    const { mutate, confirm, legacy } = setup();
    confirm(mutate({ type: 'createRecurringTask', values: { title: '同名值班', description: '每双周一次' }, rule, location: '活动室' }));
    mutate({ type: 'create', entity: 'task', values: { title: '同名值班', description: '每双周一次' } });
    const restored = parseState(legacy());
    expect(records(restored, 'block')).toHaveLength(6);
    expect(new Set(records(restored, 'block').map(block => block.recurrence?.seriesId)).size).toBe(1);
    expect(records(restored, 'block').every(block => block.recurrence)).toBe(true);
  });

  it('keeps a pre-existing standalone before-image standalone and permits undoing the adoption', () => {
    const { repository, planner, mutate, confirm, task, legacy } = setup();
    mutate({ type: 'create', entity: 'block', values: { title: '旧执行时段', kind: 'work', start: '2026-11-03T20:40:00+08:00', end: '2026-11-03T21:10:00+08:00', location: '活动室' } });
    const standalone = planner.snapshot().blocks[0]!;
    const applied = confirm(mutate(
      { type: 'update', entity: 'block', id: standalone.id, expectedVersion: standalone.version, values: { title: task.title, kind: 'event', taskId: task.id } },
      { type: 'scheduleRecurringTask', id: task.id, expectedVersion: task.version, rule, location: '活动室' },
    ));
    if (applied.status !== 'applied') throw Error(applied.message);
    const restored = parseState(legacy());
    const adopted = restored.journal.find(journal => journal.id === applied.transactionId)!.details.find(detail => detail.id === standalone.id)!;
    expect(adopted.before).toMatchObject({ kind: 'work', recurrence: null, taskId: null });
    expect(adopted.after).toMatchObject({ kind: 'event', recurrence: { seriesId: `legacy-recurring:${applied.transactionId}:1`, occurrenceStart: standalone.start } });
    repository.replaceState(restored);
    expect(planner.undo(applied.transactionId).status).toBe('applied');
    expect(planner.snapshot().blocks).toHaveLength(1);
    expect(planner.snapshot().blocks[0]).toMatchObject({ id: standalone.id, kind: 'work', taskId: null, recurrence: null, title: standalone.title });
  });

  it('preserves original positions after legacy one-off edits, supports undo and reopening', () => {
    const { repository, planner, mutate, confirm, schedule, legacy, root } = setup();
    const scheduled = schedule(); if (scheduled.status !== 'applied') throw Error(scheduled.message);
    const original = planner.snapshot().blocks[1]!;
    const edited = confirm(mutate({ type: 'updateRecurringEvent', id: original.id, expectedVersion: original.version, scope: 'single', values: { start: '2026-11-18T22:00:00+08:00' } }));
    if (edited.status !== 'applied') throw Error(edited.message);
    const raw = legacy();
    // Older versions used an ordinary update command for this same journaled edit.
    const operation = raw.operations.find((value: { id: string }) => value.id === raw.journal.find((value: { id: string }) => value.id === edited.transactionId).operationId);
    const request = JSON.parse(operation.fingerprint); request.mutations[0] = { type: 'update', entity: 'block', id: original.id, expectedVersion: original.version, values: { start: '2026-11-18T22:00:00+08:00', end: '2026-11-18T22:30:00+08:00' } }; operation.fingerprint = JSON.stringify(request);
    repository.replaceState(raw); repository.close();
    const reopened = createRepository(join(root, 'planner.sqlite')); repositories.push(reopened); const restarted = createPlanner(reopened);
    expect(restarted.snapshot().blocks.find(block => block.id === original.id)).toMatchObject({ start: '2026-11-18T22:00:00+08:00', recurrence: { occurrenceStart: original.start } });
    expect(restarted.undo(edited.transactionId).status).toBe('applied');
    expect(restarted.snapshot().blocks.find(block => block.id === original.id)).toMatchObject({ start: original.start, recurrence: { occurrenceStart: original.start } });
    expect(restarted.undo(scheduled.transactionId).status).toBe('applied');
    expect(restarted.snapshot().blocks).toEqual([]);
  });

  it('ignores undone or unproven series instead of inferring membership from title and task', () => {
    const { schedule, legacy } = setup(); schedule();
    const undone = legacy(); undone.journal.at(-1).undoneAt = '2026-10-23T18:05:00+08:00';
    expect(records(parseState(undone), 'block').every(block => block.recurrence === null)).toBe(true);
    for (const fingerprint of ['broken', '{}', JSON.stringify({ mutations: [{ type: 'scheduleRecurringTask', id: 'unknown', rule }] })]) {
      const raw = legacy(); raw.operations.at(-1).fingerprint = fingerprint;
      expect(records(parseState(raw), 'block').every(block => block.recurrence === null)).toBe(true);
    }
  });

  it('keeps separate schedules for one task in separate series', () => {
    const { schedule, legacy } = setup();
    schedule({ ...rule, untilDate: '2026-11-17' });
    schedule({ ...rule, fromDate: '2026-12-01' });
    const restored = parseState(legacy());
    expect(new Set(records(restored, 'block').map(block => block.recurrence?.seriesId)).size).toBe(2);
  });

  it('retains all siblings when undo persists only some normalized records and journal images', () => {
    const { repository, schedule, root } = setup(); schedule(); repository.close();
    // Write an actual old database, rather than replaceState(), which would eagerly
    // persist all normalized records and hide the partial-persistence regression.
    const db = new DatabaseSync(join(root, 'planner.sqlite'));
    for (const table of ['records', 'journal'] as const) {
      const rows = db.prepare(`SELECT id, payload FROM ${table}`).all() as { id: string; payload: string }[];
      for (const row of rows) db.prepare(`UPDATE ${table} SET payload = ? WHERE id = ?`).run(JSON.stringify(JSON.parse(row.payload), (key, value) => key === 'recurrence' || key === 'cancelled' ? undefined : value), row.id);
    }
    db.close();
    const reopened = createRepository(join(root, 'planner.sqlite')); repositories.push(reopened); const planner = createPlanner(reopened);
    expect(planner.snapshot().blocks.every(block => block.recurrence)).toBe(true);
    const first = planner.snapshot().blocks[0]!;
    const preview = planner.mutate(MutationRequestSchema.parse({ operationId: 'legacy-partial-edit', origin: 'manual', mutations: [{ type: 'updateRecurringEvent', id: first.id, expectedVersion: first.version, scope: 'single', values: { location: '临时地点' } }] }));
    if (preview.status !== 'preview') throw Error(preview.message);
    const edited = planner.mutate({ ...preview.proposedRequest, confirmed: true, confirmationToken: preview.confirmationToken });
    if (edited.status !== 'applied') throw Error(edited.message);
    expect(planner.undo(edited.transactionId).status).toBe('applied');
    expect(planner.snapshot().blocks.every(block => block.recurrence?.seriesId === first.recurrence!.seriesId)).toBe(true);
    reopened.close();
    const restarted = createRepository(join(root, 'planner.sqlite')); repositories.push(restarted);
    expect(restarted.snapshot().blocks.every(block => block.recurrence?.seriesId === first.recurrence!.seriesId)).toBe(true);
    const original = restarted.read().journal.find(journal => !journal.undoneAt && journal.details.filter(detail => detail.entity === 'block').length === 6)!;
    expect(createPlanner(restarted).undo(original.id).status).toBe('applied');
    expect(restarted.snapshot().blocks).toEqual([]);
  });
});
