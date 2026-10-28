import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createLedgerService, type LedgerService } from '../ledger/service';
import { createController } from './controller';
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, type LedgerEntry } from '../shared/ledger';
import { ledgerLoans } from '../shared/ledger-loans';

const now = '2026-10-23T21:30:00+08:00';
const disposables: Array<Repository | LedgerService> = [];
afterEach(() => { for (const service of disposables.splice(0)) service.close(); });
const route = { kind: 'ledger', reply: '交由账本处理' };
function setup(intents: unknown[]) {
  const repository = createRepository(':memory:');
  const ledger = createLedgerService(':memory:', { now: () => new Date(now) });
  disposables.push(repository, ledger);
  const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const controller = createController({ repository, planner: createPlanner(repository), ledger, now: () => now, getApiKey: async () => 'synthetic-key', fetch: async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    if (!intents.length) throw Error('Unexpected extra AI request');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents.shift()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  } });
  return { controller, ledger, repository, payloads };
}
function values(kind: LedgerEntry['kind'], title: string, amountCents: number, deltaCents: number, extra: Record<string, unknown> = {}) {
  return { kind, title, amountCents, date: '2026-10-23', month: '2026-10', category: '合成借款', personalCents: 0, cashflows: [{ accountId: 'wechat', deltaCents }], ...extra };
}
function principal(id: string, kind: 'loan_borrow' | 'loan_lend', amountCents: number, counterparty: string): LedgerEntry {
  return LedgerEntrySchema.parse({ id, ...values(kind, `合成来源${id}`, amountCents, kind === 'loan_borrow' ? amountCents : -amountCents, { counterparty }), date: '2026-09-20', month: '2026-09', version: 1, createdAt: '2026-09-20T12:00:00+08:00', updatedAt: '2026-09-20T12:00:00+08:00' });
}
function seed(ledger: LedgerService, entries: LedgerEntry[]) {
  ledger.import({ format: 'ultimate-calendar-ledger', formatVersion: 1, entries, balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [] }, 'synthetic-loan-import');
}

