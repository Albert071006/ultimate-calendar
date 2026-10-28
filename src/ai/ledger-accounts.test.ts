import { afterEach, describe, expect, it } from 'vitest';
import { LedgerService } from '../ledger/service';
import { ledgerAccounts, type LedgerAccount, type LedgerSnapshot } from '../shared/ledger';
import { LedgerIntentSchema } from '../shared/ledger-command';
import { prepareLedgerAccounts, validateLedgerQueryAccount } from './ledger-accounts';

const services: LedgerService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function snapshot(extra: LedgerAccount[] = []): LedgerSnapshot {
  const service = new LedgerService(':memory:'); services.push(service);
  const result = service.snapshot();
  if (extra.length) result.accounts = [...ledgerAccounts(result), ...extra];
  return result;
}
const bank = (id: string, name: string, aliases: string[] = []): LedgerAccount => ({ id, name, aliases, kind: 'cash' });
const store = (id: string, name: string, aliases: string[] = []): LedgerAccount => ({ id, name, aliases, kind: 'stored' });
const request = (text: string) => ({ operationId: 'synthetic-accounts', text });
function prepare(source: LedgerSnapshot, text: string, name: string, aliases: string[] = [], kind: 'cash' | 'stored' = 'cash') {
  const intent = LedgerIntentSchema.parse({ kind: 'mutate', changes: [{ type: 'createAccount', key: 'new-account:0', name, kind, aliases }] });
  if (intent.kind !== 'mutate') throw Error('Expected mutation');
  return prepareLedgerAccounts(intent, source, request(text));
}

describe('explicit account identity guards', () => {
  const cards = () => snapshot([
    bank('boc-one', '中国银行尾号1111', ['中行', '中国银行', '日常工资卡']),
    bank('boc-two', '中国银行尾号2222', ['中行', '中国银行', '备用银行卡']),
  ]);
  it.each(['中国银行买饭20元', '中行余额多少'])('rejects choosing one of two cards from a shared bank name: %s', text => {
    const source = cards();
    for (const accountId of ['boc-one', 'boc-two']) expect(() => validateLedgerQueryAccount({ accountId }, source, request(text))).toThrow(/多张卡/);
  });
  it.each(['中国银行尾号1111买饭20元', '中行尾号1111余额多少', '日常工资卡余额多少'])('accepts an explicit tail or exclusive nickname: %s', text => {
    expect(() => validateLedgerQueryAccount({ accountId: 'boc-one' }, cards(), request(text))).not.toThrow();
  });
  it('refuses the wrong tail and does not mistake an amount for a card tail', () => {
    expect(() => validateLedgerQueryAccount({ accountId: 'boc-one' }, cards(), request('中行尾号2222买饭20元'))).toThrow(/尾号/);
    expect(() => validateLedgerQueryAccount({ accountId: 'boc-one' }, cards(), request('中国银行1111元的消费'))).toThrow(/多张卡/);
  });
  it('does not use a tail shared by two cards as unique identification', () => {
    const source = snapshot([bank('a', '中国银行生活卡尾号1234', ['中国银行']), bank('b', '中国银行备用卡尾号1234', ['中国银行'])]);
    expect(() => validateLedgerQueryAccount({ accountId: 'a' }, source, request('中国银行尾号1234余额'))).toThrow(/多张卡/);
  });
  it('requires a distinguishing label for two membership cards at the same merchant', () => {
    const source = snapshot([store('s1', '合成咖啡店会员卡尾号1111', ['合成咖啡店', '日常咖啡卡']), store('s2', '合成咖啡店会员卡尾号2222', ['合成咖啡店'])]);
    expect(() => validateLedgerQueryAccount({ accountId: 's1' }, source, request('合成咖啡店会员卡买咖啡20'))).toThrow(/多张卡/);
    for (const text of ['合成咖啡店会员卡尾号1111买咖啡20', '日常咖啡卡买咖啡20']) {
      expect(() => validateLedgerQueryAccount({ accountId: 's1' }, source, request(text))).not.toThrow();
    }
  });
  it.each(['杭州银行买饭20元', '天津银行余额多少', '中行买饭20元'])('does not map an explicitly named bank to a generic card or a different bank: %s', text => {
    const source = snapshot([bank('cmb-named', '招商银行', ['招行'])]);
    for (const accountId of ['cmb', 'cmb-named']) expect(() => validateLedgerQueryAccount({ accountId }, source, request(text))).toThrow();
  });
  it('accepts an explicitly named bank outside the abbreviation table', () => {
    const source = snapshot([bank('hangzhou', '杭州银行', [])]);
    expect(() => validateLedgerQueryAccount({ accountId: 'hangzhou' }, source, request('杭州银行余额多少'))).not.toThrow();
  });
  it('accepts explicit multi-bank transfers and two different merchant accounts in one command', () => {
    const source = snapshot([bank('boc', '中国银行', ['中行']), bank('cmb-named', '招商银行', ['招行']), bank('hangzhou', '杭州银行'), store('s1', '合成甲店会员卡', ['合成甲店']), store('s2', '合成乙店会员卡', ['合成乙店'])]);
    for (const accountId of ['boc', 'cmb-named', 'hangzhou']) expect(() => validateLedgerQueryAccount({ accountId }, source, request('中国银行转20元到招商银行，再转10元到杭州银行'))).not.toThrow();
    for (const accountId of ['s1', 's2']) expect(() => validateLedgerQueryAccount({ accountId }, source, request('合成甲店会员卡买20元，合成乙店会员卡买30元'))).not.toThrow();
    const namedCards = snapshot([bank('boc', '中国银行', ['中行']), bank('cmb-one', '招商银行尾号1234', ['招行']), bank('cmb-two', '招商银行尾号5678', ['招行'])]);
    for (const accountId of ['boc', 'cmb-one']) expect(() => validateLedgerQueryAccount({ accountId }, namedCards, request('中国银行转20元到招商银行尾号1234'))).not.toThrow();
  });
  it('ignores stale account mentions from completed history', () => {
    const source = snapshot([bank('boc', '中国银行', ['中行'])]);
    expect(() => validateLedgerQueryAccount({ accountId: 'boc' }, source, { ...request('杭州银行买饭20'), history: [
      { role: 'user', text: '中国银行买早餐10元' }, { role: 'assistant', text: '已保存', outcome: { domain: 'ledger', phase: 'saved' } },
    ] })).toThrow();
  });
});

