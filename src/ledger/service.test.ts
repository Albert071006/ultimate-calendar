import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LEDGER_RULES, LEDGER_ACCOUNTS, LedgerEntryDraftSchema, LedgerImportPayloadSchema, ledgerAllowanceKey, type LedgerEntry, type LedgerEntryDraft, type LedgerMutationRequest } from '../shared/ledger';
import { LedgerError, LedgerService, readLedgerDatabase, replaceLedgerDatabase } from './service';
import { summarizeLedger } from './summary';
import { openDatabase } from '../storage/database';

const services: LedgerService[] = [];
const NOW = new Date('2026-10-23T12:00:00Z');
function service(now: () => Date = () => NOW) { const result = new LedgerService(':memory:', { now }); services.push(result); return result; }
afterEach(() => { for (const value of services.splice(0)) value.close(); });
function draft(overrides: Partial<LedgerEntryDraft> = {}): LedgerEntryDraft {
  return LedgerEntryDraftSchema.parse({ id: 'lunch', kind: 'expense', date: '2026-10-23', month: '2026-10', title: '午饭', category: '餐饮', amountCents: 2000, personalCents: 2000, cashflows: [{ accountId: 'alipay', deltaCents: -2000 }], ...overrides });
}
function persisted(input: LedgerEntryDraft): LedgerEntry { return { ...input, version: 1, createdAt: '2026-10-23T09:00:00Z', updatedAt: '2026-10-23T09:00:00Z', voided: false, sameDayBalanceOrder: 'after' }; }
function save(ledger: LedgerService, entry: LedgerEntryDraft, operationId = entry.id) {
  return ledger.mutate({ operationId, expectedRevision: ledger.snapshot().revision, changes: [{ type: 'putEntry', entry, expectedVersion: null, confirmDuplicate: false, note: '' }] });
}
function importEntries(ledger: LedgerService, entries: LedgerEntry[], extra: Partial<Parameters<LedgerService['import']>[0]> = {}) {
  return ledger.import(LedgerImportPayloadSchema.parse({ format: 'ultimate-calendar-ledger', formatVersion: 1, entries, balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, ...extra }), 'import');
}

