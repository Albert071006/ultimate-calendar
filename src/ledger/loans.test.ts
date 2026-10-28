import { afterEach, describe, expect, it } from 'vitest';
import { LedgerDataSchema, LedgerEntryDraftSchema, LedgerEntrySchema, LedgerImportPayloadSchema, LedgerSnapshotSchema,
  type LedgerEntry, type LedgerEntryDraft, type LedgerMutationRequest } from '../shared/ledger';
import { ledgerLoans, type LedgerLoanKind } from '../shared/ledger-loans';
import { LedgerService, LedgerValidationRejection, readLedgerDatabase, replaceLedgerDatabase } from './service';
import { ledgerReceivable } from './receivable';
import { openDatabase } from '../storage/database';

const services: LedgerService[] = [];
const now = new Date('2026-12-01T12:00:00Z');
afterEach(() => { for (const ledger of services.splice(0)) ledger.close(); });
function service() { const ledger = new LedgerService(':memory:', { now: () => now }); services.push(ledger); return ledger; }
function loan(id: string, kind: LedgerLoanKind, amountCents = 10000, extra: Partial<LedgerEntryDraft> = {}): LedgerEntryDraft {
  const incoming = kind === 'loan_borrow' || kind === 'loan_collect';
  return LedgerEntryDraftSchema.parse({ id, kind, date: '2026-09-10', month: '2026-09', title: `合成借款 ${id}`, category: '借款',
    counterparty: '合成同学甲', amountCents, personalCents: 0, cashflows: [{ accountId: 'wechat', deltaCents: incoming ? amountCents : -amountCents }], ...extra });
}
function put(ledger: LedgerService, ...entries: LedgerEntryDraft[]) {
  const snapshot = ledger.snapshot();
  return ledger.mutate({ operationId: `put-${snapshot.revision}`, expectedRevision: snapshot.revision, changes: entries.map(entry => ({
    type: 'putEntry', entry, expectedVersion: snapshot.entries.find(old => old.id === entry.id)?.version ?? null, confirmDuplicate: false, note: '',
  })) });
}
function entry(draft: LedgerEntryDraft, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return LedgerEntrySchema.parse({ ...draft, version: 1, createdAt: '2026-09-10T12:00:00Z', updatedAt: '2026-09-10T12:00:00Z', ...extra });
}
function settlement(id: string, kind: 'loan_repay' | 'loan_collect', amount: number, original?: string, extra: Partial<LedgerEntryDraft> = {}) {
  return loan(id, kind, amount, { date: '2026-10-10', month: '2026-10', relatedEntryIds: original ? [original] : [], ...extra });
}

