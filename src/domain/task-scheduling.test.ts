import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, type Repository, newEntity } from '../storage/repository';
import { createPlanner } from './planner';
import { TaskSchema, MutationRequestSchema, type MutationInput, type MutationResult } from '../shared/contracts';
import { taskScheduleMode } from './task-scheduling';

const repositories: Repository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
function setup(mode?: 'single' | 'multiple', count = 1) {
  const repository = createRepository(':memory:', { automaticBackup: () => {} }); repositories.push(repository);
  const planner = createPlanner(repository, { automaticBackup: () => {} });
  repository.transact(state => {
    const task = newEntity(state, 'task', { title: '示例阅读', ...(mode ? { scheduleMode: mode } : {}) });
    for (let index = 0; index < count; index++) newEntity(state, 'block', { title: '示例阅读', kind: 'work', taskId: task.id,
      start: `2030-04-${15 + index}T09:00:00+08:00`, end: `2030-04-${15 + index}T10:00:00+08:00` });
  });
  const mutate = (...mutations: MutationInput[]) => planner.mutate(MutationRequestSchema.parse({ operationId: crypto.randomUUID(), origin: 'manual', mutations }));
  const confirm = (result: MutationResult) => { if (result.status !== 'preview') throw Error(result.message); return planner.mutate({ ...result.proposedRequest, confirmed: true, confirmationToken: result.confirmationToken }); };
  const task = () => planner.snapshot().tasks[0]!, block = () => planner.snapshot().blocks[0]!;
  const createBlock = () => mutate({ type: 'create', entity: 'block', values: { title: '新增示例阅读', taskId: task().id, kind: 'work', start: '2030-04-20T09:00:00+08:00', end: '2030-04-20T10:00:00+08:00' } });
  return { repository, planner, mutate, confirm, task, block, createBlock };
}

describe('one-slot task completion', () => {
  it.each(['finishBlock', 'finishTask'] as const)('finishes and restores both records through %s in one undoable operation', type => {
    const f = setup(); const before = f.planner.snapshot();
    const target = () => type === 'finishBlock' ? f.block() : f.task();
    const finish = f.mutate({ type, id: target().id, expectedVersion: target().version, completed: true });
    expect(finish.status).toBe('applied'); expect(finish.changes).toHaveLength(2);
    expect(f.task().status).toBe('done'); expect(f.block().completed).toBe(true);
    expect(f.planner.undo().status).toBe('applied');
    expect(f.task().status).toBe(before.tasks[0]!.status); expect(f.block().completed).toBe(before.blocks[0]!.completed);
    expect(f.mutate({ type, id: target().id, expectedVersion: target().version, completed: true }).status).toBe('applied');
    expect(f.mutate({ type, id: target().id, expectedVersion: target().version, completed: false }).status).toBe('applied');
    expect(f.task().status).toBe('open'); expect(f.block().completed).toBe(false);
  });

  it.each(['task', 'block'] as const)('keeps generic %s completion edits consistent', entity => {
    const f = setup();
    const mutation: MutationInput = entity === 'task'
      ? { type: 'update', entity, id: f.task().id, expectedVersion: f.task().version, values: { status: 'done' } }
      : { type: 'update', entity, id: f.block().id, expectedVersion: f.block().version, values: { completed: true } };
    expect(f.mutate(mutation).status).toBe('applied'); expect(f.task().status).toBe('done'); expect(f.block().completed).toBe(true);
  });

  it('repairs a historical completed slot with an open task only when the user completes it again', () => {
    const f = setup();
    f.repository.writeInternal({ operationId: 'old-completion', changes: [{ entity: 'block', id: f.block().id, expectedVersion: 1, values: { completed: true } }] });
    expect(f.task().status).toBe('open');
    expect(f.mutate({ type: 'finishBlock', id: f.block().id, expectedVersion: 2, completed: true }).status).toBe('applied');
    expect(f.task().status).toBe('done'); expect(f.block().completed).toBe(true);
  });

  it.each(['task', 'block'] as const)('does not rewrite legacy completion when a full %s editor payload only changes the title', entity => {
    const f = setup();
    f.repository.writeInternal({ operationId: 'old-completion', changes: [{ entity: 'task', id: f.task().id, expectedVersion: 1, values: { status: 'done' } }] });
    const mutation: MutationInput = entity === 'task'
      ? { type: 'update', entity, id: f.task().id, expectedVersion: f.task().version, values: { title: '修改标题', status: 'done' } }
      : { type: 'update', entity, id: f.block().id, expectedVersion: f.block().version, values: { title: '修改标题', completed: false } };
    expect(f.mutate(mutation).status).toBe('applied');
    expect(f.task().status).toBe('done'); expect(f.block().completed).toBe(false);
  });

  it('guards linked records when undoing completion after a later task edit', () => {
    const f = setup(); const result = f.mutate({ type: 'finishBlock', id: f.block().id, expectedVersion: 1, completed: true });
    if (result.status !== 'applied') throw Error(result.message);
    f.mutate({ type: 'update', entity: 'task', id: f.task().id, expectedVersion: 2, values: { title: '后来编辑' } });
    expect(f.planner.undo(result.transactionId).status).toBe('clarification'); expect(f.task().title).toBe('后来编辑'); expect(f.block().completed).toBe(true);
  });

  it.each([undefined, 'multiple'] as const)('keeps existing multiple slots independent with mode %s', mode => {
    const f = setup(mode, 2);
    expect(taskScheduleMode(f.task(), f.planner.snapshot().blocks)).toBe('multiple');
    expect(f.mutate({ type: 'finishBlock', id: f.block().id, expectedVersion: 1, completed: true }).status).toBe('applied');
    expect(f.task().status).toBe('open');
    expect(f.mutate({ type: 'finishTask', id: f.task().id, expectedVersion: 1, completed: true }).status).toBe('applied');
    expect(f.planner.snapshot().blocks.map(block => block.completed)).toEqual([true, false]);
  });

  it('keeps explicit multiple mode independent even before a second slot is scheduled', () => {
    const f = setup('multiple');
    f.mutate({ type: 'finishBlock', id: f.block().id, expectedVersion: 1, completed: true });
    expect(f.task().status).toBe('open');
  });
});

