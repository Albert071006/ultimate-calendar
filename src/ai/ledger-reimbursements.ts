import { formatLedgerMoney, type LedgerEntryDraft, type LedgerMutationRequest, type LedgerSnapshot } from '../shared/ledger';

type Changes = LedgerMutationRequest['changes'];
type Adjustment = LedgerEntryDraft['adjustments'][number];

/** A pre-write question, not a failed/unknown write or a request to rerun AI. */
export class LedgerReimbursementClarification extends Error {
  constructor(readonly question: string) {
    super(question);
    this.name = 'LedgerReimbursementClarification';
  }
}
const ask = (question: string): never => { throw new LedgerReimbursementClarification(question); };
const sameTargets = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(id => b.includes(id));
const total = (values: readonly number[]) => values.reduce((sum, cents) => sum + cents, 0);
const money = (cents: number) => `¥${formatLedgerMoney(cents)}`;
const description = (entries: readonly LedgerEntryDraft[], remaining?: ReadonlyMap<string, number>) => {
  const labels = entries.slice(0, 8).map(entry => `“${entry.title}”${remaining ? `剩余${money(remaining.get(entry.id)!)}` : ''}`);
  return labels.join('、') + (entries.length > 8 ? `等${entries.length}笔` : '');
};

/** Split only a uniquely determined full settlement. Persistence continues to
 * require each adjustment group to share a month/category, and remains the final
 * authority for versions, duplicate receipts, cash flow and atomic writes.
 * The caller must submit with this snapshot's expectedRevision, never refresh
 * the revision on a normalized proposal without rebuilding that proposal. */
