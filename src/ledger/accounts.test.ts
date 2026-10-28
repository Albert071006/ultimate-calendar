import { afterEach, describe, expect, it } from 'vitest';
import { LEDGER_ACCOUNTS, LedgerAccountSchema, LedgerDataSchema, LedgerEntryDraftSchema, LedgerImportPayloadSchema,
  LedgerSnapshotSchema, ledgerAccounts, type LedgerAccount, type LedgerEntryDraft, type LedgerMutationRequest } from '../shared/ledger';
import { LedgerService, LedgerValidationRejection, readLedgerDatabase, replaceLedgerDatabase } from './service';
import { openDatabase } from '../storage/database';

const services: LedgerService[] = [];
const now = new Date('2026-10-28T12:00:00Z');
afterEach(() => { for (const ledger of services.splice(0)) ledger.close(); });
function service() { const ledger = new LedgerService(':memory:', { now: () => now }); services.push(ledger); return ledger; }
function account(id = 'bank-a', name = '合成银行甲', kind: LedgerAccount['kind'] = 'cash'): LedgerAccount {
  return { id, name, kind, aliases: kind === 'cash' ? ['银行卡'] : ['会员卡'] };
}
function expense(id: string, accountId: string | null, extra: Partial<LedgerEntryDraft> = {}): LedgerEntryDraft {
  return LedgerEntryDraftSchema.parse({ id, kind: 'expense', date: '2026-10-28', month: '2026-10', title: `合成消费 ${id}`, category: '其他',
    amountCents: 100, personalCents: 100, cashflows: [{ accountId, deltaCents: -100 }], ...extra });
}
function put(entry: LedgerEntryDraft): LedgerMutationRequest['changes'][number] {
  return { type: 'putEntry', entry, expectedVersion: null, confirmDuplicate: false, note: '' };
}
function mutate(ledger: LedgerService, changes: LedgerMutationRequest['changes']) {
  const expectedRevision = ledger.snapshot().revision;
  return ledger.mutate({ operationId: `synthetic-${expectedRevision}`, expectedRevision, changes });
}
function balance(id: string, accountId: string, cents: number): LedgerMutationRequest['changes'][number] {
  return { type: 'setBalance', snapshot: { id, accountId, balanceCents: cents, date: '2026-10-27', asOf: null, coveredEntryIds: [], note: '', sourceId: null } };
}

