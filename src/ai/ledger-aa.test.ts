import { afterEach, describe, expect, it } from 'vitest';
import { LedgerEntryDraftSchema, type LedgerEntryDraft, type LedgerMutationRequest } from '../shared/ledger';
import { LedgerService } from '../ledger/service';
import { ledgerReceivable } from '../ledger/receivable';
import { normalizeAAReturns } from './ledger-aa';

type Changes = LedgerMutationRequest['changes'];
type PutEntry = Extract<Changes[number], { type: 'putEntry' }>;
const services: LedgerService[] = [];
const now = new Date('2024-06-08T12:00:00Z');
afterEach(() => { for (const ledger of services.splice(0)) ledger.close(); });

function entry(values: Partial<LedgerEntryDraft> = {}): LedgerEntryDraft {
  return LedgerEntryDraftSchema.parse({ id: 'shared-trip', kind: 'expense', date: '2024-05-18', month: '2024-05',
    title: '合成共同出行', category: '交通', amountCents: 6000, personalCents: 6000,
    cashflows: [{ accountId: 'alipay', deltaCents: -6000 }], ...values });
}
function put(values: LedgerEntryDraft, expectedVersion: number | null = null): PutEntry {
  return { type: 'putEntry', entry: values, expectedVersion, confirmDuplicate: false, note: '合成测试' };
}
function receipt(values: Partial<LedgerEntryDraft> = {}): PutEntry {
  return put(entry({ id: 'shared-return', kind: 'aa_return', date: '2024-06-07', month: '2024-06', title: '合成同伴返款',
    amountCents: 1800, personalCents: 0, cashflows: [{ accountId: 'wechat', deltaCents: 1800 }], relatedEntryIds: ['shared-trip'],
    adjustments: [{ targetEntryIds: ['shared-trip'], amountCents: 1800, note: '本次明确同伴承担' }], ...values }));
}
function setup(values: Partial<LedgerEntryDraft> = {}) {
  const ledger = new LedgerService(':memory:', { now: () => now }); services.push(ledger);
  ledger.mutate({ operationId: 'original-payment', expectedRevision: 0, changes: [put(entry(values))] });
  return ledger;
}
function save(ledger: LedgerService, changes: Changes, operationId = 'aa-command') {
  const snapshot = ledger.snapshot('2024-05');
  const request = { operationId, expectedRevision: snapshot.revision, changes: normalizeAAReturns(changes, snapshot) };
  return { request, result: ledger.mutate(request) };
}

