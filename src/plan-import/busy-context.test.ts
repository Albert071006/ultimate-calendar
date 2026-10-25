import { describe, expect, it } from 'vitest';
import { emptyState, newEntity, stateSnapshot } from '../storage/repository';
import { BusyContextSchema, BusyExportRequestSchema } from '../shared/busy-context';
import type { PlanSource } from '../shared/plan-context';
import { buildBusyContext, busyContextFingerprint } from './busy-context';

const source: PlanSource = { kind: 'local', dataInstanceId: '44444444-4444-4444-8444-444444444444' };
const request = BusyExportRequestSchema.parse({ fromDate: '2026-11-02', toDate: '2026-11-02' });
function fixture() {
  const state = emptyState();
  newEntity(state, 'goal', { title: 'PRIVATE_GOAL', description: 'PRIVATE_GOAL_DESCRIPTION', resources: [{ id: 'private-resource', kind: 'web', name: 'PRIVATE_RESOURCE', url: 'https://example.com/private-resource' }] });
  newEntity(state, 'task', { title: 'PRIVATE_TASK', description: 'PRIVATE_TASK_DESCRIPTION', deadline: { date: '2026-11-02', time: '12:00' } });
  newEntity(state, 'source', { importedAt: '2026-11-01T08:00:00+08:00', kind: 'text', text: 'PRIVATE_QQ_RAW_TEXT' });
  newEntity(state, 'block', { title: 'PRIVATE_WORK_TITLE', kind: 'work', start: '2026-11-02T10:00:00+08:00', end: '2026-11-02T11:00:00+08:00' });
  newEntity(state, 'block', { title: 'PRIVATE_EVENT_TITLE', kind: 'event', start: '2026-11-02T23:50:00+08:00', end: null });
  newEntity(state, 'block', { title: 'PRIVATE_CANCELLED_TITLE', kind: 'event', cancelled: true, start: '2026-11-02T15:00:00+08:00', end: '2026-11-02T16:00:00+08:00' });
  const course = newEntity(state, 'course', { title: 'PRIVATE_COURSE_TITLE', weekday: 1, startTime: '09:00', endTime: '10:00', firstWeek: 1, lastWeek: 1, termStart: '2026-11-02' });
  newEntity(state, 'courseException', { courseId: course.id, originalDate: '2026-11-02', cancelled: false, replacement: { title: 'PRIVATE_MOVED_COURSE_TITLE', start: '2026-11-02T13:00:00+08:00', end: '2026-11-02T14:00:00+08:00', location: '' } });
  return { state, snapshot: stateSnapshot(state) };
}

describe('standalone busy time context', () => {
  it('exports only anonymous confirmed intervals by default and guides full new-goal plans through v1', () => {
    const { snapshot } = fixture(), before = JSON.stringify(snapshot), context = buildBusyContext(snapshot, request, source);
    expect(BusyContextSchema.safeParse(context).success).toBe(true); expect(context.busyIntervals).toHaveLength(3);
    expect(JSON.stringify(context)).not.toContain('PRIVATE_');
    expect(context).not.toHaveProperty('tasks'); expect(context).not.toHaveProperty('goals'); expect(context).not.toHaveProperty('resources'); expect(context).not.toHaveProperty('basis');
    expect(context.instructions.join(' ')).toContain('version 为 1'); expect(context.instructions.join(' ')).toContain('goalRef'); expect(context.instructions.join(' ')).toContain('taskRef');
    expect(context.instructions.join(' ')).toContain('不提供目标上下文的自动基线保护'); expect(JSON.stringify(snapshot)).toBe(before);
  });

  it('honors moved/cancelled courses, cross-boundary clipping and default event duration', () => {
    const { snapshot } = fixture();
    const wide = structuredClone(snapshot.blocks[0]!); wide.id = 'synthetic-cross-boundary'; wide.title = '跨界事项'; wide.start = '2026-11-01T23:00:00+08:00'; wide.end = '2026-11-03T01:00:00+08:00'; snapshot.blocks.push(wide);
    const context = buildBusyContext(snapshot, { ...request, includeBusyTitles: true }, source);
    expect(context.busyIntervals.find(interval => interval.title === '跨界事项')).toMatchObject({ start: '2026-11-02T00:00:00+08:00', end: '2026-11-03T00:00:00+08:00' });
    expect(context.busyIntervals.find(interval => interval.category === 'course')).toMatchObject({ start: '2026-11-02T13:00:00+08:00', end: '2026-11-02T14:00:00+08:00' });
    expect(context.busyIntervals.find(interval => interval.title === 'PRIVATE_EVENT_TITLE')?.end).toBe('2026-11-03T00:00:00+08:00');
    expect(context.busyIntervals.some(interval => interval.title === 'PRIVATE_CANCELLED_TITLE')).toBe(false);
    expect(context.busyIntervals.some(interval => interval.start === '2026-11-02T12:00:00+08:00')).toBe(false);
    snapshot.courseExceptions[0]!.cancelled = true; snapshot.courseExceptions[0]!.replacement = null;
    expect(buildBusyContext(snapshot, request, source).busyIntervals.some(interval => interval.category === 'course')).toBe(false);
  });

  it('fingerprints in-range occupancy independently of unrelated planning text and collection order', () => {
    const { snapshot } = fixture(), original = busyContextFingerprint(snapshot, request);
    snapshot.blocks.reverse(); snapshot.courses.reverse(); snapshot.tasks[0]!.description = 'OTHER_PRIVATE_TEXT'; snapshot.sources[0]!.text = 'OTHER_PRIVATE_SOURCE';
    expect(busyContextFingerprint(snapshot, { ...request, instructions: '换一个规划要求' })).toBe(original);
    const block = snapshot.blocks.find(value => value.kind === 'work')!; block.start = '2026-11-02T10:30:00+08:00';
    expect(busyContextFingerprint(snapshot, request)).not.toBe(original);
  });

  it('supports an empty calendar without any goal and states its exact coverage', () => {
    const context = buildBusyContext(stateSnapshot(emptyState()), request, source);
    expect(context.busyIntervals).toEqual([]); expect(context.coverage).toContain('共 0 个已确认忙碌区间'); expect(context.coverage).toContain('2026-11-02');
    expect(() => buildBusyContext(stateSnapshot(emptyState()), { ...request, toDate: '2026-11-01' }, source)).toThrow();
  });
});
