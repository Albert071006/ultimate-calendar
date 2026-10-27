import { describe, expect, it } from 'vitest';
import { PLAN_FILE_EXAMPLE, PlanFileSchema, PlanFileV3Schema, PlanImportConfirmSchema, type PlanFileInput } from './plan-import';

describe('plan file v1 boundary', () => {
  it('supports a task-only file and the linked example with explicit defaults', () => {
    expect(PlanFileSchema.parse(PLAN_FILE_EXAMPLE).blocks[0]?.kind).toBe('work');
    const plan = PlanFileSchema.parse({ format: 'ultimate-calendar-plan', version: 1, timezone: 'Asia/Shanghai', planId: 'plan-one', title: '计划', tasks: [{ id: 't1', title: '任务' }] });
    expect(plan.tasks[0]).toMatchObject({ deadline: null, status: 'open', resourceRefs: [] });
  });
  it('rejects wrong versions, unknown fields and executable resources', () => {
    for (const extra of [{ version: 2 }, { timezone: 'UTC' }, { confirmed: true }, { path: 'C:/private.txt' }, { resources: [{ id: 'r', name: '资源', kind: 'web', url: 'javascript:alert(1)' }] }])
      expect(PlanFileSchema.safeParse({ ...PLAN_FILE_EXAMPLE, ...extra }).success).toBe(false);
  });
  it('rejects duplicate keys, missing relations and conflicting reference forms', () => {
    const plan = PlanFileSchema.parse(PLAN_FILE_EXAMPLE);
    for (const changed of [
      { tasks: [plan.tasks[0], plan.tasks[0]] },
      { tasks: [{ ...plan.tasks[0], goalRef: 'missing' }] },
      { tasks: [{ ...plan.tasks[0], goalId: 'existing-goal' }] },
      { blocks: [{ ...plan.blocks[0], taskRef: 'missing' }] },
      { goals: [{ ...plan.goals[0], resourceRefs: ['missing'] }] },
    ]) expect(PlanFileSchema.safeParse({ ...plan, ...changed }).success).toBe(false);
  });
  it('rejects non-real dates, wrong zones, missing end and reversed intervals', () => {
    for (const change of [{ start: '2026-02-30T19:00:00+08:00' }, { start: '2026-11-02T19:00:00Z' }, { end: null }, { end: '2026-11-02T18:00:00+08:00' }])
      expect(PlanFileSchema.safeParse({ ...PLAN_FILE_EXAMPLE, blocks: [{ ...PLAN_FILE_EXAMPLE.blocks![0], ...change }] }).success).toBe(false);
  });
  it('bounds total records and individual resource references', () => {
    expect(PlanFileSchema.safeParse({ ...PLAN_FILE_EXAMPLE, tasks: Array.from({ length: 500 }, (_, i) => ({ id: `t${i}`, title: '任务' })) }).success).toBe(false);
    expect(PlanFileSchema.safeParse({ ...PLAN_FILE_EXAMPLE, goals: [], tasks: [], blocks: [] }).success).toBe(false);
  });
});

const basis = { source: { kind: 'local' as const, dataInstanceId: '11111111-1111-4111-8111-111111111111' },
  goalId: 'original-goal', fromDate: '2030-04-15', toDate: '2030-04-21', exportedAt: '2030-04-14T12:00:00+08:00', fingerprint: 'a'.repeat(64) };
const revision = (): PlanFileInput => ({ format: 'ultimate-calendar-plan', version: 3, timezone: 'Asia/Shanghai', planId: 'revision-one', title: '调整本周计划', basis,
  updates: [{ id: 'rename', kind: 'task', targetId: 'original-task', expectedVersion: 2, values: { title: '阅读并写摘要' } }],
});