describe('explicit multiple-slot scheduling', () => {
  it('leaves the optional mode absent in legacy records', () => {
    const f = setup(); expect(Object.hasOwn(TaskSchema.parse(f.task()), 'scheduleMode')).toBe(false);
  });

  it('rejects a second slot without turning the task into an inferred legacy multiple task', () => {
    const f = setup(); const before = f.planner.snapshot();
    expect(f.createBlock()).toMatchObject({ status: 'clarification', message: expect.stringContaining('多个时段') });
    expect(f.planner.snapshot()).toEqual(before);
  });

  it('permits explicitly choosing multiple in the same atomic request as the second slot', () => {
    const f = setup();
    const preview = f.mutate({ type: 'update', entity: 'task', id: f.task().id, expectedVersion: 1, values: { scheduleMode: 'multiple' } },
      { type: 'create', entity: 'block', values: { title: '第二段', kind: 'work', taskId: f.task().id, start: '2030-04-20T09:00:00+08:00', end: '2030-04-20T10:00:00+08:00' } });
    expect(f.confirm(preview).status).toBe('applied'); expect(f.task().scheduleMode).toBe('multiple'); expect(f.planner.snapshot().blocks).toHaveLength(2);
    expect(f.planner.undo().status).toBe('applied'); expect(f.planner.snapshot().blocks).toHaveLength(1); expect(f.task().scheduleMode).toBeUndefined();
  });

  it('rejects attaching a standalone block to an already scheduled single task', () => {
    const f = setup();
    f.mutate({ type: 'create', entity: 'block', values: { title: '独立时段', kind: 'work', start: '2030-04-20T09:00:00+08:00', end: '2030-04-20T10:00:00+08:00' } });
    const standalone = f.planner.snapshot().blocks[1]!;
    expect(f.mutate({ type: 'update', entity: 'block', id: standalone.id, expectedVersion: 1, values: { taskId: f.task().id } }).status).toBe('clarification');
    expect(f.planner.snapshot().blocks[1]!.taskId).toBeNull();
  });

  it('preserves old multiple-slot editing but rejects switching it to single before removing extra slots', () => {
    const f = setup(undefined, 2);
    expect(f.mutate({ type: 'update', entity: 'block', id: f.block().id, expectedVersion: 1, values: { title: '修改旧安排' } }).status).toBe('applied');
    expect(f.createBlock().status).toBe('applied');
    expect(f.mutate({ type: 'update', entity: 'task', id: f.task().id, expectedVersion: 1, values: { scheduleMode: 'single' } }).status).toBe('clarification');
    expect(f.planner.snapshot().blocks).toHaveLength(3);
  });

  it('retains legacy multiple intent when deleting down to one slot and can undo without rewriting the old record', () => {
    const f = setup(undefined, 2);
    const removed = f.mutate({ type: 'delete', entity: 'block', id: f.block().id, expectedVersion: 1 });
    expect(removed.status).toBe('applied'); expect(f.task().scheduleMode).toBe('multiple');
    const remaining = f.block();
    expect(f.mutate({ type: 'finishBlock', id: remaining.id, expectedVersion: remaining.version, completed: true }).status).toBe('applied');
    expect(f.task().status).toBe('open');
    expect(f.planner.undo().status).toBe('applied'); expect(f.planner.undo().status).toBe('applied');
    expect(f.planner.snapshot().blocks).toHaveLength(2); expect(f.task().scheduleMode).toBeUndefined();
  });

  it('allows a new single slot when the only old event was cancelled without changing its history', () => {
    const f = setup(undefined, 0);
    f.repository.transact(state => { newEntity(state, 'block', { title: '已取消', kind: 'event', taskId: f.task().id,
      start: '2030-04-14T09:00:00+08:00', end: null, cancelled: true }); });
    expect(f.createBlock().status).toBe('applied');
    const live = f.planner.snapshot().blocks.find(block => !block.cancelled)!;
    f.mutate({ type: 'finishBlock', id: live.id, expectedVersion: 1, completed: true });
    expect(f.task().status).toBe('done'); expect(f.planner.snapshot().blocks[0]).toMatchObject({ cancelled: true, completed: false, version: 1 });
  });

  it('treats a one-date recurrence as explicit multiple mode and preserves it through completion', () => {
    const f = setup(undefined, 0);
    const preview = f.mutate({ type: 'scheduleRecurringTask', id: f.task().id, expectedVersion: 1,
      rule: { frequency: 'weekly', fromDate: '2030-04-15', untilDate: '2030-04-15', weekday: 1, time: '09:00' }, location: '' });
    expect(f.confirm(preview).status).toBe('applied'); expect(f.task().scheduleMode).toBe('multiple');
    expect(f.mutate({ type: 'finishBlock', id: f.block().id, expectedVersion: 1, completed: true }).status).toBe('applied'); expect(f.task().status).toBe('open');
    expect(f.mutate({ type: 'update', entity: 'task', id: f.task().id, expectedVersion: f.task().version, values: { scheduleMode: 'single' } }).status).toBe('clarification');
  });
});
