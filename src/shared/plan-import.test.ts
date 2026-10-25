import { describe, expect, it } from 'vitest';
import { PLAN_FILE_EXAMPLE, PlanFileSchema } from './plan-import';

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