describe('local ledger transactions', () => {
  it('uses exact integer cents, saves pending accounts, and completes the original entry', () => {
    const ledger = service();
    const result = save(ledger, draft({ cashflows: [{ accountId: null, deltaCents: -2000 }] }));
    expect(result.snapshot.summary.personalCents).toBe(2000);
    expect(result.snapshot.summary.pendingAccountCount).toBe(1);
    const original = result.snapshot.entries[0]!;
    const corrected = ledger.mutate({ operationId: 'account-followup', expectedRevision: 1, changes: [{ type: 'putEntry', entry: draft(), expectedVersion: 1, confirmDuplicate: false, note: '补充支付宝' }] });
    expect(corrected.snapshot.entries).toHaveLength(1);
    expect(corrected.snapshot.entries[0]!.version).toBe(2);
    expect(corrected.snapshot.audit.at(-1)!.beforeEntries).toEqual([original]);
    expect(corrected.snapshot.summary.pendingAccountCount).toBe(0);
  });
  it('is idempotent across changed revisions and detects operation-ID misuse', () => {
    const ledger = service(); const request: LedgerMutationRequest = { operationId: 'stable', expectedRevision: 0, changes: [{ type: 'putEntry', entry: draft(), expectedVersion: null, confirmDuplicate: false, note: '' }] };
    ledger.mutate(request); save(ledger, draft({ id: 'tea', title: '茶', amountCents: 101, personalCents: 101, cashflows: [{ accountId: 'wechat', deltaCents: -101 }] }));
    expect(ledger.mutate(request).status).toBe('already_saved');
    expect(ledger.snapshot().summary.personalCents).toBe(2101);
    expect(() => ledger.mutate({ ...request, changes: [{ type: 'putEntry', entry: draft(), expectedVersion: null, confirmDuplicate: false, note: 'different' }] })).toThrow(LedgerError);
  });
  it('asks about semantic duplicates and only inserts after explicit confirmation', () => {
    const ledger = service(); save(ledger, draft());
    expect(() => save(ledger, draft({ id: 'again' }))).toThrow(/已有相同日期/);
    expect(ledger.snapshot().entries).toHaveLength(1);
    ledger.mutate({ operationId: 'confirmed', expectedRevision: 1, changes: [{ type: 'putEntry', entry: draft({ id: 'again' }), expectedVersion: null, confirmDuplicate: true, note: '是第二次消费' }] });
    expect(ledger.snapshot().entries).toHaveLength(2);
  });
  it('rolls back the whole multi-entry operation if any entry is invalid', () => {
    const ledger = service();
    expect(() => ledger.mutate({ operationId: 'batch', expectedRevision: 0, changes: [draft(), draft({ id: 'wrong', personalCents: 2500 })].map(entry => ({ type: 'putEntry', entry, expectedVersion: null, confirmDuplicate: false, note: '' })) })).toThrow();
    expect(ledger.snapshot().entries).toEqual([]); expect(ledger.snapshot().revision).toBe(0);
  });
  it('prevents stale writes and keeps undo atomic and idempotent', () => {
    const ledger = service(); save(ledger, draft());
    expect(() => ledger.mutate({ operationId: 'stale', expectedRevision: 0, changes: [{ type: 'voidEntry', id: 'lunch', expectedVersion: 1, note: '' }] })).toThrow(/已更新/);
    const undone = ledger.undo({ operationId: 'undo1', expectedRevision: 1 });
    expect(undone.snapshot.entries).toEqual([]); expect(undone.snapshot.audit.at(-1)!.action).toBe('撤销账本操作');
    expect(ledger.undo({ operationId: 'undo1', expectedRevision: 1 }).status).toBe('already_saved');
    expect(() => ledger.undo({ operationId: 'undo2', expectedRevision: 2 })).toThrow(/没有可撤销/);
  });
  it('does not guess personal responsibility for an AA payment', () => {
    const ledger = service(); save(ledger, draft({ personalCents: null }));
    expect(ledger.snapshot().summary.personalCents).toBe(0); expect(ledger.snapshot().summary.pendingPersonalCount).toBe(1);
  });
});

