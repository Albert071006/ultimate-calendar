import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, LedgerQuerySchema, ledgerQueryWithDefaultMonth, type LedgerEntry, type LedgerQuery } from '../shared/ledger';
import { normalizeLedgerQueryScope } from '../ai/ledger-query';
import { LedgerService } from './service';
import { ledgerEntryMatches, summarizeLedger } from './summary';

const now = '2026-11-07T06:00:00Z';
const services: LedgerService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function entry(id: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return LedgerEntrySchema.parse({ id, kind: 'expense', title: `合成项目${id}`, category: '活动', date: '2026-11-01', month: '2026-11',
    amountCents: 1000, personalCents: 1000, cashflows: [{ accountId: 'alipay', deltaCents: -1000 }],
    version: 1, createdAt: now, updatedAt: now, ...extra });
}
function fixture(entries: LedgerEntry[]) {
  const service = new LedgerService(':memory:', { now: () => new Date(now) }); services.push(service);
  service.import({ format: 'ultimate-calendar-ledger', formatVersion: 1, entries, balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [] }, 'synthetic-query-scope');
  return service;
}

describe('scoped ledger queries', () => {
  it('separates birthday notes from unrelated records sharing the same batch transcript', () => {
    const originalText = '合成批次：生日活动的8笔费用，以及普通午饭。';
    const ledger = fixture([...Array.from({ length: 8 }, (_, index) => entry(`party-${index}`, { note: '生日活动', originalText })),
      entry('lunch', { title: '合成普通午饭', note: '普通午饭', originalText })]);
    const before = ledger.snapshot('2026-11');
    const legacy = ledger.query({ month: '2026-11', search: '生日' });
    expect(legacy.entries).toHaveLength(9);
    const result = ledger.query(normalizeLedgerQueryScope({ month: '2026-11', search: '生日' }));
    expect(result.entries).toHaveLength(8);
    expect(result.entries.some(value => value.id === 'lunch')).toBe(false);
    expect(result.summary.personalCents).toBe(8000);
    expect(result.summary.actualPaidCents).toBe(8000);
    expect(ledger.query({ month: '2026-11', search: '生日', searchFields: ['originalText'] }).entries).toHaveLength(9);
    expect(ledger.snapshot('2026-11')).toEqual(before);
  });

  it('respects note-only, title-only and counterparty-only searches', () => {
    const ledger = fixture([entry('note', { note: 'Birthday' }), entry('title', { title: 'Birthday' }),
      entry('person', { counterparty: 'Birthday' }), entry('source', { originalText: 'Birthday' })]);
    for (const [field, id] of [['note', 'note'], ['title', 'title'], ['counterparty', 'person'], ['originalText', 'source']] as const) {
      expect(ledger.query({ month: '2026-11', search: 'birthday', searchFields: [field] }).entries.map(value => value.id)).toEqual([id]);
    }
  });

  it('intersects exact IDs with every other filter and never revives voided records', () => {
    const selected = entry('selected', { note: '生日' });
    const voided = entry('voided', { note: '生日', voided: true });
    const ledger = fixture([selected, voided, entry('other', { note: '生日' })]);
    expect(ledger.query({ month: '2026-11', entryIds: ['selected', 'selected', 'voided', 'missing'], search: '生日', searchFields: ['note'] }).entries.map(value => value.id)).toEqual(['selected']);
    for (const filter of [{ month: '2026-10' }, { from: '2026-11-02' }, { to: '2026-10-31' }, { accountId: 'wechat' }, { category: '餐饮' }, { search: '其他' }]) {
      expect(ledger.query({ entryIds: ['selected'], ...filter }).entries).toEqual([]);
    }
    expect(ledgerEntryMatches(voided, { entryIds: ['voided'] })).toBe(false);
  });

  it('treats empty or unknown exact IDs as an empty result, including all totals', () => {
    const ledger = fixture([entry('expense')]);
    for (const entryIds of [[], ['missing']]) {
      const result = ledger.query({ month: '2026-11', entryIds });
      expect(result.entries).toEqual([]);
      expect(result.summary).toMatchObject({ personalCents: 0, actualPaidCents: 0, incomeCents: 0, categories: [], days: [] });
      expect(result.receivables.items).toEqual([]);
    }
  });

  it('keeps cross-month group adjustments exact and does not invent allocation to a selected subset', () => {
    const ledger = fixture([entry('first', { note: '生日' }), entry('second', { note: '生日' }), entry('receipt', {
      kind: 'reimbursement', title: '合成次月报销', month: '2026-12', date: '2026-12-01', amountCents: 600, personalCents: 0,
      cashflows: [{ accountId: 'wechat', deltaCents: 600 }], adjustments: [{ targetEntryIds: ['first', 'second'], amountCents: 600, note: '' }],
    })]);
    const both = ledger.query({ month: '2026-11', entryIds: ['first', 'second'] });
    expect(both.summary).toMatchObject({ personalCents: 1400, unallocatedAdjustmentCents: 0 });
    const one = ledger.query({ month: '2026-11', entryIds: ['first'] });
    expect(one.summary).toMatchObject({ personalCents: 1000, unallocatedAdjustmentCents: 600 });
    expect(ledger.query({ month: '2026-11', search: '生日', searchFields: ['note'] }).summary.personalCents).toBe(1400);
  });

  it('validates bounded fields and exact selections without changing old query payloads', () => {
    expect(LedgerQuerySchema.parse({ search: '生日' })).toEqual({ search: '生日' });
    expect(LedgerQuerySchema.parse({ entryIds: [] })).toEqual({ entryIds: [] });
    for (const value of [{ searchFields: [] }, { searchFields: ['cashflows'] }, { searchFields: Array(5).fill('note') }, { entryIds: Array(1001).fill('a') }, { entryIds: [''] }]) {
      expect(LedgerQuerySchema.safeParse(value).success).toBe(false);
    }
  });

  it('selects exact historical records across months without implicitly applying the current month', () => {
    const ledger = fixture([entry('old', { month: '2026-09', date: '2026-09-12' }),
      entry('older', { month: '2026-08', date: '2026-08-15' }), entry('current'),
      entry('voided', { month: '2026-09', date: '2026-09-12', voided: true })]);
    const query = { entryIds: ['old', 'older', 'old', 'voided', 'missing'] };
    const result = ledger.query(query);
    expect(result.entries.map(value => value.id)).toEqual(['old', 'older']);
    expect(result.summary).toMatchObject({ personalCents: 2000, actualPaidCents: 2000, incomeCents: 0,
      categories: [{ category: '活动', cents: 2000 }], days: [{ date: '2026-08-15', cents: 1000 }, { date: '2026-09-12', cents: 1000 }] });
    expect(result.summary.accounts.find(account => account.id === 'alipay')!.periodChangeCents).toBe(-2000);
    expect(summarizeLedger(ledger.exportJson(), query, new Date(now))).toEqual(result.summary);
    expect(ledger.query().entries.map(value => value.id)).toEqual(['current']);
    expect(ledger.query({ search: '合成', category: '活动' }).entries.map(value => value.id)).toEqual(['current']);
  });

  it('intersects explicit periods with historical IDs instead of widening either filter', () => {
    const ledger = fixture([entry('old', { month: '2026-09', date: '2026-09-12' }),
      entry('older', { month: '2026-08', date: '2026-08-15' }), entry('current')]);
    const entryIds = ['old', 'older', 'current'];
    for (const filter of [{ month: '2026-09' }, { from: '2026-09-01', to: '2026-10-31' }, { from: '2026-09-12', month: '2026-09' }]) {
      const result = ledger.query({ entryIds, ...filter });
      expect(result.entries.map(value => value.id)).toEqual(['old']);
      expect(result.summary.personalCents).toBe(1000);
    }
    const mismatch = ledger.query({ entryIds, month: '2026-08', from: '2026-09-01' });
    expect(mismatch.entries).toEqual([]);
    expect(mismatch.summary.personalCents).toBe(0);
  });

  it('keeps empty exact selections empty without a month and preserves normal query defaults', () => {
    const ledger = fixture([entry('old', { month: '2026-09', date: '2026-09-12' }), entry('current')]);
    const query: LedgerQuery = { entryIds: [] };
    expect(ledgerQueryWithDefaultMonth(query, new Date(now))).toEqual(query);
    expect(query).toEqual({ entryIds: [] });
    expect(ledgerQueryWithDefaultMonth({}, new Date(now))).toEqual({ month: '2026-11' });
    expect(ledgerQueryWithDefaultMonth({ entryIds: undefined }, new Date(now))).toEqual({ entryIds: undefined, month: '2026-11' });
    const result = ledger.query(query);
    expect(result.entries).toEqual([]);
    expect(result.receivables).toMatchObject({ cents: 0, items: [], entryIds: [] });
    expect(result.summary).toMatchObject({ actualPaidCents: 0, personalCents: 0, incomeCents: 0, familyUsageCents: 0,
      uncertainDateCents: 0, excludedUncertainDateCents: 0, unallocatedAdjustmentCents: 0, categories: [], days: [] });
    expect(result.summary.accounts.every(account => account.periodChangeCents === 0)).toBe(true);
  });

  it('includes a selected old record with an uncertain day, excluding it only for an explicit date range', () => {
    const ledger = fixture([entry('uncertain', { month: '2026-09', date: null, dateNote: '仅确认月份' }), entry('current')]);
    const all = ledger.query({ entryIds: ['uncertain'] });
    expect(all.entries.map(value => value.id)).toEqual(['uncertain']);
    expect(all.summary).toMatchObject({ personalCents: 1000, uncertainDateCents: 1000, excludedUncertainDateCents: 0 });
    const range = ledger.query({ entryIds: ['uncertain'], from: '2026-09-01', to: '2026-09-30' });
    expect(range.entries).toEqual([]);
    expect(range.summary).toMatchObject({ personalCents: 0, uncertainDateCents: 0, excludedUncertainDateCents: 1000 });
  });

  it('settles historical selected expenses using later adjustment receipts even when those receipts are not selected', () => {
    const ledger = fixture([entry('old-a', { month: '2026-09', date: '2026-09-12' }),
      entry('old-b', { month: '2026-09', date: '2026-09-13' }),
      entry('older', { month: '2026-08', date: '2026-08-15' }), entry('current'),
      entry('receipt', { kind: 'reimbursement', title: '合成后续报销', amountCents: 1300, personalCents: 0,
        cashflows: [{ accountId: 'wechat', deltaCents: 1300 }], adjustments: [
          { targetEntryIds: ['old-a', 'old-b'], amountCents: 600, note: '组合冲减' },
          { targetEntryIds: ['older'], amountCents: 700, note: '单独冲减' },
        ] })]);
    const all = ledger.query({ entryIds: ['old-a', 'old-b', 'older'] });
    expect(all.entries.map(value => value.id)).toEqual(['old-a', 'old-b', 'older']);
    expect(all.summary).toMatchObject({ personalCents: 1700, actualPaidCents: 3000, unallocatedAdjustmentCents: 0 });
    expect(all.summary.accounts.find(account => account.id === 'wechat')!.periodChangeCents).toBe(0);
    const partial = ledger.query({ entryIds: ['old-a', 'older'] });
    expect(partial.summary).toMatchObject({ personalCents: 1300, unallocatedAdjustmentCents: 600 });
    expect(ledger.query({ entryIds: ['old-a', 'old-b', 'older', 'receipt'] }).summary.accounts.find(account => account.id === 'wechat')!.periodChangeCents).toBe(1300);
  });

  it('includes old selected advances and calculates later repayments before applying the exact selection', () => {
    const ledger = fixture([entry('old', { month: '2026-09', date: '2026-09-12', personalCents: 500 }),
      entry('current'), entry('receipt', { kind: 'aa_return', title: '合成后续AA', amountCents: 200, personalCents: 0,
        cashflows: [{ accountId: 'wechat', deltaCents: 200 }], relatedEntryIds: ['old'] })]);
    const result = ledger.query({ entryIds: ['old'] });
    expect(result.entries.map(value => value.id)).toEqual(['old']);
    expect(result.receivables).toMatchObject({ cents: 300, items: [{ entryId: 'old', advancedCents: 500, returnedCents: 200, outstandingCents: 300 }] });
    expect(result.summary.personalCents).toBe(500);
  });
});
