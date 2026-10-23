import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, newEntity, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createController } from './controller';
import { BlockSchema, type Block, type CommandRequest } from '../shared/contracts';

// Synthetic model output checks context delivery and the real controller/planner save path.
// These tests do not measure a live model's interpretation of natural language.
const repositories: Repository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
const at = '2026-10-23T19:00:00+08:00';
function completion(value: unknown) {
  return new Response(JSON.stringify({ id: 'synthetic-title-edit', choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }), { status: 200 });
}
function setup(transport: typeof fetch) {
  const repository = createRepository(':memory:'); repositories.push(repository);
  const planner = createPlanner(repository);
  const controller = createController({ repository, planner, getApiKey: async () => 'synthetic-title-key', fetch: transport, now: () => at });
  const target = repository.transact(state => {
    newEntity(state, 'task', { title: '交实验报告', description: '保留这项任务' });
    newEntity(state, 'goal', { title: '完成本学期课程' });
    newEntity(state, 'block', { title: '搬帐篷', kind: 'event', start: '2026-10-24T17:00:00+08:00', end: '2026-10-24T17:30:00+08:00', location: '活动室' });
    return BlockSchema.parse(newEntity(state, 'block', { title: '去示例服务中心办理借阅证', kind: 'event', taskId: null,
      start: '2026-10-24T10:00:00+08:00', end: '2026-10-24T10:30:00+08:00', location: '示例服务中心',
      reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null } }));
  });
  return { repository, planner, controller, target };
}

describe('title-only command context and persistence', () => {
  it.each([
    { name: 'a complete current request', text: '把办借阅证这个活动标题里的“去示例服务中心”去掉', history: [] },
    { name: 'a short answer continuing the title-edit clarification', text: '去示例服务中心办借阅证', history: [
      { role: 'user', text: '把办借阅证的标题里的“去示例服务中心”去掉' },
      { role: 'assistant', text: '要修改哪一条记录的标题？' },
    ] },
  ] satisfies { name: string; text: string; history: NonNullable<CommandRequest['history']> }[])('retrieves tomorrow’s unlinked event from $name and saves only its title', async ({ text, history }) => {
    let expectedTarget: Block; let calls = 0;
    const { repository, planner, controller, target } = setup(async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      const payload = JSON.parse(body.messages.at(-1).content);
      expect(body.messages.slice(1,-1)).toEqual(history.map(({role,text})=>({role,content:text})));
      expect(payload).toMatchObject({ userCommand: text, context: { fromDate: '2026-10-23', toDate: '2026-10-23', selected: [] } });
      expect(payload.context.calendar.some((item: { refId: string }) => item.refId === expectedTarget.id)).toBe(false);
      expect(payload.context.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ id: expectedTarget.id, version: expectedTarget.version, title: expectedTarget.title, taskId: null, recurrence: null })]));
      return completion({ kind: 'mutate', reply: '标题改为“办理借阅证”，保留地点和时间。', mutations: [{ type: 'update', entity: 'block', id: expectedTarget.id, expectedVersion: expectedTarget.version, values: { title: '办理借阅证' } }] });
    });
    expectedTarget = target;
    const before = structuredClone(repository.read().entities);
    const request = { operationId: 'rename-event-title', text, history, fromDate: '2026-10-23', toDate: '2026-10-23' };
    const result = await controller.command(request);
    expect(result).toMatchObject({ ok: true, data: { items: [], mutationResult: { status: 'applied' } } });
    const saved = planner.snapshot().blocks.find(block => block.id === target.id)!;
    expect(saved).toEqual({ ...target, title: '办理借阅证', version: target.version + 1, updatedAt: expect.any(String) });
    const expected = structuredClone(before); expected.block = expected.block.map(block => block.id === target.id ? saved : block);
    expect(repository.read().entities).toEqual(expected);
    const journal = repository.read().journal.at(-1)!;
    expect(journal.origin).toBe('ai');
    expect(journal.details).toEqual([expect.objectContaining({ entity: 'block', id: target.id, before: target, after: saved })]);
    await controller.command(request);
    expect(calls).toBe(1); expect(repository.read().entities).toEqual(expected);
    expect(planner.undo(journal.id).status).toBe('applied');
    expect(planner.snapshot().blocks.find(block => block.id === target.id)).toEqual({ ...target, version: saved.version + 1, updatedAt: expect.any(String) });
  });

  it('passes both same-title targets to the model and leaves all records unchanged for a clarification response', async () => {
    let expectedIds: string[] = [];
    const { repository, controller, target } = setup(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const payload = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
      expect(payload.context.blocks.filter((block: { id: string }) => expectedIds.includes(block.id))).toHaveLength(2);
      return completion({ kind: 'clarification', reply: '有两次同名活动。', questions: ['修改10月24日还是10月25日那次的标题？'] });
    });
    const second = repository.transact(state => newEntity(state, 'block', { title: target.title, kind: 'event', start: '2026-10-25T10:00:00+08:00', end: '2026-10-25T10:30:00+08:00', location: target.location }));
    expectedIds = [target.id, second.id];
    const before = structuredClone(repository.read().entities);
    const result = await controller.command({ operationId: 'ambiguous-title-edit', text: '把去示例服务中心办理借阅证的标题里去示例服务中心去掉', fromDate: '2026-10-23', toDate: '2026-10-23' });
    expect(result).toMatchObject({ ok: true, data: { mutationResult: null, items: [], reply: expect.stringContaining('10月25日') } });
    expect(repository.read().entities).toEqual(before); expect(repository.read().journal).toEqual([]);
  });
});
