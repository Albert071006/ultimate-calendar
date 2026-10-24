import type { LedgerEntry, LedgerQuery } from '../shared/ledger';
import { ledgerEntryMatches } from './summary';

export type ReceivableReturnKind = 'aa_return' | 'refund' | 'reimbursement';
export interface ReceivableReturn {
  entryId: string; date: string | null; title: string; kind: ReceivableReturnKind; allocatedCents: number;
}
export interface ReceivableItem {
  entryId: string; date: string | null; month: string; title: string;
  paidCents: number; personalCents: number; advancedCents: number; returnedCents: number; outstandingCents: number;
  returns: ReceivableReturn[];
}
export interface ReceivableUncertainty {
  entryIds: string[]; returnEntryId: string | null;
  reason: 'unknown-personal-share' | 'missing-related-expense' | 'ambiguous-allocation' | 'unallocated-return';
  message: string; amountCents?: number;
}
export interface Receivable {
  cents: number; entryIds: string[]; items: ReceivableItem[]; uncertainties: ReceivableUncertainty[];
}

function order(a: LedgerEntry, b: LedgerEntry) {
  return (a.date ?? a.month).localeCompare(b.date ?? b.month)
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
function isReturn(entry: LedgerEntry): entry is LedgerEntry & { kind: ReceivableReturnKind } {
  return entry.kind === 'aa_return' || entry.kind === 'refund' || entry.kind === 'reimbursement';
}

/** Read-only settlement view. Allocate each return once across the complete ledger, then filter original expenses. */
export function ledgerReceivable(entries: LedgerEntry[], monthOrQuery: string | LedgerQuery): Receivable {
  const query = typeof monthOrQuery === 'string' ? { month: monthOrQuery } : monthOrQuery;
  const live = entries.filter(entry => !entry.voided).sort(order);
  const byId = new Map(live.map(entry => [entry.id, entry]));
  const expenses = live.filter(entry => entry.kind === 'expense');
  const items = new Map<string, ReceivableItem>();
  const uncertainties: ReceivableUncertainty[] = [];
  for (const expense of expenses) {
    if (expense.personalCents === null) {
      uncertainties.push({ entryIds: [expense.id], returnEntryId: null, reason: 'unknown-personal-share', message: `「${expense.title}」的个人承担金额尚未确认，未猜测这笔消费的代垫金额。` });
    } else if (expense.amountCents > expense.personalCents) {
      const advancedCents = expense.amountCents - expense.personalCents;
      items.set(expense.id, { entryId: expense.id, date: expense.date, month: expense.month, title: expense.title,
        paidCents: expense.amountCents, personalCents: expense.personalCents, advancedCents, returnedCents: 0,
        outstandingCents: advancedCents, returns: [] });
    }
  }
  const reverseLinks = new Map<string, string[]>();
  for (const expense of expenses) for (const returnId of expense.relatedEntryIds) {
    const ids = reverseLinks.get(returnId) ?? []; ids.push(expense.id); reverseLinks.set(returnId, ids);
  }
  for (const back of live.filter(isReturn)) {
    // Personal refunds are already accounted for by adjustments. Extra confirmed income is not a repayment.
    const personalAdjustment = back.adjustments.reduce((sum, adjustment) => sum + adjustment.amountCents, 0);
    let remaining = Math.max(0, back.amountCents - back.incomeCents - back.assetSaleCents - personalAdjustment);
    if (!remaining) continue;
    const targetIds = [...new Set([...back.relatedEntryIds, ...back.adjustments.flatMap(adjustment => adjustment.targetEntryIds), ...(reverseLinks.get(back.id) ?? [])])];
    if (!targetIds.length) continue; // An unlinked historical refund cannot settle an unrelated current expense.
    const targets = targetIds.map(id => byId.get(id));
    const uncertainty = (reason: ReceivableUncertainty['reason'], message: string, amountCents = remaining) => {
      uncertainties.push({ entryIds: targetIds, returnEntryId: back.id, reason, message: `返款「${back.title}」：${message}`, amountCents });
    };
    if (targets.some(target => !target || target.kind !== 'expense')) {
      uncertainty('missing-related-expense', '关联范围包含缺失、已移除或非消费记录，未擅自把返款分给其他消费。'); continue;
    }
    const related = (targets as LedgerEntry[]).sort(order);
    if (related.some(target => target.personalCents === null)) {
      uncertainty('unknown-personal-share', '关联消费中有个人承担金额待确认的记录，暂不能确定这笔返款的分配。'); continue;
    }
    const pending = related.map(target => items.get(target.id)).filter((item): item is ReceivableItem => !!item && item.outstandingCents > 0);
    if (!pending.length) continue;
    // A group with no known advance on one target may contain a personal refund not represented by an adjustment.
    if (related.some(target => !items.has(target.id) && !back.adjustments.some(adjustment => adjustment.targetEntryIds.includes(target.id)))) {
      uncertainty('ambiguous-allocation', '关联消费中包含没有明确代垫差额的记录，返款归属不明确，未猜测分摊。'); continue;
    }
    const total = pending.reduce((sum, item) => sum + item.outstandingCents, 0);
    if (pending.length > 1 && remaining < total) {
      uncertainty('ambiguous-allocation', '关联多笔消费且不足以全部结清，尚未说明每笔应分配多少；未按日期猜测哪笔已结清。'); continue;
    }
    for (const item of pending) {
      if (!remaining) break;
      const allocatedCents = Math.min(remaining, item.outstandingCents);
      item.outstandingCents -= allocatedCents; item.returnedCents += allocatedCents; remaining -= allocatedCents;
      item.returns.push({ entryId: back.id, date: back.date, title: back.title, kind: back.kind, allocatedCents });
    }
    if (remaining > 0) uncertainty('unallocated-return', '返款超过已关联的代垫差额，超出部分未当作其他消费的返款。');
  }
  const selectedIds = new Set(expenses.filter(expense => ledgerEntryMatches(expense, query)).map(expense => expense.id));
  const selected = [...items.values()].filter(item => selectedIds.has(item.entryId));
  const outstanding = selected.filter(item => item.outstandingCents > 0);
  return { cents: outstanding.reduce((sum, item) => sum + item.outstandingCents, 0), entryIds: outstanding.map(item => item.entryId), items: selected,
    uncertainties: uncertainties.filter(issue => issue.entryIds.some(id => selectedIds.has(id))) };
}
