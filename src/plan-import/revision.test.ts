import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { apiResultSchema, MutationRequestSchema, MutationResultSchema, type MutationRequestInput, type MutationResult } from '../shared/contracts';
import type { PlanFileInput } from '../shared/plan-import';
import { PlanExportRequestSchema, type PlanSource } from '../shared/plan-context';
import { buildPlanContext } from './context';
import { createPlanImportService } from './service';
import { createWriteJournal } from '../remote/write-journal';
import type { NodeRemoteClient } from '../remote/node-client';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks(); });
const source: PlanSource = { kind: 'cloud', dataInstanceId: '30303030-3030-4030-8030-303030303030', generation: 1 };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'revision-import-'));
  cleanup.push(() => { const delta = relative(tmpdir(), directory); if (!delta || delta.startsWith('..') || isAbsolute(delta)) throw Error('Unsafe test cleanup'); rmSync(directory, { recursive: true, force: true }); });
  const repository = createRepository(join(directory, 'synthetic.sqlite'), { automaticBackup: () => {} }); cleanup.push(() => repository.close());
  const planner = createPlanner(repository, { automaticBackup: () => {} });
  const manual = (mutations: MutationRequestInput['mutations']) => {
    let result = planner.mutate(MutationRequestSchema.parse({ operationId: crypto.randomUUID(), origin: 'manual', mutations }));
    if (result.status === 'preview') result = planner.mutate({ ...result.proposedRequest, confirmed: true, confirmationToken: result.confirmationToken });
    if (result.status !== 'applied') throw Error(result.message); return result;
  };
  manual([{ type: 'create', entity: 'goal', values: { title: '合成阅读目标', description: '原目标说明' } }]);
  const goal = planner.snapshot().goals[0]!;
  manual([{ type: 'create', entity: 'task', values: { title: '合成第一章', goalId: goal.id, description: '保留此任务说明' } },
    { type: 'create', entity: 'task', values: { title: '合成第二章', goalId: goal.id } }]);
  const [task1, task2] = planner.snapshot().tasks;
  manual([{ type: 'create', entity: 'block', values: { title: '原学习时段一', taskId: task1!.id, kind: 'work', start: '2030-04-15T09:00:00+08:00', end: '2030-04-15T10:00:00+08:00' } },
    { type: 'create', entity: 'block', values: { title: '原学习时段二', taskId: task2!.id, kind: 'work', start: '2030-04-15T10:00:00+08:00', end: '2030-04-15T11:00:00+08:00' } }]);
  const [block1, block2] = planner.snapshot().blocks;
  const context = () => buildPlanContext(planner.snapshot(), PlanExportRequestSchema.parse({ goalId: goal.id, fromDate: '2030-04-15', toDate: '2030-04-21' }), source);
  const mutate = vi.fn(async (input: MutationRequestInput): Promise<MutationResult> => planner.mutate(MutationRequestSchema.parse(input)));
  const getSource = vi.fn(async () => source), scope = vi.fn(async () => 'synthetic:cloud:source:generation-1');
  const options = { directory, snapshot: async () => planner.snapshot(), mutate, scope, source: getSource };
  const plan: PlanFileInput = { format: 'ultimate-calendar-plan', version: 3, timezone: 'Asia/Shanghai', planId: 'synthetic-revision', title: '合成修订', basis: context().basis,
    updates: [{ id: 'goal-description', kind: 'goal', targetId: goal.id, expectedVersion: goal.version, values: { description: '重新安排阅读目标' } }] };
  return { directory, repository, planner, manual, mutate, getSource, scope, options, service: createPlanImportService(options), context, plan, goal, task1: task1!, task2: task2!, block1: block1!, block2: block2! };
}
async function apply(f: ReturnType<typeof fixture>, plan = f.plan, flags: { allowDeletions?: boolean; allowConflicts?: boolean } = {}) {
  const preview = await f.service.preview(plan); return f.service.confirm({ token: preview.token, ...flags });
}