describe('loan principal and settlement views', () => {
  it('calculates partial and cross-month settlements separately for every principal without inferring unlinked balances', () => {
    const entries = [
      entry(loan('borrow', 'loan_borrow')), entry(loan('lend', 'loan_lend', 8000)), entry(loan('other-borrow', 'loan_borrow', 9000)),
      entry(settlement('repay1', 'loan_repay', 2500, 'borrow')), entry(settlement('repay2', 'loan_repay', 1500, 'borrow', { date: '2026-11-10', month: '2026-11' })),
      entry(settlement('collect', 'loan_collect', 3000, 'lend')),
      entry(settlement('old-repay', 'loan_repay', 1200)), entry(settlement('old-collect', 'loan_collect', 600)),
      entry(settlement('voided-repay', 'loan_repay', 6000, 'borrow'), { voided: true }), entry(loan('voided-borrow', 'loan_borrow'), { voided: true }),
    ];
    const before = structuredClone(entries);
    expect(ledgerLoans(entries)).toMatchObject({ payableCents: 15000, receivableCents: 5000, items: [
      { entryId: 'borrow', kind: 'loan_borrow', principalCents: 10000, settledCents: 4000, outstandingCents: 6000, settlements: [{ id: 'repay1' }, { id: 'repay2' }] },
      { entryId: 'lend', kind: 'loan_lend', principalCents: 8000, settledCents: 3000, outstandingCents: 5000 },
      { entryId: 'other-borrow', outstandingCents: 9000 },
    ], unlinked: [{ id: 'old-repay' }, { id: 'old-collect' }] });
    expect(entries).toEqual(before);
  });
  it('preserves old advance and credit-card repayment behavior and does not double-count new loans as receivables', () => {
    const ledger = service(); const oldKeys = Object.keys(ledger.snapshot().summary);
    const legacyAdvance = LedgerEntryDraftSchema.parse({ ...loan('legacy', 'loan_lend', 2000), kind: 'expense' });
    delete legacyAdvance.counterparty;
    put(ledger, loan('borrow', 'loan_borrow'), loan('lend', 'loan_lend', 8000), settlement('repay', 'loan_repay', 2500, 'borrow'),
      settlement('collect', 'loan_collect', 3000, 'lend'), legacyAdvance,
      LedgerEntryDraftSchema.parse({ ...loan('credit-card', 'loan_repay', 500), kind: 'repayment' }));
    const summary = ledger.query({ from: '2026-09-01', to: '2026-11-30' }).summary;
    expect(summary).toMatchObject({ actualPaidCents: 13000, personalCents: 0, incomeCents: 0, assetSaleCents: 0, pendingPersonalCount: 0 });
    expect(summary.accounts.find(account => account.id === 'wechat')?.periodChangeCents).toBe(0);
    expect(Object.keys(summary)).toEqual(oldKeys);
    expect(ledgerReceivable(ledger.snapshot().entries, {})).toMatchObject({ cents: 2000, items: [{ entryId: 'legacy' }] });
    expect(ledgerLoans(ledger.snapshot().entries)).toMatchObject({ payableCents: 7500, receivableCents: 5000 });
    expect(ledger.query({ month: '2026-09', search: '合成同学甲' }).entries.map(item => item.id)).toEqual(['borrow', 'lend', 'credit-card']);
  });
  it('keeps missing counterparties and unlinked real repayments unknown without inventing a principal', () => {
    const ledger = service();
    const unnamed = loan('unknown', 'loan_borrow', 1000, { counterparty: undefined, cashflows: [{ accountId: null, deltaCents: 1000 }] });
    put(ledger, unnamed, settlement('unlinked', 'loan_repay', 600, undefined, { counterparty: '' }));
    expect(ledgerLoans(ledger.snapshot().entries)).toMatchObject({ payableCents: 1000, receivableCents: 0,
      items: [{ counterparty: '', outstandingCents: 1000 }], unlinked: [{ id: 'unlinked', counterparty: '' }] });
    expect(ledger.snapshot('2026-09').summary.pendingAccountCount).toBe(1);
  });
});

