import { expect, it } from 'vitest';
import { LedgerEntrySchema } from '../shared/ledger';
import { ledgerReceivable } from './receivable';

const stamp = '2026-06-20T12:00:00+08:00';
const entry = (id: string, values: Record<string, unknown>) => LedgerEntrySchema.parse({
  id, kind: 'expense', date: '2026-06-20', month: '2026-06', title: id, category: '餐饮', amountCents: 0, personalCents: 0,
  cashflows: [], version: 1, createdAt: stamp, updatedAt: stamp, ...values,
});

it('explains open and settled advances without inventing an unknown personal share', () => {
  const entries = [
    entry('tea', { amountCents: 3600, personalCents: 1800 }),
    entry('dinner', { date: '2026-06-21', amountCents: 10000, personalCents: 2500 }),
    entry('solo', { amountCents: 1500, personalCents: 1500 }),
    entry('unknown', { amountCents: 8000, personalCents: null }),
    entry('back', { kind: 'aa_return', amountCents: 1800, relatedEntryIds: ['tea'] }),
    entry('partial', { kind: 'aa_return', amountCents: 2500, relatedEntryIds: ['dinner'] }),
  ];
  const result = ledgerReceivable(entries, '2026-06');
  expect(result).toMatchObject({ cents: 5000, entryIds: ['dinner'] });
  expect(result.items).toEqual([
    { entryId: 'tea', date: '2026-06-20', month: '2026-06', title: 'tea', paidCents: 3600, personalCents: 1800, advancedCents: 1800, returnedCents: 1800, outstandingCents: 0,
      returns: [{ entryId: 'back', date: '2026-06-20', title: 'back', kind: 'aa_return', allocatedCents: 1800 }] },
    { entryId: 'dinner', date: '2026-06-21', month: '2026-06', title: 'dinner', paidCents: 10000, personalCents: 2500, advancedCents: 7500, returnedCents: 2500, outstandingCents: 5000,
      returns: [{ entryId: 'partial', date: '2026-06-20', title: 'partial', kind: 'aa_return', allocatedCents: 2500 }] },
  ]);
  expect(result.uncertainties).toEqual([{ entryIds: ['unknown'], returnEntryId: null, reason: 'unknown-personal-share', message: expect.any(String) }]);
});

it('settles already-netted refunds and reimbursements and excludes confirmed excess income', () => {
  const entries = [
    entry('cancelled-item', { amountCents: 5200, personalCents: 4700 }),
    entry('group-booking', { amountCents: 18000, personalCents: 0 }),
    entry('item-refund', { kind: 'refund', amountCents: 500, relatedEntryIds: ['cancelled-item'] }),
    entry('booking-reimbursement', { kind: 'reimbursement', amountCents: 20000, incomeCents: 2000, relatedEntryIds: ['group-booking'] }),
  ];
  const original = structuredClone(entries);
  const result = ledgerReceivable(entries, '2026-06');
  expect(result).toMatchObject({ cents: 0, entryIds: [], uncertainties: [] });
  expect(result.items.map(item => [item.entryId, item.returnedCents, item.outstandingCents])).toEqual([['cancelled-item', 500, 0], ['group-booking', 18000, 0]]);
  expect(entries).toEqual(original);
});

it('does not use a personal refund adjustment to repay someone else’s share', () => {
  const entries = [
    entry('shared-order', { amountCents: 9000, personalCents: 4000 }),
    entry('personal-refund', { kind: 'refund', amountCents: 1600, relatedEntryIds: ['shared-order'], adjustments: [{ targetEntryIds: ['shared-order'], amountCents: 1600 }] }),
    entry('mixed-reimbursement', { kind: 'reimbursement', amountCents: 3000, incomeCents: 300, assetSaleCents: 200, relatedEntryIds: ['shared-order'], adjustments: [{ targetEntryIds: ['shared-order'], amountCents: 1000 }] }),
  ];
  expect(ledgerReceivable(entries, '2026-06').items[0]).toMatchObject({ advancedCents: 5000, returnedCents: 1500, outstandingCents: 3500, returns: [{ entryId: 'mixed-reimbursement', allocatedCents: 1500 }] });
});

