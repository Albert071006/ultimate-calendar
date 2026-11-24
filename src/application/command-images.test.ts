import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createLedgerService, type LedgerService } from '../ledger/service';
import { createController } from './controller';
import type { ChatMessage } from '../ai/deepseek';
import type { CommandRequest } from '../shared/contracts';

const at = '2026-10-23T21:30:00+08:00';
const image = { imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', label: '合成收据.png' };
const disposables: Array<Repository | LedgerService> = [];
afterEach(() => { for (const disposable of disposables.splice(0)) disposable.close(); vi.restoreAllMocks(); });
function setup(intents: unknown[], modalities: string[] = ['text', 'image']) {
  const repository = createRepository(':memory:'); const ledger = createLedgerService(':memory:', { now: () => new Date(at) });
  disposables.push(repository, ledger);
  const payloads: Array<{ messages: ChatMessage[] }> = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)));
    if (!intents.length) throw new Error('Unexpected synthetic model request');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents.shift()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  const planner = createPlanner(repository);
  const controller = createController({ repository, planner, ledger, now: () => at, getApiKey: async () => 'synthetic-key', getModelInputModalities: () => modalities, fetch });
  return { repository, planner, ledger, controller, payloads, fetch };
}
const route = { kind: 'ledger', reply: '处理账单' };
const expense = { kind: 'mutate', changes: [{ type: 'createEntry', key: 'new:0', values: { kind: 'expense', date: '2026-10-23', month: '2026-10', title: '合成午饭', category: '餐饮', amountCents: 2000, personalCents: 2000, cashflows: [{ accountId: 'alipay', deltaCents: -2000 }] } }] };
function pictureUrls(messages: ChatMessage[]) {
  return messages.flatMap(message => Array.isArray(message.content) ? message.content.flatMap(part => part.type === 'image_url' ? [part.image_url.url] : []) : []);
}