describe('independent bank and merchant accounts', () => {
  it('reads legacy payloads without adding an accounts field or changing stored bytes', () => {
    const ledger = service(); mutate(ledger, [put(expense('legacy', 'cmb'))]);
    const db = (ledger as unknown as { db: { prepare(sql: string): { get(): { payload: string } } } }).db;
    const before = db.prepare('SELECT payload FROM ledger_state WHERE id=1').get().payload;
    const snapshot = ledger.snapshot(); const exported = ledger.exportJson(); ledger.query({ accountId: 'cmb' });
    expect(snapshot).not.toHaveProperty('accounts'); expect(exported).not.toHaveProperty('accounts');
    expect(ledgerAccounts(snapshot)).toBe(LEDGER_ACCOUNTS);
    expect(LedgerSnapshotSchema.parse(snapshot)).toEqual(snapshot); expect(LedgerImportPayloadSchema.parse(exported)).toEqual(exported);
    expect(db.prepare('SELECT payload FROM ledger_state WHERE id=1').get().payload).toBe(before);
  });
  it('keeps two bank cards and two merchants separate even when aliases overlap', () => {
    const ledger = service();
    mutate(ledger, [account('bank-a', '合成银行甲一号卡'), account('bank-b', '合成银行甲二号卡'), account('shop-a', '合成甲店会员卡', 'stored'), account('shop-b', '合成乙店会员卡', 'stored')]
      .map(value => ({ type: 'putAccount', account: value })));
    mutate(ledger, [balance('bank-a-balance', 'bank-a', 10000), balance('bank-b-balance', 'bank-b', 20000), balance('shop-a-balance', 'shop-a', 3000), balance('shop-b-balance', 'shop-b', 4000)]);
    mutate(ledger, [put(expense('first-bank', 'bank-a')), put(expense('second-bank', 'bank-b', { amountCents: 200, personalCents: 200, cashflows: [{ accountId: 'bank-b', deltaCents: -200 }] })),
      put(expense('first-shop', 'shop-a')), put(expense('gift', 'shop-b', { kind: 'bonus', amountCents: 500, personalCents: 0, cashflows: [{ accountId: 'shop-b', deltaCents: 500 }] })),
      put(expense('borrow', 'bank-b', { kind: 'loan_borrow', amountCents: 700, personalCents: 0, cashflows: [{ accountId: 'bank-b', deltaCents: 700 }] }))]);
    const snapshot = ledger.snapshot();
    expect(ledgerAccounts(snapshot)).toHaveLength(10);
    expect(snapshot.summary.accounts.filter(item => ['bank-a', 'bank-b', 'shop-a', 'shop-b'].includes(item.id))).toMatchObject([
      { id: 'bank-a', name: '合成银行甲一号卡', balanceCents: 9900, periodChangeCents: -100 },
      { id: 'bank-b', name: '合成银行甲二号卡', balanceCents: 20500, periodChangeCents: 500 },
      { id: 'shop-a', name: '合成甲店会员卡', balanceCents: 2900 }, { id: 'shop-b', name: '合成乙店会员卡', balanceCents: 4500 },
    ]);
    expect(ledger.query({ accountId: 'bank-a' }).entries.map(item => item.id)).toEqual(['first-bank']);
    expect(ledger.exportCsv()).toContain('合成银行甲二号卡 7.00'); expect(ledger.exportCsv()).toContain('合成乙店会员卡 5.00');
  });
  it('keeps a new unverified account balance unknown rather than assuming zero or deriving it from activity alone', () => {
    const ledger = service(); mutate(ledger, [{ type: 'putAccount', account: account() }, put(expense('new-card-expense', 'bank-a'))]);
    expect(ledger.snapshot().summary.accounts.find(item => item.id === 'bank-a')).toMatchObject({ balanceCents: null, snapshotDate: null, periodChangeCents: -100 });
    expect(ledger.snapshot().summary.cashBalanceCents).toBeNull();
  });
  it('creates a card and records a transaction atomically, replays once, and undo removes the first materialized directory', () => {
    const ledger = service();
    const request: LedgerMutationRequest = { operationId: 'create-and-pay', expectedRevision: 0,
      changes: [{ type: 'putAccount', account: account() }, put(expense('new-card-expense', 'bank-a'))] };
    const saved = ledger.mutate(request);
    expect(saved.snapshot.accounts).toHaveLength(7); expect(saved.snapshot.entries).toHaveLength(1);
    expect(ledger.mutate(request).status).toBe('already_saved'); expect(ledger.snapshot().revision).toBe(1);
    const undone = ledger.undo({ operationId: 'undo-create-and-pay', expectedRevision: 1 });
    expect(undone.snapshot).not.toHaveProperty('accounts'); expect(undone.snapshot.entries).toEqual([]);
    expect(ledger.mutate(request).status).toBe('already_saved'); expect(ledger.snapshot()).not.toHaveProperty('accounts');
  });
  it('does not leave a newly created account or audit record behind when another change fails', () => {
    const ledger = service(); const before = ledger.snapshot();
    expect(() => mutate(ledger, [{ type: 'putAccount', account: account() }, put(expense('valid', 'bank-a')), put(expense('invalid', 'missing'))]))
      .toThrow(LedgerValidationRejection);
    expect(ledger.snapshot()).toEqual(before);
  });
  it('renames an existing account without changing references and undo restores the original label', () => {
    const ledger = service(); mutate(ledger, [put(expense('existing', 'cmb'))]); const before = ledger.snapshot();
    mutate(ledger, [{ type: 'putAccount', account: { ...LEDGER_ACCOUNTS.find(item => item.id === 'cmb')!, name: '合成已确认银行卡' } }]);
    expect(ledger.snapshot().entries).toEqual(before.entries); expect(ledger.exportCsv()).toContain('合成已确认银行卡 -1.00');
    ledger.undo({ operationId: 'undo-rename', expectedRevision: ledger.snapshot().revision });
    expect(ledger.snapshot()).not.toHaveProperty('accounts'); expect(ledger.snapshot().entries).toEqual(before.entries);
  });
});