describe('AA receipts expressed as adjustments', () => {
  it('atomically corrects a gross personal share, preserves payment metadata, and credits the cross-month receiving account once', () => {
    const ledger = setup({ note: '保留原注释', originalText: '合成付款原文', sourceId: 'synthetic-import', sourceKey: 'synthetic-row' });
    const before = ledger.snapshot('2024-05'); const proposal = [receipt()]; const unchanged = structuredClone(proposal);
    const { result } = save(ledger, proposal);
    expect(proposal).toEqual(unchanged); expect(before.entries[0]!.personalCents).toBe(6000);
    const original = result.snapshot.entries.find(item => item.id === 'shared-trip')!;
    expect(original).toMatchObject({ amountCents: 6000, personalCents: 4200, version: 2, note: '保留原注释',
      originalText: '合成付款原文', sourceId: 'synthetic-import', sourceKey: 'synthetic-row',
      cashflows: [{ accountId: 'alipay', deltaCents: -6000 }] });
    expect(original.createdAt).toBe(before.entries[0]!.createdAt);
    expect(result.snapshot.entries.find(item => item.id === 'shared-return')).toMatchObject({
      kind: 'aa_return', amountCents: 1800, personalCents: 0, incomeCents: 0, adjustments: [], relatedEntryIds: ['shared-trip'],
    });
    expect(result.snapshot.revision).toBe(before.revision + 1);
    expect(ledger.snapshot('2024-05').summary).toMatchObject({ actualPaidCents: 6000, personalCents: 4200, incomeCents: 0 });
    expect(ledger.snapshot('2024-06').summary).toMatchObject({ personalCents: 0, incomeCents: 0 });
    expect(ledger.snapshot('2024-06').summary.accounts.find(account => account.id === 'wechat')!.periodChangeCents).toBe(1800);
    expect(ledger.snapshot('2024-05').summary.accounts.find(account => account.id === 'alipay')!.periodChangeCents).toBe(-6000);
    expect(ledgerReceivable(result.snapshot.entries, '2024-05')).toMatchObject({ cents: 0, uncertainties: [],
      items: [{ advancedCents: 1800, returnedCents: 1800, outstandingCents: 0 }] });
  });

  it('retains an adjustment-only original reference on the normalized receipt', () => {
    const ledger = setup(); const { result } = save(ledger, [receipt({ relatedEntryIds: [] })]);
    expect(result.snapshot.entries.find(item => item.id === 'shared-return')).toMatchObject({ adjustments: [], relatedEntryIds: ['shared-trip'] });
    expect(ledgerReceivable(result.snapshot.entries, '2024-05').cents).toBe(0);
  });

  it('combines several explicit same-batch returns into one versioned personal-share correction', () => {
    const ledger = setup(); const { request, result } = save(ledger, [receipt(), receipt({ id: 'second-return', title: '合成另一同伴返款',
      amountCents: 900, cashflows: [{ accountId: 'wechat', deltaCents: 900 }],
      adjustments: [{ targetEntryIds: ['shared-trip'], amountCents: 900, note: '' }] })]);
    expect(request.changes.filter(change => change.type === 'putEntry' && change.entry.id === 'shared-trip')).toHaveLength(1);
    expect(result.snapshot.entries.find(item => item.id === 'shared-trip')).toMatchObject({ personalCents: 3300, version: 2 });
    expect(ledgerReceivable(result.snapshot.entries, '2024-05')).toMatchObject({ cents: 0, uncertainties: [],
      items: [{ advancedCents: 2700, returnedCents: 2700, outstandingCents: 0 }] });
  });

  it.each([4200, null])('rejects a repeated/unknown adjustment when personalCents=%s, while accepting the cash-only receipt', personalCents => {
    const ledger = setup({ personalCents }); const before = ledger.snapshot('2024-05');
    expect(() => save(ledger, [receipt()])).toThrow(/原消费已区分|个人承担尚未确认/);
    expect(ledger.snapshot('2024-05')).toEqual(before);
    const proposal = [receipt({ adjustments: [] })];
    expect(normalizeAAReturns(proposal, before)).toEqual(proposal);
    const { result } = save(ledger, proposal);
    expect(result.snapshot.entries.find(item => item.id === 'shared-trip')!.personalCents).toBe(personalCents);
    expect(ledger.snapshot('2024-06').summary.accounts.find(account => account.id === 'wechat')!.periodChangeCents).toBe(1800);
    const receivable = ledgerReceivable(result.snapshot.entries, '2024-05');
    if (personalCents === null) {
      expect(ledger.snapshot('2024-05').summary.pendingPersonalCount).toBe(1);
      expect(receivable.uncertainties.some(issue => issue.reason === 'unknown-personal-share')).toBe(true);
    } else expect(receivable).toMatchObject({ cents: 0, uncertainties: [] });
  });

  it.each([
    ['several targets', { adjustments: [{ targetEntryIds: ['shared-trip', 'other-trip'], amountCents: 1800 }] }],
    ['several adjustments', { adjustments: [{ targetEntryIds: ['shared-trip'], amountCents: 900 }, { targetEntryIds: ['shared-trip'], amountCents: 900 }] }],
    ['amount mismatch', { adjustments: [{ targetEntryIds: ['shared-trip'], amountCents: 900 }] }],
    ['unrelated link', { relatedEntryIds: ['other-trip'] }],
    ['duplicate link', { relatedEntryIds: ['shared-trip', 'shared-trip'] }],
    ['ordinary income', { incomeCents: 1800 }],
    ['asset-sale income', { assetSaleCents: 1800 }],
    ['missing target', { relatedEntryIds: [], adjustments: [{ targetEntryIds: ['missing-trip'], amountCents: 1800 }] }],
    ['return preceding original expense', { date: '2024-05-17', month: '2024-05' }],
  ] as const)('rejects %s without saving either side', (_label, values) => {
    const ledger = setup(); const before = ledger.snapshot('2024-05');
    const proposed = put(LedgerEntryDraftSchema.parse({ ...receipt().entry, ...values }));
    expect(() => save(ledger, [proposed])).toThrow(/AA 返款未保存/);
    expect(ledger.snapshot('2024-05')).toEqual(before);
  });

  it.each(['update', 'void'] as const)('rejects a target already scheduled for %s in the same batch', action => {
    const ledger = setup(); const before = ledger.snapshot('2024-05');
    const other: Changes[number] = action === 'update' ? put(entry({ personalCents: 4200 }), 1)
      : { type: 'voidEntry', id: 'shared-trip', expectedVersion: 1, note: '合成移除' };
    expect(() => save(ledger, [receipt(), other])).toThrow(/同批已更正/);
    expect(ledger.snapshot('2024-05')).toEqual(before);
  });

  it('rejects a removed target and an update of an existing receipt', () => {
    const ledger = setup();
    ledger.mutate({ operationId: 'remove-original', expectedRevision: 1, changes: [{ type: 'voidEntry', id: 'shared-trip', expectedVersion: 1, note: '' }] });
    expect(() => save(ledger, [receipt()])).toThrow(/有效的原消费/);
    const other = setup(); const proposed = receipt(); proposed.expectedVersion = 1;
    expect(() => save(other, [proposed])).toThrow(/更正已有返款/);
    expect(other.snapshot().revision).toBe(1);
  });

  it('rejects an existing non-expense target without changing it', () => {
    const ledger = setup({ kind: 'income', personalCents: 0, incomeCents: 6000, cashflows: [{ accountId: 'alipay', deltaCents: 6000 }] });
    const before = ledger.snapshot('2024-05');
    expect(() => save(ledger, [receipt()])).toThrow(/有效的原消费/);
    expect(ledger.snapshot('2024-05')).toEqual(before);
  });

  it('keeps an existing personal refund and settles only the new AA share', () => {
    const ledger = setup();
    save(ledger, [put(entry({ id: 'personal-refund', kind: 'refund', title: '合成优惠退回', date: '2024-06-02', month: '2024-06',
      amountCents: 1200, personalCents: 0, cashflows: [{ accountId: 'alipay', deltaCents: 1200 }],
      adjustments: [{ targetEntryIds: ['shared-trip'], amountCents: 1200, note: '' }] }))], 'refund-command');
    const { result } = save(ledger, [receipt()]);
    expect(ledger.snapshot('2024-05').summary.personalCents).toBe(3000);
    expect(ledgerReceivable(result.snapshot.entries, '2024-05')).toMatchObject({ cents: 0, uncertainties: [],
      items: [{ advancedCents: 1800, returnedCents: 1800 }] });
  });

  it.each(['forward', 'reverse'] as const)('rejects an existing unexplained cash-only return linked %s to a gross expense', direction => {
    const ledger = setup();
    const prior = receipt({ id: 'prior-return', title: '合成早先返款', date: '2024-06-03', adjustments: [],
      relatedEntryIds: direction === 'forward' ? ['shared-trip'] : [] });
    const changes: Changes = [prior];
    if (direction === 'reverse') changes.push(put(entry({ relatedEntryIds: ['prior-return'] }), 1));
    ledger.mutate({ operationId: 'previous-cash-receipt', expectedRevision: 1, changes });
    const before = ledger.snapshot('2024-05');
    expect(() => save(ledger, [receipt()])).toThrow(/已有其他关联返款/);
    expect(ledger.snapshot('2024-05')).toEqual(before);
  });

  it('rejects a mixed same-batch cash-only return instead of letting it consume the newly corrected share', () => {
    const ledger = setup(); const before = ledger.snapshot('2024-05');
    const additional = receipt({ id: 'cash-only-return', title: '合成不明份额返款', adjustments: [] });
    expect(() => save(ledger, [receipt(), additional])).toThrow(/已有其他关联返款/);
    expect(ledger.snapshot('2024-05')).toEqual(before);
  });

  it('rolls back all entries when a prior refund plus the AA correction exceeds personal spending', () => {
    const ledger = setup();
    save(ledger, [put(entry({ id: 'large-refund', kind: 'refund', title: '合成大额退回', amountCents: 5000, personalCents: 0,
      cashflows: [{ accountId: 'alipay', deltaCents: 5000 }], adjustments: [{ targetEntryIds: ['shared-trip'], amountCents: 5000, note: '' }] }))], 'refund-command');
    const before = ledger.snapshot('2024-05');
    expect(() => save(ledger, [receipt(), put(entry({ id: 'unrelated', title: '合成独立餐费' }))])).toThrow(/超过原个人开销/);
    expect(ledger.snapshot('2024-05')).toEqual(before);
  });

  it('rejects cumulative same-batch returns exceeding the original payment', () => {
    const ledger = setup(); const before = ledger.snapshot('2024-05');
    expect(() => save(ledger, [receipt(), receipt({ id: 'too-much', title: '合成超额返款', amountCents: 5000,
      cashflows: [{ accountId: 'wechat', deltaCents: 5000 }], adjustments: [{ targetEntryIds: ['shared-trip'], amountCents: 5000, note: '' }] })])).toThrow(/累计返款超过/);
    expect(ledger.snapshot('2024-05')).toEqual(before);
  });

  it('rejects stale original versions atomically even if the caller supplies the current ledger revision', () => {
    const ledger = setup(); const changes = normalizeAAReturns([receipt()], ledger.snapshot());
    ledger.mutate({ operationId: 'concurrent-edit', expectedRevision: 1, changes: [put(entry({ note: '合成并发更正' }), 1)] });
    const before = ledger.snapshot();
    expect(() => ledger.mutate({ operationId: 'late-return', expectedRevision: before.revision, changes })).toThrow(/已被修改/);
    expect(ledger.snapshot()).toEqual(before);
  });

  it('replays the saved request idempotently and undoes both the receipt and original-share correction', () => {
    const ledger = setup(); const before = ledger.snapshot('2024-05');
    const { request, result } = save(ledger, [receipt()]);
    expect(ledger.mutate(request).status).toBe('already_saved');
    expect(ledger.snapshot().revision).toBe(result.snapshot.revision);
    expect(ledger.snapshot().entries).toHaveLength(2);
    const undone = ledger.undo({ operationId: 'undo-aa-command', expectedRevision: result.snapshot.revision, month: '2024-05' });
    expect(undone.snapshot.entries).toEqual(before.entries);
    expect(undone.snapshot.summary.personalCents).toBe(6000);
    expect(ledger.snapshot('2024-06').summary.accounts.find(account => account.id === 'wechat')!.periodChangeCents).toBe(0);
  });
});
