import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, newEntity, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createController } from './controller';
import type { ResourceReference } from '../shared/resources';
import type { Task, Block } from '../shared/contracts';

const repositories: Repository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
const local: ResourceReference = { id: 'sample-answer', name: '阅读答案.pdf', kind: 'file', deviceId: 'sample-pc', deviceName: '学习电脑' };
const web: ResourceReference = { id: 'sample-course', name: '听力网址', kind: 'web', url: 'https://example.com/listening' };
const now = '2026-10-25T18:00:00+08:00';
const response = (value: unknown) => new Response(JSON.stringify({ id: 'synthetic-resource', choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }), { status: 200 });
function setup(model: (messages: { role: string; content: string }[]) => unknown) {
  const repository = createRepository(':memory:'); repositories.push(repository);
  const planner = createPlanner(repository);
  const controller = createController({ repository, planner, now: () => now, getApiKey: async () => 'synthetic-key',
    fetch: async (_url, init) => response(model(JSON.parse(String(init?.body)).messages)) });
  const task = repository.transact(state => newEntity(state, 'task', { title: '周六阅读练习', resources: [web] })) as Task;
  return { repository, planner, controller, task };
}

describe('natural-language resource commands', () => {
  it('attaches selected metadata to an existing task without duplicating its original resources, and replays once', async () => {
    let calls = 0;
    const fixture = setup(messages => {
      calls++;
      const { context } = JSON.parse(messages.at(-1)!.content);
      expect(context.attachedResources).toEqual([local]);
      expect(messages[0]!.content).toContain('kind=resource_attach');
      expect(JSON.stringify(messages)).not.toContain('C:\\');
      return { kind: 'resource_attach', reply: '关联到周六阅读练习', target: { entity: 'task', id: fixture.task.id }, expectedVersion: fixture.task.version, resourceIds: [local.id] };
    });
    const request = { operationId: 'attach-answer', text: '把这个文件关联到周六阅读练习', resources: [local], selected: [{ entity: 'task' as const, id: fixture.task.id }] };
    const result = await fixture.controller.command(request);
    expect(result).toMatchObject({ ok: true, data: { mutationResult: { status: 'applied' } } });
    expect(fixture.planner.snapshot().tasks[0]!.resources).toEqual([web, local]);
    expect(await fixture.controller.command(request)).toEqual(result);
    expect(calls).toBe(1);
    expect(fixture.planner.snapshot().journal).toHaveLength(1);
  });

  it('returns validated inherited references for opening without declaring host success or changing the planner', async () => {
    const fixture = setup(() => ({ kind: 'resource_open', reply: '已打开资料', resourceIds: [local.id] }));
    const ids = fixture.repository.transact(state => {
      const goal = newEntity(state, 'goal', { title: '阅读目标', resources: [local] });
      const task = state.entities.task.find(task => task.id === fixture.task.id)!;
      if ('goalId' in task) task.goalId = goal.id;
      const block = newEntity(state, 'block', { title: '周六练习时段', kind: 'event', start: '2026-10-31T18:00:00+08:00', end: null, taskId: fixture.task.id });
      return { goal, block };
    });
    const before = fixture.planner.snapshot();
    const result = await fixture.controller.command({ operationId: 'open-answer', text: '打开这个时段的阅读答案', selected: [{ entity: 'block', id: ids.block.id }] });
    expect(result).toMatchObject({ ok: true, data: { resourcesToOpen: [local], reply: '已找到资料：阅读答案.pdf。', mutationResult: null } });
    expect(fixture.planner.snapshot().tasks).toEqual(before.tasks);
    expect(fixture.planner.snapshot().blocks).toEqual(before.blocks);
    expect(fixture.planner.snapshot().journal).toEqual([]);
  });

  it('asks only for recurring scope when omitted and uses existing preview for following attachment', async () => {
    let scope: 'this-and-following' | undefined;
    let block: Block;
    const fixture = setup(() => ({ kind: 'resource_attach', reply: '关联本次资料', target: { entity: 'block', id: block.id }, expectedVersion: block.version, resourceIds: [local.id], ...(scope ? { scope } : {}) }));
    block = fixture.repository.transact(state => newEntity(state, 'block', { title: '重复练习', kind: 'event', start: '2026-10-31T18:00:00+08:00', end: null, recurrence: { seriesId: 'sample-series', occurrenceStart: '2026-10-31T18:00:00+08:00' } })) as Block;
    const result = await fixture.controller.command({ operationId: 'scope-needed', text: '给这次练习关联答案', resources: [local] });
    expect(result).toMatchObject({ ok: true, data: { mutationResult: null, reply: expect.stringContaining('本次及以后') } });
    expect(fixture.planner.snapshot().blocks[0]!.resources).toBeUndefined();
    scope = 'this-and-following';
    const preview = await fixture.controller.command({ operationId: 'scope-given', text: '本次及以后都用这份答案', resources: [local] });
    expect(preview).toMatchObject({ ok: true, data: { mutationResult: { status: 'preview', proposedRequest: { mutations: [{ type: 'updateRecurringEvent', scope, values: { resources: [local] } }] } } } });
  });

  it('rejects fabricated resource ids and retargeting an existing link in generic mutations', async () => {
    let forged = false;
    const fixture = setup(() => forged
      ? { kind: 'mutate', reply: '修改资料', mutations: [{ type: 'update', entity: 'task', id: fixture.task.id, expectedVersion: fixture.task.version, values: { resources: [{ ...web, url: 'https://example.com/unrequested' }] } }] }
      : { kind: 'resource_open', reply: '打开', resourceIds: ['invented-path-id'] });
    expect(await fixture.controller.command({ operationId: 'unknown-open', text: '打开答案' })).toMatchObject({ ok: false, error: { code: 'AI_RESPONSE' } });
    forged = true;
    expect(await fixture.controller.command({ operationId: 'retarget-resource', text: '重命名听力网址' })).toMatchObject({ ok: false, error: { code: 'AI_RESPONSE' } });
    expect(fixture.planner.snapshot().tasks[0]!.resources).toEqual([web]);
  });
});