describe('grounded new account proposals', () => {
  it.each([
    ['新建中国银行账户', '中国银行', ['招行']],
    ['新建中国银行账户，同时从招商银行消费20元', '中国银行', ['招行']],
    ['新建杭州银行账户', '杭州银行', ['中国银行']],
    ['新建中国银行账户', '中国银行', ['虚构专属卡']],
    ['新建合成咖啡店会员卡', '合成咖啡店会员卡', ['虚构店铺']],
    ['新建中国银行账户', '中国银行工资卡', []],
    ['新建中国银行账户', '杭州银行', []],
  ] as Array<[string, string, string[]]>)('rejects ungrounded or conflicting names and aliases: %s / %s', (text, name, aliases) => {
    expect(() => prepare(snapshot(), text, name, aliases)).toThrow();
  });
  it.each([
    ['新建中国银行账户', '中国银行', ['中行']], ['新建工行账户', '中国工商银行', ['工商银行', '工行']],
    ['只新建杭州银行账户，暂时不记流水', '杭州银行', []],
    ['新建合成咖啡店会员卡', '合成咖啡店会员卡', ['合成咖啡店']],
    ['新建中国银行尾号1234的卡，别名叫日常卡', '中国银行尾号1234', ['中国银行', '日常卡']],
  ] as Array<[string, string, string[]]>)('accepts grounded names, canonical abbreviations and explicit account-only requests: %s', (text, name, aliases) => {
    const plan = prepare(snapshot(), text, name, aliases, name.includes('咖啡店') ? 'stored' : 'cash');
    expect(plan.changes).toHaveLength(1); expect(plan.changes[0]).toMatchObject({ type: 'putAccount', account: { name, aliases } });
    expect(plan.resolve('new-account:0')).toMatch(/^account:/);
  });
  it('uses the immediately pending clarification as identity evidence', () => {
    const intent = LedgerIntentSchema.parse({ kind: 'mutate', changes: [{ type: 'createAccount', key: 'new-account:0', name: '杭州银行', kind: 'cash' }] });
    if (intent.kind !== 'mutate') throw Error('Expected mutation');
    const plan = prepareLedgerAccounts(intent, snapshot(), { ...request('是，单独新建'), history: [
      { role: 'user', text: '杭州银行' }, { role: 'assistant', text: '是否新建这个账户？', outcome: { domain: 'ledger', phase: 'clarification' } },
    ] });
    expect(plan.changes).toHaveLength(1);
  });
  it('reuses a unique existing name or canonical alias without creating another account', () => {
    const source = snapshot([bank('boc-existing', '中国银行', ['中行'])]);
    const plan = prepare(source, '新增中行账户', '中行');
    expect(plan.resolve('new-account:0')).toBe('boc-existing'); expect(plan.accounts).toHaveLength(7);
    expect(plan.changes).toEqual([{ type: 'putAccount', account: source.accounts!.at(-1) }]);
    expect(() => prepare(source, '新增中行账户', '中行', [], 'stored')).toThrow(/类型/);
  });
  it('does not reuse a shared alias or overwrite its aliases', () => {
    const source = snapshot([bank('boc-one', '中国银行尾号1111', ['中行']), bank('boc-two', '中国银行尾号2222', ['中行'])]);
    expect(() => prepare(source, '新建中行账户', '中行')).toThrow(/多张卡/);
  });
  it('enforces the persistence schema name and alias length before adaptation', () => {
    const change = { type: 'createAccount', key: 'new-account:0', name: '名'.repeat(100), kind: 'cash', aliases: ['别'.repeat(100)] };
    expect(LedgerIntentSchema.safeParse({ kind: 'mutate', changes: [change] }).success).toBe(true);
    expect(LedgerIntentSchema.safeParse({ kind: 'mutate', changes: [{ ...change, name: '名'.repeat(101) }] }).success).toBe(false);
    expect(LedgerIntentSchema.safeParse({ kind: 'mutate', changes: [{ ...change, aliases: ['别'.repeat(101)] }] }).success).toBe(false);
  });
});
