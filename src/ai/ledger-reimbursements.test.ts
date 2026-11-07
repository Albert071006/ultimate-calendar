import { afterEach, describe, expect, it } from 'vitest';
import { LedgerEntryDraftSchema, type LedgerEntryDraft, type LedgerMutationRequest } from '../shared/ledger';
import { LedgerService } from '../ledger/service';
import { LedgerReimbursementClarification, normalizeReimbursements } from './ledger-reimbursements';

type Changes = LedgerMutationRequest['changes'];
type PutEntry = Extract<Changes[number], { type: 'putEntry' }>;
const services: LedgerService[] = [];
const now = new Date('2024-06-08T12:00:00Z');
afterEach(() => { for (const ledger of services.splice(0)) ledger.close(); });

function expense(values: Partial<LedgerEntryDraft> = {}): LedgerEntryDraft {
  return LedgerEntryDraftSchema.parse({ id: 'trip', kind: 'expense', date: '2024-04-18', month: '2024-04',
    title: '合成出行', category: '交通', amountCents: 6000, personalCents: 6000,
    cashflows: [{ accountId: 'alipay', deltaCents: -6000 }], ...values });
}
function put(entry: LedgerEntryDraft, expectedVersion: number | null = null): PutEntry {
  return { type: 'putEntry', entry, expectedVersion, confirmDuplicate: false, note: '合成测试' };
}
function receipt(values: Partial<LedgerEntryDraft> = {}, expectedVersion: number | null = null): PutEntry {
  return put(LedgerEntryDraftSchema.parse({ id: 'return', kind: 'reimbursement', date: '2024-06-07', month: '2024-06',
    title: '合成活动报销', category: '报销', amountCents: 10500, personalCents: 0, incomeCents: 500,
    cashflows: [{ accountId: 'wechat', deltaCents: 10500 }], relatedEntryIds: ['trip', 'meal'],
    adjustments: [{ targetEntryIds: ['trip', 'meal'], amountCents: 10000, note: '已确认全部冲减' }],
    note: '保留报销说明', originalText: '合成报销原文', ...values }), expectedVersion);
}
function setup(overrides: Partial<LedgerEntryDraft> = {}, extra: LedgerEntryDraft[] = []) {
  const ledger = new LedgerService(':memory:', { now: () => now }); services.push(ledger);
  ledger.mutate({ operationId: 'payments', expectedRevision: 0, changes: [put(expense()), put(expense({ id: 'meal', title: '合成餐费',
    category: '餐饮', date: '2024-05-19', month: '2024-05', amountCents: 4000, personalCents: 4000,
    cashflows: [{ accountId: 'alipay', deltaCents: -4000 }], ...overrides })), ...extra.map(entry => put(entry))] });
  return ledger;
}
function save(ledger: LedgerService, changes: Changes, operationId = 'reimbursement') {
  const snapshot = ledger.snapshot('2024-06');
  const request = { operationId, expectedRevision: snapshot.revision, changes: normalizeReimbursements(changes, snapshot) };
  return { request, result: ledger.mutate(request) };
}
function singleReceipt(id: string, cents: number, target = 'trip'): PutEntry {
  return receipt({ id, title: `合成返款${id}`, amountCents: cents, incomeCents: 0,
    cashflows: [{ accountId: 'wechat', deltaCents: cents }], relatedEntryIds: [target],
    adjustments: [{ targetEntryIds: [target], amountCents: cents, note: '' }] });
}
function fullReceipt(cents: number, values: Partial<LedgerEntryDraft> = {}): PutEntry {
  return receipt({ amountCents: cents, incomeCents: 0, cashflows: [{ accountId: 'wechat', deltaCents: cents }],
    adjustments: [{ targetEntryIds: ['trip', 'meal'], amountCents: cents, note: '全部结清' }], ...values });
}

