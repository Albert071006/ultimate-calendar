import { afterEach, describe, expect, it } from 'vitest';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createLedgerService, type LedgerService } from '../ledger/service';
import { LEDGER_ACCOUNTS } from '../shared/ledger';
import { createController } from './controller';

const now = '2026-03-09T12:00:00+08:00';
const services: Array<Repository | LedgerService> = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function setup(changes: unknown[]) {
  const repository = createRepository(':memory:'), ledger = createLedgerService(':memory:', { now: () => new Date(now) });
  services.push(repository, ledger);
  const responses: unknown[] = [{ kind: 'ledger', reply: '由账本处理' }, { kind: 'mutate', changes }];
  let calls = 0;
  const controller = createController({ repository, planner: createPlanner(repository), ledger, now: () => now, getApiKey: async () => 'synthetic-key', fetch: async () => {
    calls++; if (!responses.length) throw Error('Unexpected real or repeated AI request');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses.shift()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  } });
  return { ledger, controller, calls: () => calls };
}
function expense(key: string, title: string, accountId: string, amountCents: number) {
  return { type: 'createEntry', key, values: { kind: 'expense', title, date: '2026-03-09', month: '2026-03', category: '合成消费', amountCents, personalCents: amountCents, cashflows: [{ accountId, deltaCents: -amountCents }] } };
}

