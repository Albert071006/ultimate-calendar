import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository, newEntity, updateEntity } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { MutationRequestSchema, type MutationRequestInput, type MutationResult } from '../shared/contracts';
import { PlanExportRequestSchema, type PlanSource } from '../shared/plan-context';
import type { PlanFileInput } from '../shared/plan-import';
import { buildPlanContext } from './context';
import { createPlanImportService } from './service';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const origin: PlanSource = { kind: 'cloud', dataInstanceId: '44444444-4444-4444-8444-444444444444', generation: 1 };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'plan-revision-boundaries-'));
  cleanup.push(() => {
    const delta = relative(tmpdir(), directory);
    if (!delta || delta.startsWith('..') || isAbsolute(delta)) throw Error('Unsafe synthetic cleanup');
    rmSync(directory, { recursive: true, force: true });
  });
  const repository = createRepository(join(directory, 'synthetic.sqlite'), { automaticBackup: () => {} });
  cleanup.push(() => repository.close());
  const planner = createPlanner(repository, { automaticBackup: () => {} });
  function seed(mutations: MutationRequestInput['mutations']) {
    let result = planner.mutate(MutationRequestSchema.parse({ operationId: crypto.randomUUID(), origin: 'manual', mutations }));
    if (result.status === 'preview') result = planner.mutate({ ...result.proposedRequest, confirmed: true, confirmationToken: result.confirmationToken });
    if (result.status !== 'applied') throw Error(result.message);
    return result;
  }
  const goalId = seed([{ type: 'create', entity: 'goal', values: { title: '合成学习目标', description: '保留目标说明', priority: 'high', targetDate: '2030-05-01' } }]).changes[0]!.id;
  const otherGoalId = seed([{ type: 'create', entity: 'goal', values: { title: '合成无关目标' } }]).changes[0]!.id;
  const courseId = seed([{ type: 'create', entity: 'course', values: { title: '合成关联课程', weekday: 3, startTime: '08:00', endTime: '09:00', firstWeek: 1, lastWeek: 1, termStart: '2030-04-15' } }]).changes[0]!.id;
  const taskId = seed([{ type: 'create', entity: 'task', values: {
    title: '原阅读任务', description: '原有详细步骤', goalId, courseId, deadline: { date: '2030-04-20', time: '21:00' },
    reminders: { enabled: false, leadMinutes: [30], dateOnlyTime: '18:00' },
    resources: [{ id: 'synthetic-guide', kind: 'web', name: '合成讲义', url: 'https://example.com/guide' }],
  } }]).changes[0]!.id;
  const otherTaskId = seed([{ type: 'create', entity: 'task', values: { title: '无关任务', goalId: otherGoalId } }]).changes[0]!.id;
  const blockIds = [15, 16].map(day => seed([{ type: 'create', entity: 'block', values: { title: `原学习 ${day}`, kind: 'work', taskId,
    start: `2030-04-${day}T19:00:00+08:00`, end: `2030-04-${day}T20:00:00+08:00`, location: '原地点',
    reminders: { enabled: false, leadMinutes: null, dateOnlyTime: null },
  } }]).changes[0]!.id);
  const otherBlockId = seed([{ type: 'create', entity: 'block', values: { title: '无关目标时段', kind: 'work', taskId: otherTaskId,
    start: '2030-04-17T19:00:00+08:00', end: '2030-04-17T20:00:00+08:00',
  } }]).changes[0]!.id;
  const source = vi.fn(async (): Promise<PlanSource> => origin);
  const mutate = vi.fn(async (request: MutationRequestInput): Promise<MutationResult> => planner.mutate(MutationRequestSchema.parse(request)));
  const options = { directory, snapshot: async () => planner.snapshot(), mutate, source, scope: async () => 'synthetic:revision-boundaries' };
  const service = createPlanImportService(options);
  const plan = (): PlanFileInput => ({ format: 'ultimate-calendar-plan', version: 3, timezone: 'Asia/Shanghai', planId: 'boundary-revision', title: '合成修订计划',
    basis: buildPlanContext(planner.snapshot(), PlanExportRequestSchema.parse({ goalId, fromDate: '2030-04-15', toDate: '2030-04-21' }), origin).basis,
    updates: [{ id: 'rename-task', kind: 'task', targetId: taskId, expectedVersion: planner.snapshot().tasks.find(task => task.id === taskId)!.version, values: { title: '修订后的阅读任务' } }],
  });
  const deletions = () => [{ id: 'delete-task', kind: 'task' as const, targetId: taskId, expectedVersion: planner.snapshot().tasks.find(task => task.id === taskId)!.version },
    ...blockIds.map((id, index) => ({ id: `delete-block-${index}`, kind: 'block' as const, targetId: id, expectedVersion: planner.snapshot().blocks.find(block => block.id === id)!.version }))];
  return { repository, planner, seed, source, mutate, options, service, plan, deletions, goalId, otherGoalId, taskId, otherTaskId, blockIds, otherBlockId };
}