describe('deterministic reimbursement allocation', () => {
  it('splits a full cross-month/category settlement while preserving excess income, cash, metadata and originals', () => {
    const ledger = setup(); const before = ledger.snapshot(); const proposal = [receipt()]; const untouched = structuredClone(proposal);
    const { result } = save(ledger, proposal);
    expect(proposal).toEqual(untouched);
    expect(result.snapshot.entries.filter(entry => entry.kind === 'expense')).toEqual(before.entries);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')).toMatchObject({ ...proposal[0]!.entry, adjustments: [
      { targetEntryIds: ['trip'], amountCents: 6000, note: '已确认全部冲减' },
      { targetEntryIds: ['meal'], amountCents: 4000, note: '已确认全部冲减' },
    ] });
    expect(ledger.snapshot('2024-04').summary).toMatchObject({ actualPaidCents: 6000, personalCents: 0, categories: [] });
    expect(ledger.snapshot('2024-05').summary).toMatchObject({ actualPaidCents: 4000, personalCents: 0, categories: [] });
    expect(ledger.query({ month: '2024-04', category: '交通' }).summary.personalCents).toBe(0);
    expect(ledger.snapshot('2024-06').summary).toMatchObject({ personalCents: 0, incomeCents: 500 });
    expect(ledger.snapshot('2024-06').summary.accounts.find(account => account.id === 'wechat')!.periodChangeCents).toBe(10500);
  });

  it.each(['refund', 'reimbursement'] as const)('supports full %s without classifying any amount as extra income', kind => {
    const ledger = setup(); const { result } = save(ledger, [fullReceipt(10000, { kind })]);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')!.adjustments).toHaveLength(2);
    expect(result.snapshot.summary.incomeCents).toBe(0);
  });

  it('uses only the remaining personal amount after a historical single-target refund', () => {
    const ledger = setup(); save(ledger, [singleReceipt('earlier', 1000)], 'earlier');
    const { result } = save(ledger, [fullReceipt(9000)]);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')!.adjustments.map(item => item.amountCents)).toEqual([5000, 4000]);
    expect(ledger.snapshot('2024-04').summary.personalCents).toBe(0);
  });

  it.each([false, true])('accounts for explicit single-target refunds in the same batch, reverse order=%s', reverse => {
    const ledger = setup(); const changes: Changes = [singleReceipt('same-batch', 1000), fullReceipt(9000)];
    const { result } = save(ledger, reverse ? changes.reverse() : changes);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')!.adjustments.map(item => item.amountCents)).toEqual([5000, 4000]);
    expect(ledger.snapshot('2024-04').summary.personalCents).toBe(0);
  });

  it('keeps a zero-remaining target linked without creating a zero or repeated adjustment', () => {
    const ledger = setup(); save(ledger, [singleReceipt('earlier', 6000)], 'earlier');
    const { result } = save(ledger, [fullReceipt(4000, { relatedEntryIds: [] })]);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')).toMatchObject({ relatedEntryIds: ['trip'],
      adjustments: [{ targetEntryIds: ['meal'], amountCents: 4000, note: '全部结清' }] });
  });

  it.each([false, true])('handles a singleton and full remaining group in one receipt, reverse order=%s', reverse => {
    const ledger = setup(); const proposal = fullReceipt(10000);
    proposal.entry.adjustments = [{ targetEntryIds: ['trip'], amountCents: 1000, note: '明确单笔' },
      { targetEntryIds: ['trip', 'meal'], amountCents: 9000, note: '余款结清' }];
    if (reverse) proposal.entry.adjustments.reverse();
    const { result } = save(ledger, [proposal]);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')!.adjustments.map(item => item.amountCents).sort((a, b) => a - b)).toEqual([1000, 4000, 5000]);
    expect(ledger.snapshot('2024-04').summary.personalCents).toBe(0);
  });

  it('replaces an updated receipt rather than counting its old reduction twice', () => {
    const ledger = setup(); save(ledger, [singleReceipt('return', 1000)], 'earlier');
    const update = fullReceipt(10000); update.expectedVersion = 1;
    const { result } = save(ledger, [update]);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')).toMatchObject({ version: 2, amountCents: 10000 });
    expect(result.snapshot.entries).toHaveLength(3);
    expect(result.snapshot.summary.accounts.find(account => account.id === 'wechat')!.periodChangeCents).toBe(10000);
  });

  it('uses a same-batch original share correction and leaves both authorized changes intact', () => {
    const ledger = setup(); const { result } = save(ledger, [fullReceipt(9000), put(expense({ personalCents: 5000 }), 1)]);
    expect(result.snapshot.entries.find(entry => entry.id === 'trip')!.personalCents).toBe(5000);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')!.adjustments[0]!.amountCents).toBe(5000);
    expect(ledger.snapshot('2024-04').summary.personalCents).toBe(0);
  });

  it('supports a new same-batch original and excludes a voided historical refund', () => {
    const ledger = setup(); save(ledger, [singleReceipt('earlier', 1000)], 'earlier');
    const created = expense({ id: 'new-expense', title: '合成额外交通' });
    const proposed = fullReceipt(16000, { relatedEntryIds: [], adjustments: [{ targetEntryIds: ['trip', 'meal', 'new-expense'], amountCents: 16000, note: '' }] });
    const { result } = save(ledger, [proposed, put(created), { type: 'voidEntry', id: 'earlier', expectedVersion: 1, note: '已确认移除错误返款' }]);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')!.adjustments.map(item => item.amountCents)).toEqual([6000, 4000, 6000]);
    expect(ledger.snapshot('2024-04').summary.personalCents).toBe(0);
  });

  it('preserves valid partial same-month/category grouped reimbursements and their account-only edits', () => {
    const ledger = setup({ category: '交通', month: '2024-04', date: '2024-04-19' });
    const proposal = fullReceipt(3000); const { result } = save(ledger, [proposal]);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')!.adjustments).toEqual(proposal.entry.adjustments);
    const update = put(LedgerEntryDraftSchema.parse({ ...proposal.entry, cashflows: [{ accountId: 'alipay', deltaCents: 3000 }] }), 1);
    expect(normalizeReimbursements([update], result.snapshot)).toEqual([update]);
    save(ledger, [update], 'account-update');
    expect(ledger.snapshot('2024-04').summary.personalCents).toBe(7000);
  });

  it('splits a same-month/category full remaining group when historical single-target adjustments require it', () => {
    const ledger = setup({ category: '交通', month: '2024-04', date: '2024-04-19' });
    save(ledger, [singleReceipt('earlier', 1000)], 'earlier');
    const { result } = save(ledger, [fullReceipt(9000)]);
    expect(result.snapshot.entries.find(entry => entry.id === 'return')!.adjustments.map(item => item.amountCents)).toEqual([5000, 4000]);
    expect(ledger.snapshot('2024-04').summary.personalCents).toBe(0);
  });

  it('replays an accepted request once and undoes the complete reimbursement without rewriting originals', () => {
    const ledger = setup(); const before = ledger.snapshot(); const { request, result } = save(ledger, [receipt()]);
    expect(ledger.mutate(request).status).toBe('already_saved');
    expect(ledger.snapshot().revision).toBe(result.snapshot.revision);
    ledger.undo({ operationId: 'undo-return', expectedRevision: result.snapshot.revision });
    expect(ledger.snapshot().entries).toEqual(before.entries);
  });
});