describe('assistant image execution', () => {
  it('sends multiple pictures and documents once to the ledger parser, preserving exact retry receipts', async () => {
    const { controller, ledger, payloads } = setup([route, expense]);
    const documents = [{ label: '合成收据.csv', text: '项目,金额\n合成午饭,20' }];
    const request = { operationId: 'multi-receipt', text: '按附件记录这一次午饭消费', images: [image, { ...image, label: '另一页.png' }], documents };
    const result = await controller.command(request);
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'saved' } } });
    expect(await controller.command(request)).toEqual(result);
    expect(payloads).toHaveLength(2);
    expect(pictureUrls(payloads[0]!.messages)).toHaveLength(0);
    expect(JSON.stringify(payloads[0]!.messages)).not.toContain('合成收据.csv');
    expect(JSON.stringify(payloads[0]!.messages)).not.toContain(documents[0]!.text.slice(0, 5));
    expect(pictureUrls(payloads[1]!.messages)).toHaveLength(2);
    expect(JSON.stringify(payloads[1]!.messages)).toContain('合成收据.csv');
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toHaveLength(1);
    expect(await controller.command({ ...request, documents: [{ ...documents[0]!, text: '另一份账单' }] })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('does not treat a file-only upload as authorization to write, and rejects multi-image requests on text-only models', async () => {
    const { controller, ledger } = setup([route]);
    expect(await controller.command({ operationId: 'only-file', text: '', documents: [{ label: '合成表.csv', text: '记录午饭20元' }] })).toMatchObject({ ok: true, data: { conversationState: { phase: 'clarification' } } });
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toHaveLength(0);
    const textOnly = setup([], ['text']);
    expect(await textOnly.controller.command({ operationId: 'no-multi-vision', text: '解释图片', images: [image, image] })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(textOnly.fetch).not.toHaveBeenCalled();
  });
  it('passes original pixels to the ledger parser and replays the exact receipt without another charge or entry', async () => {
    const { controller, ledger, payloads } = setup([route, expense]);
    const request = { operationId: 'receipt-image', text: '把图片里的合成午饭记账', image };
    const result = await controller.command(request);
    expect(result).toMatchObject({ ok: true, data: { conversationState: { domain: 'ledger', phase: 'saved' } } });
    expect(await controller.command(request)).toEqual(result);
    expect(payloads).toHaveLength(2);
    expect(pictureUrls(payloads[0]!.messages)).toEqual([]);
    expect(pictureUrls(payloads[1]!.messages)).toEqual([image.imageDataUrl]);
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toHaveLength(1);
    expect(await controller.command({ ...request, image: { ...image, imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAAA' } })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await controller.command({ operationId: request.operationId, text: request.text })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(payloads).toHaveLength(2);
  });

  it('books exactly the inspected receipt when the next user turn explicitly refers to it', async () => {
    const { controller, ledger, payloads } = setup([{ kind: 'query', reply: '图中是合成午饭收据' }, route, expense]);
    const viewed = { operationId: 'view-receipt', text: '看看这张图片', image };
    const reply = await controller.command(viewed);
    if (!reply.ok) throw Error(reply.error.message);
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toHaveLength(0);
    const request: CommandRequest = { operationId: 'history-image', text: '按这张图记账', history: [
      { role: 'user', text: viewed.text, image }, { role: 'assistant', text: reply.data.reply, outcome: reply.data.conversationState },
    ] };
    expect(await controller.command(request)).toMatchObject({ ok: true, data: { conversationState: { phase: 'saved' } } });
    expect(pictureUrls(payloads[1]!.messages)).toEqual([]);
    expect(pictureUrls(payloads[2]!.messages)).toEqual([image.imageDataUrl]);
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toEqual([expect.objectContaining({
      title: '合成午饭', amountCents: 2000, cashflows: [{ accountId: 'alipay', deltaCents: -2000 }],
    })]);
    expect(await controller.command({ ...request, history: [{ role: 'user', text: '', image: { ...image, label: 'changed.png' } }] })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('keeps an attachment-only answer to a read-only clarification from writing to the ledger', async () => {
    const { controller, ledger, fetch } = setup([{ kind: 'clarification', reply: '需要放大查看。', questions: ['能再发一张清晰的图吗？'] }, route, expense]);
    const first = { text: '帮我解释一下这张图', image };
    const answer = await controller.command({ operationId: 'read-only', ...first });
    if (!answer.ok) throw Error(answer.error.message);
    expect(answer.data.conversationState?.phase).toBe('clarification');
    const result = await controller.command({ operationId: 'clearer-picture', text: '', image, history: [
      { role: 'user', ...first }, { role: 'assistant', text: answer.data.reply, outcome: answer.data.conversationState },
    ] });
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'clarification' } } });
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['query', 'clarification', 'saved'] as const)('does not use an unrelated receipt from a %s turn as the new expense amount', async phase => {
    const { controller, ledger, payloads } = setup([route, expense]);
    const result = await controller.command({ operationId: 'different-expense', text: '帮我记一笔新的午饭消费', history: [
      { role: 'user', text: '看一下上周书店的20元收据', image },
      { role: 'assistant', text: '这是书店收据。', outcome: { domain: 'ledger', phase } },
    ] });
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'clarification' } } });
    expect(pictureUrls(payloads.at(-1)!.messages)).toEqual([]);
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toEqual([]);
  });

  it('keeps the selected receipt through an account clarification without including an older receipt', async () => {
    const { controller, ledger, payloads } = setup([route, { kind: 'clarification', question: '使用哪个账户？' }, expense]);
    const oldImage = { ...image, imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAAA' };
    const history: NonNullable<CommandRequest['history']> = [
      { role: 'user', text: '看看这份旧收据', image: oldImage }, { role: 'assistant', text: '旧收据。', outcome: { domain: 'calendar', phase: 'query' } },
      { role: 'user', text: '这张新收据是什么', image }, { role: 'assistant', text: '是午餐收据。', outcome: { domain: 'calendar', phase: 'query' } },
      { role: 'user', text: '图里的商户是哪家？' }, { role: 'assistant', text: '合成餐厅。', outcome: { domain: 'calendar', phase: 'query' } },
    ];
    const text = '按这张图记账';
    const question = await controller.command({ operationId: 'choose-receipt', text, history });
    if (!question.ok) throw Error(question.error.message);
    expect(question.data.conversationState?.phase).toBe('clarification');
    const saved = await controller.command({ operationId: 'choose-account', text: '支付宝', history: [...history,
      { role: 'user', text }, { role: 'assistant', text: question.data.reply, outcome: question.data.conversationState },
    ] });
    expect(saved).toMatchObject({ ok: true, data: { conversationState: { phase: 'saved' } } });
    for (const payload of payloads.slice(1)) expect(pictureUrls(payload.messages)).toEqual([image.imageDataUrl]);
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toEqual([expect.objectContaining({ amountCents: 2000 })]);
  });

  it('recovers a committed image request after a receipt interruption without another model call or duplicate', async () => {
    const { controller, ledger, payloads } = setup([route, expense]);
    const mutate = ledger.mutate.bind(ledger); let interrupted = false;
    vi.spyOn(ledger, 'mutate').mockImplementation(request => {
      const result = mutate(request);
      if (!interrupted) { interrupted = true; throw new Error('Synthetic interruption after commit'); }
      return result;
    });
    const request = { operationId: 'interrupted-image', text: '按收据记账', image };
    expect((await controller.command(request)).ok).toBe(false);
    expect(await controller.command({ ...request, image: { ...image, label: 'another-receipt.png' } })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect((await controller.command(request)).ok).toBe(true);
    expect(payloads).toHaveLength(2);
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toHaveLength(1);
  });

  it.each([route, { kind: 'mutate', reply: '创建任务', mutations: [{ type: 'create', entity: 'task', values: { title: '不能自动创建' } }] }, { kind: 'undo', reply: '撤销' }])('does not treat an image-only upload as execution authority: $kind', async intent => {
    const { controller, repository, ledger, payloads } = setup([intent]);
    const before = repository.read();
    const result = await controller.command({ operationId: 'only-picture', text: '', image });
    expect(result).toMatchObject({ ok: true, data: { mutationResult: null, conversationState: { phase: 'clarification' } } });
    expect(repository.read().entities).toEqual(before.entities);
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toHaveLength(0);
    expect(payloads).toHaveLength(1);
  });

  it('allows image descriptions and an image that answers an explicitly authorized pending request', async () => {
    const described = setup([{ kind: 'query', reply: '这是一张合成收据。' }]);
    expect(await described.controller.command({ operationId: 'describe', text: '', image })).toMatchObject({ ok: true, data: { reply: '这是一张合成收据。', conversationState: { phase: 'query' } } });
    const { controller, ledger } = setup([route, expense]);
    expect(await controller.command({ operationId: 'supply-receipt', text: '', image, history: [
      { role: 'user', text: '按我的收据记账' }, { role: 'assistant', text: '请发收据图片', outcome: { domain: 'ledger', phase: 'clarification' } },
    ] })).toMatchObject({ ok: true, data: { conversationState: { domain: 'ledger', phase: 'saved' } } });
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toHaveLength(1);
  });

  it('rejects images for a known text-only model before any paid request, including history images', async () => {
    const { controller, fetch } = setup([], ['text']);
    for (const request of [{ operationId: 'no-vision', text: '解释图片', image }, { operationId: 'no-history-vision', text: '解释图片', history: [{ role: 'user' as const, text: '', image }] }]) {
      expect(await controller.command(request)).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: expect.stringContaining('不支持图片输入') } });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