describe('separate cash flow, expense, and associated adjustments', () => {
  it('AA cross-account repayment does not reduce already-net personal spending again', () => {
    const ledger = service();
    save(ledger, draft({ amountCents: 10570, personalCents: 5270, cashflows: [{ accountId: 'alipay', deltaCents: -10570 }] }));
    save(ledger, draft({ id: 'aa', kind: 'aa_return', title: '同学 AA 返款', amountCents: 5300, personalCents: 0, cashflows: [{ accountId: 'wechat', deltaCents: 5300 }], relatedEntryIds: ['lunch'] }));
    const summary = ledger.snapshot().summary;
    expect(summary.personalCents).toBe(5270); expect(summary.incomeCents).toBe(0);
    expect(summary.accounts.find(account => account.id === 'alipay')!.periodChangeCents).toBe(-10570);
    expect(summary.accounts.find(account => account.id === 'wechat')!.periodChangeCents).toBe(5300);
  });
  it('a November refund adjusts October spending only and refuses a second excess reduction', () => {
    const ledger = service(() => new Date('2026-11-03T12:00:00Z')); save(ledger, draft());
    const refund = draft({ id: 'refund', date: '2026-11-02', month: '2026-11', kind: 'refund', title: '午饭退款', personalCents: 0, cashflows: [{ accountId: 'wechat', deltaCents: 2000 }], adjustments: [{ targetEntryIds: ['lunch'], amountCents: 2000, note: '' }] });
    save(ledger, refund);
    expect(ledger.snapshot('2026-10').summary.personalCents).toBe(0);
    expect(ledger.snapshot('2026-11').summary.personalCents).toBe(0); expect(ledger.snapshot('2026-11').summary.incomeCents).toBe(0);
    expect(ledger.snapshot('2026-11').summary.accounts.find(account => account.id === 'wechat')!.periodChangeCents).toBe(2000);
    expect(() => save(ledger, { ...refund, id: 'again', title: '重复报销' })).toThrow(/超过原个人开销/);
    expect(() => ledger.mutate({ operationId: 'void-original', expectedRevision: 2, changes: [{ type: 'voidEntry', id: 'lunch', expectedVersion: 1, note: '' }] })).toThrow(/原消费/);
  });
  it('preserves synthetic group reimbursement, netted expenses, unrelated refunds, and stored-value returns', () => {
    const ledger = service();
    importEntries(ledger, [
      persisted(draft({ id: 'flight1', title: '合成车票甲', category: '交通', amountCents: 21000, personalCents: 21000, cashflows: [{ accountId: 'wechat', deltaCents: -21000 }] })),
      persisted(draft({ id: 'flight2', title: '合成车票乙', category: '交通', amountCents: 34000, personalCents: 34000, cashflows: [{ accountId: 'alipay', deltaCents: -34000 }] })),
      persisted(draft({ id: 'flight-return', kind: 'reimbursement', title: '合成交通报销', amountCents: 7500, personalCents: 0, cashflows: [{ accountId: 'wechat', deltaCents: 7500 }], adjustments: [{ targetEntryIds: ['flight1', 'flight2'], amountCents: 7500, note: '组级一次冲减' }] })),
      persisted(draft({ id: 'hotel', title: '合成住宿', amountCents: 12999, personalCents: 0, cashflows: [{ accountId: 'alipay', deltaCents: -12999 }] })),
      persisted(draft({ id: 'hotel-return', kind: 'reimbursement', title: '合成住宿报销', amountCents: 15000, personalCents: 0, incomeCents: 2001, cashflows: [{ accountId: 'alipay', deltaCents: 15000 }], relatedEntryIds: ['hotel'] })),
      persisted(draft({ id: 'old-refund', kind: 'refund', title: '合成旧票退款', amountCents: 45600, personalCents: 0, cashflows: [{ accountId: 'alipay', deltaCents: 45600 }], note: '原消费未入账，不冲减本月新行程' })),
      persisted(draft({ id: 'hair-return', kind: 'refund', title: '合成储值卡返款', amountCents: 6500, personalCents: 0, cashflows: [{ accountId: 'wechat', deltaCents: 6500 }] })),
    ]);
    expect(ledger.snapshot().summary.personalCents).toBe(47500);
    expect(ledger.snapshot().summary.incomeCents).toBe(2001);
    const filtered = ledger.query({ month: '2026-10', accountId: 'wechat', category: '交通' }).summary;
    expect(filtered.personalCents).toBe(21000); expect(filtered.unallocatedAdjustmentCents).toBe(7500);
  });
  it('tracks stored-value transfers and bonuses without counting them as expense or income', () => {
    const ledger = service();
    save(ledger, draft({ id: 'topup', kind: 'transfer', title: '饭卡充值', amountCents: 50000, personalCents: 0, cashflows: [{ accountId: 'alipay', deltaCents: -50000 }, { accountId: 'meal', deltaCents: 50000 }] }));
    save(ledger, draft({ id: 'gift', kind: 'bonus', title: '赠送', amountCents: 6000, personalCents: 0, cashflows: [{ accountId: 'bakery', deltaCents: 6000 }] }));
    save(ledger, draft({ cashflows: [{ accountId: 'meal', deltaCents: -2000 }] }));
    expect(ledger.snapshot().summary.personalCents).toBe(2000); expect(ledger.snapshot().summary.incomeCents).toBe(0);
    expect(ledger.snapshot().summary.accounts.find(account => account.id === 'meal')!.periodChangeCents).toBe(48000);
  });
  it('separates laptop proceeds and family-card usage from ordinary income and assets', () => {
    const ledger = service();
    save(ledger, draft({ id: 'sale', kind: 'asset_sale', title: '合成设备转让', amountCents: 50000, personalCents: 0, assetSaleCents: 50000, cashflows: [{ accountId: 'wechat', deltaCents: 50000 }] }));
    save(ledger, draft({ cashflows: [{ accountId: 'family', deltaCents: -2000 }] }));
    const summary = ledger.snapshot().summary;
    expect(summary.assetSaleCents).toBe(50000); expect(summary.incomeCents).toBe(0); expect(summary.familyUsageCents).toBe(2000);
    expect(summary.accounts.find(account => account.id === 'family')!.balanceCents).toBeNull();
  });
});

