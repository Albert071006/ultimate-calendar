import { LedgerEntryDraftSchema, type LedgerEntryDraft, type LedgerMutationRequest, type LedgerSnapshot } from '../shared/ledger';
import { WorkflowError } from './deepseek';

type Changes = LedgerMutationRequest['changes'];
function reject(message: string): never { throw new WorkflowError('AI_RESPONSE', `AA 返款未保存：${message}`); }

/** Keep AA receipts in the existing ledger format. Some model responses express
 * a newly discovered shared expense as an adjustment on the receipt. Convert
 * only an unambiguous, fully personal original into a versioned share correction,
 * in the same transaction as the cash receipt. Never drop the reduction alone. */
export function normalizeAAReturns(changes: Changes, snapshot: LedgerSnapshot): Changes {
  const result = structuredClone(changes);
  const corrections = new Map<string, { original: LedgerSnapshot['entries'][number]; cents: number }>();
  const converted = new Set<string>();
  for (const change of result) {
    if (change.type !== 'putEntry' || change.entry.kind !== 'aa_return' || !change.entry.adjustments.length) continue;
    const receipt = change.entry;
    if (change.expectedVersion !== null) reject('更正已有返款时请分别确认原消费的个人承担，不能再次冲减。');
    if (receipt.adjustments.length !== 1 || receipt.adjustments[0]!.targetEntryIds.length !== 1) reject('涉及多笔消费，请明确每笔返款金额，不能自动分摊。');
    const adjustment = receipt.adjustments[0]!;
    const targetId = adjustment.targetEntryIds[0]!;
    if (adjustment.amountCents !== receipt.amountCents || receipt.incomeCents || receipt.assetSaleCents ||
        receipt.relatedEntryIds.some(id => id !== targetId) || new Set(receipt.relatedEntryIds).size !== receipt.relatedEntryIds.length) {
      reject('返款金额与原消费的冲减或关联不一致，请核对本次 AA 金额。');
    }
    const original = snapshot.entries.find(entry => entry.id === targetId);
    if (!original || original.voided || original.kind !== 'expense') reject('请关联一笔有效的原消费，不补造历史付款。');
    if (original.personalCents === null) reject('原消费的个人承担尚未确认；请只记录实际到账，不推算最终个人份额。');
    if (original.personalCents !== original.amountCents) reject('原消费已区分个人承担；返款应结清代垫，不能再次扣减个人开销。');
    if (receipt.month < original.month || (receipt.date && original.date && receipt.date < original.date)) reject('返款日期早于原消费，请核对关联记录。');
    if (result.some(item => (item.type === 'putEntry' && item.entry.id === targetId) || (item.type === 'voidEntry' && item.id === targetId))) {
      reject('同批已更正原消费，请保留该更正并去掉返款上的重复冲减。');
    }
    const correction = corrections.get(targetId) ?? { original, cents: 0 };
    correction.cents += adjustment.amountCents;
    if (correction.cents > original.personalCents) reject('累计返款超过原个人开销，请核对原消费和返款金额。');
    corrections.set(targetId, correction);
    receipt.adjustments = [];
    receipt.relatedEntryIds = [targetId];
    converted.add(receipt.id);
  }
  if (!corrections.size) return result;
  const proposed = new Map<string, LedgerEntryDraft>(snapshot.entries.filter(entry => !entry.voided).map(entry => [entry.id, entry]));
  for (const change of result) {
    if (change.type === 'putEntry') proposed.set(change.entry.id, change.entry);
    else if (change.type === 'voidEntry') proposed.delete(change.id);
  }
  for (const { original } of corrections.values()) for (const receipt of proposed.values()) {
    if (converted.has(receipt.id) || !['aa_return', 'refund', 'reimbursement'].includes(receipt.kind)) continue;
    const unsettled = receipt.amountCents - receipt.incomeCents - receipt.assetSaleCents - receipt.adjustments.reduce((sum, item) => sum + item.amountCents, 0);
    const linked = receipt.relatedEntryIds.includes(original.id) || original.relatedEntryIds.includes(receipt.id) || receipt.adjustments.some(item => item.targetEntryIds.includes(original.id));
    if (unsettled > 0 && linked) reject('原消费已有其他关联返款，请先核对个人承担与已收回金额，不能重复冲减或猜测分配。');
  }
  // The persistence boundary still validates all existing refunds/reimbursements,
  // versions, duplicates and balances before either half of the batch is saved.
  return [...corrections.values()].map(({ original, cents }): Changes[number] => {
    const { version, createdAt: _created, updatedAt: _updated, voided: _voided, sameDayBalanceOrder: _order, ...draft } = original;
    return { type: 'putEntry', entry: LedgerEntryDraftSchema.parse({ ...draft, personalCents: original.personalCents! - cents }),
      expectedVersion: version, confirmDuplicate: false, note: 'AA 返款明确同学承担部分，更正原消费个人开销；实际付款不变' };
  }).concat(result);
}