describe('reimbursement questions and persistence protection', () => {
  it.each([3000, 11000])('asks about an ambiguous or excess grouped amount %s without writing or inventing income', cents => {
    const ledger = setup(); const before = ledger.snapshot(); const proposed = fullReceipt(cents);
    let error: unknown;
    try { save(ledger, [proposed]); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(LedgerReimbursementClarification);
    expect((error as LedgerReimbursementClarification).question).toContain('“合成出行”剩余¥60.00');
    expect((error as LedgerReimbursementClarification).question).toContain('合计尚可冲减¥100.00');
    expect(proposed.entry.incomeCents).toBe(0);
    expect(ledger.snapshot()).toEqual(before);
  });

  it.each(['unknown-share', 'missing', 'voided', 'non-expense'] as const)('asks about an invalid %s original', condition => {
    const ledger = setup(condition === 'unknown-share' ? { personalCents: null } : condition === 'non-expense'
      ? { kind: 'income', personalCents: 0, incomeCents: 4000, cashflows: [{ accountId: 'alipay', deltaCents: 4000 }] } : {});
    if (condition === 'voided') ledger.mutate({ operationId: 'void-meal', expectedRevision: 1, changes: [{ type: 'voidEntry', id: 'meal', expectedVersion: 1, note: '' }] });
    const proposed = receipt();
    if (condition === 'missing') proposed.entry.adjustments[0]!.targetEntryIds[1] = 'missing';
    const before = ledger.snapshot();
    expect(() => save(ledger, [proposed])).toThrow(LedgerReimbursementClarification);
    expect(ledger.snapshot()).toEqual(before);
  });

  it.each(['historical', 'same-batch'] as const)('refuses to redistribute overlapping %s multi-target reductions', mode => {
    const extra = expense({ id: 'other-trip', title: '合成另一段交通' });
    const ledger = setup({}, [extra]);
    const group = fullReceipt(2000, { id: 'earlier', title: '合成共同退款', relatedEntryIds: [],
      adjustments: [{ targetEntryIds: ['trip', 'other-trip'], amountCents: 2000, note: '未分配到单笔' }] });
    if (mode === 'historical') save(ledger, [group], 'earlier');
    const before = ledger.snapshot();
    expect(() => save(ledger, [receipt(), ...(mode === 'same-batch' ? [group] : [])])).toThrow(/组合退款或报销/);
    expect(ledger.snapshot()).toEqual(before);
  });

  it('also asks for allocation when an explicit singleton overlaps a prior grouped reduction', () => {
    const ledger = setup({ category: '交通', month: '2024-04', date: '2024-04-19' });
    save(ledger, [fullReceipt(3000)], 'grouped');
    expect(() => save(ledger, [singleReceipt('later', 1000)])).toThrow(LedgerReimbursementClarification);
  });

  it.each(['forward', 'reverse', 'same-batch'] as const)('refuses an unexplained cash-only receipt linked %s', direction => {
    const ledger = setup();
    const prior = singleReceipt('unclear', 1000); prior.entry.adjustments = [];
    if (direction === 'reverse') prior.entry.relatedEntryIds = [];
    if (direction !== 'same-batch') save(ledger, [prior, ...(direction === 'reverse' ? [put(expense({ relatedEntryIds: ['unclear'] }), 1)] : [])], 'unclear');
    const before = ledger.snapshot();
    expect(() => save(ledger, [receipt(), ...(direction === 'same-batch' ? [prior] : [])])).toThrow(/已抵扣个人开销或只是收回代垫/);
    expect(ledger.snapshot()).toEqual(before);
  });

  it('does not treat an explicitly classified extra income as an unallocated cash return', () => {
    const ledger = setup(); const prior = singleReceipt('income-only', 1000);
    prior.entry.adjustments = []; prior.entry.incomeCents = 1000;
    save(ledger, [prior], 'income-only');
    expect(() => save(ledger, [receipt()])).not.toThrow();
    expect(ledger.snapshot('2024-06').summary.incomeCents).toBe(1500);
  });

  it.each(['duplicate-target', 'duplicate-link', 'self-link', 'overlapping-groups', 'duplicate-change', 'void-target'] as const)('rejects %s in the same batch before any write', condition => {
    const ledger = setup(); const before = ledger.snapshot(); const proposed = receipt(); const changes: Changes = [proposed];
    if (condition === 'duplicate-target') proposed.entry.adjustments[0]!.targetEntryIds.push('trip');
    if (condition === 'duplicate-link') proposed.entry.relatedEntryIds.push('trip');
    if (condition === 'self-link') proposed.entry.relatedEntryIds.push('return');
    if (condition === 'overlapping-groups') proposed.entry.adjustments.push({ targetEntryIds: ['trip', 'meal'], amountCents: 1000, note: '' });
    if (condition === 'duplicate-change') changes.push(put(expense(), 1), put(expense(), 2));
    if (condition === 'void-target') changes.push({ type: 'voidEntry', id: 'trip', expectedVersion: 1, note: '' });
    expect(() => save(ledger, changes)).toThrow(LedgerReimbursementClarification);
    expect(ledger.snapshot()).toEqual(before);
  });

  it('keeps concurrent edits protected by the original snapshot revision, with no partial write', () => {
    const ledger = setup(); const snapshot = ledger.snapshot(); const changes = normalizeReimbursements([receipt()], snapshot);
    ledger.mutate({ operationId: 'concurrent-change', expectedRevision: snapshot.revision, changes: [put(expense({ personalCents: 5000 }), 1)] });
    const before = ledger.snapshot();
    expect(() => ledger.mutate({ operationId: 'stale-return', expectedRevision: snapshot.revision, changes })).toThrow(/账本已更新/);
    expect(ledger.snapshot()).toEqual(before);
  });

  it('keeps expectedVersion on updated receipts and rejects a stale version atomically', () => {
    const ledger = setup(); save(ledger, [singleReceipt('return', 1000)], 'initial');
    const update = receipt({}, 1); const changes = normalizeReimbursements([update], ledger.snapshot());
    const current = singleReceipt('return', 1000); current.expectedVersion = 1; current.entry.note = '合成并发修改';
    save(ledger, [current], 'concurrent-update'); const before = ledger.snapshot();
    expect(() => ledger.mutate({ operationId: 'stale-update', expectedRevision: before.revision, changes })).toThrow(/已被修改/);
    expect(ledger.snapshot()).toEqual(before);
  });

  it('retains persistence validation for mismatched receipt cash flow and rolls back the entire batch', () => {
    const ledger = setup(); const before = ledger.snapshot(); const bad = receipt(); bad.entry.cashflows[0]!.deltaCents = 9999;
    expect(() => save(ledger, [bad, put(expense({ id: 'unrelated', title: '合成独立出行' }))])).toThrow(/收款金额一致/);
    expect(ledger.snapshot()).toEqual(before);
  });
});
