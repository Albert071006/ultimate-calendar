import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createLedgerService, type LedgerService } from '../ledger/service';
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, ledgerAccounts, type LedgerEntry } from '../shared/ledger';
import type { CommandRequest } from '../shared/contracts';
import { createController } from './controller';

const now = '2026-04-12T12:00:00+08:00';
const disposables: Array<Repository | LedgerService> = [];
afterEach(() => { for (const item of disposables.splice(0)) item.close(); });
function entry(id: string, overrides: Partial<LedgerEntry> = {}) {
  return LedgerEntrySchema.parse({ id, kind: 'expense', date: '2026-04-02', month: '2026-04', title: '合成交通', category: '交通',
    amountCents: 4000, personalCents: 4000, cashflows: [{ accountId: 'alipay', deltaCents: -4000 }], note: '合成旅行',
    originalText: '合成旅行交通、住宿，以及无关打印一次录入', version: 1, createdAt: now, updatedAt: now, ...overrides });
}
function setup(intents: unknown[], entries = [entry('trip-transport'), entry('trip-hotel', { title: '合成住宿', category: '住宿', amountCents: 16000, personalCents: 16000, cashflows: [{ accountId: 'alipay', deltaCents: -16000 }] }), entry('other', { title: '合成打印', category: '学习', note: '', amountCents: 500, personalCents: 500, cashflows: [{ accountId: 'alipay', deltaCents: -500 }] })]) {
  const repository = createRepository(':memory:');
  const ledger = createLedgerService(':memory:', { now: () => new Date(now) }); disposables.push(repository, ledger);
  ledger.import({ format: 'ultimate-calendar-ledger', formatVersion: 1, entries, balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [] }, 'synthetic-import');
  let calls = 0;
  const controller = createController({ repository, planner: createPlanner(repository), ledger, now: () => now, getApiKey: async () => 'synthetic-key',
    fetch: async () => { calls++; if (!intents.length) throw Error('Unexpected model call'); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents.shift()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { status: 200 }); } });
  return { controller, ledger, repository, calls: () => calls, intents };
}
const route = { kind: 'ledger', reply: '交由账本处理' };
function reimbursement(amount = 20500, adjustments = [{ targetEntryIds: ['trip-transport', 'trip-hotel'], amountCents: 20000 }], incomeCents = 500) {
  return { kind: 'mutate', changes: [{ type: 'createEntry', key: 'new:0', values: { kind: 'reimbursement', date: '2026-04-12', month: '2026-04',
    title: '合成旅行报销', category: '报销', amountCents: amount, personalCents: 0, incomeCents, cashflows: [{ accountId: 'alipay', deltaCents: amount }],
    relatedEntryIds: ['trip-transport', 'trip-hotel'], adjustments } }] };
}

