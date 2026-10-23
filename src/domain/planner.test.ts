import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from './planner';
import { buildCalendar } from './calendar';
import { collectReminders } from './reminders';
import { createBackup, restoreBackup } from '../storage/backups';
import { DEFAULT_SETTINGS, MutationRequestSchema, type MutationInput, type MutationResult } from '../shared/contracts';

const roots: string[] = [];
const repos: Repository[] = [];
afterEach(() => { vi.useRealTimers(); for (const r of repos.splice(0)) r.close(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'planner-')); roots.push(dir);
  const path = join(dir, 'planner.sqlite'); const repository = createRepository(path); repos.push(repository);
  const planner = createPlanner(repository); let i = 0;
  const mutate = (...mutations: MutationInput[]) => planner.mutate({ operationId: `test-${++i}`, origin: 'manual', mutations, confirmed: false } as never);
  const confirm = (result: MutationResult) => { if (result.status !== 'preview') throw Error('Expected preview'); return planner.mutate({ ...result.proposedRequest, origin: 'manual', confirmed: true, confirmationToken: result.confirmationToken }); };
  return { repository, planner, mutate, confirm, dir, path };
}
function seed(r: Repository) {
  return r.writeInternal({ operationId: 'seed', changes: [
    { entity: 'source', values: { kind: 'text', text: 'synthetic notice', importedAt: '2026-09-01T10:00:00+08:00' } },
  ] }).entities[0]!;
}
function candidate(r: Repository, sourceId: string, extra = {}) {
  return r.writeInternal({ operationId: `candidate-${crypto.randomUUID()}`, changes: [{ entity: 'candidate', values: { title: '报告', sourceIds: [sourceId], deadline: { date: '2026-10-23', time: null }, ...extra } }] }).entities[0]!;
}