describe('balance snapshot coverage and migration safety', () => {
  it('does not debit historical covered entries again, including later account clarification/correction', () => {
    const ledger = service();
    importEntries(ledger, [persisted(draft({ date: '2026-10-03', cashflows: [{ accountId: null, deltaCents: -2000 }] }))], { balanceSnapshots: [{ id: 'baseline', accountId: 'alipay', balanceCents: 10000, date: '2026-10-23', asOf: null, recordedAt: '2026-10-23T10:00:00Z', coveredEntryIds: ['lunch'], note: '', sourceId: null }] });
    ledger.mutate({ operationId: 'clarify', expectedRevision: 1, changes: [{ type: 'putEntry', entry: draft({ date: '2026-10-03' }), expectedVersion: 1, confirmDuplicate: false, note: '旧消费补充账户' }] });
    expect(ledger.snapshot().summary.accounts[0]!.balanceCents).toBe(10000);
    save(ledger, draft({ id: 'now', title: '当前午饭', occurredAt: NOW.toISOString() }));
    expect(ledger.snapshot().summary.accounts[0]!.balanceCents).toBe(8000);
    save(ledger, draft({ id: 'backfill', title: '补录旧消费', date: '2026-10-02' }));
    const account = ledger.snapshot().summary.accounts[0]!;
    expect(account.balanceCents).toBe(8000); expect(account.pendingEntryIds).toEqual(['backfill']);
  });
  it('keeps same-day ordering unresolved when the user selects ask; reconciliation resolves pending entries', () => {
    const ledger = service();
    importEntries(ledger, [], { rules: { ...DEFAULT_LEDGER_RULES, sameDayNewEntryOrder: 'ask' }, balanceSnapshots: [{ id: 'baseline', accountId: 'alipay', balanceCents: 10000, date: '2026-10-23', asOf: null, recordedAt: '2026-10-23T10:00:00Z', coveredEntryIds: [], note: '', sourceId: null }] });
    save(ledger, draft());
    expect(ledger.snapshot().summary.accounts[0]!.pendingEntryIds).toEqual(['lunch']);
    ledger.mutate({ operationId: 'reconcile', expectedRevision: 2, changes: [{ type: 'setBalance', snapshot: { id: 'new-baseline', accountId: 'alipay', balanceCents: 8000, date: '2026-10-23', asOf: NOW.toISOString(), coveredEntryIds: ['lunch'], note: '当前余额', sourceId: null } }] });
    expect(ledger.snapshot().summary.accounts[0]!.balanceCents).toBe(8000); expect(ledger.snapshot().summary.accounts[0]!.pendingEntryIds).toEqual([]);
  });
  it('records explicit before/after answers without inventing a clock time and applies each cashflow once', () => {
    const ledger = service();
    importEntries(ledger, [], { balanceSnapshots: [{ id: 'baseline', accountId: 'alipay', balanceCents: 10000, date: '2026-10-23', asOf: null, recordedAt: '2026-10-23T10:00:00Z', coveredEntryIds: [], note: '', sourceId: null }] });
    save(ledger, draft());
    const update = (position: 'before' | 'after', version: number, operationId: string) => ledger.mutate({ operationId, expectedRevision: ledger.snapshot().revision, changes: [{ type: 'putEntry', entry: draft({ snapshotPositions: [{ snapshotId: 'baseline', position }] }), expectedVersion: version, confirmDuplicate: false, note: `用户确认在快照${position}` }] });
    update('after', 1, 'clarify-after');
    expect(ledger.snapshot().entries[0]!.occurredAt).toBeNull(); expect(ledger.snapshot().summary.accounts[0]!.balanceCents).toBe(8000);
    expect(ledger.snapshot().summary.accounts[0]!.pendingEntryIds).toEqual([]);
    update('after', 2, 'repeat-correction'); expect(ledger.snapshot().summary.accounts[0]!.balanceCents).toBe(8000);
    update('before', 3, 'correct-before'); expect(ledger.snapshot().summary.accounts[0]!.balanceCents).toBe(10000);
    expect(() => ledger.mutate({ operationId: 'unknown-ref', expectedRevision: ledger.snapshot().revision, changes: [{ type: 'putEntry', entry: draft({ snapshotPositions: [{ snapshotId: 'invented', position: 'after' }] }), expectedVersion: 4, confirmDuplicate: false, note: '' }] })).toThrow(/不存在的快照/);
  });
  it('rejects a same-day future balance observation', () => {
    const ledger = service();
    expect(() => ledger.mutate({ operationId: 'future-balance', expectedRevision: 0, changes: [{ type: 'setBalance', snapshot: { id: 'future', accountId: 'alipay', balanceCents: 10000, date: '2026-10-23', asOf: '2026-10-23T23:00:00+08:00', coveredEntryIds: [], note: '', sourceId: null } }] })).toThrow(/尚未发生/);
    expect(ledger.snapshot().balanceSnapshots).toEqual([]);
  });
  it('rejects future actual transactions while preserving historical records and default current-day consumption', () => {
    const ledger = service();
    expect(() => save(ledger, draft({ date: '2026-10-24' }))).toThrow(/尚未发生/);
    expect(() => save(ledger, draft({ date: null, month: '2026-11', dateNote: '下个月' }))).toThrow(/尚未发生/);
    expect(() => save(ledger, draft({ occurredAt: '2026-10-23T23:00:00+08:00' }))).toThrow(/尚未发生/);
    expect(ledger.snapshot().entries).toEqual([]);
    save(ledger, draft({ date: '2026-10-03' }));
    save(ledger, draft({ id: 'current', title: '今日午饭' }));
    expect(ledger.snapshot().summary.personalCents).toBe(4000);
  });
  it('keeps unknown Oct4/5 expense in the month but out of individual days', () => {
    const ledger = service(); save(ledger, draft({ date: null, dateNote: '10月4日或5日', amountCents: 2450, personalCents: 2450, cashflows: [{ accountId: null, deltaCents: -2450 }] }));
    expect(ledger.snapshot().summary.personalCents).toBe(2450); expect(ledger.snapshot().summary.uncertainDateCents).toBe(2450); expect(ledger.snapshot().summary.days).toEqual([]);
    expect(ledger.query({ from: '2026-10-04', to: '2026-10-04' }).summary.personalCents).toBe(0);
    expect(ledger.query({ from: '2026-10-04', to: '2026-10-04' }).summary.excludedUncertainDateCents).toBe(2450);
  });
  it('imports a complete backup only once and preserves correction history and private source in full export', () => {
    const ledger = service(); save(ledger, draft());
    const exported = ledger.exportJson(); const other = service(); other.import(exported, 'restore1'); other.import(exported, 'restore2');
    expect(other.snapshot().entries).toHaveLength(1); expect(other.snapshot().summary.personalCents).toBe(2000);
    const sourcePayload = { ...exported, sources: [{ id: 'old-page', label: '旧账本', importedAt: NOW.toISOString(), content: '私人原始资料', checksum: 'hash' }] };
    other.import(sourcePayload, 'source');
    expect(other.exportJson().sources[0]!.content).toBe('私人原始资料'); expect(other.snapshot().sources[0]).not.toHaveProperty('content');
  });
  it('supports old backup inspection and atomic replacement helpers without ledger tables', () => {
    const db = openDatabase(':memory:');
    expect(readLedgerDatabase(db).entries).toEqual([]);
    const ledger = service(); save(ledger, draft()); const exported = ledger.exportJson();
    const { format: _format, formatVersion: _formatVersion, ...data } = exported;
    replaceLedgerDatabase(db, { revision: 3, ...data });
    expect(readLedgerDatabase(db).entries).toHaveLength(1); db.close();
  });
});