describe('account directory validation', () => {
  it('normalizes names and aliases while requiring distinct account names', () => {
    expect(LedgerAccountSchema.parse({ ...account(), name: '  合成银行卡  ', aliases: ['  银行卡  '] })).toMatchObject({ name: '合成银行卡', aliases: ['银行卡'] });
    const ledger = service(); mutate(ledger, [{ type: 'putAccount', account: account('a', 'Synthetic Card') }]);
    const before = ledger.snapshot();
    expect(() => mutate(ledger, [{ type: 'putAccount', account: account('b', ' synthetic card ') }])).toThrow(/名称重复/);
    expect(ledger.snapshot()).toEqual(before);
  });
  it.each([
    ['default kind change', account('cmb', '银行卡', 'stored')], ['family kind change', account('family', '亲情卡', 'cash')],
    ['new family account', account('family-two', '合成另一张亲情卡', 'family')],
  ])('rejects %s', (_label, value) => {
    const ledger = service(); const before = ledger.snapshot();
    expect(() => mutate(ledger, [{ type: 'putAccount', account: value as LedgerAccount }])).toThrow(LedgerValidationRejection);
    expect(ledger.snapshot()).toEqual(before);
  });
  it('cannot change the kind of a previously created account', () => {
    const ledger = service(); mutate(ledger, [{ type: 'putAccount', account: account() }]); const before = ledger.snapshot();
    expect(() => mutate(ledger, [{ type: 'putAccount', account: account('bank-a', '合成银行甲', 'stored') }])).toThrow(/类型不能改变/);
    expect(ledger.snapshot()).toEqual(before);
  });
  it.each(['missing', 'family'])('rejects balance and allowance references to %s', id => {
    const ledger = service(); const before = ledger.snapshot();
    expect(() => mutate(ledger, [balance('invalid-balance', id, 1000)])).toThrow(LedgerValidationRejection);
    expect(() => mutate(ledger, [{ type: 'updateRules', rules: { ...before.rules, monthlyAllowance: { ...before.rules.monthlyAllowance, accountId: id } }, note: '' }])).toThrow(LedgerValidationRejection);
    expect(ledger.snapshot()).toEqual(before);
  });
  it('rejects unknown cashflow and query references', () => {
    const ledger = service();
    expect(() => mutate(ledger, [put(expense('unknown', 'unknown-bank'))])).toThrow(/不存在的账户/);
    expect(() => ledger.query({ accountId: 'unknown-bank' })).toThrow(/账户不存在/);
    expect(ledger.snapshot().entries).toEqual([]);
  });
  it.each(['cash', 'stored'] as const)('uses dynamic %s account kind for bonus and loan validation', kind => {
    const ledger = service(); const before = ledger.snapshot();
    const invalid = kind === 'cash'
      ? expense('invalid-bonus', 'new-card', { kind: 'bonus', personalCents: 0, cashflows: [{ accountId: 'new-card', deltaCents: 100 }] })
      : expense('invalid-loan', 'new-card', { kind: 'loan_borrow', personalCents: 0, cashflows: [{ accountId: 'new-card', deltaCents: 100 }] });
    expect(() => mutate(ledger, [{ type: 'putAccount', account: account('new-card', '合成新账户', kind) }, put(invalid)])).toThrow(LedgerValidationRejection);
    expect(ledger.snapshot()).toEqual(before);
  });
  it('generates configured allowance into an independently named bank account', () => {
    const ledger = service(); const rules = ledger.snapshot().rules;
    mutate(ledger, [{ type: 'putAccount', account: account() }, { type: 'updateRules', rules: { ...rules, monthlyAllowance: { enabled: true, amountCents: 1000, accountId: 'bank-a', startMonth: '2026-10' } }, note: '' }]);
    ledger.ensureMonthlyAllowance();
    expect(ledger.snapshot().entries).toMatchObject([{ incomeCents: 1000, cashflows: [{ accountId: 'bank-a', deltaCents: 1000 }] }]);
    expect(ledger.ensureMonthlyAllowance()).toBeNull();
  });
});