describe('durable planner rules', () => {
  it('accepts once across operation retries without inventing work or deadline time', () => {
    const { repository: r, planner: p } = setup(); const s = seed(r); const c = candidate(r, s.id);
    const request = { operationId: 'accept', origin: 'manual' as const, confirmed: false, mutations: [{ type: 'acceptCandidate' as const, id: c.id, expectedVersion: 1 }] };
    const accepted = p.mutate(request);
    expect(accepted).toMatchObject({ status: 'applied', message: '已接受，截止时间已保留，执行时间待安排，可撤销' });
    expect(p.mutate(request)).toEqual(accepted);
    expect(p.snapshot().tasks).toHaveLength(1); expect(p.snapshot().blocks).toHaveLength(0);
    expect(buildCalendar(p.snapshot(), '2026-10-23', '2026-10-23', true)[0]).toMatchObject({ start: null, busy: false, date: '2026-10-23' });
  });
  it('accepts a known start-only event as a default 30-minute slot and keeps task independent of work completion', () => {
    const { repository: r, planner: p, mutate } = setup(); const c = candidate(r, seed(r).id, { eventStart: '2026-10-24T14:00:00+08:00' });
    expect(mutate({ type: 'acceptCandidate', id: c.id, expectedVersion: 1 })).toMatchObject({ status: 'applied', message: '已接受，活动已加入日历：2026-10-24 14:00（默认安排30分钟，可调整），可撤销' });
    const task = p.snapshot().tasks[0]!;
    mutate({ type: 'create', entity: 'block', values: { title: '工作1', kind: 'work', taskId: task.id, start: '2026-10-23T10:00:00+08:00', end: '2026-10-23T11:00:00+08:00' } });
    mutate({ type: 'create', entity: 'block', values: { title: '工作2', kind: 'work', taskId: task.id, start: '2026-10-23T12:00:00+08:00', end: '2026-10-23T13:00:00+08:00' } });
    const b = p.snapshot().blocks.find(x => x.kind === 'work')!; mutate({ type: 'finishBlock', id: b.id, expectedVersion: 1 });
    expect(p.snapshot().tasks[0]).toMatchObject({ status: 'open', deadline: { date: '2026-10-23', time: null } });
    expect(buildCalendar(p.snapshot(), '2026-10-24', '2026-10-24', true)[0]).toMatchObject({ category: 'event', end: '2026-10-24T14:30:00+08:00', busy: true });
    expect(p.snapshot().blocks.find(value => value.kind === 'event')!.end).toBeNull();
  });
  it('previews an overlap inside a default activity slot and allows an event starting at the 30-minute boundary', () => {
    const { repository: r, planner: p, mutate } = setup();
    const c = candidate(r, seed(r).id, { deadline: null, eventStart: '2026-10-24T14:00:00+08:00', eventEnd: null });
    expect(mutate({ type: 'acceptCandidate', id: c.id, expectedVersion: 1 }).status).toBe('applied');
    expect(mutate({ type: 'create', entity: 'block', values: { title: '重叠活动', kind: 'event', start: '2026-10-24T14:15:00+08:00', end: '2026-10-24T14:25:00+08:00' } })).toMatchObject({ status: 'preview', conflicts: [{ kind: 'time' }] });
    expect(p.snapshot().blocks).toHaveLength(1);
    expect(mutate({ type: 'create', entity: 'block', values: { title: '后续活动', kind: 'event', start: '2026-10-24T14:30:00+08:00', end: '2026-10-24T14:50:00+08:00' } })).toMatchObject({ status: 'applied', conflicts: [] });
    expect(p.snapshot().blocks).toHaveLength(2);
  });
  it('accepts an explicit activity range into the calendar and reports it without requesting a new work session', () => {
    const { repository: r, planner: p, mutate } = setup();
    const c = candidate(r, seed(r).id, { deadline: null, eventStart: '2026-10-24T17:00:00+08:00', eventEnd: '2026-10-24T18:10:00+08:00' });
    expect(mutate({ type: 'acceptCandidate', id: c.id, expectedVersion: 1 })).toMatchObject({ status: 'applied', message: '已接受，活动已加入日历：2026-10-24 17:00，可撤销' });
    expect(p.snapshot().blocks).toMatchObject([{ kind: 'event', taskId: p.snapshot().tasks[0]!.id, candidateId: c.id, start: '2026-10-24T17:00:00+08:00', end: '2026-10-24T18:10:00+08:00' }]);
    expect(buildCalendar(p.snapshot(), '2026-10-24', '2026-10-24', false)).toMatchObject([{ category: 'event', start: '2026-10-24T17:00:00+08:00', end: '2026-10-24T18:10:00+08:00', busy: true }]);
  });
  it('reports an accepted task without dates as awaiting scheduling and does not invent an event', () => {
    const { repository: r, planner: p, mutate } = setup(); const c = candidate(r, seed(r).id, { deadline: null });
    expect(mutate({ type: 'acceptCandidate', id: c.id, expectedVersion: 1 })).toMatchObject({ status: 'applied', message: '已接受，任务待安排，可撤销' });
    expect(p.snapshot().tasks).toHaveLength(1); expect(p.snapshot().blocks).toEqual([]);
  });
  it('saves a recovered task event with internal provenance so a later revision updates the same arrangement', () => {
    const { repository: r, planner: p, mutate, confirm } = setup(); const source = seed(r);
    const original = candidate(r, source.id, { eventStart: null, eventEnd: null });
    mutate({ type: 'acceptCandidate', id: original.id, expectedVersion: 1 }); const task = p.snapshot().tasks[0]!;
    const result = mutate({ type: 'scheduleTaskEvent', id: task.id, expectedVersion: task.version, values: { title: task.title, kind: 'event', taskId: task.id, start: '2026-10-22T21:30:00+08:00', end: null } });
    expect(result.status).toBe('applied'); const event = p.snapshot().blocks[0]!;
    expect(event).toMatchObject({ candidateId: original.id, taskId: task.id, start: '2026-10-22T21:30:00+08:00', end: null });
    const revision = candidate(r, source.id, { revisionOfId: original.id, eventStart: '2026-10-29T21:30:00+08:00', eventEnd: null });
    const preview = mutate({ type: 'acceptCandidate', id: revision.id, expectedVersion: 1 });
    expect(preview.status).toBe('preview'); expect(p.snapshot().blocks).toHaveLength(1);
    expect(confirm(preview).status).toBe('applied');
    expect(p.snapshot().blocks).toHaveLength(1); expect(p.snapshot().blocks[0]).toMatchObject({ id: event.id, candidateId: revision.id, taskId: task.id, start: '2026-10-29T21:30:00+08:00' });
  });
  it('rejects recovered event requests with stale versions, changed task links, or a non-event kind without writes', () => {
    const { repository: r, planner: p, mutate } = setup(); const original = candidate(r, seed(r).id);
    mutate({ type: 'acceptCandidate', id: original.id, expectedVersion: 1 }); const task = p.snapshot().tasks[0]!;
    const values = { title: task.title, kind: 'event' as const, taskId: task.id, start: '2026-10-22T21:30:00+08:00', end: null };
    const before = p.snapshot();
    expect(mutate({ type: 'scheduleTaskEvent', id: task.id, expectedVersion: task.version + 1, values })).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'version' }] });
    expect(mutate({ type: 'scheduleTaskEvent', id: task.id, expectedVersion: task.version, values: { ...values, taskId: null } }).status).toBe('clarification');
    expect(mutate({ type: 'scheduleTaskEvent', id: task.id, expectedVersion: task.version, values: { ...values, kind: 'work', end: '2026-10-22T22:30:00+08:00' } }).status).toBe('clarification');
    expect(p.snapshot()).toEqual(before);
    r.writeInternal({ operationId: 'unlink-candidate', changes: [{ entity: 'candidate', id: original.id, expectedVersion: 2, values: { taskId: null } }] });
    const unlinked = p.snapshot(); expect(mutate({ type: 'scheduleTaskEvent', id: task.id, expectedVersion: task.version, values }).status).toBe('clarification'); expect(p.snapshot()).toEqual(unlinked);
    mutate({ type: 'create', entity: 'task', values: { title: '没有通知来源' } }); const standalone = p.snapshot().tasks.find(value => value.id !== task.id)!;
    const standaloneBefore = p.snapshot(); expect(mutate({ type: 'scheduleTaskEvent', id: standalone.id, expectedVersion: standalone.version, values: { ...values, taskId: standalone.id } }).status).toBe('clarification'); expect(p.snapshot()).toEqual(standaloneBefore);
  });
  it('blocks duplicate fixed arrangements created while the editor or preview is open', () => {
    const { repository: r, planner: p, mutate, confirm } = setup(); const original = candidate(r, seed(r).id);
    mutate({ type: 'acceptCandidate', id: original.id, expectedVersion: 1 }); const task = p.snapshot().tasks[0]!;
    mutate({ type: 'create', entity: 'block', values: { title: '已占用', kind: 'work', start: '2026-10-22T21:00:00+08:00', end: '2026-10-22T22:00:00+08:00' } });
    const request: MutationInput = { type: 'scheduleTaskEvent', id: task.id, expectedVersion: task.version, values: { title: task.title, kind: 'event', taskId: task.id, start: '2026-10-22T21:30:00+08:00', end: '2026-10-22T22:30:00+08:00' } };
    const preview = mutate(request); expect(preview.status).toBe('preview'); expect(p.snapshot().blocks).toHaveLength(1);
    mutate({ type: 'create', entity: 'block', values: { title: '另一窗口已安排', kind: 'event', taskId: task.id, start: '2026-10-23T15:30:00+08:00', end: null } });
    const before = p.snapshot(); expect(confirm(preview).status).toBe('clarification'); expect(mutate(request)).toMatchObject({ status: 'clarification', message: '任务已有固定活动，请查看现有安排，不能重复添加' }); expect(p.snapshot()).toEqual(before);
  });
  it('keeps pending and ignored decisions outside busy time', () => {
    const { repository: r, planner: p, mutate } = setup(); const c = candidate(r, seed(r).id);
    expect(buildCalendar(p.snapshot(), '2026-10-23', '2026-10-23', true)).toMatchObject([{ busy: false, pending: true }]);
    expect(buildCalendar(p.snapshot(), '2026-10-23', '2026-10-23', false)).toEqual([]);
    mutate({ type: 'ignoreCandidate', id: c.id, expectedVersion: 1 }); expect(buildCalendar(p.snapshot(), '2026-10-23', '2026-10-23', true)).toEqual([]);
  });
  it('previews bulk without writes, binds exact operations, and rejects stale confirmation', () => {
    const { planner: p, mutate, confirm } = setup();
    const preview = mutate({ type: 'create', entity: 'task', values: { title: 'A' } }, { type: 'create', entity: 'task', values: { title: 'B' } });
    expect(preview.status).toBe('preview'); expect(p.snapshot().tasks).toEqual([]); expect(confirm(preview).status).toBe('applied');
    const t = p.snapshot().tasks[0]!;
    const change = mutate({ type: 'update', entity: 'task', id: t.id, expectedVersion: 1, values: { title: 'C' } }, { type: 'create', entity: 'task', values: { title: 'D' } });
    mutate({ type: 'update', entity: 'task', id: t.id, expectedVersion: 1, values: { description: 'newer' } });
    expect(confirm(change).status).toBe('clarification'); expect(p.snapshot().tasks).toHaveLength(2);
  });
  it('rolls back all members and internal writes on invalid references', () => {
    const { planner: p, mutate, repository: r } = setup();
    expect(mutate({ type: 'create', entity: 'task', values: { title: 'A' } }, { type: 'create', entity: 'block', values: { title: 'bad', taskId: 'missing', kind: 'event', start: '2026-10-23T10:00:00+08:00', end: null } }).status).toBe('clarification');
    expect(p.snapshot().tasks).toEqual([]);
    expect(() => r.writeInternal({ operationId: 'bad', changes: [{ entity: 'goal', values: { title: 'goal' } }, { entity: 'candidate', values: { title: 'bad', sourceIds: ['missing'] } }] })).toThrow(); expect(p.snapshot().goals).toEqual([]);
  });
  it('previews removal even without linked arrangements and rejects stale task versions without writes', () => {
    const { planner: p, mutate, confirm } = setup();
    mutate({ type: 'create', entity: 'task', values: { title: '不要的任务' } }); const task = p.snapshot().tasks[0]!;
    const before = p.snapshot();
    expect(mutate({ type: 'removeTask', id: task.id, expectedVersion: task.version + 1 })).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'version', entity: 'task' }] });
    expect(p.snapshot()).toEqual(before);
    const preview = mutate({ type: 'removeTask', id: task.id, expectedVersion: task.version });
    expect(preview.status).toBe('preview'); expect(p.snapshot()).toEqual(before);
    expect(confirm(preview)).toMatchObject({ status: 'applied', message: '任务已移除，可撤销' });
    expect(p.snapshot().tasks).toEqual([]);
  });
  it('removes a task with all linked work and events only after review, preserves provenance, and undoes the full graph', () => {
    const { repository: r, planner: p, mutate, confirm } = setup();
    const source = seed(r); const notice = candidate(r, source.id, { eventStart: '2026-10-24T14:00:00+08:00', eventEnd: '2026-10-24T15:00:00+08:00' });
    mutate({ type: 'acceptCandidate', id: notice.id, expectedVersion: 1 }); const task = p.snapshot().tasks[0]!;
    const duplicate = candidate(r, source.id, { duplicateOfId: notice.id }); mutate({ type: 'acceptCandidate', id: duplicate.id, expectedVersion: 1 });
    mutate({ type: 'create', entity: 'goal', values: { title: '保留目标' } }); const goal = p.snapshot().goals[0]!;
    mutate({ type: 'update', entity: 'task', id: task.id, expectedVersion: task.version, values: { status: 'done', goalId: goal.id } });
    mutate({ type: 'create', entity: 'block', values: { title: '任务执行', kind: 'work', taskId: task.id, start: '2026-10-23T10:00:00+08:00', end: '2026-10-23T11:00:00+08:00', completed: true } });
    mutate({ type: 'create', entity: 'block', values: { title: '独立安排', kind: 'event', start: '2026-10-25T16:00:00+08:00', end: null } });
    const before = p.snapshot();
    const preview = mutate({ type: 'removeTask', id: task.id, expectedVersion: before.tasks[0]!.version, includeLinkedBlocks: true });
    expect(preview.status).toBe('preview'); expect(p.snapshot()).toEqual(before);
    if (preview.status !== 'preview') throw Error('Expected preview');
    expect(preview.details.filter(detail => detail.entity === 'block' && !detail.after)).toHaveLength(2);
    const removed = confirm(preview);
    expect(removed).toMatchObject({ status: 'applied', message: '任务及关联安排已移除，可撤销' });
    expect(p.snapshot().tasks).toEqual([]); expect(p.snapshot().blocks).toEqual(before.blocks.filter(block => !block.taskId));
    expect(p.snapshot().candidates).toHaveLength(2); expect(p.snapshot().candidates.every(value => value.taskId === null && value.status === 'accepted')).toBe(true);
    expect(p.snapshot().sources).toEqual(before.sources); expect(p.snapshot().goals).toEqual(before.goals); expect(p.snapshot().feedback).toEqual(before.feedback);
    if (removed.status !== 'applied') throw Error('Expected applied');
    expect(p.undo(removed.transactionId).status).toBe('applied');
    const content = (values: typeof before.tasks | typeof before.blocks | typeof before.candidates) => values.map(({ version: _v, updatedAt: _at, ...value }) => value).sort((a, b) => a.id.localeCompare(b.id));
    expect(content(p.snapshot().tasks)).toEqual(content(before.tasks)); expect(content(p.snapshot().blocks)).toEqual(content(before.blocks)); expect(content(p.snapshot().candidates)).toEqual(content(before.candidates));
    expect(p.snapshot().sources).toEqual(before.sources); expect(p.snapshot().goals).toEqual(before.goals); expect(p.snapshot().feedback).toEqual(before.feedback);
  });
  it('can retain and unlink task arrangements, and requires a new review after a linked arrangement changes', () => {
    const { repository: r, planner: p, mutate, confirm } = setup();
    const notice = candidate(r, seed(r).id, { eventStart: '2026-10-24T14:00:00+08:00' }); mutate({ type: 'acceptCandidate', id: notice.id, expectedVersion: 1 });
    const task = p.snapshot().tasks[0]!; const block = p.snapshot().blocks[0]!;
    const stalePreview = mutate({ type: 'removeTask', id: task.id, expectedVersion: task.version, includeLinkedBlocks: true });
    mutate({ type: 'update', entity: 'block', id: block.id, expectedVersion: block.version, values: { title: '刚修改的安排' } });
    const updated = p.snapshot(); expect(confirm(stalePreview)).toMatchObject({ status: 'clarification', message: '预览之后数据已改变，请查看最新内容后重新预览' }); expect(p.snapshot()).toEqual(updated);
    const preview = mutate({ type: 'removeTask', id: task.id, expectedVersion: task.version, includeLinkedBlocks: false });
    expect(p.snapshot()).toEqual(updated); expect(confirm(preview)).toMatchObject({ status: 'applied', message: '任务已移除，可撤销' });
    expect(p.snapshot().tasks).toEqual([]); expect(p.snapshot().blocks).toMatchObject([{ id: block.id, title: '刚修改的安排', taskId: null, candidateId: notice.id, start: block.start, end: null }]);
    expect(p.snapshot().candidates).toMatchObject([{ id: notice.id, status: 'accepted', taskId: null, sourceIds: updated.candidates[0]!.sourceIds }]);
  });
  it('persists undo after reopening and refuses stale or dangling-reference undo', () => {
    const { repository: r, path, mutate } = setup(); const created = mutate({ type: 'create', entity: 'task', values: { title: 'A' } });
    r.close(); const reopened = createRepository(path); repos.push(reopened); const p2 = createPlanner(reopened);
    expect(p2.snapshot().tasks).toHaveLength(1); expect(p2.undo(created.status === 'applied' ? created.transactionId : '').status).toBe('applied'); expect(p2.snapshot().tasks).toEqual([]);
    const taskResult = p2.mutate(MutationRequestSchema.parse({ operationId: 'second', origin: 'manual', confirmed: false, mutations: [{ type: 'create', entity: 'task', values: { title: 'parent' } }] }));
    const t = p2.snapshot().tasks[0]!; p2.mutate(MutationRequestSchema.parse({ operationId: 'child', origin: 'manual', confirmed: false, mutations: [{ type: 'create', entity: 'block', values: { title: 'child', taskId: t.id, kind: 'event', start: '2026-10-24T10:00:00+08:00', end: null } }] }));
    expect(p2.undo(taskResult.status === 'applied' ? taskResult.transactionId : '').status).toBe('clarification'); expect(p2.snapshot().tasks).toHaveLength(1);
  });
  it('requires deliberate overlap confirmation and previews task deletion unlinks', () => {
    const { planner: p, mutate, confirm } = setup();
    mutate({ type: 'create', entity: 'task', values: { title: 'task' } }); const t = p.snapshot().tasks[0]!;
    mutate({ type: 'create', entity: 'block', values: { title: 'one', taskId: t.id, kind: 'work', start: '2026-10-23T10:00:00+08:00', end: '2026-10-23T11:00:00+08:00' } });
    const overlap = mutate({ type: 'create', entity: 'block', values: { title: 'two', kind: 'work', start: '2026-10-23T10:30:00+08:00', end: '2026-10-23T11:30:00+08:00' } });
    expect(overlap.status).toBe('preview'); expect(confirm(overlap).status).toBe('applied');
    const deletion = mutate({ type: 'delete', entity: 'task', id: t.id, expectedVersion: 1 }); expect(deletion.status).toBe('preview'); confirm(deletion);
    expect(p.snapshot().blocks.every(b => b.taskId === null)).toBe(true);
  });
  it('preserves independent accepted task after acknowledged source deletion', () => {
    const { repository: r, planner: p, mutate } = setup(); const s = seed(r); const c = candidate(r, s.id);
    mutate({ type: 'acceptCandidate', id: c.id, expectedVersion: 1 });
    mutate({ type: 'delete', entity: 'source', id: s.id, expectedVersion: 1, acknowledgeProvenanceLoss: true });
    expect(p.snapshot().sources).toEqual([]); expect(p.snapshot().tasks).toHaveLength(1); expect(p.snapshot().candidates[0]!.sourceIds).toEqual([s.id]);
  });
  it('refuses stale undo after later edit and undoes goal links without orphaning tasks', () => {
    const { planner: p, mutate } = setup(); const created = mutate({ type: 'create', entity: 'goal', values: { title: 'goal' } }); const g = p.snapshot().goals[0]!;
    mutate({ type: 'create', entity: 'task', values: { title: 'child', goalId: g.id } });
    expect(p.undo(created.status === 'applied' ? created.transactionId : '').status).toBe('clarification');
    const edit = mutate({ type: 'update', entity: 'goal', id: g.id, expectedVersion: 1, values: { title: 'edited' } });
    mutate({ type: 'update', entity: 'goal', id: g.id, expectedVersion: 2, values: { description: 'later' } });
    expect(p.undo(edit.status === 'applied' ? edit.transactionId : '').status).toBe('clarification'); expect(p.snapshot().goals[0]!.description).toBe('later');
  });
  it('rejects altered previews, AI self confirmation, and operationId collisions', () => {
    const { planner: p, mutate } = setup(); const preview = mutate({ type: 'create', entity: 'task', values: { title: 'A' } }, { type: 'create', entity: 'task', values: { title: 'B' } });
    if (preview.status !== 'preview') throw Error('expected preview');
    const changed = structuredClone(preview.proposedRequest); changed.mutations[0] = { type: 'create', entity: 'task', values: { ...('values' in changed.mutations[0]! ? changed.mutations[0].values : {}), title: 'evil' } } as never;
    expect(p.mutate({ ...changed, confirmed: true, confirmationToken: preview.confirmationToken }).status).toBe('clarification');
    expect(p.mutate({ ...preview.proposedRequest, origin: 'ai', confirmed: true, confirmationToken: preview.confirmationToken }).status).toBe('clarification'); expect(p.snapshot().tasks).toEqual([]);
    const request = MutationRequestSchema.parse({ operationId: 'collision', origin: 'manual', mutations: [{ type: 'create', entity: 'task', values: { title: 'first' } }] }); p.mutate(request);
    expect(p.mutate({ ...request, mutations: [{ ...request.mutations[0]!, values: { title: 'second' } } as never] }).status).toBe('clarification'); expect(p.snapshot().tasks).toHaveLength(1);
  });
  it('treats equal interval boundaries consistently with and without milliseconds', () => {
    const { mutate, planner: p } = setup();
    mutate({ type: 'create', entity: 'block', values: { title: 'one', kind: 'work', start: '2026-10-23T09:00:00+08:00', end: '2026-10-23T10:00:00.000+08:00' } });
    expect(mutate({ type: 'create', entity: 'block', values: { title: 'two', kind: 'work', start: '2026-10-23T10:00:00+08:00', end: '2026-10-23T11:00:00+08:00' } }).status).toBe('applied'); expect(p.snapshot().blocks).toHaveLength(2);
  });
  it('records snooze feedback and restores ignored candidates to pending', () => {
    const { repository: r, planner: p, mutate } = setup(); const c = candidate(r, seed(r).id);
    mutate({ type: 'ignoreCandidate', id: c.id, expectedVersion: 1, reason: '不适合' });
    mutate({ type: 'snoozeCandidate', id: c.id, expectedVersion: 2, until: '2026-10-25T09:00:00+08:00' });
    expect(p.snapshot().candidates[0]).toMatchObject({ status: 'pending', snoozedUntil: '2026-10-25T09:00:00+08:00' }); expect(p.snapshot().feedback.map(f => f.decision)).toEqual(['ignored', 'snoozed']);
  });
  it('edits course single/all/following with preview and preserves only applicable exceptions', () => {
    const { planner: p, mutate, confirm } = setup();
    mutate({ type: 'create', entity: 'course', values: { title: '数学', weekday: 1, startTime: '08:00', endTime: '09:00', firstWeek: 1, lastWeek: 5, termStart: '2026-09-07' } }); const c = p.snapshot().courses[0]!;
    confirm(mutate({ type: 'update', entity: 'course', id: c.id, expectedVersion: 1, scope: 'single', occurrenceDate: '2026-09-14', values: { startTime: '10:00', endTime: '11:00' } }));
    expect(buildCalendar(p.snapshot(), '2026-09-14', '2026-09-14', true)[0]!.start).toBe('2026-09-14T10:00:00+08:00');
    confirm(mutate({ type: 'update', entity: 'course', id: c.id, expectedVersion: 1, scope: 'this-and-following', occurrenceDate: '2026-09-21', values: { title: '后续数学' } }));
    expect(p.snapshot().courses).toHaveLength(2); expect(p.snapshot().courseExceptions).toHaveLength(1);
    const first = p.snapshot().courses.find(x => x.id === c.id)!;
    confirm(mutate({ type: 'update', entity: 'course', id: c.id, expectedVersion: first.version, scope: 'all', values: { weekday: 2 } })); expect(p.snapshot().courseExceptions).toEqual([]);
  });
  it('allows undoing several successive edits while rejecting an unrelated later edit', () => {
    const { planner: p, mutate } = setup(); mutate({ type: 'create', entity: 'task', values: { title: 'original' } }); const t = p.snapshot().tasks[0]!;
    mutate({ type: 'update', entity: 'task', id: t.id, expectedVersion: 1, values: { title: 'first' } });
    mutate({ type: 'update', entity: 'task', id: t.id, expectedVersion: 2, values: { title: 'second' } });
    expect(p.undo().status).toBe('applied'); expect(p.snapshot().tasks[0]!.title).toBe('first');
    expect(p.undo().status).toBe('applied'); expect(p.snapshot().tasks[0]).toMatchObject({ title: 'original', version: 5 });
  });
  it('handles operation IDs that match object property names without losing idempotency', () => {
    const { planner: p } = setup();
    for (const operationId of ['__proto__', 'constructor', 'toString']) { const request = MutationRequestSchema.parse({ operationId, origin: 'manual', mutations: [{ type: 'create', entity: 'task', values: { title: operationId } }] }); expect(p.mutate(request).status).toBe('applied'); expect(p.mutate(request).status).toBe('applied'); }
    expect(p.snapshot().tasks).toHaveLength(3);
  });
  it('rejects renderer and AI attempts to forge generated event provenance', () => {
    const { planner: p, mutate } = setup();
    expect(mutate({ type: 'create', entity: 'block', values: { title: 'forged', candidateId: 'someone', kind: 'event', start: '2026-10-23T10:00:00+08:00', end: null } } as never).status).toBe('clarification'); expect(p.snapshot().blocks).toEqual([]);
  });
  it('does not replay source analysis usage when an import operation retries', () => {
    const { repository: r, planner: p } = setup(); const request = { operationId: 'import-once', changes: [{ entity: 'source' as const, values: { kind: 'text', text: 'synthetic', importedAt: '2026-10-22T10:00:00+08:00' } }], usage: { id: 'usage-once', operationId: 'import-once', createdAt: '2026-10-22T10:00:00+08:00', model: 'fixture', purpose: 'source' as const, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2, estimatedCost: null, currency: null } };
    expect(r.writeInternal(request).entities[0]!.id).toBe(r.writeInternal(request).entities[0]!.id); expect(p.snapshot().tokenUsage).toHaveLength(1); expect(p.snapshot().sources).toHaveLength(1);
  });
  it('restores an ignored candidate explicitly with restored feedback and cleared snooze', () => {
    const { repository: r, planner: p, mutate } = setup(); const c = candidate(r, seed(r).id);
    mutate({ type: 'ignoreCandidate', id: c.id, expectedVersion: 1 });
    expect(mutate({ type: 'restoreCandidate', id: c.id, expectedVersion: 2 } as never).status).toBe('applied');
    expect(p.snapshot().candidates[0]).toMatchObject({ status: 'pending', snoozedUntil: null }); expect(p.snapshot().feedback.at(-1)!.decision).toBe('restored');
  });
  it('keeps background source status writes out of the latest user undo action', () => {
    const { repository: r, planner: p, mutate } = setup(); const s = seed(r);
    mutate({ type: 'create', entity: 'task', values: { title: 'user action' } });
    r.writeInternal({ operationId: 'processing', changes: [{ entity: 'source', id: s.id, expectedVersion: 1, values: { status: 'processing' } }] });
    expect(p.undo().status).toBe('applied'); expect(p.snapshot().tasks).toEqual([]); expect(p.snapshot().sources[0]!.status).toBe('processing');
  });
  it('rejects single occurrence reminder edits instead of silently losing them', () => {
    const { planner: p, mutate } = setup(); mutate({ type: 'create', entity: 'course', values: { title: '数学', weekday: 1, startTime: '08:00', endTime: '09:00', firstWeek: 1, lastWeek: 5, termStart: '2026-09-07' } }); const c = p.snapshot().courses[0]!;
    expect(mutate({ type: 'update', entity: 'course', id: c.id, expectedVersion: 1, scope: 'single', occurrenceDate: '2026-09-14', values: { reminders: { enabled: false } } }).status).toBe('clarification'); expect(p.snapshot().courseExceptions).toEqual([]);
  });
  it('reviews accepted revision against the same task, preserving goal, completion and work sessions', () => {
    const { repository: r, planner: p, mutate, confirm } = setup(); const source = seed(r); const c = candidate(r, source.id, { eventStart: '2026-10-24T14:00:00+08:00', eventEnd: '2026-10-24T15:00:00+08:00' });
    mutate({ type: 'acceptCandidate', id: c.id, expectedVersion: 1 }); const t = p.snapshot().tasks[0]!;
    mutate({ type: 'create', entity: 'goal', values: { title: 'goal' } }); const g = p.snapshot().goals[0]!;
    mutate({ type: 'update', entity: 'task', id: t.id, expectedVersion: 1, values: { goalId: g.id, status: 'done' } });
    mutate({ type: 'create', entity: 'block', values: { title: 'session', kind: 'work', taskId: t.id, start: '2026-10-23T10:00:00+08:00', end: '2026-10-23T11:00:00+08:00' } });
    const revision = candidate(r, source.id, { revisionOfId: c.id, title: '延期报告', deadline: { date: '2026-10-30', time: null }, eventStart: '2026-10-25T14:00:00+08:00', eventEnd: null });
    const preview = mutate({ type: 'acceptCandidate', id: revision.id, expectedVersion: 1 }); expect(preview.status).toBe('preview'); expect(p.snapshot().tasks[0]!.title).toBe('报告');
    expect(confirm(preview)).toMatchObject({ status: 'applied', message: '已接受，活动时间已更新到日历：2026-10-25 14:00（默认安排30分钟，可调整），可撤销' }); expect(p.snapshot().tasks).toHaveLength(1); expect(p.snapshot().tasks[0]).toMatchObject({ id: t.id, title: '延期报告', goalId: g.id, status: 'done', deadline: { date: '2026-10-30', time: null } });
    expect(p.snapshot().blocks.filter(b => b.kind === 'work')).toHaveLength(1); expect(p.snapshot().blocks.filter(b => b.kind === 'event')).toMatchObject([{ start: '2026-10-25T14:00:00+08:00', end: null }]);
  });
  it('does not duplicate the current source event when a second revision names an older accepted notice', () => {
    const { repository: r, planner: p, mutate, confirm } = setup(); const source = seed(r); const first = candidate(r, source.id, { eventStart: '2026-10-24T14:00:00+08:00', eventEnd: '2026-10-24T15:00:00+08:00' }); mutate({ type: 'acceptCandidate', id: first.id, expectedVersion: 1 });
    const second = candidate(r, source.id, { revisionOfId: first.id, eventStart: '2026-10-25T14:00:00+08:00', eventEnd: '2026-10-25T15:00:00+08:00' }); confirm(mutate({ type: 'acceptCandidate', id: second.id, expectedVersion: 1 }));
    const third = candidate(r, source.id, { revisionOfId: first.id, eventStart: '2026-10-26T14:00:00+08:00', eventEnd: '2026-10-26T15:00:00+08:00' }); confirm(mutate({ type: 'acceptCandidate', id: third.id, expectedVersion: 1 }));
    expect(p.snapshot().tasks).toHaveLength(1); expect(p.snapshot().blocks).toHaveLength(1); expect(p.snapshot().blocks[0]!.start).toBe('2026-10-26T14:00:00+08:00');
  });
  it('links an accepted duplicate to the existing task without duplicating or rewriting it', () => {
    const { repository: r, planner: p, mutate } = setup(); const source = seed(r); const first = candidate(r, source.id); mutate({ type: 'acceptCandidate', id: first.id, expectedVersion: 1 });
    const duplicate = candidate(r, source.id, { duplicateOfId: first.id, title: 'duplicate wording' }); expect(mutate({ type: 'acceptCandidate', id: duplicate.id, expectedVersion: 1 })).toMatchObject({ status: 'applied', message: '已接受，已关联原任务，可撤销' });
    expect(p.snapshot().tasks).toHaveLength(1); expect(p.snapshot().tasks[0]!.title).toBe('报告'); expect(p.snapshot().candidates.every(c => c.taskId === p.snapshot().tasks[0]!.id)).toBe(true);
  });
  it('requires time conflict preview when deleting a cancellation restores an occupied course', () => {
    const { planner: p, mutate, confirm } = setup(); mutate({ type: 'create', entity: 'course', values: { title: '课', weekday: 1, startTime: '10:00', endTime: '11:00', firstWeek: 1, lastWeek: 1, termStart: '2026-09-07' } }); const c = p.snapshot().courses[0]!;
    confirm(mutate({ type: 'create', entity: 'courseException', values: { courseId: c.id, originalDate: '2026-09-07', cancelled: true } }));
    mutate({ type: 'create', entity: 'block', values: { title: '其他', kind: 'work', start: '2026-09-07T10:00:00+08:00', end: '2026-09-07T11:00:00+08:00' } }); const e = p.snapshot().courseExceptions[0]!;
    expect(mutate({ type: 'delete', entity: 'courseException', id: e.id, expectedVersion: 1 }).status).toBe('preview'); expect(p.snapshot().courseExceptions).toHaveLength(1);
  });
});