const syntheticAllowanceRules = { ...DEFAULT_LEDGER_RULES, monthlyAllowance: { enabled: true, amountCents: 100_000, accountId: null, startMonth: '2026-10' } };
function allowanceService(now: () => Date = () => NOW) {
  const ledger = service(now);
  importEntries(ledger, [], { rules: syntheticAllowanceRules });
  return ledger;
}

describe('fixed monthly rules and safe exports', () => {
  it('starts without automatic income or assumed family limits and never treats credit cards as family cards', () => {
    const ledger = service();
    expect(ledger.snapshot().rules.monthlyAllowance).toMatchObject({ enabled: false, amountCents: 0, accountId: null });
    expect(ledger.snapshot().rules).toMatchObject({ familyMonthlyLimitCents: 0, familyActualRemainingCents: null, familyRefreshDay: null });
    expect(ledger.ensureMonthlyAllowance()).toBeNull();
    expect(ledger.snapshot().entries).toEqual([]);
    expect(ledger.snapshot().summary.incomeCents).toBe(0);
    expect(LEDGER_ACCOUNTS.find(account => account.id === 'family')?.aliases).not.toContain('信用卡');
  });
  it('binds imported allowance to the same rule-month key and never adds future months', () => {
    const ledger = service();
    importEntries(ledger, [persisted(draft({ id: 'old-015', kind: 'income', date: '2026-10-01', title: '合成生活费', amountCents: 100000, personalCents: 0, incomeCents: 100000, cashflows: [{ accountId: null, deltaCents: 100000 }], ruleKey: ledgerAllowanceKey('2026-10') }))], { rules: syntheticAllowanceRules });
    expect(ledger.ensureMonthlyAllowance()).toBeNull(); expect(ledger.snapshot().entries).toHaveLength(1);
    expect(ledger.snapshot('2026-11').summary.incomeCents).toBe(0);
  });
  it('keeps allowance idempotent, voiding does not regenerate, and rule changes affect future records only', () => {
    const ledger = allowanceService();
    ledger.ensureMonthlyAllowance(); expect(ledger.ensureMonthlyAllowance()).toBeNull();
    const key = ledgerAllowanceKey('2026-10');
    ledger.mutate({ operationId: 'not-arrived', expectedRevision: 2, changes: [{ type: 'voidEntry', id: key, expectedVersion: 1, note: '用户确认未到账' }] });
    expect(ledger.ensureMonthlyAllowance()).toBeNull(); expect(ledger.snapshot().summary.incomeCents).toBe(0);
  });
  it('catches up elapsed months once without generating a future month or undo-regenerating', () => {
    const ledger = allowanceService(() => new Date('2026-12-23T12:00:00Z'));
    ledger.ensureMonthlyAllowance();
    expect(ledger.snapshot().entries.map(entry => entry.month)).toEqual(['2026-10', '2026-11', '2026-12']);
    ledger.undo({ operationId: 'undo-december', expectedRevision: 4 });
    expect(ledger.ensureMonthlyAllowance()).toBeNull();
    const restored = service(() => new Date('2026-12-23T12:00:00Z'));
    restored.import(ledger.exportJson(), 'restore'); expect(restored.ensureMonthlyAllowance()).toBeNull();
  });
  it('resumes an allowance in January without backfilling paused November and December and can undo the rule change', () => {
    let clock = NOW;
    const ledger = allowanceService(() => clock); ledger.ensureMonthlyAllowance();
    const originalEntries = ledger.snapshot().entries;
    clock = new Date('2026-11-01T01:00:00Z');
    ledger.mutate({ operationId: 'pause', expectedRevision: ledger.snapshot().revision, changes: [{ type: 'updateRules', rules: { ...ledger.snapshot().rules, monthlyAllowance: { ...ledger.snapshot().rules.monthlyAllowance, enabled: false } }, note: '暂停生活费' }] });
    clock = new Date('2026-12-01T01:00:00Z'); expect(ledger.ensureMonthlyAllowance()).toBeNull();
    clock = new Date('2027-01-01T01:00:00Z');
    const resume = (operationId: string, startMonth: string) => ledger.mutate({ operationId, expectedRevision: ledger.snapshot().revision, changes: [{ type: 'updateRules', rules: { ...ledger.snapshot().rules, monthlyAllowance: { ...ledger.snapshot().rules.monthlyAllowance, enabled: true, startMonth } }, note: '恢复生活费' }] });
    resume('resume1', '2026-10');
    expect(ledger.snapshot().rules.monthlyAllowance.startMonth).toBe('2027-01');
    expect(ledger.snapshot().entries).toEqual(originalEntries);
    expect(ledger.snapshot().audit.at(-1)!.note).toContain('从 2027-01 恢复，不补暂停月份');
    ledger.undo({ operationId: 'undo-resume', expectedRevision: ledger.snapshot().revision });
    expect(ledger.snapshot().rules.monthlyAllowance).toMatchObject({ enabled: false, startMonth: '2026-10' });
    resume('resume-later', '2027-02'); expect(ledger.snapshot().rules.monthlyAllowance.startMonth).toBe('2027-02');
    expect(ledger.ensureMonthlyAllowance()).toBeNull();
    ledger.undo({ operationId: 'undo-later', expectedRevision: ledger.snapshot().revision });
    resume('resume2', '2026-10'); ledger.ensureMonthlyAllowance();
    expect(ledger.snapshot().entries.map(entry => entry.month)).toEqual(['2026-10', '2027-01']);
    expect(ledger.snapshot().entries[0]).toEqual(originalEntries[0]);
    expect(ledger.snapshot('2026-11').summary.incomeCents).toBe(0); expect(ledger.snapshot('2026-12').summary.incomeCents).toBe(0);
  });
  it('rejects partial ledger schemas and missing singleton rows rather than treating corruption as empty', () => {
    const partial = openDatabase(':memory:'); partial.exec('CREATE TABLE ledger_state (id INTEGER PRIMARY KEY,payload TEXT)');
    expect(() => readLedgerDatabase(partial)).toThrow(/不完整/); partial.close();
    const missing = openDatabase(':memory:'); missing.exec('CREATE TABLE ledger_state (id INTEGER PRIMARY KEY,payload TEXT); CREATE TABLE ledger_operations(id TEXT PRIMARY KEY)');
    expect(() => readLedgerDatabase(missing)).toThrow(/缺失/); missing.close();
  });
  it('exports escaped CSV with a UTF-8 BOM and no executable spreadsheet formulas', () => {
    const ledger = service(); save(ledger, draft({ title: '=HYPERLINK("bad")', note: '逗号,\n换行' }));
    const csv = ledger.exportCsv(); expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"'); expect(csv).toContain('"逗号,\n换行"');
  });
  it('summary supports deterministic account/category/date ranges without using model arithmetic', () => {
    const ledger = service(); save(ledger, draft());
    save(ledger, draft({ id: 'bus', title: '公交', category: '交通', amountCents: 200, personalCents: 200, cashflows: [{ accountId: 'wechat', deltaCents: -200 }] }));
    expect(summarizeLedger(ledger.exportJson(), { from: '2026-10-01', to: '2026-10-31', accountId: 'wechat' }, NOW).personalCents).toBe(200);
    expect(ledger.query({ category: '餐饮' }).entries.map(entry => entry.id)).toEqual(['lunch']);
  });
});