async function expectBlocked(f: ReturnType<typeof fixture>, plan: PlanFileInput, explanation?: RegExp) {
  const before = f.planner.snapshot();
  const preview = await f.service.preview(plan);
  expect(preview.rows.some(row => row.state === 'blocked')).toBe(true);
  if (explanation) expect(preview.rows.map(row => row.detail).join('\n')).toMatch(explanation);
  expect(await f.service.confirm({ token: preview.token, allowConflicts: true, allowDeletions: true })).toMatchObject({ status: 'partial', applied: 0 });
  expect(f.mutate).not.toHaveBeenCalled();
  expect(f.planner.snapshot()).toEqual(before);
}

describe('v3 revision boundaries against a real planner', () => {
  it('blocks a target version mismatch even with a fresh unchanged basis', async () => {
    const f = fixture(), plan = f.plan(); plan.updates![0]!.expectedVersion++;
    await expectBlocked(f, plan, /版本/);
  });

  it.each(['goal', 'task', 'block'] as const)('blocks a %s target belonging to another goal', async kind => {
    const f = fixture(), targetId = kind === 'goal' ? f.otherGoalId : kind === 'task' ? f.otherTaskId : f.otherBlockId;
    await expectBlocked(f, { ...f.plan(), updates: [{ id: 'foreign-target', kind, targetId, expectedVersion: 1, values: { title: '不应修改' } }] }, /不属于/);
  });

  it.each(['source', 'fingerprint', 'unavailable-source'] as const)('blocks %s without sending any mutation', async mismatch => {
    const f = fixture(), plan = f.plan();
    if (mismatch === 'source') f.source.mockResolvedValue({ ...origin, generation: 2 });
    if (mismatch === 'fingerprint') plan.basis!.fingerprint = '0'.repeat(64);
    if (mismatch === 'unavailable-source') f.source.mockRejectedValue(Error('synthetic source offline'));
    await expectBlocked(f, plan);
  });

  it.each(['update', 'delete'] as const)('blocks %s of an original block outside the exported date range', async action => {
    const f = fixture(), id = f.blockIds[0]!;
    f.seed([{ type: 'update', entity: 'block', id, expectedVersion: 1, values: { start: '2030-04-14T19:00:00+08:00', end: '2030-04-14T20:00:00+08:00' } }]);
    const plan = f.plan(); plan.updates = [];
    if (action === 'update') plan.updates = [{ id: 'out-of-range', kind: 'block', targetId: id, expectedVersion: 2, values: { title: '不应修改' } }];
    else plan.deletions = [{ id: 'out-of-range', kind: 'block', targetId: id, expectedVersion: 2 }];
    await expectBlocked(f, plan, /原时段.*范围/);
  });

  it.each(['move', 'new'] as const)('blocks an out-of-range %s time even if its task belongs to the selected goal', async operation => {
    const f = fixture(), plan = f.plan();
    if (operation === 'move') plan.updates = [{ id: 'move-outside', kind: 'block', targetId: f.blockIds[0]!, expectedVersion: 1,
      values: { start: '2030-04-22T19:00:00+08:00', end: '2030-04-22T20:00:00+08:00' } }];
    else plan.blocks = [{ id: 'outside-new', title: '不应新增', taskId: f.taskId, start: '2030-04-22T19:00:00+08:00', end: '2030-04-22T20:00:00+08:00' }];
    await expectBlocked(f, plan, /范围|规划日期/);
  });

  it.each(['recurrence', 'completed', 'cancelled'] as const)('protects a %s block from both update and explicit deletion', async flag => {
    const f = fixture(), id = f.blockIds[0]!;
    f.repository.writeInternal({ operationId: `synthetic-${flag}`, changes: [{ entity: 'block', id, expectedVersion: 1, values: {
      kind: 'event', ...(flag === 'recurrence' ? { recurrence: { seriesId: 'synthetic-series', occurrenceStart: '2030-04-15T19:00:00+08:00' } } : { [flag]: true }),
    } }] });
    await expectBlocked(f, { ...f.plan(), updates: [{ id: 'protected', kind: 'block', targetId: id, expectedVersion: 2, values: { title: '不应修改' } }] }, /重复|已完成|已取消/);
    await expectBlocked(f, { ...f.plan(), updates: [], deletions: [{ id: 'protected', kind: 'block', targetId: id, expectedVersion: 2 }] }, /重复|已完成|已取消/);
  });

  it('will not delete a task whose notification provenance would be changed implicitly', async () => {
    const f = fixture();
    f.repository.transact(state => {
      const source = newEntity(state, 'source', { kind: 'text', text: '合成通知：请阅读材料', sentAt: '2030-04-14T12:00:00+08:00', importedAt: '2030-04-14T12:00:00+08:00' });
      const candidate = newEntity(state, 'candidate', { title: '合成通知任务', action: '阅读材料', sourceIds: [source.id], sourceQuote: '请阅读材料', status: 'accepted', taskId: f.taskId });
      updateEntity(state, 'task', f.taskId, { candidateId: candidate.id });
    });
    await expectBlocked(f, { ...f.plan(), updates: [], deletions: f.deletions() }, /关联通知/);
  });

  it('will not delete a task unless every linked block is listed explicitly', async () => {
    const f = fixture();
    await expectBlocked(f, { ...f.plan(), updates: [], deletions: f.deletions().slice(0, 2) }, /全部关联时段/);
  });

  it('blocks new blocks referring to a task that this same file would delete', async () => {
    const f = fixture();
    await expectBlocked(f, { ...f.plan(), updates: [], deletions: f.deletions(), blocks: [{ id: 'dangling-block', title: '不能引用已删除任务', taskId: f.taskId,
      start: '2030-04-18T19:00:00+08:00', end: '2030-04-18T20:00:00+08:00',
    }] });
  });

  it('protects a completed task from explicit deletion', async () => {
    const f = fixture(); f.seed([{ type: 'finishTask', id: f.taskId, expectedVersion: 1, completed: true }]);
    await expectBlocked(f, { ...f.plan(), updates: [], deletions: f.deletions() }, /已完成任务/);
  });

  it('changes an explicit task title without resetting its completion, ownership, reminders, deadline or resources', async () => {
    const f = fixture(); f.seed([{ type: 'finishTask', id: f.taskId, expectedVersion: 1, completed: true }]);
    const before = f.planner.snapshot(), task = before.tasks.find(value => value.id === f.taskId)!;
    const preview = await f.service.preview(f.plan());
    expect(preview.rows).toMatchObject([{ state: 'update', action: 'update', existingId: f.taskId }]);
    const result = await f.service.confirm({ token: preview.token });
    expect(result, result.message).toMatchObject({ status: 'complete', applied: 1 });
    const after = f.planner.snapshot(), updated = after.tasks.find(value => value.id === f.taskId)!;
    expect(updated).toEqual({ ...task, title: '修订后的阅读任务', version: task.version + 1, updatedAt: updated.updatedAt });
    expect(after.goals).toEqual(before.goals); expect(after.blocks).toEqual(before.blocks);
    expect(after.tasks.find(value => value.id === f.otherTaskId)).toEqual(before.tasks.find(value => value.id === f.otherTaskId));
  });
});
