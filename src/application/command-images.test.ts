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
  it('passes original pixels through both model stages and replays the exact receipt without another charge or entry', async () => {
    const { controller, ledger, payloads } = setup([route, expense]);
    const request = { operationId: 'receipt-image', text: '把图片里的合成午饭记账', image };
    const result = await controller.command(request);
    expect(result).toMatchObject({ ok: true, data: { conversationState: { domain: 'ledger', phase: 'saved' } } });
    expect(await controller.command(request)).toEqual(result);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) expect(pictureUrls(payload.messages)).toEqual([image.imageDataUrl]);
    expect(ledger.snapshot().entries.filter(entry => !entry.ruleKey)).toHaveLength(1);
    expect(await controller.command({ ...request, image: { ...image, imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAAA' } })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await controller.command({ operationId: request.operationId, text: request.text })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(payloads).toHaveLength(2);
  });

  it('uses a historical user image for an explicitly requested follow-up in both model stages', async () => {
    const { controller, payloads } = setup([route, expense]);
    const request: CommandRequest = { operationId: 'history-image', text: '按这张图记账', history: [
      { role: 'user', text: '', image }, { role: 'assistant', text: '图中是合成午饭收据', outcome: { domain: 'calendar', phase: 'query' } },
    ] };
    expect((await controller.command(request)).ok).toBe(true);
    for (const payload of payloads) expect(pictureUrls(payload.messages)).toEqual([image.imageDataUrl]);
    expect(await controller.command({ ...request, history: [{ role: 'user', text: '', image: { ...image, label: 'changed.png' } }] })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
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
