import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository, newEntity, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { collectReminders } from '../domain/reminders';
import { buildCalendar } from '../domain/calendar';
import { createController } from './controller';
import { MutationRequestSchema, type MutationResult, type Block } from '../shared/contracts';

// Deterministic synthetic responses test the real command adapter and planner without API usage.
const repositories: Repository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); vi.useRealTimers(); });
const at = '2026-10-23T18:00:00+08:00';
const rule = { frequency: 'even-weeks', fromDate: '2026-10-23', untilDate: '2027-01-17', weekday: 2, time: '20:40', termStart: '2026-08-31' };
function completion(value: unknown) {
  return new Response(JSON.stringify({ id: 'synthetic-recurring-edit', choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }), { status: 200 });
}
function setup(transport: typeof fetch) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at));
  const repository = createRepository(':memory:'); repositories.push(repository);
  repository.saveSettings({ termStart: '2026-08-31', termWeeks: 20 });
  const planner = createPlanner(repository);
  const confirm = (result: MutationResult) => {
    if (result.status !== 'preview') throw Error(`expected preview, got ${result.status}`);
    const saved = planner.mutate({ ...result.proposedRequest, origin: 'manual', confirmed: true, confirmationToken: result.confirmationToken });
    expect(saved.status).toBe('applied'); return saved;
  };
  confirm(planner.mutate(MutationRequestSchema.parse({ operationId: 'seed-duty-series', origin: 'manual', mutations: [{ type: 'createRecurringTask', values: { title: '双周周二晚活动室值班检查' }, rule, reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null } }] })));
  const task = planner.snapshot().tasks[0]!;
  repository.transact(state => {
    newEntity(state, 'block', { title: '另一场临时值班', taskId: task.id, kind: 'event', start: '2026-11-18T14:00:00+08:00', end: '2026-11-18T14:30:00+08:00' });
    newEntity(state, 'course', { title: '高等数学', weekday: 2, startTime: '08:30', endTime: '10:05', firstWeek: 1, lastWeek: 20, termStart: '2026-08-31' });
  });
  const controller = createController({ repository, planner, getApiKey: async () => 'synthetic-edit-key', fetch: transport, now: () => at });
  return { repository, planner, controller, confirm, task };
}