describe('plan file v3 explicit revisions', () => {
  it('supports modification-only and deletion-only files, with real target versions', () => {
    expect(PlanFileV3Schema.parse(revision()).updates![0]).toEqual({ id: 'rename', kind: 'task', targetId: 'original-task', expectedVersion: 2, values: { title: '阅读并写摘要' } });
    const onlyDelete = { ...revision(), updates: undefined, deletions: [{ id: 'delete-time', kind: 'block', targetId: 'original-block', expectedVersion: 4 }] };
    expect(PlanFileSchema.parse(onlyDelete).deletions).toHaveLength(1);
    expect(PlanImportConfirmSchema.parse({ token: 'preview' })).toMatchObject({ allowDeletions: false });
  });

  it('does not default omitted patch fields or add v3 fields to a legacy receipt input', () => {
    const old = PlanFileSchema.parse(PLAN_FILE_EXAMPLE);
    expect(old).not.toHaveProperty('updates'); expect(old).not.toHaveProperty('deletions');
    expect(old.tasks[0]).not.toHaveProperty('scheduleMode');
    for (const kind of ['goal', 'task', 'block'] as const) {
      const parsed = PlanFileSchema.parse({ ...revision(), updates: [{ id: 'rename', kind, targetId: 'original-record', expectedVersion: 1, values: { title: '新标题' } }] });
      expect(parsed.updates![0]!.values).toEqual({ title: '新标题' });
    }
    expect(PlanFileSchema.parse({ ...revision(), updates: [{ id: 'date', kind: 'task', targetId: 'original-task', expectedVersion: 1, values: { deadline: null, resourceRefs: [] } }] }).updates![0]!.values)
      .toEqual({ deadline: null, resourceRefs: [] });
    expect(PlanFileSchema.parse({ ...revision(), updates: [{ id: 'mode', kind: 'task', targetId: 'original-task', expectedVersion: 1, values: { scheduleMode: 'multiple' } }] }).updates![0]!.values)
      .toEqual({ scheduleMode: 'multiple' });
  });

  it('rejects v3 fields in v1/v2 and requires an unchanged-context envelope for v3', () => {
    for (const version of [1, 2]) {
      expect(PlanFileSchema.safeParse({ ...PLAN_FILE_EXAMPLE, version, ...(version === 2 ? { basis } : {}), updates: [] }).success).toBe(false);
      expect(PlanFileSchema.safeParse({ ...PLAN_FILE_EXAMPLE, version, ...(version === 2 ? { basis } : {}), deletions: [] }).success).toBe(false);
    }
    expect(PlanFileSchema.safeParse({ ...revision(), basis: undefined }).success).toBe(false);
    expect(PlanFileSchema.safeParse({ ...revision(), goals: [{ id: 'copy', title: '复制目标' }] }).success).toBe(false);
  });

  it('protects ownership/completion fields, forbids empty patches and requires explicit reminder replacements', () => {
    for (const values of [{}, { status: 'open' }, { goalId: 'other-goal' }, { courseId: null }, { reminders: { leadMinutes: [5] } }])
      expect(PlanFileSchema.safeParse({ ...revision(), updates: [{ id: 'change', kind: 'task', targetId: 'original-task', expectedVersion: 1, values }] }).success).toBe(false);
    for (const values of [{ completed: false }, { cancelled: false }, { taskId: 'other-task' }, { kind: 'event' }, { recurrence: null }, { end: null }])
      expect(PlanFileSchema.safeParse({ ...revision(), updates: [{ id: 'change', kind: 'block', targetId: 'original-block', expectedVersion: 1, values }] }).success).toBe(false);
    expect(PlanFileSchema.safeParse({ ...revision(), updates: [{ id: 'change', kind: 'task', targetId: 'original-task', expectedVersion: 0, values: { title: '标题' } }] }).success).toBe(false);
    expect(PlanFileSchema.safeParse({ ...revision(), deletions: [{ id: 'delete-goal', kind: 'goal', targetId: 'original-goal', expectedVersion: 1 }] }).success).toBe(false);
    const reminders = { enabled: false, leadMinutes: null, dateOnlyTime: null };
    expect(PlanFileSchema.parse({ ...revision(), updates: [{ id: 'remind', kind: 'task', targetId: 'original-task', expectedVersion: 1, values: { reminders } }] }).updates![0]!.values).toEqual({ reminders });
  });

  it('rejects repeated update/delete targets, duplicate row identifiers and broken resource references', () => {
    const update = revision().updates![0]!;
    for (const extra of [
      { updates: [update, { ...update, id: 'again' }] },
      { updates: [update, { ...update, targetId: 'different-task' }] },
      { deletions: [{ id: 'delete-task', kind: 'task', targetId: update.targetId, expectedVersion: 2 }] },
      { updates: [{ ...update, values: { resourceRefs: ['missing'] } }] },
      { resources: [{ id: 'guide', kind: 'web', name: '讲义', url: 'https://example.com/guide' }], updates: [{ ...update, values: { resourceRefs: ['guide', 'guide'] } }] },
    ]) expect(PlanFileSchema.safeParse({ ...revision(), ...extra }).success).toBe(false);
  });

  it('counts modifications and deletions toward the same 500-row limit', () => {
    const updates = Array.from({ length: 500 }, (_, i) => ({ id: `update-${i}`, kind: 'task' as const, targetId: `task-${i}`, expectedVersion: 1, values: { title: `修改 ${i}` } }));
    expect(PlanFileSchema.safeParse({ ...revision(), updates }).success).toBe(true);
    expect(PlanFileSchema.safeParse({ ...revision(), updates, tasks: [{ id: 'new-task', title: '额外新增', goalId: basis.goalId }] }).success).toBe(false);
    expect(PlanFileSchema.safeParse({ ...revision(), updates: [] }).success).toBe(false);
  });
});