it('allocates explicit returns globally before month, date, account, category or search filters', () => {
  const entries = [
    entry('old-books', { date: '2026-05-15', month: '2026-05', category: '书籍', amountCents: 4000, personalCents: 2000, cashflows: [{ accountId: 'alipay', deltaCents: -4000 }] }),
    entry('new-meal', { title: '合餐', amountCents: 6000, personalCents: 3000, cashflows: [{ accountId: 'wechat', deltaCents: -6000 }] }),
    entry('old-return', { date: '2026-07-02', month: '2026-07', kind: 'aa_return', amountCents: 2000, relatedEntryIds: ['old-books'] }),
    entry('new-return', { date: '2026-07-02', month: '2026-07', kind: 'aa_return', amountCents: 1500, relatedEntryIds: ['new-meal'] }),
    entry('voided', { amountCents: 20000, personalCents: 0, voided: true }),
  ];
  expect(ledgerReceivable(entries, '2026-05')).toMatchObject({ cents: 0, entryIds: [] });
  expect(ledgerReceivable(entries, '2026-06')).toMatchObject({ cents: 1500, entryIds: ['new-meal'] });
  for (const query of [{ month: '2026-06' }, { from: '2026-06-01', to: '2026-06-30' }, { accountId: 'wechat' as const }, { category: '餐饮' }, { search: '合餐' }]) {
    expect(ledgerReceivable(entries, query)).toMatchObject({ cents: 1500, entryIds: ['new-meal'], items: [{ entryId: 'new-meal', returnedCents: 1500 }] });
  }
});

it('is independent of input order and uses stable dates then creation time and IDs', () => {
  const entries = [
    entry('b', { amountCents: 2500, personalCents: 1500 }),
    entry('a', { amountCents: 2500, personalCents: 1500 }),
    entry('return-late', { date: '2026-06-23', kind: 'aa_return', amountCents: 200, relatedEntryIds: ['a'] }),
    entry('return-early', { date: '2026-06-22', kind: 'aa_return', amountCents: 800, relatedEntryIds: ['a'] }),
    entry('return-b', { date: '2026-06-24', kind: 'aa_return', amountCents: 300, relatedEntryIds: ['b'] }),
  ];
  const result = ledgerReceivable(entries, '2026-06');
  expect(result).toEqual(ledgerReceivable([...entries].reverse(), '2026-06'));
  expect(result.items.map(item => [item.entryId, item.outstandingCents])).toEqual([['a', 0], ['b', 700]]);
  expect(result.items[0]!.returns.map(back => [back.entryId, back.allocatedCents])).toEqual([['return-early', 800], ['return-late', 200]]);
});

it('holds a grouped return when an unknown share could consume it, including outside the visible month', () => {
  const entries = [
    entry('known', { amountCents: 7000, personalCents: 2000 }),
    entry('unknown', { month: '2026-05', date: '2026-05-01', amountCents: 9000, personalCents: null }),
    entry('combined-return', { kind: 'aa_return', amountCents: 4000, relatedEntryIds: ['known', 'unknown'] }),
  ];
  const result = ledgerReceivable(entries, '2026-06');
  expect(result).toMatchObject({ cents: 5000, items: [{ entryId: 'known', returnedCents: 0 }] });
  expect(result.uncertainties).toEqual([{ entryIds: ['known', 'unknown'], returnEntryId: 'combined-return', reason: 'unknown-personal-share', amountCents: 4000, message: expect.any(String) }]);
});

it('does not allocate across missing or voided links or an unexplained personal-only target', () => {
  for (const extra of [undefined, entry('other', { voided: true, amountCents: 4000 }), entry('other', { amountCents: 4000, personalCents: 4000 })]) {
    const entries = [entry('known', { amountCents: 6000, personalCents: 2000 }), ...(extra ? [extra] : []), entry('unclear-return', { kind: 'refund', amountCents: 2000, relatedEntryIds: ['known', 'other'] })];
    expect(ledgerReceivable(entries, '2026-06')).toMatchObject({ cents: 4000, uncertainties: [{ returnEntryId: 'unclear-return', amountCents: 2000 }] });
  }
});