describe('assistant loan bookkeeping', () => {
  it('records a mixed borrowing, withdrawal, fee and purchase atomically without treating principal as income or spending', async () => {
    const { controller, ledger, payloads } = setup([route, { kind: 'mutate', changes: [
      { type: 'createEntry', key: 'new:0', values: values('loan_borrow', '合成同学借款到账', 42000, 42000, { counterparty: '合成同学甲' }) },
      { type: 'createEntry', key: 'new:1', values: values('transfer', '合成提现', 60000, -60000, { cashflows: [{ accountId: 'wechat', deltaCents: -60000 }, { accountId: null, deltaCents: 60000 }] }) },
      { type: 'createEntry', key: 'new:2', values: values('expense', '合成提现手续费', 60, -60, { personalCents: 60 }) },
      { type: 'createEntry', key: 'new:3', values: values('expense', '合成软件购买', 21900, -21900, { personalCents: 21900, cashflows: [{ accountId: null, deltaCents: -21900 }] }) },
    ] }]);
    const request = { operationId: 'mixed-borrowing', text: '合成同学甲借给我420元到微信；提现600元到未跟踪账户，微信收6毛手续费；再从该账户购买合成软件219元' };
    const reply = await controller.command(request);
    expect(reply).toMatchObject({ ok: true, data: { conversationState: { phase: 'saved', domain: 'ledger' } } });
    const snapshot = ledger.snapshot('2026-10');
    expect(snapshot.entries).toHaveLength(4);
    expect(snapshot.summary).toMatchObject({ personalCents: 21960, incomeCents: 0, assetSaleCents: 0 });
    expect(ledgerLoans(snapshot.entries)).toMatchObject({ payableCents: 42000, receivableCents: 0 });
    expect(await controller.command(request)).toEqual(reply);
    expect(ledger.snapshot().entries).toHaveLength(4);
    expect(payloads).toHaveLength(2);
  });

  it('resolves same-command principal references and keeps interest separate from partial repayment', async () => {
    const { controller, ledger } = setup([route, { kind: 'mutate', changes: [
      { type: 'createEntry', key: 'new:0', values: values('loan_borrow', '合成短借', 24000, 24000, { counterparty: '合成同学乙' }) },
      { type: 'createEntry', key: 'new:1', values: values('loan_repay', '合成部分归还', 6000, -6000, { counterparty: '合成同学乙', relatedEntryIds: ['new:0'] }) },
      { type: 'createEntry', key: 'new:2', values: values('expense', '合成借款利息', 300, -300, { personalCents: 300 }) },
    ] }]);
    const result = await controller.command({ operationId: 'same-command-repay', text: '合成同学乙今天借我240元到微信，我已归还这笔本金60元并另付利息3元，均微信' });
    expect(result.ok).toBe(true);
    const snapshot = ledger.snapshot('2026-10');
    const borrowed = snapshot.entries.find(entry => entry.kind === 'loan_borrow')!;
    expect(snapshot.entries.find(entry => entry.kind === 'loan_repay')?.relatedEntryIds).toEqual([borrowed.id]);
    expect(ledgerLoans(snapshot.entries)).toMatchObject({ payableCents: 18000 });
    expect(snapshot.summary).toMatchObject({ personalCents: 300, incomeCents: 0, actualPaidCents: 6300 });
  });

  it('collects a previous month loan and separately records interest, without duplicate principal on replay', async () => {
    const { controller, ledger, payloads } = setup([route, { kind: 'mutate', changes: [
      { type: 'createEntry', key: 'new:0', values: values('loan_collect', '合成收回本金', 15000, 15000, { counterparty: '合成同学丙', relatedEntryIds: ['old-lend'] }) },
      { type: 'createEntry', key: 'new:1', values: values('income', '合成收到利息', 200, 200, { incomeCents: 200 }) },
    ] }]);
    seed(ledger, [principal('old-lend', 'loan_lend', 15000, '合成同学丙')]);
    const request = { operationId: 'collect-older-loan', text: '合成同学丙还了上个月我借给他的150元本金，另付2元利息到微信' };
    const result = await controller.command(request);
    expect(result.ok).toBe(true);
    expect(ledgerLoans(ledger.snapshot().entries)).toMatchObject({ receivableCents: 0, items: [{ principalCents: 15000, settledCents: 15000, outstandingCents: 0 }] });
    expect(ledger.snapshot('2026-10').summary).toMatchObject({ personalCents: 0, incomeCents: 200 });
    expect(await controller.command(request)).toEqual(result);
    expect(payloads).toHaveLength(2);
  });

  it('queries old debts across the current ledger month and includes partial settlements from a later month', async () => {
    const { controller, ledger } = setup([route, { kind: 'query', query: { search: '合成同学丁' }, detail: 'loans' }]);
    const borrowed = principal('september-debt', 'loan_borrow', 18000, '合成同学丁');
    const partial = LedgerEntrySchema.parse({ id: 'october-repay', ...values('loan_repay', '合成十月还款', 7000, -7000, { counterparty: '合成同学丁', relatedEntryIds: [borrowed.id] }), version: 1, createdAt: now, updatedAt: now });
    seed(ledger, [borrowed, partial, principal('other-debt', 'loan_borrow', 9900, '合成同学戊')]);
    const beforeQuery = ledger.snapshot();
    const result = await controller.command({ operationId: 'query-current-debt', text: '我还欠合成同学丁多少本金', domain: 'ledger', ledgerView: { month: '2026-10', tab: 'flows' } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('Expected query result');
    expect(result.data.reply).toContain('待还 ¥110.00');
    expect(result.data.reply).toContain('已归还 ¥70.00');
    expect(result.data.reply).not.toContain('合成同学戊');
    expect(ledger.snapshot()).toEqual(beforeQuery);
  });

  it('records explicitly untracked historical repayment as an unlinked cash movement, without inventing a debt or calling it settled', async () => {
    const { controller, ledger } = setup([route, { kind: 'mutate', changes: [
      { type: 'createEntry', key: 'new:0', values: values('loan_repay', '合成历史借款归还', 5000, -5000, { counterparty: '合成同学己', note: '原借款未录入，剩余未知' }) },
    ] }]);
    const result = await controller.command({ operationId: 'unlinked-historical-repay', text: '归还合成同学己50元本金，微信，原借款没有记在这里' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error('Expected saved result');
    expect(result.data.reply).toContain('剩余本金未知');
    expect(result.data.reply).toContain('未扣减任何已知借款');
    expect(result.data.reply).not.toContain('已结清');
    expect(ledger.snapshot().entries).toHaveLength(1);
    expect(ledgerLoans(ledger.snapshot().entries).unlinked).toHaveLength(1);
  });

  it('keeps an ambiguous direction or allocation as clarification without writing any loan', async () => {
    const { controller, ledger } = setup([route, { kind: 'clarification', question: '这 80 元是你收到的借款，还是你转给对方的借款？' }]);
    const result = await controller.command({ operationId: 'ambiguous-borrow', text: '合成同学借我80' });
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'clarification' } } });
    expect(ledger.snapshot().entries).toHaveLength(0);
  });
});
