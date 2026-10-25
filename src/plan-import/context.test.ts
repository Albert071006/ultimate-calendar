import { describe, expect, it } from 'vitest';
import { BlockSchema, CourseExceptionSchema, CourseSchema, GoalSchema, SnapshotSchema, SourceSchema, TaskSchema, type Snapshot } from '../shared/contracts';
import { PlanExportRequestSchema, type PlanSource } from '../shared/plan-context';
import { buildPlanContext, planContextFingerprint } from './context';

const at = '2026-11-01T08:00:00+08:00';
const meta = (id: string) => ({ id, version: 1, createdAt: at, updatedAt: at });
const source: PlanSource = { kind: 'cloud', dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 };
const request = PlanExportRequestSchema.parse({ goalId: 'goal-selected', fromDate: '2026-11-02', toDate: '2026-11-02' });
function fixture(): Snapshot {
  return SnapshotSchema.parse({ schemaVersion: 1, goals: [GoalSchema.parse({ ...meta('goal-selected'), title: '合成目标', resources: [{ id: 'goal-web', kind: 'web', name: '目标资料', url: 'https://example.com/goal' }] }), GoalSchema.parse({ ...meta('goal-unrelated'), title: 'PRIVATE_OTHER_GOAL' })],
    tasks: [TaskSchema.parse({ ...meta('task-selected'), title: '合成学习任务', goalId: 'goal-selected', courseId: 'course-linked', candidateId: 'PRIVATE_SOURCE_LINK' }), TaskSchema.parse({ ...meta('task-unrelated'), title: 'PRIVATE_OTHER_TASK', description: 'PRIVATE_OTHER_TEXT', goalId: 'goal-unrelated' })],
    blocks: [BlockSchema.parse({ ...meta('block-selected'), title: '合成学习时段', kind: 'work', taskId: 'task-selected', candidateId: 'PRIVATE_SOURCE_LINK', start: '2026-11-02T19:00:00+08:00', end: '2026-11-02T20:00:00+08:00' }), BlockSchema.parse({ ...meta('block-unrelated'), title: 'PRIVATE_BUSY_TITLE', kind: 'event', start: '2026-11-02T22:00:00+08:00', end: null })],
    courses: [CourseSchema.parse({ ...meta('course-linked'), title: '合成课程', weekday: 1, startTime: '09:00', endTime: '10:00', firstWeek: 1, lastWeek: 1, termStart: '2026-11-02', resources: [{ id: 'course-web', kind: 'web', name: '课程资料', url: 'https://example.com/course' }] }), CourseSchema.parse({ ...meta('course-sibling'), title: '合成课程', weekday: 2, startTime: '09:00', endTime: '10:00', firstWeek: 1, lastWeek: 1, termStart: '2026-11-02', resources: [{ id: 'sibling-web', kind: 'web', name: '同课程资料', url: 'https://example.com/sibling' }] })],
    sources: [SourceSchema.parse({ ...meta('source-private'), importedAt: at, kind: 'text', text: 'PRIVATE_QQ_RAW_TEXT' })], candidates: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
}
const fingerprint = (snapshot: Snapshot) => planContextFingerprint(snapshot, request.goalId, request.fromDate, request.toDate);

describe('goal planning context export', () => {
  it('exports only selected planning records and resolves inherited course/goal resources', () => {
    const context = buildPlanContext(fixture(), request, source), serialized = JSON.stringify(context);
    expect(context.tasks).toHaveLength(1); expect(context.blocks).toHaveLength(1);
    expect(serialized).not.toContain('PRIVATE_'); expect(serialized).not.toContain('candidateId');
    expect(context.resourceLinks.filter(link => link.target.entity === 'block').map(link => link.resource.id)).toEqual(expect.arrayContaining(['goal-web', 'course-web', 'sibling-web']));
    expect(context.resourceLinks.some(link => link.owner.id === 'course-sibling' && link.inherited)).toBe(true);
    expect(context.busyIntervals.filter(interval => interval.selectedPlan)).toHaveLength(1);
    expect(context.busyIntervals.find(interval => interval.selectedPlan)?.title).toBe('合成学习时段');
    expect(context.busyIntervals.find(interval => interval.start === '2026-11-02T22:00:00+08:00')).toMatchObject({ end: '2026-11-02T22:30:00+08:00', selectedPlan: false });
    expect(context.basis.source).toEqual(source); expect(context.instructions.join(' ')).toContain('version 为 2');
  });

  it('clips confirmed occupancy and honors moved/cancelled courses, without adding deadlines or cancelled blocks', () => {
    const snapshot = fixture();
    snapshot.blocks.push(BlockSchema.parse({ ...meta('cross-day'), title: '跨日事项', kind: 'event', start: '2026-11-01T23:00:00+08:00', end: '2026-11-03T01:00:00+08:00' }));
    snapshot.blocks.push(BlockSchema.parse({ ...meta('cancelled'), title: '取消事项', kind: 'event', cancelled: true, start: '2026-11-02T11:00:00+08:00', end: '2026-11-02T12:00:00+08:00' }));
    snapshot.tasks[0]!.deadline = { date: '2026-11-02', time: '12:30' };
    snapshot.courseExceptions.push(CourseExceptionSchema.parse({ ...meta('move-course'), courseId: 'course-linked', originalDate: '2026-11-02', cancelled: false, replacement: { title: '合成调课', start: '2026-11-02T13:00:00+08:00', end: '2026-11-02T14:00:00+08:00', location: '' } }));
    const context = buildPlanContext(snapshot, { ...request, includeBusyTitles: true }, source);
    expect(context.busyIntervals.find(interval => interval.title === '跨日事项')).toMatchObject({ start: '2026-11-02T00:00:00+08:00', end: '2026-11-03T00:00:00+08:00' });
    expect(context.busyIntervals.find(interval => interval.category === 'course')).toMatchObject({ title: '合成调课', start: '2026-11-02T13:00:00+08:00' });
    expect(context.busyIntervals.some(interval => interval.title === '取消事项')).toBe(false);
    expect(context.busyIntervals.some(interval => interval.start === '2026-11-02T12:30:00+08:00')).toBe(false);
    snapshot.courseExceptions[0]!.replacement = null; snapshot.courseExceptions[0]!.cancelled = true;
    expect(buildPlanContext(snapshot, request, source).busyIntervals.some(interval => interval.category === 'course')).toBe(false);
  });

  it('has a stable fingerprint independent of presentation, source text and collection ordering', () => {
    const snapshot = fixture(), original = fingerprint(snapshot);
    const context = buildPlanContext(snapshot, { ...request, includeBusyTitles: true, instructions: '另一个要求' }, source);
    expect(context.basis.fingerprint).toBe(original);
    snapshot.tasks.reverse(); snapshot.blocks.reverse(); snapshot.courses.reverse(); snapshot.goals.reverse();
    snapshot.sources[0]!.text = 'DIFFERENT_PRIVATE_RAW';
    expect(fingerprint(snapshot)).toBe(original);
  });

  it('invalidates on completion, cancellation, movement, related resource changes and new busy occupancy', () => {
    const initial = fixture(), original = fingerprint(initial);
    const done = structuredClone(initial); done.tasks[0]!.status = 'done'; expect(fingerprint(done)).not.toBe(original);
    const moved = structuredClone(initial); moved.blocks[0]!.start = '2026-11-02T20:00:00+08:00'; moved.blocks[0]!.end = '2026-11-02T21:00:00+08:00'; expect(fingerprint(moved)).not.toBe(original);
    const removed = structuredClone(initial); removed.blocks.shift(); expect(fingerprint(removed)).not.toBe(original);
    const cancelled = structuredClone(initial); cancelled.blocks[1]!.cancelled = true; expect(fingerprint(cancelled)).not.toBe(original);
    const resources = structuredClone(initial); resources.courses[1]!.resources![0]!.name = '新版资料'; expect(fingerprint(resources)).not.toBe(original);
    const added = structuredClone(initial); added.blocks.push(BlockSchema.parse({ ...meta('new-busy'), title: '新增事项', kind: 'work', start: '2026-11-02T15:00:00+08:00', end: '2026-11-02T16:00:00+08:00' })); expect(fingerprint(added)).not.toBe(original);
  });
});