describe('account import, export and backup compatibility', () => {
  it('restores a full directory with renamed defaults and custom cards, including backup replacement', () => {
    const ledger = service(); mutate(ledger, [{ type: 'putAccount', account: { ...LEDGER_ACCOUNTS[2]!, name: '合成已确认银行卡' } }, { type: 'putAccount', account: account() }, put(expense('new-card-entry', 'bank-a')), balance('card-snapshot', 'bank-a', 9000)]);
    const payload = ledger.exportJson(); const other = service();
    other.import(payload, 'import-new-accounts'); other.import(payload, 'import-new-accounts');
    expect(other.snapshot().accounts).toEqual(ledger.snapshot().accounts); expect(other.snapshot().entries).toEqual(ledger.snapshot().entries);
    expect(other.snapshot().summary).toEqual(ledger.snapshot().summary);
    const db = openDatabase(':memory:');
    try {
      const { format: _format, formatVersion: _version, ...data } = payload;
      const full = LedgerDataSchema.parse({ revision: 7, ...data }); replaceLedgerDatabase(db, full);
      expect(readLedgerDatabase(db)).toEqual(full);
    } finally { db.close(); }
  });
  it('imports an old account-less package without overwriting destination labels or deleting custom cards', () => {
    const old = service(); mutate(old, [put(expense('old-cmb-entry', 'cmb'))]); const payload = old.exportJson();
    const ledger = service(); mutate(ledger, [{ type: 'putAccount', account: account() }, { type: 'putAccount', account: { ...LEDGER_ACCOUNTS[2]!, name: '合成已确认银行卡' } }]);
    const before = ledger.snapshot().accounts;
    ledger.import(payload, 'import-old');
    expect(ledger.snapshot().accounts).toEqual(before); expect(ledger.snapshot().entries[0]?.cashflows[0]?.accountId).toBe('cmb');
    expect(ledger.exportCsv()).toContain('合成已确认银行卡 -1.00');
  });
  it('adds missing custom accounts during import but refuses to overwrite an existing account', () => {
    const source = service(); mutate(source, [{ type: 'putAccount', account: account() }, put(expense('source-entry', 'bank-a'))]);
    const ledger = service(); mutate(ledger, [put(expense('target-entry', 'alipay'))]); ledger.import(source.exportJson(), 'merge-new-card');
    expect(ledger.snapshot().accounts).toHaveLength(7); expect(ledger.snapshot().entries).toHaveLength(2);
    const conflicting = source.exportJson(); conflicting.accounts = conflicting.accounts!.map(item => item.id === 'bank-a' ? { ...item, name: '合成冲突名称' } : item);
    const before = ledger.snapshot(); expect(() => ledger.import(conflicting, 'conflict')).toThrow(/未覆盖账户目录/);
    expect(ledger.snapshot()).toEqual(before);
  });
  it.each(['missing-default', 'duplicate-id', 'duplicate-name', 'extra-family'] as const)('rejects an invalid imported account directory: %s', invalid => {
    const ledger = service(); const before = ledger.snapshot(); const payload = ledger.exportJson();
    payload.accounts = structuredClone([...LEDGER_ACCOUNTS]);
    if (invalid === 'missing-default') payload.accounts = payload.accounts.filter(item => item.id !== 'cmb');
    if (invalid === 'duplicate-id') payload.accounts.push({ ...LEDGER_ACCOUNTS[0]! });
    if (invalid === 'duplicate-name') payload.accounts.push(account('another', LEDGER_ACCOUNTS[0]!.name));
    if (invalid === 'extra-family') payload.accounts.push(account('extra-family', '合成额外亲情卡', 'family'));
    expect(() => ledger.import(payload, `invalid-${invalid}`)).toThrow(); expect(ledger.snapshot()).toEqual(before);
  });
});