describe('natural-language recurring occurrence edits', () => {
  it.each(['single', 'this-and-following'] as const)('changes %s at a future anchor outside the default calendar window, preserving duration and reminders', async scope => {
    let anchor: Block;
    const { planner, controller, confirm, task } = setup(async (_url, init) => {
      const request = JSON.parse(String(init?.body)); const { context } = JSON.parse(request.messages[1].content);
      expect(context.toDate).toBe('2026-11-06');
      expect(context.blocks).toContainEqual(expect.objectContaining({ id: anchor.id, version: anchor.version, recurrence: anchor.recurrence }));
      expect(context.recurringSeries).toContainEqual(expect.objectContaining({ seriesId: anchor.recurrence!.seriesId, occurrenceCount: 6 }));
      expect(request.messages[0].content).toContain('scope=this-and-following');
      expect(request.messages[0].content).toContain('scope=this-and-following 允许以已经取消/完成的活动为锚点');
      expect(request.messages[0].content).toContain('未改时长时省略 values.end');
      return completion({ kind: 'mutate', reply: `请确认${scope === 'single' ? '仅本次' : '本次及以后'}值班改为21:00，保持30分钟时长。`, mutations: [{ type: 'updateRecurringEvent', id: anchor.id, expectedVersion: anchor.version, scope, values: { start: '2026-11-17T21:00:00+08:00' } }] });
    });
    const before = planner.snapshot(); anchor = before.blocks.find(block => block.recurrence?.occurrenceStart === '2026-11-17T20:40:00+08:00')!;
    const result = await controller.command({ operationId: `edit-${scope}`, text: scope === 'single' ? '把11月17日这次值班改到晚上9点，仅本次' : '从11月17日这次起，以后值班都改到晚上9点', selected: [{ entity: 'task', id: task.id }] });
    if (!result.ok || result.data.mutationResult?.status !== 'preview') throw Error('expected edit preview');
    expect(planner.snapshot().blocks).toEqual(before.blocks);
    expect(result.data.mutationResult.details.filter(detail => detail.entity === 'block')).toHaveLength(scope === 'single' ? 1 : 5);
    confirm(result.data.mutationResult);
    const after = planner.snapshot();
    expect(after.tasks).toEqual(before.tasks); expect(after.courses).toEqual(before.courses);
    for (const block of after.blocks) {
      const original = before.blocks.find(item => item.id === block.id)!;
      const changed = block.recurrence?.seriesId === anchor.recurrence!.seriesId && (scope === 'single' ? block.id === anchor.id : block.recurrence.occurrenceStart >= anchor.recurrence!.occurrenceStart);
      if (!changed) expect(block).toEqual(original);
      else {
        expect(block.start).toBe(`${original.start.slice(0, 10)}T21:00:00+08:00`);
        expect(Date.parse(block.end!) - Date.parse(block.start)).toBe(30 * 60_000);
        expect(block.reminders).toEqual(original.reminders); expect(block.recurrence).toEqual(original.recurrence);
      }
    }
    expect(collectReminders(after, '2026-11-17T20:29:00+08:00', '2026-11-17T20:30:00+08:00')).toMatchObject([{ refId: anchor.id, dueAt: '2026-11-17T21:00:00+08:00' }]);
  });

  it.each(['single', 'this-and-following'] as const)('cancels %s without deleting its task, unrelated linked activity or courses', async scope => {
    let anchor: Block;
    const { planner, controller, confirm } = setup(async () => completion({ kind: 'mutate', reply: '请确认取消范围', mutations: [{ type: 'cancelRecurringEvent', id: anchor.id, expectedVersion: anchor.version, scope }] }));
    const before = planner.snapshot(); anchor = before.blocks.find(block => block.recurrence?.occurrenceStart === '2026-11-17T20:40:00+08:00')!;
    const result = await controller.command({ operationId: `cancel-${scope}`, text: scope === 'single' ? '11月17日这次值班取消' : '从11月17日这次起，之后值班都取消', selected: [{ entity: 'block', id: anchor.id }] });
    if (!result.ok || result.data.mutationResult?.status !== 'preview') throw Error('expected cancel preview');
    expect(planner.snapshot().blocks).toEqual(before.blocks); confirm(result.data.mutationResult);
    const after = planner.snapshot();
    expect(after.blocks).toHaveLength(before.blocks.length);
    expect(after.blocks.filter(block => block.cancelled)).toHaveLength(scope === 'single' ? 1 : 5);
    expect(after.tasks).toEqual(before.tasks); expect(after.courses).toEqual(before.courses);
    expect(after.blocks.find(block => !block.recurrence)).toEqual(before.blocks.find(block => !block.recurrence));
    expect(collectReminders(after, '2026-11-17T20:09:00+08:00', '2026-11-17T20:10:00+08:00')).toEqual([]);
    expect(buildCalendar(after, '2026-11-17', '2026-11-17', false).some(item => item.refId === anchor.id)).toBe(false);
    expect(buildCalendar(after, '2026-11-17', '2026-11-17', false).some(item => item.title === '高等数学')).toBe(true);
  });

  it('rejects a model using a task ID as a recurring cancellation anchor before any write', async () => {
    let taskId = '';
    const { planner, controller, task } = setup(async () => completion({ kind: 'mutate', reply: '取消值班', mutations: [{ type: 'cancelRecurringEvent', id: taskId, expectedVersion: 1, scope: 'this-and-following' }] })); taskId = task.id;
    const before = planner.snapshot();
    const result = await controller.command({ operationId: 'invalid-anchor', text: '以后值班取消', selected: [{ entity: 'task', id: task.id }] });
    expect(result).toMatchObject({ ok: false, error: { code: 'AI_RESPONSE' } });
    expect(planner.snapshot().blocks).toEqual(before.blocks); expect(planner.snapshot().tasks).toEqual(before.tasks);
  });

  it('returns an ambiguous-scope clarification without applying any edit', async () => {
    const { planner, controller } = setup(async () => completion({ kind: 'clarification', reply: '请确定修改范围', questions: ['值班改为晚上9点是仅本次，还是本次及以后？'] }));
    const before = planner.snapshot();
    const result = await controller.command({ operationId: 'clarify-scope', text: '值班改到晚上9点' });
    expect(result).toMatchObject({ ok: true, data: { reply: expect.stringContaining('仅本次'), mutationResult: null, items: [] } });
    expect(planner.snapshot().blocks).toEqual(before.blocks);
  });
});
