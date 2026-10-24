import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { buildCalendar } from '../domain/calendar';
import { collectReminders } from '../domain/reminders';
import { createController } from './controller';
import { MutationRequestSchema } from '../shared/contracts';

const repositories: Repository[] = [];
afterEach(() => { repositories.splice(0).forEach(repository => repository.close()); vi.useRealTimers(); });
const now = '2030-04-12T14:00:00+08:00';
const start = '2030-04-14T18:00:00+08:00';
const end = '2030-04-14T18:30:00+08:00';
const request = { operationId: 'synthetic-reminder', text: '后天晚上六点提醒我取打印材料', fromDate: '2030-04-19', toDate: '2030-04-25' };
const scheduled = { type: 'createScheduledTask', values: { title: '取打印材料' }, start, end: null };
function completion(value: unknown) {
  return new Response(JSON.stringify({ id: 'synthetic-scheduled', choices: [{ message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }), { status: 200 });
}
function setup(proposal: unknown) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
  const repository = createRepository(':memory:'); repositories.push(repository);
  const planner = createPlanner(repository);
  const payloads: { messages: { content: string }[] }[] = [];
  const controller = createController({ repository, planner, getApiKey: async () => 'synthetic-key', now: () => now, fetch: async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body))); return completion(proposal);
  } });
  return { repository, planner, controller, payloads };
}

describe('single timed command execution', () => {
  it('directly saves a linked 30-minute reminder using now rather than the viewed date, then retries and undoes atomically', async () => {
    const { planner, controller, payloads } = setup({ kind: 'mutate', reply: '请确认预览后保存。', mutations: [scheduled] });
    const response = await controller.command(request);
    expect(response).toMatchObject({ ok: true, data: { mutationResult: { status: 'applied' }, conversationState: { phase: 'saved' } } });
    if (!response.ok || response.data.mutationResult?.status !== 'applied') throw Error('expected direct save');
    const snapshot = planner.snapshot();
    expect(snapshot.tasks).toHaveLength(1); expect(snapshot.blocks).toHaveLength(1);
    expect(snapshot.tasks[0]!.deadline).toBeNull();
    expect(snapshot.blocks[0]).toMatchObject({ title: '取打印材料', taskId: snapshot.tasks[0]!.id, kind: 'event', start, end, reminders: { enabled: true, leadMinutes: [0] } });
    expect(buildCalendar(snapshot, '2030-04-14', '2030-04-14', false)).toMatchObject([{ start, end, refKind: 'block', refId: snapshot.blocks[0]!.id }]);
    expect(collectReminders(snapshot, '2030-04-14T17:59:59+08:00', start)).toMatchObject([{ refKind: 'block', dueAt: start, scheduledAt: start }]);
    expect(response.data.reply).toContain('2030-04-14 18:00–18:30');
    expect(response.data.reply).toContain('准时提醒'); expect(response.data.reply).not.toContain('确认');
    const context = JSON.parse(payloads[0]!.messages.at(-1)!.content).context;
    expect(context.explicitReminderStart).toBe(start); expect(context.fromDate).toBe('2030-04-19');
    expect(payloads[0]!.messages[0]!.content).toContain('createScheduledTask');
    expect((await controller.command(request))).toEqual(response); expect(payloads).toHaveLength(1);
    expect(planner.undo(response.data.mutationResult.transactionId).status).toBe('applied');
    expect(planner.snapshot().tasks).toHaveLength(0); expect(planner.snapshot().blocks).toHaveLength(0);
  });

  it('repairs the old deadline-only model proposal for a unique explicit reminder without inventing a deadline', async () => {
    const { planner, controller } = setup({ kind: 'mutate', reply: '已设置截止时间', mutations: [{ type: 'create', entity: 'task', values: { title: '取打印材料', deadline: { date: '2030-04-19', time: '09:00' } } }] });
    expect(await controller.command(request)).toMatchObject({ ok: true, data: { mutationResult: { status: 'applied' } } });
    expect(planner.snapshot().tasks[0]!.deadline).toBeNull();
    expect(planner.snapshot().blocks).toMatchObject([{ start, end, reminders: { leadMinutes: [0] } }]);
  });

  it('keeps a genuine deadline separate from an explicitly scheduled activity and preserves its duration', async () => {
    const deadline = { date: '2030-04-18', time: '12:00' };
    const { planner, controller } = setup({ kind: 'mutate', reply: '安排阅读', mutations: [{ ...scheduled, values: { title: '阅读材料', deadline }, end: '2030-04-14T19:30:00+08:00' }] });
    const result = await controller.command({ operationId: 'read-with-deadline', text: '后天晚上六点到七点半阅读材料，4月18日中午十二点截止' });
    expect(result).toMatchObject({ ok: true, data: { mutationResult: { status: 'applied' } } });
    expect(planner.snapshot().tasks[0]!.deadline).toEqual(deadline);
    expect(planner.snapshot().blocks[0]).toMatchObject({ start, end: '2030-04-14T19:30:00+08:00' });
  });

  it('does not turn a real deadline reminder into an activity or erase its deadline', async () => {
    const deadline = { date: '2030-04-14', time: '18:00' };
    const { planner, controller } = setup({ kind: 'mutate', reply: '提交截止', mutations: [{ type: 'create', entity: 'task', values: { title: '提交材料', deadline } }] });
    expect(await controller.command({ operationId: 'deadline-only', text: '提交材料后天晚上六点截止，提醒我别忘了' })).toMatchObject({ ok: true, data: { mutationResult: { status: 'applied' } } });
    expect(planner.snapshot().tasks[0]!.deadline).toEqual(deadline); expect(planner.snapshot().blocks).toEqual([]);
  });

  it('keeps conflicting reminders as a preview and bases the reply on the unsaved result', async () => {
    const { planner, controller } = setup({ kind: 'mutate', reply: '已保存，已安排成功', mutations: [scheduled] });
    planner.mutate(MutationRequestSchema.parse({ operationId: 'seed-conflict', origin: 'manual', mutations: [{ type: 'create', entity: 'block', values: { title: '合成已有活动', start, end, kind: 'event' } }] }));
    const response = await controller.command(request);
    if (!response.ok || response.data.mutationResult?.status !== 'preview') throw Error('expected conflict preview');
    expect(response.data.reply).toContain('时间冲突'); expect(response.data.reply).not.toContain('已保存');
    expect(planner.snapshot().tasks).toEqual([]); expect(planner.snapshot().blocks).toHaveLength(1);
    const preview = response.data.mutationResult;
    expect(planner.mutate({ ...preview.proposedRequest, origin: 'manual', confirmed: true, confirmationToken: preview.confirmationToken }).status).toBe('applied');
    expect(planner.snapshot().tasks).toHaveLength(1); expect(planner.snapshot().blocks).toHaveLength(2);
    expect(await controller.command(request)).toMatchObject({ ok: true, data: { mutationResult: { status: 'applied' } } });
    expect(planner.snapshot().blocks).toHaveLength(2);
  });

  it('does not create records from a clarification even when a current message contains a reminder time', async () => {
    const { planner, controller } = setup({ kind: 'clarification', reply: '有两条同名材料', questions: ['要取哪一份？'] });
    expect(await controller.command(request)).toMatchObject({ ok: true, data: { mutationResult: null, conversationState: { phase: 'clarification' } } });
    expect(planner.snapshot().tasks).toEqual([]); expect(planner.snapshot().blocks).toEqual([]);
  });
});