it('holds partial allocations even with complete dates, but can settle a fully covered group', () => {
  const expenses = [entry('dated', { amountCents: 5000, personalCents: 2000 }), entry('undated', { date: null, amountCents: 3000, personalCents: 1000 })];
  expect(ledgerReceivable([...expenses, entry('partial', { kind: 'aa_return', amountCents: 2000, relatedEntryIds: ['dated', 'undated'] })], '2026-06')).toMatchObject({ cents: 5000, uncertainties: [{ reason: 'ambiguous-allocation' }] });
  expect(ledgerReceivable([...expenses, entry('complete', { kind: 'aa_return', amountCents: 5000, relatedEntryIds: ['dated', 'undated'] })], '2026-06')).toMatchObject({ cents: 0, uncertainties: [] });
  const dated = expenses.map(item => ({ ...item, date: '2026-06-20' }));
  expect(ledgerReceivable([...dated, entry('partial', { kind: 'aa_return', amountCents: 2000, relatedEntryIds: ['dated', 'undated'] })], '2026-06')).toMatchObject({ cents: 5000, uncertainties: [{ reason: 'ambiguous-allocation' }] });
});

it('never spends a shared partial return again when querying its different months', () => {
  const entries = [
    entry('may', { month: '2026-05', date: '2026-05-18', amountCents: 4000, personalCents: 2000 }),
    entry('june', { amountCents: 6000, personalCents: 3000 }),
    entry('shared-return', { kind: 'aa_return', amountCents: 3500, relatedEntryIds: ['may', 'june'] }),
  ];
  const may = ledgerReceivable(entries, '2026-05'), june = ledgerReceivable(entries, '2026-06');
  expect(may).toMatchObject({ cents: 2000, items: [{ entryId: 'may', returnedCents: 0 }], uncertainties: [{ returnEntryId: 'shared-return', amountCents: 3500, reason: 'ambiguous-allocation' }] });
  expect(june).toMatchObject({ cents: 3000, items: [{ entryId: 'june', returnedCents: 0 }], uncertainties: [{ returnEntryId: 'shared-return', amountCents: 3500, reason: 'ambiguous-allocation' }] });
  expect(may.uncertainties[0]!.message).toContain('shared-return');
});

it('recognizes explicit reverse and adjustment links without double-crediting duplicate links', () => {
  const entries = [
    entry('advance', { amountCents: 8000, personalCents: 2000, relatedEntryIds: ['returned'] }),
    entry('returned', { kind: 'reimbursement', amountCents: 4500, relatedEntryIds: ['advance'], adjustments: [{ targetEntryIds: ['advance'], amountCents: 1000 }] }),
    entry('unlinked', { kind: 'refund', amountCents: 8000 }),
    entry('voided-return', { kind: 'aa_return', amountCents: 8000, relatedEntryIds: ['advance'], voided: true }),
  ];
  expect(ledgerReceivable(entries, '2026-06').items[0]).toMatchObject({ returnedCents: 3500, outstandingCents: 2500, returns: [{ entryId: 'returned', allocatedCents: 3500 }] });
  expect(ledgerReceivable(entries.filter(e => e.id !== 'returned').concat(entry('returned', { kind: 'aa_return', amountCents: 6000 })), '2026-06').cents).toBe(0);
});

it('reports excess linked returns without assigning them to unrelated advances', () => {
  const entries = [entry('linked', { amountCents: 3000, personalCents: 2000 }), entry('unrelated', { amountCents: 5000, personalCents: 2000 }), entry('too-much', { kind: 'aa_return', amountCents: 1700, relatedEntryIds: ['linked'] })];
  expect(ledgerReceivable(entries, '2026-06')).toMatchObject({ cents: 3000, entryIds: ['unrelated'], uncertainties: [{ returnEntryId: 'too-much', reason: 'unallocated-return', amountCents: 700 }] });
});