describe('guarded JSON plan revisions', () => {
  it('previews exact field changes and preserves omitted fields, IDs, state and associations', async () => {
    const f = fixture();
    f.plan.updates!.push({ id: 'task-deadline', kind: 'task', targetId: f.task1.id, expectedVersion: 1, values: { title: '更新的第一章', deadline: { date: '2030-04-20', time: '18:00' } } });
    const before = f.planner.snapshot(), preview = await f.service.preview(f.plan);
    expect(f.mutate).not.toHaveBeenCalled(); expect(preview.rows.map(row => row.state)).toEqual(['update', 'update']);
    expect(preview.rows[0]?.changes).toEqual([{ field: '说明', before: '原目标说明', after: '重新安排阅读目标' }]);
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ status: 'complete', applied: 2, remaining: 0 });
    const after = f.planner.snapshot();
    expect(after.goals[0]).toMatchObject({ id: f.goal.id, description: '重新安排阅读目标', version: 2 });
    expect(after.tasks.find(task => task.id === f.task1.id)).toMatchObject({ title: '更新的第一章', deadline: { date: '2030-04-20', time: '18:00' }, description: '保留此任务说明', status: 'open', goalId: f.goal.id });
    expect(after.blocks).toEqual(before.blocks); expect(after.candidates).toEqual(before.candidates);
    expect(await apply(f)).toMatchObject({ status: 'complete', applied: 0 });
    expect(f.mutate).toHaveBeenCalledTimes(2); // One atomic preview and confirmation, never a second write.
  });

  it('swaps existing times atomically without transient conflicts', async () => {
    const f = fixture(); f.plan.updates = [
      { id: 'move-a', kind: 'block', targetId: f.block1.id, expectedVersion: 1, values: { start: f.block2.start, end: f.block2.end! } },
      { id: 'move-b', kind: 'block', targetId: f.block2.id, expectedVersion: 1, values: { start: f.block1.start, end: f.block1.end! } },
    ];
    const preview = await f.service.preview(f.plan); expect(preview.conflicts).toEqual([]);
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ status: 'complete', applied: 2 });
    expect(f.mutate.mock.calls[0]?.[0].mutations).toHaveLength(2);
    expect(f.planner.snapshot().blocks.find(block => block.id === f.block1.id)?.start).toBe(f.block2.start);
    expect(f.planner.snapshot().blocks.find(block => block.id === f.block2.id)?.start).toBe(f.block1.start);
  });

  it('requires deletion approval, then deletes only the explicit task and all its blocks before creating linked additions', async () => {
    const f = fixture();
    f.plan.deletions = [{ id: 'remove-task', kind: 'task', targetId: f.task2.id, expectedVersion: 1 }, { id: 'remove-block', kind: 'block', targetId: f.block2.id, expectedVersion: 1 }];
    f.plan.tasks = [{ id: 'new-task', title: '合成新增任务', goalId: f.goal.id }];
    f.plan.blocks = [{ id: 'new-block', title: '新任务学习', taskRef: 'new-task', start: f.block2.start, end: f.block2.end! }];
    const preview = await f.service.preview(f.plan); expect(preview.requiresDeletionApproval).toBe(true); expect(preview.conflicts).toEqual([]);
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ status: 'partial', applied: 0 }); expect(f.mutate).not.toHaveBeenCalled();
    expect(await apply(f, f.plan, { allowDeletions: true })).toMatchObject({ status: 'complete', applied: 5 });
    const after = f.planner.snapshot(); expect(after.tasks.some(task => task.id === f.task2.id)).toBe(false); expect(after.blocks.some(block => block.id === f.block2.id)).toBe(false);
    const task = after.tasks.find(task => task.title === '合成新增任务')!;
    expect(after.blocks.find(block => block.title === '新任务学习')?.taskId).toBe(task.id); expect(after.blocks.find(block => block.id === f.block1.id)).toEqual(f.block1);
    f.service = createPlanImportService(f.options); expect(await apply(f)).toMatchObject({ status: 'complete', applied: 0 });
  });

  it('compares conflicts against the final revised calendar and requires explicit conflict approval', async () => {
    const f = fixture();
    f.manual([{ type: 'create', entity: 'block', values: { title: '不可改的其它安排', kind: 'event', start: '2030-04-15T13:00:00+08:00', end: '2030-04-15T14:00:00+08:00' } }]);
    f.plan.basis = f.context().basis;
    f.plan.updates = [{ id: 'move', kind: 'block', targetId: f.block1.id, expectedVersion: 1, values: { start: '2030-04-15T13:30:00+08:00', end: '2030-04-15T14:30:00+08:00' } }];
    const preview = await f.service.preview(f.plan); expect(preview.conflicts).toHaveLength(1);
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ applied: 0 });
    expect(await apply(f, f.plan, { allowConflicts: true })).toMatchObject({ status: 'complete', applied: 1 });
    expect(f.planner.snapshot().blocks.find(block => block.id === f.block1.id)?.start).toBe('2030-04-15T13:30:00+08:00');
  });

  it.each([false, true])('replays the exact %s-confirmed revision after a lost response and restart', async confirmed => {
    const f = fixture(); if (confirmed) f.plan.updates!.push({ id: 'task-title', kind: 'task', targetId: f.task1.id, expectedVersion: 1, values: { title: '修订标题' } });
    f.plan.tasks = [{ id: 'after-revision', title: '随后新增任务', goalId: f.goal.id }];
    let lose = true;
    f.mutate.mockImplementation(async input => { const result = f.planner.mutate(MutationRequestSchema.parse(input)); if (result.status === 'applied' && lose) { lose = false; throw Error('synthetic lost response'); } return result; });
    expect(await apply(f)).toMatchObject({ status: 'partial' });
    const stored = JSON.parse(readFileSync(join(f.directory, 'plan-import-receipts.json'), 'utf8'));
    expect(stored.pending.key).toBe('revision:group'); expect(stored.pending.request.confirmed).toBe(confirmed); expect(stored.plans[0].revision.before).toHaveLength(confirmed ? 2 : 1);
    const count = f.mutate.mock.calls.length; f.service = createPlanImportService(f.options);
    expect(await apply(f)).toMatchObject({ status: 'complete' }); expect(f.mutate.mock.calls[count]?.[0]).toEqual(stored.pending.request);
    expect(f.planner.snapshot().goals[0]?.version).toBe(2); expect(f.planner.snapshot().tasks.filter(task => task.title === '随后新增任务')).toHaveLength(1);
  });

  it('only acknowledges a saved revision after later user editing, never overwrites or adds', async () => {
    const f = fixture(); f.plan.tasks = [{ id: 'not-created', title: '不可提前新增', goalId: f.goal.id }];
    let lose = true; f.mutate.mockImplementation(async input => { const result = f.planner.mutate(MutationRequestSchema.parse(input)); if (result.status === 'applied' && lose) { lose = false; throw Error('synthetic response lost'); } return result; });
    expect(await apply(f)).toMatchObject({ status: 'partial' });
    const goal = f.planner.snapshot().goals[0]!; f.manual([{ type: 'update', entity: 'goal', id: goal.id, expectedVersion: goal.version, values: { description: '用户后来的修改' } }]);
    f.service = createPlanImportService(f.options); const preview = await f.service.preview(f.plan);
    expect(preview.canVerifyPending).toBe(true); expect(preview.rows.some(row => row.state === 'blocked')).toBe(true);
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ status: 'partial', applied: 0 });
    expect(f.planner.snapshot().goals[0]?.description).toBe('用户后来的修改'); expect(f.planner.snapshot().tasks.some(task => task.title === '不可提前新增')).toBe(false);
    expect(JSON.parse(readFileSync(join(f.directory, 'plan-import-receipts.json'), 'utf8')).pending).toBeNull();
  });

  it('does not revive an undone revision and blocks other plans while the original request remains unknown', async () => {
    const f = fixture(); let lose = true;
    f.mutate.mockImplementation(async input => { const result = f.planner.mutate(MutationRequestSchema.parse(input)); if (result.status === 'applied' && lose) { lose = false; throw Error('synthetic response lost'); } return result; });
    expect(await apply(f)).toMatchObject({ status: 'partial' });
    await expect(f.service.preview({ format: 'ultimate-calendar-plan', version: 1, timezone: 'Asia/Shanghai', planId: 'different-plan', title: 'other', tasks: [{ id: 't', title: 'other' }] })).rejects.toThrow(/另一份计划/);
    const journal = f.planner.snapshot().journal[0]!; expect(f.planner.undo(journal.id).status).toBe('applied');
    const preview = await f.service.preview(f.plan); expect(preview.canVerifyPending).toBe(true);
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ status: 'partial', applied: 0 });
    expect(f.planner.snapshot().goals[0]?.description).toBe('原目标说明');
  });

  it('rejects preview races, changed file contents and changed source identity before a mutation', async () => {
    const f = fixture(), preview = await f.service.preview(f.plan);
    f.manual([{ type: 'update', entity: 'task', id: f.task1.id, expectedVersion: 1, values: { title: '手机端并发修改' } }]);
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ status: 'partial', applied: 0 }); expect(f.mutate).not.toHaveBeenCalled();
    f.plan.basis = f.context().basis; expect(await apply(f)).toMatchObject({ status: 'complete' });
    const changed = structuredClone(f.plan); changed.title = '更改同一个文件'; await expect(f.service.preview(changed)).rejects.toThrow(/planId.*改变/);
    const second = { ...structuredClone(f.plan), planId: 'another-revision', basis: f.context().basis, updates: [{ id: 'g', kind: 'goal' as const, targetId: f.goal.id, expectedVersion: 2, values: { title: '不写入另一份资料' } }] };
    f.getSource.mockResolvedValue({ ...source, generation: 2 }); const rejected = await f.service.preview(second); expect(rejected.rows.every(row => row.state === 'blocked')).toBe(true);
    const count = f.mutate.mock.calls.length; expect(await f.service.confirm({ token: rejected.token })).toMatchObject({ applied: 0 }); expect(f.mutate).toHaveBeenCalledTimes(count);
  });

  it('refuses a backend preview with extra changes before confirming it', async () => {
    const f = fixture(); f.plan.updates!.push({ id: 't', kind: 'task', targetId: f.task1.id, expectedVersion: 1, values: { title: '任务修订' } });
    f.mutate.mockImplementation(async input => {
      const result = f.planner.mutate(MutationRequestSchema.parse(input));
      return result.status === 'preview' ? { ...result, details: [...result.details, { entity: 'block', id: f.block1.id, before: f.block1, after: null }] } : result;
    });
    expect(await apply(f)).toMatchObject({ status: 'partial', applied: 0 }); expect(f.mutate).toHaveBeenCalledTimes(1);
    expect(f.planner.snapshot().goals[0]?.description).toBe('原目标说明');
  });

  it('recovers a lost confirmed cloud revision through the write journal without sending it twice', async () => {
    const f = fixture(); f.plan.updates!.push({ id: 't', kind: 'task', targetId: f.task1.id, expectedVersion: 1, values: { title: '云端修订' } });
    const receipts = new Map<string, { status: 'completed'; method: 'mutate'; result: { ok: true; data: MutationResult } }>();
    let lose = true;
    const client = { origin: 'https://synthetic.invalid', getSession: async () => ({ deviceId: '11111111-1111-4111-8111-111111111111', identity: { protocolVersion: 1, dataInstanceId: source.dataInstanceId, generation: 1 } }),
      operation: vi.fn(async (id: string) => receipts.get(id) ?? { status: 'unknown' }),
      rpc: vi.fn(async (_method: string, input: MutationRequestInput, requestId: string) => {
        const result = f.planner.mutate(MutationRequestSchema.parse(input)); receipts.set(requestId, { status: 'completed', method: 'mutate', result: { ok: true, data: result } });
        if (input.confirmed && lose) { lose = false; throw Error('synthetic cloud response lost'); } return { ok: true, data: result };
      }) };
    const journal = createWriteJournal(client as unknown as NodeRemoteClient, join(f.directory, 'write-journal.json'));
    const options = { ...f.options, mutate: async (input: MutationRequestInput) => { const result = apiResultSchema(MutationResultSchema).parse(await journal.rpc('mutate', input)); if (!result.ok) throw Error(result.error.message); return result.data; } };
    f.service = createPlanImportService(options); expect(await apply(f)).toMatchObject({ status: 'partial' });
    const calls = client.rpc.mock.calls.length; f.service = createPlanImportService(options);
    expect(await apply(f)).toMatchObject({ status: 'complete' }); expect(client.rpc).toHaveBeenCalledTimes(calls); expect(client.operation).toHaveBeenCalledOnce();
    expect(f.planner.snapshot().goals[0]?.version).toBe(2); expect(await journal.inspect()).toEqual({ status: 'none' });
  });

  it('continues lost additions after an applied revision without revising the original records again', async () => {
    const f = fixture(); f.plan.tasks = [{ id: 'new-task', title: '后续任务', goalId: f.goal.id }];
    f.plan.blocks = [{ id: 'new-block', title: '后续时段', taskRef: 'new-task', start: '2030-04-16T09:00:00+08:00', end: '2030-04-16T10:00:00+08:00' }];
    let lose = true; f.mutate.mockImplementation(async input => {
      const result = f.planner.mutate(MutationRequestSchema.parse(input));
      if (input.mutations.some(m => m.type === 'create' && m.entity === 'task') && result.status === 'applied' && lose) { lose = false; throw Error('synthetic addition response lost'); }
      return result;
    });
    expect(await apply(f)).toMatchObject({ status: 'partial', applied: 1 });
    f.service = createPlanImportService(f.options); expect(await apply(f)).toMatchObject({ status: 'complete', applied: 2 });
    expect(f.planner.snapshot().goals[0]?.version).toBe(2); const newTask = f.planner.snapshot().tasks.find(task => task.title === '后续任务')!;
    expect(f.planner.snapshot().blocks.filter(block => block.taskId === newTask.id)).toHaveLength(1);
    expect(f.mutate.mock.calls.filter(([input]) => input.operationId.startsWith('plan-revision:'))).toHaveLength(1);
  });

  it('re-previews after an expired backend confirmation without applying an old token or changing the operation ID', async () => {
    const f = fixture(); f.plan.updates!.push({ id: 't', kind: 'task', targetId: f.task1.id, expectedVersion: 1, values: { title: '明确修订' } });
    let expire = true, currentPlanner = f.planner;
    f.mutate.mockImplementation(async input => {
      if (input.confirmed && expire) { expire = false; currentPlanner = createPlanner(f.repository, { automaticBackup: () => {} }); }
      return currentPlanner.mutate(MutationRequestSchema.parse(input));
    });
    expect(await apply(f)).toMatchObject({ status: 'partial', applied: 0 }); expect(f.planner.snapshot().goals[0]?.version).toBe(1);
    expect(await apply(f)).toMatchObject({ status: 'complete', applied: 2 });
    expect(new Set(f.mutate.mock.calls.map(([input]) => input.operationId)).size).toBe(1);
    const confirmations = f.mutate.mock.calls.map(([input]) => input).filter(input => input.confirmed);
    expect(confirmations[1]!.confirmationToken).not.toBe(confirmations[0]!.confirmationToken);
  });
});