describe('ledger scoped queries and reimbursement conversation', () => {
  it('keeps a bank given before multiple questions and bypasses rerouting for a clear amount answer', async () => {
    const final = { kind: 'mutate', changes: [
      { type: 'createAccount', key: 'new-account:0', name: '合成杏林银行', kind: 'cash', aliases: [] },
      { type: 'createEntry', key: 'new:0', values: { kind: 'expense', date: '2026-04-12', month: '2026-04', title: '合成茶饮', category: '餐饮', amountCents: 2000, personalCents: 2000,
        cashflows: [{ accountId: 'new-account:0', deltaCents: -2000 }] } },
    ] };
    const { controller, ledger, calls } = setup([route, { kind: 'clarification', question: '实际支付多少元？' },
      { kind: 'clarification', question: '是什么消费项目？' }, route, final], []);
    const history: NonNullable<CommandRequest['history']> = [];
    for (const [index, text] of ['用合成杏林银行记一笔消费', '20', '合成茶饮'].entries()) {
      const result = await controller.command({ operationId: `several-questions-${index}`, text, history: [...history] });
      expect(result.ok).toBe(true); if (!result.ok) return;
      history.push({ role: 'user', text }, { role: 'assistant', text: result.data.reply, outcome: result.data.conversationState });
      expect(result.data.conversationState?.phase).toBe(index === 2 ? 'saved' : 'clarification');
      expect(ledger.snapshot().entries).toHaveLength(index === 2 ? 1 : 0);
    }
    expect(calls()).toBe(5);
    expect(ledger.snapshot().accounts?.find(account => account.name === '合成杏林银行')).toBeTruthy();
    expect(ledger.snapshot().entries[0]).toMatchObject({ title: '合成茶饮', amountCents: 2000 });
  });

  it('continues amount then account answers with one parser call each and no premature write', async () => {
    const final = { kind: 'mutate', changes: [{ type: 'createEntry', key: 'new:0', values: { kind: 'expense', date: '2026-04-12', month: '2026-04', title: '合成茶饮', category: '餐饮', amountCents: 2000, personalCents: 2000,
      cashflows: [{ accountId: 'alipay', deltaCents: -2000 }] } }] };
    const { controller, ledger, calls } = setup([route, { kind: 'clarification', question: '多少钱？' }, { kind: 'clarification', question: '哪个账户？' }, final], []);
    const history: NonNullable<CommandRequest['history']> = [];
    for (const [index, text] of ['合成茶饮记一笔', '20元', '支付宝'].entries()) {
      const result = await controller.command({ operationId: `amount-account-${index}`, text, history: [...history] });
      expect(result.ok).toBe(true); if (!result.ok) return;
      history.push({ role: 'user', text }, { role: 'assistant', text: result.data.reply, outcome: result.data.conversationState });
      expect(ledger.snapshot().entries).toHaveLength(index === 2 ? 1 : 0);
    }
    expect(calls()).toBe(4);
    expect(ledger.snapshot().summary.personalCents).toBe(2000);
  });

  it('queries an exact old-month selection without applying the currently visible month', async () => {
    const { controller } = setup([route, { kind: 'query', query: { entryIds: ['old'] }, detail: 'entries' }], [entry('old', { date: '2026-03-02', month: '2026-03' })]);
    const result = await controller.command({ operationId: 'old-selection', text: '查这笔账', domain: 'ledger', ledgerView: { month: '2026-04', tab: 'flows' } });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.reply).toContain('指定账目（不限月份）：个人开销 ¥40.00');
    expect(result.data.reply).toContain('2026-03-02');
  });

  it('offers real same-bank account choices and queries only the chosen card without loosening write checks', async () => {
    const choices = ['a', 'b'].map((key, index) => ({ label: `合成杏林银行尾号${index ? '2222' : '1111'}`, query: { accountId: `card-${key}` }, detail: 'entries' }));
    const { controller, ledger, calls } = setup([route, { kind: 'clarification', question: '请选择要查询的银行卡', queryChoices: choices }], []);
    ledger.import({ format: 'ultimate-calendar-ledger', formatVersion: 1, entries: [
      entry('card-a-payment', { cashflows: [{ accountId: 'card-a', deltaCents: -4000 }] }),
      entry('card-b-payment', { title: '另一卡合成付款', cashflows: [{ accountId: 'card-b', deltaCents: -4000 }] }),
    ], accounts: [...ledgerAccounts(ledger.snapshot()), ...choices.map((choice, index) => ({ id: `card-${index ? 'b' : 'a'}`, name: choice.label, kind: 'cash' as const, aliases: ['合成杏林银行'] }))],
    balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [] }, 'synthetic-bank-choice-import');
    const text = '查合成杏林银行卡这个月的开销';
    const before = ledger.snapshot();
    const question = await controller.command({ operationId: 'bank-choice-question', text });
    expect(question.ok).toBe(true); if (!question.ok) return;
    const answer = await controller.command({ operationId: 'bank-choice-answer', text: '第一个', history: [
      { role: 'user', text }, { role: 'assistant', text: question.data.reply, outcome: question.data.conversationState },
    ] });
    expect(answer.ok).toBe(true); if (!answer.ok) return;
    expect(answer.data.reply).toContain('个人开销 ¥40.00');
    expect(answer.data.reply).toContain('尾号1111');
    expect(answer.data.reply).not.toContain('另一卡合成付款');
    expect(calls()).toBe(2);
    expect(ledger.snapshot()).toEqual(before);
  });

  it('excludes unrelated payments sharing the same source transcript and shows the executed scope', async () => {
    const { controller, ledger } = setup([route, { kind: 'query', query: { month: '2026-04', search: '合成旅行' }, detail: 'entries' }]);
    const before = ledger.snapshot();
    const result = await controller.command({ operationId: 'topic-query', text: '四月合成旅行花了多少钱' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reply).toContain('个人开销 ¥200.00');
    expect(result.data.reply).toContain('合成旅行');
    expect(result.data.reply).toContain('匹配 2 笔');
    expect(result.data.reply).not.toContain('合成打印');
    expect(ledger.snapshot()).toEqual(before);
  });

  it('continues the selected query without another model request, keeping the original month and note filter', async () => {
    const choices = [{ label: '备注标记的旅行费用', query: { search: '合成旅行', searchFields: ['note'] }, detail: 'entries' },
      { label: '当月全部账目', query: {}, detail: 'entries' }];
    const { controller, ledger, calls } = setup([route, { kind: 'clarification', question: '请选择范围', queryChoices: choices }]);
    const question = await controller.command({ operationId: 'scope-question', text: '查一下账单', domain: 'ledger', ledgerView: { month: '2026-04', tab: 'flows' } });
    expect(question.ok).toBe(true); if (!question.ok) return;
    expect(question.data.reply).toContain('1. 备注标记的旅行费用');
    expect(question.data.conversationState?.ledgerQueryChoices?.[0]?.query.month).toBe('2026-04');
    const before = ledger.snapshot();
    const request: CommandRequest = { operationId: 'scope-answer', text: '第一个', domain: 'ledger', ledgerView: { month: '2026-03', tab: 'flows' }, history: [
      { role: 'user', text: '查一下账单' }, { role: 'assistant', text: question.data.reply, outcome: question.data.conversationState },
    ] };
    const result = await controller.command(request);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.reply).toContain('2026-04：个人开销 ¥200.00');
    expect(result.data.reply).toContain('（备注）');
    expect(result.data.reply).not.toContain('合成打印');
    expect(calls()).toBe(2);
    expect(await controller.command(request)).toEqual(result);
    expect(calls()).toBe(2);
    expect(ledger.snapshot()).toEqual(before);
  });

  it('does not silently turn an unavailable selected record into a partial or full-ledger total', async () => {
    const { controller, ledger } = setup([route, { kind: 'query', query: { entryIds: ['trip-transport', 'missing'] }, detail: 'summary' }]);
    const before = ledger.snapshot();
    const result = await controller.command({ operationId: 'missing-query-record', text: '查询选中的账目' });
    expect(result).toMatchObject({ ok: true, data: { conversationState: { domain: 'ledger', phase: 'clarification' } } });
    expect(result.ok && result.data.reply).toContain('未扩大查询范围');
    expect(ledger.snapshot()).toEqual(before);
  });

  it('saves one receipt with per-entry full offsets and excess income, and replay and undo remain atomic', async () => {
    const { controller, ledger, calls } = setup([route, reimbursement()]);
    const before = ledger.snapshot();
    const request = { operationId: 'full-reimbursement', text: '合成旅行全部报销205元到支付宝，冲减交通住宿200元，多的5元按额外收入' };
    const result = await controller.command(request);
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'saved' } } });
    const after = ledger.snapshot('2026-04');
    expect(after.entries).toHaveLength(before.entries.length + 1);
    const receipt = after.entries.find(item => item.kind === 'reimbursement')!;
    expect(receipt.cashflows).toEqual([{ accountId: 'alipay', deltaCents: 20500 }]);
    expect(receipt.incomeCents).toBe(500);
    expect(receipt.adjustments).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetEntryIds: ['trip-transport'], amountCents: 4000 }),
      expect.objectContaining({ targetEntryIds: ['trip-hotel'], amountCents: 16000 }),
    ]));
    expect(after.summary).toMatchObject({ personalCents: 500, incomeCents: 500 });
    expect(ledger.query({ month: '2026-04', category: '交通' }).summary.personalCents).toBe(0);
    expect(ledger.query({ month: '2026-04', search: '合成旅行', searchFields: ['note'] }).summary.personalCents).toBe(0);
    expect(await controller.command(request)).toEqual(result);
    expect(calls()).toBe(2);
    expect(ledger.snapshot('2026-04').entries).toEqual(after.entries);
    ledger.undo({ operationId: 'undo-full-reimbursement', expectedRevision: after.revision, month: '2026-04' });
    expect(ledger.snapshot('2026-04').entries).toEqual(before.entries);
  });

  it('asks a normal follow-up for an ambiguous partial offset and saves only after its allocation is supplied', async () => {
    const { controller, ledger, calls, intents } = setup([route, reimbursement(10000, [{ targetEntryIds: ['trip-transport', 'trip-hotel'], amountCents: 10000 }], 0)]);
    const before = ledger.snapshot();
    const request = { operationId: 'partial-question', text: '合成旅行部分报销100元到支付宝，冲减费用' };
    const question = await controller.command(request);
    expect(question).toMatchObject({ ok: true, data: { conversationState: { domain: 'ledger', phase: 'clarification' } } });
    if (!question.ok) return;
    expect(question.data.reply).toContain('整批账目尚未保存');
    expect(ledger.snapshot()).toEqual(before);
    expect(await controller.command(request)).toEqual(question);
    expect(calls()).toBe(2);
    intents.push(route, reimbursement(10000, [{ targetEntryIds: ['trip-transport'], amountCents: 4000 }, { targetEntryIds: ['trip-hotel'], amountCents: 6000 }], 0));
    const result = await controller.command({ operationId: 'partial-answer', text: '交通40，住宿60', history: [
      { role: 'user', text: request.text }, { role: 'assistant', text: question.data.reply, outcome: question.data.conversationState },
    ] });
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'saved' } } });
    expect(ledger.snapshot().entries).toHaveLength(before.entries.length + 1);
    expect(ledger.snapshot().summary.personalCents).toBe(10500);
  });
});