describe('calendar, reminders and backups', () => {
  it('rolls back schema defaults and version together when bootstrap fails, then reopens successfully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-init-')); roots.push(dir); const path = join(dir, 'planner.sqlite');
    const db = new DatabaseSync(path); db.exec(`CREATE TABLE settings (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE metadata (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TRIGGER fail_bootstrap BEFORE INSERT ON metadata WHEN NEW.id='lastBackupAt'
      BEGIN SELECT RAISE(ABORT, 'synthetic interrupted bootstrap'); END;`);
    try {
      expect(() => createRepository(path)).toThrow('synthetic interrupted bootstrap');
      expect(db.prepare('SELECT count(*) AS count FROM settings').get()!['count']).toBe(0);
      expect(db.prepare('SELECT count(*) AS count FROM metadata').get()!['count']).toBe(0);
      expect(db.prepare('PRAGMA user_version').get()!['user_version']).toBe(0);
      expect(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='records'").get()!['count']).toBe(0);
      db.exec('DROP TRIGGER fail_bootstrap');
    } finally { db.close(); }
    const reopened = createRepository(path); repos.push(reopened); expect(reopened.snapshot().tasks).toEqual([]); expect(reopened.snapshot().settings).toEqual(DEFAULT_SETTINGS);
  });
  it('recovers only provably empty legacy partial initialization without resetting user data', () => {
    for (const includeVersion of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), 'planner-partial-')); roots.push(dir); const path = join(dir, 'planner.sqlite');
      const db = new DatabaseSync(path); db.exec('CREATE TABLE settings (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE metadata (id TEXT PRIMARY KEY, payload TEXT NOT NULL); PRAGMA user_version=1');
      db.prepare('INSERT INTO settings(id,payload) VALUES(?,?)').run('settings', JSON.stringify(DEFAULT_SETTINGS));
      if (includeVersion) db.prepare('INSERT INTO metadata(id,payload) VALUES(?,?)').run('schemaVersion', '1'); db.close();
      const reopened = createRepository(path); repos.push(reopened); expect(reopened.snapshot().settings).toEqual(DEFAULT_SETTINGS); expect(reopened.snapshot().tasks).toEqual([]);
    }
    const { repository: r, mutate, path } = setup(); mutate({ type: 'create', entity: 'task', values: { title: 'preserve user task' } }); r.close();
    const db = new DatabaseSync(path); const before = db.prepare('SELECT payload FROM records').all(); db.exec("DELETE FROM metadata WHERE id='lastBackupAt'");
    try { expect(() => createRepository(path)).toThrow(); expect(db.prepare('SELECT payload FROM records').all()).toEqual(before); expect(db.prepare('SELECT id FROM metadata ORDER BY id').all()).toEqual([{ id: 'schemaVersion' }]); } finally { db.close(); }
    const custom = setup(); custom.repository.saveSettings({ showPending: false }); custom.repository.close(); const customDb = new DatabaseSync(custom.path); customDb.exec("DELETE FROM metadata WHERE id='lastBackupAt'");
    try { expect(() => createRepository(custom.path)).toThrow(); expect(JSON.parse(customDb.prepare("SELECT payload FROM settings WHERE id='settings'").get()!['payload'] as string).showPending).toBe(false); expect(customDb.prepare('SELECT count(*) AS count FROM metadata').get()!['count']).toBe(1); } finally { customDb.close(); }
  });
  it('expands literal odd weeks and replaces September 21 once on September 22', () => {
    const { planner: p, mutate, confirm } = setup(); mutate({ type: 'create', entity: 'course', values: { title: '数学', weekday: 1, startTime: '08:00', endTime: '09:00', firstWeek: 1, lastWeek: 5, parity: 'odd', termStart: '2026-09-07' } });
    const course = p.snapshot().courses[0]!; const move = mutate({ type: 'create', entity: 'courseException', values: { courseId: course.id, originalDate: '2026-09-21', cancelled: false, replacement: { title: '调课', start: '2026-09-22T14:00:00+08:00', end: '2026-09-22T15:00:00+08:00' } } });
    expect(move.status).toBe('preview'); expect(p.snapshot().courseExceptions).toHaveLength(0); confirm(move);
    expect(buildCalendar(p.snapshot(), '2026-09-07', '2026-09-27', true).map(x => x.date)).toEqual(['2026-09-07', '2026-09-22']);
  });
  it('uses literal reminder boundaries, date-only 09:00, receipts survive restart', () => {
    const { repository: r, planner: p, mutate, path } = setup();
    mutate({ type: 'create', entity: 'task', values: { title: 'exact', deadline: { date: '2026-11-02', time: '12:00' } } });
    mutate({ type: 'create', entity: 'task', values: { title: 'date', deadline: { date: '2026-11-02', time: null } } });
    const reminders = collectReminders(p.snapshot(), '2026-11-01T11:59:59+08:00', '2026-11-02T10:00:00+08:00');
    expect(reminders.map(x => [x.title, x.scheduledAt])).toEqual([['exact', '2026-11-01T12:00:00+08:00'], ['date', '2026-11-02T09:00:00+08:00'], ['exact', '2026-11-02T10:00:00+08:00']]);
    expect(r.claimReminders(reminders)).toHaveLength(3); r.close(); const reopened = createRepository(path); repos.push(reopened); expect(reopened.claimReminders(reminders)).toEqual([]);
  });
  it('backs up source images and undo, validates restore before changing live SQLite', () => {
    const { repository: r, planner: p, mutate, dir } = setup();
    r.writeInternal({ operationId: 'image', changes: [{ entity: 'source', values: { kind: 'image', imageDataUrl: 'data:image/png;base64,aGVsbG8=', importedAt: '2026-10-22T10:00:00+08:00' } }] });
    mutate({ type: 'create', entity: 'goal', values: { title: 'before' } }); const backup = createBackup(r, join(dir, 'manual.sqlite'));
    mutate({ type: 'create', entity: 'goal', values: { title: 'after' } });
    const restored = restoreBackup(r, backup.path); expect(restored.safetyBackupPath).toBeTruthy(); expect(p.snapshot().goals.map(x => x.title)).toEqual(['before']); expect(p.snapshot().sources[0]!.imageDataUrl).toBe('data:image/png;base64,aGVsbG8=');
    expect(() => restoreBackup(r, join(dir, 'missing'))).toThrow(); expect(p.snapshot().goals).toHaveLength(1);
  });
  it('honors per-item suppression even on date-only reminders and excludes creation-time/passed points', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T09:00:00+08:00'));
    const { planner: p, mutate } = setup();
    mutate({ type: 'create', entity: 'task', values: { title: 'suppressed', deadline: { date: '2026-10-24', time: null }, reminders: { leadMinutes: [] } } });
    mutate({ type: 'create', entity: 'task', values: { title: 'created now', deadline: { date: '2026-10-23', time: null } } });
    expect(collectReminders(p.snapshot(), '2026-10-22T00:00:00+08:00', '2026-10-24T09:00:00+08:00')).toEqual([]);
  });
  it('emits blocks at 15 minutes, enables courses only by setting, and excludes lower boundary', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-01T10:00:00+08:00'));
    const { repository: r, planner: p, mutate, confirm } = setup();
    mutate({ type: 'create', entity: 'block', values: { title: '工作', kind: 'work', start: '2026-09-07T10:00:00+08:00', end: '2026-09-07T11:00:00+08:00' } });
    const courseResult = mutate({ type: 'create', entity: 'course', values: { title: '课', weekday: 1, startTime: '10:00', endTime: '11:00', firstWeek: 1, lastWeek: 1, termStart: '2026-09-07' } }); if (courseResult.status === 'preview') confirm(courseResult);
    expect(collectReminders(p.snapshot(), '2026-09-07T09:44:59+08:00', '2026-09-07T09:45:00+08:00').map(x => x.refKind)).toEqual(['block']);
    expect(collectReminders(p.snapshot(), '2026-09-07T09:45:00+08:00', '2026-09-07T10:00:00+08:00')).toEqual([]);
    r.saveSettings({ courseReminders: true }); expect(collectReminders(p.snapshot(), '2026-09-07T09:44:59+08:00', '2026-09-07T09:45:00+08:00').map(x => x.refKind).sort()).toEqual(['block', 'course']);
  });
  it('expands explicit teaching weeks and course cancellation without guessing holidays', () => {
    const { planner: p, mutate, confirm } = setup(); mutate({ type: 'create', entity: 'course', values: { title: '指定周', weekday: 1, startTime: '08:00', endTime: '09:00', firstWeek: 1, lastWeek: 5, weeks: [2, 4], parity: 'even', termStart: '2026-09-07' } }); const c = p.snapshot().courses[0]!;
    confirm(mutate({ type: 'create', entity: 'courseException', values: { courseId: c.id, originalDate: '2026-09-28', cancelled: true } }));
    expect(buildCalendar(p.snapshot(), '2026-09-07', '2026-10-05', true).map(x => x.date)).toEqual(['2026-09-14']);
  });
  it('does not include an interval ending at midnight in the following day', () => {
    const { planner: p, mutate } = setup(); mutate({ type: 'create', entity: 'block', values: { title: '晚间', kind: 'work', start: '2026-10-23T23:00:00+08:00', end: '2026-10-24T00:00:00+08:00' } });
    expect(buildCalendar(p.snapshot(), '2026-10-24', '2026-10-24', true)).toEqual([]);
    expect(buildCalendar(p.snapshot(), '2026-10-23', '2026-10-23', true)).toHaveLength(1);
  });
  it('rejects malformed records or future backup schema before touching live data', () => {
    const { repository: r, planner: p, mutate, dir } = setup(); mutate({ type: 'create', entity: 'task', values: { title: 'safe' } });
    const path = createBackup(r, join(dir, 'valid.sqlite')).path; const corrupt = join(dir, 'corrupt.sqlite'); copyFileSync(path, corrupt); const db = new DatabaseSync(corrupt);
    db.prepare("UPDATE records SET payload=? WHERE kind='task'").run(JSON.stringify({ title: 'missing metadata' })); db.close();
    expect(() => restoreBackup(r, corrupt)).toThrow(); expect(p.snapshot().tasks[0]!.title).toBe('safe');
    const future = join(dir, 'future.sqlite'); copyFileSync(path, future); const db2 = new DatabaseSync(future); db2.exec('PRAGMA user_version=999'); db2.close(); expect(() => restoreBackup(r, future)).toThrow(); expect(p.snapshot().tasks).toHaveLength(1);
  });
  it('rejects malformed persisted operation results and mismatched journal kinds during restore', () => {
    const { repository: r, planner: p, mutate, dir } = setup(); mutate({ type: 'create', entity: 'task', values: { title: 'safe' } });
    const path = createBackup(r, join(dir, 'valid.sqlite')).path; const corrupt = join(dir, 'operations.sqlite'); copyFileSync(path, corrupt); const db = new DatabaseSync(corrupt);
    db.prepare('UPDATE operations SET payload=?').run(JSON.stringify({ fingerprint: 'fake', result: { apiKey: 'should-never-be-accepted' } })); db.close();
    expect(() => restoreBackup(r, corrupt)).toThrow(); expect(p.snapshot().tasks[0]!.title).toBe('safe');
    const badJournal = join(dir, 'journal.sqlite'); copyFileSync(path, badJournal); const db2 = new DatabaseSync(badJournal); const row = db2.prepare('SELECT id,payload FROM journal LIMIT 1').get()!; const journal = JSON.parse(row['payload'] as string); journal.details[0].entity = 'source'; db2.prepare('UPDATE journal SET payload=? WHERE id=?').run(JSON.stringify(journal), row['id'] as string); db2.close();
    expect(() => restoreBackup(r, badJournal)).toThrow(); expect(p.snapshot().tasks).toHaveLength(1);
  });
  it('persists settings/preferences/usage and retains seven daily backups', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T10:00:00+08:00'));
    const { repository: r, planner: p, mutate, dir, path } = setup();
    r.saveSettings({ showPending: false }); mutate({ type: 'create', entity: 'preference', values: { text: '上午学习' } });
    for (let d = 2; d <= 10; d++) { vi.setSystemTime(new Date(`2026-10-${String(d).padStart(2, '0')}T10:00:00+08:00`)); mutate({ type: 'create', entity: 'task', values: { title: `day${d}` } }); }
    expect(readdirSync(join(dir, 'backups')).filter(f => f.startsWith('auto-'))).toHaveLength(7);
    r.addUsage({ id: 'usage', operationId: 'synthetic', createdAt: '2026-10-10T10:00:00+08:00', model: 'fixture', purpose: 'source', inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15, estimatedCost: null, currency: null });
    expect(p.snapshot().settings.showPending).toBe(false); r.close(); const reopened = createRepository(path); repos.push(reopened); expect(reopened.snapshot().preferences[0]!.text).toBe('上午学习'); expect(reopened.snapshot().tokenUsage[0]!.totalTokens).toBe(15);
  });
  it('does not rewrite existing image records when an unrelated task changes', () => {
    const { repository: r, mutate, path } = setup(); r.writeInternal({ operationId: 'image-only', changes: [{ entity: 'source', values: { kind: 'image', imageDataUrl: 'data:image/png;base64,aGVsbG8=', importedAt: '2026-10-22T10:00:00+08:00' } }] });
    const db = new DatabaseSync(path); db.exec("CREATE TABLE audit (kind TEXT); CREATE TRIGGER image_update AFTER UPDATE ON records WHEN NEW.kind='source' BEGIN INSERT INTO audit(kind) VALUES(NEW.kind); END;");
    try { mutate({ type: 'create', entity: 'task', values: { title: 'unrelated' } }); expect(db.prepare('SELECT count(*) AS count FROM audit').get()!['count']).toBe(0); } finally { db.close(); }
  });
});
