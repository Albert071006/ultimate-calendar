import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, newEntity, type Repository } from '../storage/repository';
import { createPlanner } from './planner';
import { resolveResources } from './resources';
import { recurringEventPatch } from './recurring-events';
import { ResourceReferenceSchema, type ResourceReference } from '../shared/resources';
import { TaskInputSchema, BlockInputSchema, type Block, type Task, type Course } from '../shared/contracts';

const local: ResourceReference = { id: 'fixture-file', name: '练习答案', kind: 'file', deviceId: 'fixture-desktop', deviceName: '学习电脑' };
const web: ResourceReference = { id: 'fixture-web', name: '课程教材', kind: 'web', url: 'https://example.com/course' };
const repositories: Repository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
const setup = () => { const repository = createRepository(':memory:'); repositories.push(repository); return { repository, planner: createPlanner(repository) }; };
const courseValues = { title: '示例英语', weekday: 1, startTime: '08:30', endTime: '10:00', firstWeek: 1, lastWeek: 16, termStart: '2026-08-31' };

describe('resource references and inheritance', () => {
  it('accepts existing records without resources and rejects paths, duplicate ids, credentials and non-web protocols', () => {
    expect(TaskInputSchema.parse({ title: '旧任务' }).resources).toBeUndefined();
    expect(BlockInputSchema.parse({ title: '旧活动', kind: 'event', start: '2026-11-02T18:00:00+08:00', end: null }).resources).toBeUndefined();
    expect(ResourceReferenceSchema.safeParse({ ...local, path: 'C:\\private\\answer.pdf' }).success).toBe(false);
    expect(ResourceReferenceSchema.safeParse({ ...local, name: 'C:\\private\\answer.pdf' }).success).toBe(false);
    for (const url of ['file:///C:/secret.txt', 'javascript:alert(1)', 'https://user:password@example.com']) expect(ResourceReferenceSchema.safeParse({ ...web, url }).success).toBe(false);
    expect(TaskInputSchema.safeParse({ title: '重复资料', resources: [local, local] }).success).toBe(false);
  });

  it('reads shared course/goal material dynamically, including same-course weekday rows, with correct owners and no duplicated references', () => {
    const { repository } = setup();
    const ids = repository.transact(state => {
      const course = newEntity(state, 'course', { ...courseValues, resources: [web] });
      const sibling = newEntity(state, 'course', { ...courseValues, weekday: 3 });
      newEntity(state, 'course', { ...courseValues, termStart: '2026-03-02', resources: [{ ...web, id: 'old-term' }] });
      const goal = newEntity(state, 'goal', { title: '阅读目标', resources: [{ ...web, id: 'goal-reference', name: '阅读资料', url: 'https://example.com/reading' }] });
      const task = newEntity(state, 'task', { title: '阅读练习', courseId: sibling.id, goalId: goal.id, resources: [local, web] });
      const block = newEntity(state, 'block', { title: '周三练习', kind: 'event', start: '2026-11-04T18:00:00+08:00', end: null, taskId: task.id, resources: [{ ...local, id: 'instance-file', name: '本次练习' }] });
      return { course, sibling, goal, task, block };
    });
    const resolved = resolveResources(repository.snapshot(), { entity: 'block', id: ids.block.id });
    expect(resolved.map(item => [item.resource.id, item.group])).toEqual([['instance-file', 'own'], ['fixture-file', 'task'], ['fixture-web', 'task'], ['goal-reference', 'shared']]);
    expect(resolved.at(-1)).toMatchObject({ owner: { entity: 'goal', id: ids.goal.id }, inherited: true });
    expect(resolveResources(repository.snapshot(), { entity: 'course', id: ids.sibling.id })).toEqual([
      expect.objectContaining({ resource: web, owner: { entity: 'course', id: ids.course.id }, group: 'shared', inherited: true }),
    ]);
    const course = ids.course as Course;
    const planner = createPlanner(repository);
    const change = planner.mutate({ operationId: 'rename-shared', origin: 'manual', confirmed: false, mutations: [{ type: 'update', entity: 'course', id: course.id, expectedVersion: course.version, scope: 'all', values: { resources: [{ ...web, name: '新版教材' }] } }] });
    if (change.status !== 'preview') throw Error('Expected shared course preview');
    planner.mutate({ operationId: 'rename-shared', origin: 'manual', mutations: [{ type: 'update', entity: 'course', id: course.id, expectedVersion: course.version, scope: 'all', values: { resources: [{ ...web, name: '新版教材' }] } }], confirmed: true, confirmationToken: change.confirmationToken });
    expect(resolveResources(repository.snapshot(), { entity: 'course', id: ids.sibling.id })[0]!.resource.name).toBe('新版教材');
    expect(repository.snapshot().blocks[0]!.resources).toHaveLength(1);
  });

  it('saves references in the existing versioned transaction and undo restores them without touching a file', () => {
    const { repository, planner } = setup();
    const task = repository.transact(state => newEntity(state, 'task', { title: '阅读练习', resources: [local] })) as Task;
    const result = planner.mutate({ operationId: 'unlink-resource', origin: 'manual', confirmed: false, mutations: [{ type: 'update', entity: 'task', id: task.id, expectedVersion: task.version, values: { resources: [] } }] });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw Error('Expected applied mutation');
    expect(planner.snapshot().tasks[0]!.resources).toEqual([]);
    expect(planner.undo(result.transactionId).status).toBe('applied');
    expect(planner.snapshot().tasks[0]!.resources).toEqual([local]);
  });

  it('supports only-this and following resource edits while unrelated recurring edits retain instance materials', () => {
    const { repository, planner } = setup();
    const blocks = repository.transact(state => [2, 9, 16].map(day => {
      const start = `2026-11-${String(day).padStart(2, '0')}T18:00:00+08:00`;
      return newEntity(state, 'block', { title: '值班', kind: 'event', start, end: null, recurrence: { seriesId: 'fixture-series', occurrenceStart: start }, resources: [{ ...local, id: `file-${day}` }] }) as Block;
    }));
    const apply = (operationId: string, index: number, values: object, scope: 'single' | 'this-and-following') => {
      const current = planner.snapshot().blocks.find(block => block.id === blocks[index]!.id)!;
      const request = { operationId, origin: 'manual' as const, confirmed: false, mutations: [{ type: 'updateRecurringEvent' as const, id: current.id, expectedVersion: current.version, scope, values }] };
      const preview = planner.mutate(request);
      if (preview.status !== 'preview') throw Error('Expected recurring preview');
      expect(planner.mutate({ ...request, confirmed: true, confirmationToken: preview.confirmationToken }).status).toBe('applied');
    };
    apply('only-second', 1, { resources: [web] }, 'single');
    expect(planner.snapshot().blocks.map(block => block.resources?.[0]?.id)).toEqual(['file-2', 'fixture-web', 'file-16']);
    apply('rename-series', 0, { title: '晚间值班' }, 'this-and-following');
    expect(planner.snapshot().blocks.map(block => block.resources?.[0]?.id)).toEqual(['file-2', 'fixture-web', 'file-16']);
    apply('following-files', 1, { resources: [local] }, 'this-and-following');
    expect(planner.snapshot().blocks.map(block => block.resources?.map(resource => resource.id))).toEqual([['file-2'], ['fixture-file'], ['file-16', 'fixture-file']]);
    const latest = planner.snapshot().blocks;
    const anchor = latest[1]!;
    const later = { ...latest[2]!, resources: [{ ...local, id: 'personal-note', name: '本次笔记' }] };
    const append = { type: 'updateRecurringEvent' as const, id: anchor.id, expectedVersion: anchor.version, scope: 'this-and-following' as const, resourceMode: 'append' as const, values: { resources: [local] } };
    expect(recurringEventPatch(anchor, anchor, append).resources).toEqual([local]);
    expect(recurringEventPatch(later, anchor, append).resources?.map(resource => resource.id)).toEqual(['personal-note', 'fixture-file']);
  });
});