describe('assistant independent accounts through persistence', () => {
  it.each([
    { text: '合成午饭，用微信支付20元', changes: [expense('new:0', '合成午饭', 'alipay', 2000)] },
    { text: '合成午饭微信支付20元，合成晚饭支付宝支付20元', changes: [
      expense('new:0', '合成晚饭', 'wechat', 2000), expense('new:1', '合成午饭', 'alipay', 2000),
    ] },
    { text: '合成早餐微信支付20元，合成午餐支付宝支付20元', changes: [
      expense('new:0', '早饭', 'alipay', 2000), expense('new:1', '午饭', 'wechat', 2000),
    ] },
  ])('blocks a wrong wallet before writing any row for $text', async ({ text, changes }) => {
    const { ledger, controller } = setup(changes);
    const before = ledger.snapshot();
    expect(await controller.command({ operationId: 'synthetic-wallet-mismatch', text }))
      .toMatchObject({ ok: true, data: { conversationState: { phase: 'clarification' } } });
    expect(ledger.snapshot()).toEqual(before);
  });

  it.each([
    { text: '用现金支付20元合成午饭', expected: 'synthetic-cash' },
    { text: '用会员卡付20元合成午饭', expected: 'bakery' },
    { text: '合成午饭20元，微信下单，实际从支付宝余额扣款', expected: 'alipay' },
  ])('checks the unique funding account for $text', async ({ text, expected }) => {
    for (const proposed of [expected, 'wechat']) {
      const { ledger, controller } = setup([expense('new:0', '合成午饭', proposed, 2000)]);
      if (expected === 'synthetic-cash') ledger.mutate({ operationId: 'synthetic-create-cash', expectedRevision: 0, changes: [
        { type: 'putAccount', account: { id: expected, name: '现金', aliases: [], kind: 'cash' } },
      ] });
      const before = ledger.snapshot();
      expect(await controller.command({ operationId: 'synthetic-explicit-funding', text })).toMatchObject({
        ok: true, data: { conversationState: { phase: expected === proposed ? 'saved' : 'clarification' } },
      });
      if (proposed === expected) expect(ledger.snapshot().entries[0]?.cashflows).toEqual([{ accountId: expected, deltaCents: -2000 }]);
      else expect(ledger.snapshot()).toEqual(before);
    }
  });

  it.each(['cmb', 'wechat'])('checks the funding bank behind a wallet channel (proposal %s)', async accountId => {
    const { ledger, controller } = setup([expense('new:0', '合成午饭', accountId, 2000)]);
    ledger.mutate({ operationId: 'synthetic-name-bank', expectedRevision: 0, changes: [
      { type: 'putAccount', account: { ...LEDGER_ACCOUNTS.find(value => value.id === 'cmb')!, name: '招商银行', aliases: ['招行'] } },
    ] });
    const before = ledger.snapshot();
    const result = await controller.command({ operationId: 'synthetic-wallet-channel', text: '合成午饭20元，经微信渠道，实际由招商银行扣款' });
    if (accountId === 'cmb') {
      expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'saved' } } });
      expect(ledger.snapshot().entries[0]?.cashflows).toEqual([{ accountId: 'cmb', deltaCents: -2000 }]);
    } else {
      expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'clarification' } } });
      expect(ledger.snapshot()).toEqual(before);
    }
  });

  it.each([false, true])('matches accounts to amounts without punctuation (swapped %s)', async swapped => {
    const { ledger, controller } = setup([
      expense('new:0', '早饭', swapped ? 'alipay' : 'wechat', 1000),
      expense('new:1', '晚饭', swapped ? 'wechat' : 'alipay', 2000),
    ]);
    const result = await controller.command({ operationId: 'synthetic-adjacent-payments', text: '早餐微信10元晚餐支付宝20元' });
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: swapped ? 'clarification' : 'saved' } } });
    if (swapped) expect(ledger.snapshot().entries).toHaveLength(0);
    else expect(ledger.snapshot().entries.map(entry => entry.cashflows)).toEqual([
      [{ accountId: 'wechat', deltaCents: -1000 }], [{ accountId: 'alipay', deltaCents: -2000 }],
    ]);
  });

  it.each([
    { text: '早餐微信10元晚餐20元', named: 0 },
    { text: '早餐10元晚餐20元微信支付', named: 1 },
  ])('checks a single explicit wallet in a multi-entry sentence: $text', async ({ text, named }) => {
    for (const proposed of ['wechat', 'alipay']) {
      const entries = [expense('new:0', '早餐', 'alipay', 1000), expense('new:1', '晚餐', 'alipay', 2000)];
      entries[named]!.values.cashflows[0]!.accountId = proposed;
      const { ledger, controller } = setup(entries);
      const result = await controller.command({ operationId: 'synthetic-partial-wallet', text });
      const valid = proposed === 'wechat';
      expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: valid ? 'saved' : 'clarification' } } });
      expect(ledger.snapshot().entries.map(entry => entry.cashflows)).toEqual(valid ? entries.map(row => row.values.cashflows) : []);
    }
  });

  it.each([false, true])('matches each part of a split payment to its wallet (swapped %s)', async swapped => {
    const split = expense('new:0', '合成午饭', 'wechat', 2000);
    split.values.cashflows = [
      { accountId: 'wechat', deltaCents: swapped ? -1400 : -600 }, { accountId: 'alipay', deltaCents: swapped ? -600 : -1400 },
    ];
    const { ledger, controller } = setup([split]);
    const result = await controller.command({ operationId: 'synthetic-split-wallet', text: '合成午饭实付20元，微信6元，支付宝14元' });
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: swapped ? 'clarification' : 'saved' } } });
    if (swapped) expect(ledger.snapshot().entries).toHaveLength(0);
    else expect(ledger.snapshot().entries[0]?.cashflows).toEqual(split.values.cashflows);
  });

  it('creates a named bank with its transfer and purchase, replays once, and undoes the whole batch', async () => {
    const fixture = setup([
      { type: 'createAccount', key: 'new-account:0', name: '中国银行', kind: 'cash', aliases: ['中行'] },
      { type: 'createEntry', key: 'new:0', values: { kind: 'transfer', title: '合成银行间转账', date: '2026-03-09', month: '2026-03', category: '转账', amountCents: 12000, personalCents: 0, cashflows: [{ accountId: 'cmb', deltaCents: -12000 }, { accountId: 'new-account:0', deltaCents: 12000 }] } },
      expense('new:1', '合成资料购买', 'new-account:0', 2300),
    ]);
    fixture.ledger.mutate({ operationId: 'synthetic-name-bank', expectedRevision: 0, changes: [{ type: 'putAccount', account: { ...LEDGER_ACCOUNTS.find(value => value.id === 'cmb')!, name: '招商银行', aliases: ['招行'] } }] });
    const before = fixture.ledger.snapshot('2026-03');
    const request = { operationId: 'synthetic-new-bank', text: '从招商银行转120元到中国银行（中行），再从中国银行支付23元购买合成资料' };
    const result = await fixture.controller.command(request);
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'saved', domain: 'ledger' } } });
    if (!result.ok) throw Error(result.error.message);
    expect(result.data.reply).toContain('中国银行'); expect(result.data.reply).toContain('招商银行');
    const saved = fixture.ledger.snapshot('2026-03');
    expect(saved.accounts).toHaveLength(7); expect(saved.entries).toHaveLength(2);
    expect(saved.summary.accounts.find(value => value.name === '中国银行')).toMatchObject({ balanceCents: null, periodChangeCents: 9700 });
    expect(saved.summary.accounts.find(value => value.id === 'cmb')?.periodChangeCents).toBe(-12000);
    expect(saved.summary).toMatchObject({ personalCents: 2300, incomeCents: 0 });
    expect(await fixture.controller.command(request)).toEqual(result); expect(fixture.calls()).toBe(2);
    expect(fixture.ledger.snapshot('2026-03')).toEqual(saved);
    const undone = fixture.ledger.undo({ operationId: 'synthetic-undo-bank', expectedRevision: saved.revision, month: '2026-03' });
    expect(undone.snapshot.accounts).toEqual(before.accounts); expect(undone.snapshot.entries).toEqual(before.entries);
  });

  it('creates two store accounts and never spends from the legacy membership card', async () => {
    const fixture = setup([
      { type: 'createAccount', key: 'new-account:0', name: '合成花店会员卡', kind: 'stored', aliases: ['合成花店'] },
      { type: 'createAccount', key: 'new-account:1', name: '合成茶店会员卡', kind: 'stored', aliases: ['合成茶店'] },
      expense('new:0', '合成鲜花购买', 'new-account:0', 1800), expense('new:1', '合成茶叶购买', 'new-account:1', 3200),
    ]);
    const result = await fixture.controller.command({ operationId: 'synthetic-two-stores', text: '合成花店会员卡消费18元买鲜花，合成茶店会员卡消费32元买茶叶' });
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'saved' } } });
    const snapshot = fixture.ledger.snapshot('2026-03');
    expect(snapshot.accounts).toHaveLength(8);
    expect(snapshot.summary.accounts.find(value => value.name === '合成花店会员卡')).toMatchObject({ balanceCents: null, periodChangeCents: -1800 });
    expect(snapshot.summary.accounts.find(value => value.name === '合成茶店会员卡')).toMatchObject({ balanceCents: null, periodChangeCents: -3200 });
    expect(snapshot.summary.accounts.find(value => value.id === 'bakery')?.periodChangeCents).toBe(0);
    expect(new Set(snapshot.entries.flatMap(value => value.cashflows.map(flow => flow.accountId))).size).toBe(2);
    expect(snapshot.summary.personalCents).toBe(5000);
  });

  it('resolves a new bank key in a real balance and future allowance rule without inventing entries', async () => {
    const fixture = setup([
      { type: 'createAccount', key: 'new-account:0', name: '杭州银行', kind: 'cash', aliases: [] },
      { type: 'setBalance', accountId: 'new-account:0', balanceCents: 65000, date: '2026-03-09', asOf: null, timing: 'current', note: '合成实际余额' },
      { type: 'updateRules', patch: { monthlyAllowance: { enabled: true, amountCents: 90000, accountId: 'new-account:0', startMonth: '2026-04' } }, note: '下月起' },
    ]);
    const result = await fixture.controller.command({ operationId: 'synthetic-balance-new-bank', text: '建立杭州银行账户，现在余额650元，从下个月起每月生活费900元进杭州银行' });
    expect(result).toMatchObject({ ok: true, data: { conversationState: { phase: 'saved' } } });
    const snapshot = fixture.ledger.snapshot('2026-03'), account = snapshot.accounts?.find(value => value.name === '杭州银行');
    expect(account).toBeDefined(); expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.balanceSnapshots[0]?.accountId).toBe(account?.id);
    expect(snapshot.summary.accounts.find(value => value.id === account?.id)?.balanceCents).toBe(65000);
    expect(snapshot.rules.monthlyAllowance.accountId).toBe(account?.id);
    expect(snapshot.summary).toMatchObject({ personalCents: 0, incomeCents: 0 });
  });

  it('rolls back the new account if a transaction in the same proposal has invalid amounts', async () => {
    const invalid = expense('new:0', '合成消费', 'new-account:0', 2300);
    invalid.values.cashflows[0]!.deltaCents = -2200;
    const fixture = setup([{ type: 'createAccount', key: 'new-account:0', name: '中国银行', kind: 'cash', aliases: [] }, invalid]);
    const before = fixture.ledger.snapshot('2026-03');
    const result = await fixture.controller.command({ operationId: 'synthetic-invalid-bank', text: '中国银行支付23元购买合成资料' });
    expect(result.ok).toBe(false); expect(fixture.ledger.snapshot('2026-03')).toEqual(before);
  });
});
