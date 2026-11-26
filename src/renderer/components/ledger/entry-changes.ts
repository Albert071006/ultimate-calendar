import { ledgerAccounts, type LedgerEntryDraft, type LedgerEntryKind, type LedgerSnapshot } from '../../../shared/ledger';
import { localDateTime } from '../../calendar-timeline';
import { ledgerChange } from './money';

export const kinds: Record<LedgerEntryKind, string> = { expense: '消费', income: '普通收入', asset_sale: '资产变现', transfer: '账户转账', bonus: '赠送额度', refund: '退款', reimbursement: '费用报销', aa_return: 'AA / 代垫返款', loan_borrow: '借入', loan_lend: '借出', loan_repay: '归还借款', loan_collect: '收回借款', repayment: '其他还款（信用卡等）', adjustment: '个人开销调整' };

const amount = (cents: number | null) => cents === null ? '待确认' : (cents / 100).toFixed(2);
const brief = (text: string) => text.length > 80 ? `${text.slice(0, 79)}…` : text;
const list = (items: string[]) => items.length > 3 ? `${items.slice(0, 3).join('、')}等 ${items.length} 项` : items.join('、') || '无';

/** Omit matching rows, including repeated identical payments and reordered links. */
function changedRows<T>(before: T[], after: T[], key: (row: T) => string, label: (row: T) => string) {
  const added = after.map(row => ({ key: key(row), row }));
  const removed: string[] = [];
  for (const row of before) {
    const rowKey = key(row);
    const index = added.findIndex(item => item.key === rowKey);
    if (index < 0) removed.push(label(row));
    else added.splice(index, 1);
  }
  if (removed.length || added.length) return `${list(removed)} → ${list(added.map(item => label(item.row)))}`;
}

export function summarizeEntryChanges(before: LedgerEntryDraft, after: LedgerEntryDraft, snapshot: LedgerSnapshot): string {
  const changes: string[] = [];
  const field = (label: string, oldValue: string, newValue: string) => {
    if (oldValue === newValue) return;
    let start = 0;
    if (brief(oldValue) === brief(newValue)) {
      while (oldValue[start] === newValue[start]) start++;
      start = Math.max(0, start - 12);
    }
    const excerpt = (value: string) => value ? `${start ? '…' : ''}${brief(value.slice(start))}` : '无';
    changes.push(`${label} ${excerpt(oldValue)} → ${excerpt(newValue)}`);
  };
  field('类型', kinds[before.kind], kinds[after.kind]);
  field('项目', before.title, after.title);
  field('分类', before.category, after.category);
  const day = (entry: LedgerEntryDraft) => entry.date ?? `${entry.month}（日期待确认）`;
  field(before.date || after.date ? '发生日期' : '发生月份', day(before), day(after));
  field('日期说明', before.dateNote, after.dateNote);
  const time = (stamp: string | null) => stamp ? localDateTime(Date.parse(stamp)).replace('T', ' ') : '待确认';
  field('发生时刻', time(before.occurredAt), time(after.occurredAt));

  const accounts = ledgerAccounts(snapshot);
  const account = (id: string | null) => accounts.find(item => item.id === id)?.name ?? id ?? '待确认';
  const oldFlow = before.cashflows[0], newFlow = after.cashflows[0];
  if (before.cashflows.length === 1 && after.cashflows.length === 1 && oldFlow && newFlow
      && Math.sign(oldFlow.deltaCents) === Math.sign(newFlow.deltaCents)
      && Math.abs(oldFlow.deltaCents) === before.amountCents && Math.abs(newFlow.deltaCents) === after.amountCents) {
    field(newFlow.deltaCents > 0 ? '收款账户' : '支付账户', account(oldFlow.accountId), account(newFlow.accountId));
  } else {
    const flows = changedRows(before.cashflows, after.cashflows, row => JSON.stringify([row.accountId, row.deltaCents]),
      row => `${account(row.accountId)} ${ledgerChange(row.deltaCents)}`);
    if (flows) changes.push(`分项收付 ${flows}`);
  }
  field('金额', amount(before.amountCents), amount(after.amountCents));
  field('个人开销', amount(before.personalCents), amount(after.personalCents));
  field('对方', before.counterparty || '待确认', after.counterparty || '待确认');

  if (before.relatedEntryIds.length || after.relatedEntryIds.length || before.adjustments.length || after.adjustments.length) {
    const ids = new Set([...before.relatedEntryIds, ...after.relatedEntryIds, ...[...before.adjustments, ...after.adjustments].flatMap(row => row.targetEntryIds)]);
    const titles = new Map<string, string>(), seen = new Set<string>(), ambiguous = new Set<string>();
    for (const entry of snapshot.entries) {
      if (!ids.has(entry.id)) continue;
      const name = brief(entry.title);
      titles.set(entry.id, name);
      if (seen.has(name)) ambiguous.add(name);
      seen.add(name);
    }
    const title = (id: string) => {
      const name = titles.get(id) ?? id;
      return ambiguous.has(name) ? `${name}（${id}）` : name;
    };
    const linked = changedRows(before.relatedEntryIds, after.relatedEntryIds, id => id, title);
    if (linked) changes.push(`${after.kind === 'loan_repay' || after.kind === 'loan_collect' ? '关联原借款' : '关联原消费'} ${linked}`);
    const allocationKey = (row: LedgerEntryDraft['adjustments'][number]) => JSON.stringify([[...row.targetEntryIds].sort(), row.amountCents]);
    const adjustments = changedRows(before.adjustments, after.adjustments, allocationKey,
      row => `${list(row.targetEntryIds.map(title))} ${amount(row.amountCents)}`);
    if (adjustments) changes.push(`冲减 ${adjustments}`);
    else if (changedRows(before.adjustments, after.adjustments, row => JSON.stringify([allocationKey(row), row.note]), () => '备注')) changes.push('修改冲减备注');
  }
  field(before.kind === 'reimbursement' || after.kind === 'reimbursement' ? '额外收入' : '普通收入', amount(before.incomeCents), amount(after.incomeCents));
  field('资产变现', amount(before.assetSaleCents), amount(after.assetSaleCents));
  if (before.note !== after.note) {
    if (!changes.length) return '修改备注';
    changes.push('修改备注');
  }
  return changes.length ? `修改：${changes.join('；')}` : '手工核对保存';
}
