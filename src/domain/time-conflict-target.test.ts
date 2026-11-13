import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, type Repository } from '../storage/repository';
import { MutationRequestSchema, type MutationInput, type MutationResult } from '../shared/contracts';
import { createPlanner } from './planner';

const repos: Repository[] = [];
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });
const at = (clock: string) => `2031-04-18T${clock}:00+08:00`;
function fixture() {
  const repo = createRepository(':memory:'); repos.push(repo);
  const planner = createPlanner(repo, { automaticBackup: () => {} }); let sequence = 0;
  const seed = (title: string, start: string, end: string, linked = false) => {
    const task = linked ? repo.writeInternal({ operationId: `task-${++sequence}`, changes: [{ entity: 'task', values: { title: `${title}对应任务` } }] }).entities[0]! : null;
    const block = repo.writeInternal({ operationId: `block-${++sequence}`, changes: [{ entity: 'block', values: {
      title, kind: 'event', taskId: task?.id ?? null, start: at(start), end: at(end),
    } }] }).entities[0]!;
    return { block, task };
  };
  const mutate = (...mutations: MutationInput[]) => planner.mutate(MutationRequestSchema.parse({ operationId: `change-${++sequence}`, origin: 'manual', mutations }));
  return { repo, planner, seed, mutate };
}
function preview(value: MutationResult) { if (value.status !== 'preview') throw Error(`Expected preview, got ${value.status}`); return value; }
const create = (title: string, start: string, end: string): MutationInput => ({ type: 'create', entity: 'block', values: {
  title, kind: 'event', start: at(start), end: at(end),
} });

describe('time conflict counterparts relative to the pending patch', () => {
  it.each([
    { start: '13:30', end: '14:30', linked: false }, { start: '14:30', end: '15:30', linked: false },
    { start: '13:30', end: '14:30', linked: true }, { start: '14:30', end: '15:30', linked: true },
  ])('points to the existing calendar item when the new event starts at $start, task linked=$linked', ({ start, end, linked }) => {
    const f = fixture(), existing = f.seed('已有安排', '14:00', '15:00', linked);
    const value = preview(f.mutate(create('新增活动', start, end)));
    const added = value.details.find(detail => detail.entity === 'block' && !detail.before)!;
    expect(value.conflicts).toMatchObject([{ kind: 'time', entity: 'block', id: added.id, conflictingIds: [existing.block.id] }]);
    expect(value.conflicts[0]!.conflictingIds).not.toContain(added.id);
    if (existing.task) expect(value.conflicts[0]!.conflictingIds).not.toContain(existing.task.id);
    expect(f.planner.snapshot().blocks).toHaveLength(1);
  });

  it('still selects the new activity when the same patch edits its existing counterpart', () => {
    const f = fixture(), existing = f.seed('已有安排', '14:00', '15:00');
    const value = preview(f.mutate(
      { type: 'update', entity: 'block', id: existing.block.id, expectedVersion: existing.block.version, values: { title: '已有安排的新名称' } },
      create('新增活动', '14:30', '15:30'),
    ));
    const added = value.details.find(detail => detail.entity === 'block' && !detail.before)!;
    expect(value.conflicts).toMatchObject([{ id: added.id, conflictingIds: [existing.block.id] }]);
  });

  it('uses calendar block IDs when accepting a notice creates both a task and its linked activity', () => {
    const f = fixture(), existing = f.seed('已有安排', '14:00', '15:00');
    const source = f.repo.writeInternal({ operationId: 'notice-source', changes: [{ entity: 'source', values: {
      kind: 'text', text: '请参加合成讲座', importedAt: at('12:00'), sentAt: at('12:00'),
    } }] }).entities[0]!;
    const candidate = f.repo.writeInternal({ operationId: 'notice', changes: [{ entity: 'candidate', values: {
      title: '参加合成讲座', sourceIds: [source.id], sourceQuote: '请参加合成讲座', eventStart: at('14:30'), eventEnd: at('15:30'),
    } }] }).entities[0]!;
    const value = preview(f.mutate({ type: 'acceptCandidate', id: candidate.id, expectedVersion: candidate.version }));
    const block = value.details.find(detail => detail.entity === 'block' && !detail.before)!;
    const task = value.details.find(detail => detail.entity === 'task' && !detail.before)!;
    expect(block).toBeDefined(); expect(task).toBeDefined();
    expect(value.conflicts).toMatchObject([{ entity: 'block', id: block.id, conflictingIds: [existing.block.id] }]);
    expect(value.conflicts[0]!.conflictingIds).not.toContain(task.id);
  });

  it('keeps one conflict between two new activities instead of requiring an unchanged counterpart', () => {
    const f = fixture(), value = preview(f.mutate(create('新增甲', '14:00', '15:00'), create('新增乙', '14:30', '15:30')));
    expect(value.conflicts).toHaveLength(1);
    const conflict = value.conflicts[0]!;
    expect(new Set([conflict.id, ...conflict.conflictingIds])).toEqual(new Set(value.details.filter(detail => detail.entity === 'block').map(detail => detail.id)));
    expect(conflict.conflictingIds).not.toContain(conflict.id);
  });

  it('does not report an unrelated old overlap but retains it when one participant is edited', () => {
    const f = fixture(), earlier = f.seed('已有甲', '14:00', '15:00'), later = f.seed('已有乙', '14:30', '15:30');
    expect(f.mutate(create('无关新增', '17:00', '18:00'))).toMatchObject({ status: 'applied', conflicts: [] });
    const value = preview(f.mutate({ type: 'update', entity: 'block', id: later.block.id, expectedVersion: later.block.version, values: { title: '修改乙的名称' } }));
    expect(value.conflicts).toMatchObject([{ id: later.block.id, conflictingIds: [earlier.block.id] }]);
  });

  it('keeps a conflict between two edited existing activities', () => {
    const f = fixture(), earlier = f.seed('已有甲', '14:00', '15:00'), later = f.seed('已有乙', '16:00', '17:00');
    const value = preview(f.mutate(
      { type: 'update', entity: 'block', id: earlier.block.id, expectedVersion: earlier.block.version, values: { end: at('16:30') } },
      { type: 'update', entity: 'block', id: later.block.id, expectedVersion: later.block.version, values: { title: '修改乙的名称' } },
    ));
    expect(value.conflicts).toHaveLength(1);
    expect(new Set([value.conflicts[0]!.id, ...value.conflicts[0]!.conflictingIds])).toEqual(new Set([earlier.block.id, later.block.id]));
  });

  it('identifies an existing lesson as the counterpart of a new later event', () => {
    const f = fixture();
    const course = f.repo.writeInternal({ operationId: 'course', changes: [{ entity: 'course', values: {
      title: '合成阅读课', weekday: 5, startTime: '14:00', endTime: '15:00', firstWeek: 1, lastWeek: 1, termStart: '2031-04-14',
    } }] }).entities[0]!;
    const value = preview(f.mutate(create('新增活动', '14:30', '15:30'))), added = value.details.find(detail => detail.entity === 'block')!;
    expect(value.conflicts).toMatchObject([{ entity: 'block', id: added.id, conflictingIds: [course.id] }]);
  });
});
