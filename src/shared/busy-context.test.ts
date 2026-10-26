import { describe, expect, it } from 'vitest';
import { BusyContextSchema, BusyExportRequestSchema } from './busy-context';
import { PLAN_FILE_EXAMPLE, PlanFileSchema } from './plan-import';

describe('standalone busy planning handoff', () => {
  it('requires no goal and accepts up to 366 inclusive days with hidden titles by default', () => {
    expect(BusyExportRequestSchema.parse({ fromDate: '2028-01-01', toDate: '2028-12-31' })).toEqual({ fromDate: '2028-01-01', toDate: '2028-12-31', includeBusyTitles: false, instructions: '' });
    for (const range of [{ fromDate: '2028-01-01', toDate: '2029-01-01' }, { fromDate: '2028-01-02', toDate: '2028-01-01' }, { fromDate: '2028-02-30', toDate: '2028-03-01' }]) expect(BusyExportRequestSchema.safeParse(range).success).toBe(false);
  });
  it('keeps the busy context distinct from a whole-goal import', () => {
    const busy = BusyContextSchema.parse({ format: 'ultimate-calendar-busy', version: 1, timezone: 'Asia/Shanghai', source: { kind: 'local', dataInstanceId: '11111111-1111-4111-8111-111111111111' }, fromDate: '2030-04-15', toDate: '2030-04-21', exportedAt: '2030-04-15T08:00:00+08:00', request: '', instructions: [], busyIntervals: [], coverage: '已读取指定范围' });
    expect(PlanFileSchema.safeParse(busy).success).toBe(false);
    const full = PlanFileSchema.parse(PLAN_FILE_EXAMPLE);
    expect(full.goals.length).toBeGreaterThan(0); expect(full.tasks[0]?.goalRef).toBe(full.goals[0]?.id); expect(full.blocks[0]?.taskRef).toBe(full.tasks[0]?.id);
    expect(BusyContextSchema.safeParse({ ...busy, tasks: full.tasks }).success).toBe(false);
  });
});