describe('atomic loan validation', () => {
  it('distinguishes loan counterparties and original principals while retaining exact duplicate protection', () => {
    const ledger = service();
    put(ledger, loan('party-a', 'loan_borrow', 10000, { title: '合成借入', counterparty: '合成对方甲' }),
      loan('party-b', 'loan_borrow', 10000, { title: '合成借入', counterparty: '合成对方乙' }),
      loan('other-principal', 'loan_borrow', 10000, { title: '合成另一笔借入', counterparty: '合成对方甲' }));
    put(ledger, settlement('repay-a', 'loan_repay', 1000, 'party-a', { title: '合成归还', counterparty: '合成对方甲' }),
      settlement('repay-b', 'loan_repay', 1000, 'party-b', { title: '合成归还', counterparty: '合成对方乙' }),
      settlement('repay-other', 'loan_repay', 1000, 'other-principal', { title: '合成归还', counterparty: '合成对方甲' }));
    expect(ledger.snapshot().entries).toHaveLength(6);
    expect(ledgerLoans(ledger.snapshot().entries).payableCents).toBe(27000);
    const before = ledger.snapshot();
    expect(() => put(ledger, settlement('same-again', 'loan_repay', 1000, 'party-a', { title: '合成归还', counterparty: '  合成对方甲  ' })))
      .toThrowError(expect.objectContaining({ code: 'DUPLICATE' }));
    expect(() => put(ledger, loan('same-principal-again', 'loan_borrow', 10000, { title: '合成借入', counterparty: ' 合成对方甲 ' })))
      .toThrowError(expect.objectContaining({ code: 'DUPLICATE' }));
    expect(ledger.snapshot()).toEqual(before);
  });
  const invalid: Array<[string, Partial<LedgerEntryDraft>]> = [
    ['zero principal', { amountCents: 0, cashflows: [] }], ['unknown personal amount', { personalCents: null }],
    ['personal spending', { personalCents: 1 }], ['income', { incomeCents: 1 }], ['asset sale', { assetSaleCents: 1 }],
    ['adjustment', { adjustments: [{ targetEntryIds: ['original'], amountCents: 1, note: '' }] }],
    ['family account', { cashflows: [{ accountId: 'family', deltaCents: 10000 }] }],
    ['meal account', { cashflows: [{ accountId: 'meal', deltaCents: 10000 }] }],
    ['stored account', { cashflows: [{ accountId: 'bakery', deltaCents: 10000 }] }],
    ['wrong direction', { cashflows: [{ accountId: 'wechat', deltaCents: -10000 }] }],
    ['wrong amount', { cashflows: [{ accountId: 'wechat', deltaCents: 9999 }] }],
    ['linked principal', { relatedEntryIds: ['other'] }],
  ];
  it.each(invalid)('rejects %s and rolls back the complete batch', (_label, patch) => {
    const ledger = service(); const before = ledger.snapshot();
    expect(() => put(ledger, loan('valid', 'loan_lend'), loan('invalid', 'loan_borrow', 10000, patch))).toThrow(LedgerValidationRejection);
    expect(ledger.snapshot()).toEqual(before);
  });
  it.each([
    ['missing target', { relatedEntryIds: ['missing'] }], ['multiple targets', { relatedEntryIds: ['borrow', 'lend'] }],
    ['wrong direction target', { relatedEntryIds: ['lend'] }], ['counterparty mismatch', { counterparty: '合成同学乙' }],
    ['earlier day', { date: '2026-09-09', month: '2026-09' }], ['earlier unknown day', { date: null, month: '2026-08', dateNote: '具体日期待确认' }],
  ] as Array<[string, Partial<LedgerEntryDraft>]>)('rejects a settlement with %s', (_label, patch) => {
    const ledger = service(); put(ledger, loan('borrow', 'loan_borrow'), loan('lend', 'loan_lend')); const before = ledger.snapshot();
    expect(() => put(ledger, settlement('repay', 'loan_repay', 1000, 'borrow', patch))).toThrow(LedgerValidationRejection);
    expect(ledger.snapshot()).toEqual(before);
  });
  it('rejects an earlier known settlement time on the same day and accepts unknown counterparties', () => {
    const ledger = service(); put(ledger, loan('borrow', 'loan_borrow', 10000, { occurredAt: '2026-09-10T12:00:00+08:00' }));
    expect(() => put(ledger, settlement('repay', 'loan_repay', 1000, 'borrow', { date: '2026-09-10', month: '2026-09', occurredAt: '2026-09-10T11:00:00+08:00' }))).toThrow(/不能早于/);
    put(ledger, settlement('repay', 'loan_repay', 1000, 'borrow', { counterparty: '' }));
    expect(ledgerLoans(ledger.snapshot().entries).payableCents).toBe(9000);
  });
  it.each(['loan_repay', 'loan_collect'] as const)('rejects cumulative %s overpayment across months, including within a single batch', kind => {
    const ledger = service(); put(ledger, loan('principal', kind === 'loan_repay' ? 'loan_borrow' : 'loan_lend'));
    put(ledger, settlement('partial', kind, 4000, 'principal'));
    const before = ledger.snapshot();
    expect(() => put(ledger, settlement('later1', kind, 3000, 'principal'), settlement('later2', kind, 4000, 'principal', { date: '2026-11-01', month: '2026-11' }))).toThrow(/超过原始借款本金/);
    expect(ledger.snapshot()).toEqual(before);
    put(ledger, settlement('finish', kind, 6000, 'principal', { date: '2026-11-01', month: '2026-11' }));
    expect(ledgerLoans(ledger.snapshot().entries).items[0]).toMatchObject({ settledCents: 10000, outstandingCents: 0 });
  });
  it('validates corrections and voiding against live settlements, and undo restores exact balances', () => {
    const ledger = service(); put(ledger, loan('borrow', 'loan_borrow')); put(ledger, settlement('repay', 'loan_repay', 4000, 'borrow'));
    let before = ledger.snapshot();
    expect(() => put(ledger, loan('borrow', 'loan_borrow', 3000))).toThrow(/超过原始借款本金/);
    expect(() => put(ledger, settlement('repay', 'loan_repay', 11000, 'borrow'))).toThrow(/超过原始借款本金/);
    expect(ledger.snapshot()).toEqual(before);
    const voidRequest: LedgerMutationRequest = { operationId: 'void-principal', expectedRevision: before.revision,
      changes: [{ type: 'voidEntry', id: 'borrow', expectedVersion: 1, note: '' }] };
    expect(() => ledger.mutate(voidRequest)).toThrow(/有效借入本金/);
    put(ledger, settlement('repay', 'loan_repay', 3000, 'borrow'));
    expect(ledgerLoans(ledger.snapshot().entries).payableCents).toBe(7000);
    before = ledger.snapshot();
    const removed = ledger.mutate({ operationId: 'void-settlement', expectedRevision: before.revision,
      changes: [{ type: 'voidEntry', id: 'repay', expectedVersion: 2, note: '' }] });
    expect(ledgerLoans(removed.snapshot.entries).payableCents).toBe(10000);
    ledger.undo({ operationId: 'undo-settlement-void', expectedRevision: removed.snapshot.revision });
    expect(ledger.snapshot().entries).toEqual(before.entries);
    expect(ledgerLoans(ledger.snapshot().entries).payableCents).toBe(7000);
    const revision = ledger.snapshot().revision;
    const both: LedgerMutationRequest = { operationId: 'void-both', expectedRevision: revision, changes: [
      { type: 'voidEntry', id: 'borrow', expectedVersion: 1, note: '' }, { type: 'voidEntry', id: 'repay', expectedVersion: 2, note: '' },
    ] };
    expect(ledger.mutate(both).status).toBe('saved'); expect(ledger.mutate(both).status).toBe('already_saved');
    expect(ledgerLoans(ledger.snapshot().entries)).toEqual({ payableCents: 0, receivableCents: 0, items: [], unlinked: [] });
    expect(() => put(ledger, settlement('new-repay', 'loan_repay', 100, 'borrow'))).toThrow(/有效借入本金/);
  });
});

