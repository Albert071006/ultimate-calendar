import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository, newEntity, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { collectReminders } from '../domain/reminders';
import { createController } from './controller';
import { MutationRequestSchema } from '../shared/contracts';

// Synthetic model responses exercise the full adapter/planner path without any external API or account.
const repositories: Repository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); vi.useRealTimers(); });
const at = '2026-10-23T18:00:00+08:00';
const rule = { frequency: 'even-weeks', fromDate: '2026-10-23', untilDate: '2027-01-17', weekday: 2, time: '20:40', termStart: '2026-08-31' };
function completion(value: unknown) {
  return new Response(JSON.stringify({ id: 'synthetic-recurring', choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }), { status: 200 });
}
function setup(transport: typeof fetch) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at));
  const repository = createRepository(':memory:'); repositories.push(repository);
  repository.saveSettings({ termStart: '2026-08-31', termWeeks: 20 });
  const planner = createPlanner(repository);
  const controller = createController({ repository, planner, getApiKey: async () => 'synthetic-recurring-key', fetch: transport, now: () => at });
  return { repository, planner, controller };
}

describe('natural-language recurring command execution', () => {
  it('previews and confirms six future even-week activities for the existing task, retaining its 30-minute reminders', async () => {
    let target = ''; let calls = 0;
    const { repository, planner, controller } = setup(async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      const userPayload = JSON.parse(request.messages[1].content);
      expect(userPayload.context.academicTerm).toEqual({ termStart: '2026-08-31', termWeeks: 20, currentWeek: 8, termEnd: '2027-01-17' });
      expect(userPayload.context.tasks).toMatchObject([{ id: target, version: 1 }]);
      expect(request.messages[0].content).toContain('scheduleRecurringTask');
      expect(request.messages[0].content).toContain('不能把“双周”当成从今天起每隔14天');
      return completion({ kind: 'mutate', reply: '已准备本学期双数周二20:40的安排，每次30分钟，提前30分钟提醒，请确认预览。', mutations: [{ type: 'scheduleRecurringTask', id: target, expectedVersion: 1, rule, location: '活动室' }] });
    });
    const task = repository.transact(state => newEntity(state, 'task', { title: '双周周二晚活动室值班检查', description: '每个双数周的周二晚上8:40去活动室查看一次', reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null } })); target = task.id;
    const request = { operationId: 'repeat-existing', text: '把这个双数周二20:40活动室值班设为本学期自动重复，提前30分钟提醒' };
    const response = await controller.command(request);
    expect(response).toMatchObject({ ok: true, data: { items: [], mutationResult: { status: 'preview' } } });
    if (!response.ok || response.data.mutationResult?.status !== 'preview') throw Error('expected recurring preview');
    const preview = response.data.mutationResult;
    expect(preview.details.filter(detail => detail.entity === 'block')).toHaveLength(6);
    expect(planner.snapshot().tasks).toHaveLength(1); expect(planner.snapshot().blocks).toEqual([]);
    expect(planner.mutate({ ...preview.proposedRequest, origin: 'manual', confirmed: true, confirmationToken: preview.confirmationToken }).status).toBe('applied');
    const saved = planner.snapshot();
    expect(saved.tasks).toHaveLength(1);
    expect(saved.blocks.map(block => block.start)).toEqual(['2026-11-03', '2026-11-17', '2026-12-01', '2026-12-15', '2026-12-29', '2027-01-12'].map(date => `${date}T20:40:00+08:00`));
    for (const block of saved.blocks) expect(block).toMatchObject({ taskId: target, kind: 'event', end: `${block.start.slice(0, 10)}T21:10:00+08:00`, location: '活动室', reminders: { enabled: true, leadMinutes: [30] } });
    expect(collectReminders(saved, '2026-11-03T20:09:00+08:00', '2026-11-03T20:10:00+08:00')).toMatchObject([{ refKind: 'block', refId: saved.blocks[0]!.id, dueAt: '2026-11-03T20:40:00+08:00', scheduledAt: '2026-11-03T20:10:00+08:00' }]);
    expect((await controller.command(request)).ok).toBe(true); expect(calls).toBe(1); expect(planner.snapshot().blocks).toHaveLength(6);
  });

  it('creates a new recurring task and its reminder-bearing events in one confirmed operation', async () => {
    const { planner, controller } = setup(async () => completion({ kind: 'mutate', reply: '请确认隔周安排', mutations: [{ type: 'createRecurringTask', values: { title: '隔周复盘' }, rule: { ...rule, frequency: 'biweekly', fromDate: '2026-10-23', untilDate: '2026-11-10', termStart: null }, reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null } }] }));
    const result = await controller.command({ operationId: 'repeat-new', text: '从今天起到11月10日，每两周周二20:40复盘，提前半小时提醒' });
    if (!result.ok || result.data.mutationResult?.status !== 'preview') throw Error('expected new recurring preview');
    const preview = result.data.mutationResult;
    expect(planner.snapshot().tasks).toEqual([]);
    expect(planner.mutate({ ...preview.proposedRequest, origin: 'manual', confirmed: true, confirmationToken: preview.confirmationToken }).status).toBe('applied');
    expect(planner.snapshot().tasks).toHaveLength(1);
    const task = planner.snapshot().tasks[0]!;
    expect(planner.snapshot().blocks).toHaveLength(2);
    expect(planner.snapshot().blocks.map(block => block.start.slice(0, 10))).toEqual(['2026-10-27', '2026-11-10']);
    expect(planner.snapshot().blocks.every(block => block.taskId === task.id && block.reminders.leadMinutes?.[0] === 30)).toBe(true);
  });

  it.each([false, true])('attaches calendar entries only when query requests a calendar range (%s)', async calendarRequested => {
    const { planner, controller } = setup(async () => completion({ kind: 'query', reply: calendarRequested ? '今天的课程' : '这是你的值班任务', ...(calendarRequested ? { fromDate: '2026-10-23', toDate: '2026-10-23' } : {}) }));
    planner.mutate(MutationRequestSchema.parse({ operationId: 'seed-course', origin: 'manual', mutations: [{ type: 'create', entity: 'course', values: { title: '高等数学', weekday: 5, startTime: '08:30', endTime: '10:05', firstWeek: 1, lastWeek: 20, termStart: '2026-08-31' } }] }));
    const result = await controller.command({ operationId: `query-${calendarRequested}`, text: calendarRequested ? '今天有什么课' : '看看我的值班任务说明' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('query failed');
    expect(result.data.items).toHaveLength(calendarRequested ? 1 : 0);
  });
});