export function normalizeReimbursements(changes: Changes, snapshot: LedgerSnapshot): Changes {
  const result = structuredClone(changes);
  const receipts = result.filter(change => change.type === 'putEntry' &&
    ['refund', 'reimbursement'].includes(change.entry.kind) && change.entry.adjustments.length);
  if (!receipts.length) return result;
  const pendingAllocations = new Set(receipts.flatMap(change => {
    if (change.type !== 'putEntry') return [];
    const original = snapshot.entries.find(entry => entry.id === change.entry.id);
    return original && JSON.stringify(original.adjustments) === JSON.stringify(change.entry.adjustments) ? [] : [change.entry];
  }));

  // Evaluate the final proposed state: updates replace their old adjustments,
  // voids remove them, and a same-batch expense is available in either order.
  const proposed = new Map<string, LedgerEntryDraft>(snapshot.entries.filter(entry => !entry.voided).map(entry => [entry.id, entry]));
  const changedIds = new Set<string>();
  for (const change of result) {
    if (change.type !== 'putEntry' && change.type !== 'voidEntry') continue;
    const id = change.type === 'putEntry' ? change.entry.id : change.id;
    if (changedIds.has(id)) ask('同一批请求多次更正或移除了同一笔账目，请确认最终保留的账目和报销金额。');
    changedIds.add(id);
    if (change.type === 'putEntry') proposed.set(id, change.entry);
    else proposed.delete(id);
  }

  for (const change of receipts) {
    if (change.type !== 'putEntry') continue;
    const receipt = change.entry;
    const original = snapshot.entries.find(entry => entry.id === receipt.id);
    // An account/note-only edit must not reinterpret a valid historical group.
    if (original && JSON.stringify(original.adjustments) === JSON.stringify(receipt.adjustments)) continue;
    if (new Set(receipt.relatedEntryIds).size !== receipt.relatedEntryIds.length || receipt.relatedEntryIds.includes(receipt.id)) {
      ask('这次报销的原账目关联有重复或指向报销自身，请确认要关联的原消费。');
    }
    const normalized: Adjustment[] = [];
    const settledIds: string[] = [];
    for (const adjustment of receipt.adjustments) {
      const ids = new Set(adjustment.targetEntryIds);
      if (ids.size !== adjustment.targetEntryIds.length || ids.has(receipt.id)) {
        ask('这次报销重复关联了同一笔消费或关联了报销自身，请确认需要冲减的原消费。');
      }
      const targets = [...ids].map(id => proposed.get(id));
      const invalid = targets.findIndex(target => !target || target.kind !== 'expense' || target.personalCents === null);
      if (invalid >= 0) {
        const target = targets[invalid];
        ask(target ? `请先确认“${target.title}”的原消费及个人承担金额，再确定本次冲减；金额未知时不能替你分摊。`
          : '有一笔拟冲减的原消费不存在或已移除，请确认对应的原账目；若原消费没有入账，可以只记录实际到账。');
      }
      const originals = targets as LedgerEntryDraft[];
      const crossGroup = new Set(originals.map(entry => entry.month)).size > 1 || new Set(originals.map(entry => entry.category)).size > 1;
      const remaining = new Map(originals.map(entry => [entry.id, entry.personalCents!]));
      let overlapsSingle = false;
      let overlapsGroup = false;
      for (const entry of proposed.values()) for (const prior of entry.adjustments) {
        if (prior === adjustment || !prior.targetEntryIds.some(id => ids.has(id))) continue;
        if (prior.targetEntryIds.length > 1) {
          // An explicit singleton needs no allocation. The changed group is
          // checked against it in its own turn, independent of action order.
          if (originals.length === 1 && pendingAllocations.has(entry)) continue;
          if (!crossGroup && sameTargets(prior.targetEntryIds, adjustment.targetEntryIds)) { overlapsGroup = true; continue; }
          ask(`${description(originals)}还关联着未分配到每笔的组合退款或报销，请先明确这些原消费各自已冲减多少，才能继续冲减，避免重复计算。`);
        }
        const id = prior.targetEntryIds[0]!;
        remaining.set(id, remaining.get(id)! - prior.amountCents);
        overlapsSingle = true;
      }
      // Existing valid same-month/category group allocations stay unchanged.
      if (!crossGroup && !(originals.length > 1 && overlapsSingle)) {
        normalized.push(adjustment);
        continue;
      }
      if (overlapsGroup) ask(`${description(originals)}同时存在组合冲减和逐笔冲减，请先确认每笔已冲减的金额，避免重复计算。`);

      for (const entry of proposed.values()) {
        if (entry === receipt || !['refund', 'reimbursement', 'aa_return'].includes(entry.kind)) continue;
        const unallocated = entry.amountCents - entry.incomeCents - entry.assetSaleCents - total(entry.adjustments.map(item => item.amountCents));
        const linked = entry.relatedEntryIds.some(id => ids.has(id)) || originals.some(target => target.relatedEntryIds.includes(entry.id)) ||
          entry.adjustments.some(item => item.targetEntryIds.some(id => ids.has(id)));
        if (unallocated > 0 && linked) {
          ask(`${description(originals)}已有“${entry.title}”到账，其中${money(unallocated)}尚未明确如何结算，请先确认它是否已抵扣个人开销或只是收回代垫，避免重复冲减。`);
        }
      }
      if ([...remaining.values()].some(cents => cents < 0)) {
        ask(`${description(originals)}的已有冲减超过当前个人开销，请先核对原金额和已报销金额。`);
      }
      const available = total([...remaining.values()]);
      if (adjustment.amountCents !== available) {
        ask(`${description(originals, remaining)}，合计尚可冲减${money(available)}；本次拟冲减${money(adjustment.amountCents)}。` +
          (adjustment.amountCents < available ? '请说明每笔分别冲减多少，不能自动按比例分摊。'
            : '请核对冲减金额及超出部分的性质，不能再次冲减或自动把差额记为收入。'));
      }
      for (const target of originals) {
        const cents = remaining.get(target.id)!;
        if (cents > 0) normalized.push({ ...adjustment, targetEntryIds: [target.id], amountCents: cents });
        else settledIds.push(target.id);
      }
    }
    if (normalized.length > 100) ask('本次逐笔冲减超过100项，请把报销按明确的原消费范围分批记录。');
    const related = [...new Set([...receipt.relatedEntryIds, ...settledIds])];
    if (related.length > 100) ask('本次报销关联消费超过100笔，请按明确的原消费范围分批记录。');
    receipt.adjustments = normalized;
    receipt.relatedEntryIds = related;
  }
  return result;
}