describe('loan backup compatibility', () => {
  it('retains existing entries byte-for-byte through schema parsing without adding counterparty', () => {
    const legacyDraft = LedgerEntryDraftSchema.parse({ ...loan('legacy', 'loan_lend'), kind: 'expense' }); delete legacyDraft.counterparty;
    const ledger = service(); put(ledger, legacyDraft); const legacy = ledger.snapshot().entries[0]!;
    const exported = ledger.exportJson();
    expect(LedgerImportPayloadSchema.parse(exported)).toEqual(exported);
    expect(LedgerSnapshotSchema.parse(ledger.snapshot())).toEqual(ledger.snapshot());
    expect(LedgerDataSchema.parse({ revision: 1, entries: [legacy], balanceSnapshots: [], rules: exported.rules, audit: [], sources: [] }).entries[0]).not.toHaveProperty('counterparty');
    const other = service(); other.import(exported, 'old-backup'); other.import(exported, 'old-backup-again');
    expect(other.snapshot().entries).toEqual(ledger.snapshot().entries);
    expect(ledger.exportCsv()).not.toContain('借款对方');
  });
  it('round-trips loan links, counterparties, corrections and outstanding balances through import and backup replacement', () => {
    const ledger = service(); put(ledger, loan('borrow', 'loan_borrow', 10000, { counterparty: '  合成同学甲  ' }));
    put(ledger, settlement('repay', 'loan_repay', 2000, 'borrow')); put(ledger, settlement('repay', 'loan_repay', 3000, 'borrow'));
    const exported = LedgerImportPayloadSchema.parse(ledger.exportJson());
    const other = service(); other.import(exported, 'loan-backup');
    expect(other.snapshot().entries).toEqual(ledger.snapshot().entries);
    expect(other.snapshot().audit).toEqual(expect.arrayContaining(ledger.snapshot().audit));
    expect(ledgerLoans(other.snapshot().entries)).toEqual(ledgerLoans(ledger.snapshot().entries));
    expect(other.snapshot().entries[0]?.counterparty).toBe('合成同学甲');
    expect(other.exportCsv()).toContain('借款对方'); expect(other.exportCsv()).toContain('合成同学甲');
    const db = openDatabase(':memory:');
    try {
      const { format: _format, formatVersion: _version, ...data } = exported;
      replaceLedgerDatabase(db, { revision: 9, ...data });
      expect(readLedgerDatabase(db)).toEqual({ revision: 9, ...data });
    } finally { db.close(); }
  });
});
