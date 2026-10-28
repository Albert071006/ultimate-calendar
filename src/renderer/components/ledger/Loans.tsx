import type { LedgerEntry } from '../../../shared/ledger';
import { ledgerLoans } from '../../../shared/ledger-loans';
import { kinds } from './editors';
import { ledgerMoney } from './money';
import './loans.css';

/** Loan balances span the complete ledger; changing the month never hides old debts. */
export function Loans({ entries, busy, edit }: { entries: LedgerEntry[]; busy: boolean; edit: (entry: LedgerEntry) => void }) {
  const loans = ledgerLoans(entries);
  if (!loans.items.length && !loans.unlinked.length) return null;
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const items = [...loans.items].sort((a, b) => b.outstandingCents - a.outstandingCents || a.counterparty.localeCompare(b.counterparty));
  return <section className="ledger-loans" aria-label="借款往来">
    <div className="a2-sec-h"><h3>借款</h3><span className="ui-hint">全部月份 · 本金</span></div>
    <dl className="ledger-loan-totals">
      <div><dt>待还本金</dt><dd>{ledgerMoney(loans.payableCents)}</dd></div>
      <div><dt>待收本金</dt><dd>{ledgerMoney(loans.receivableCents)}</dd></div>
    </dl>
    <details className="ledger-loan-list"><summary>查看借款明细（{items.length} 笔{loans.unlinked.length ? `，另有 ${loans.unlinked.length} 笔未关联` : ''}）</summary>
      {items.map(item => {
        const original = byId.get(item.entryId)!;
        const borrowing = item.kind === 'loan_borrow';
        return <details className="ledger-loan-item" key={item.entryId}><summary>
          <span><b>{item.counterparty || '对方待确认'}</b><small>{borrowing ? '借入' : '借出'} · {original.title} · {original.date ?? original.month}</small></span>
          <strong>{item.outstandingCents ? `${borrowing ? '待还' : '待收'} ${ledgerMoney(item.outstandingCents)}` : '已结清'}</strong>
        </summary><div className="ledger-loan-detail">
          <dl><div><dt>原本金</dt><dd>{ledgerMoney(item.principalCents)}</dd></div><div><dt>{borrowing ? '已归还' : '已收回'}</dt><dd>{ledgerMoney(item.settledCents)}</dd></div><div><dt>剩余本金</dt><dd>{ledgerMoney(item.outstandingCents)}</dd></div></dl>
          {!!item.settlements.length && <ul aria-label={borrowing ? '归还记录' : '收回记录'}>{item.settlements.map(value => <li key={value.id}>{value.date ?? value.month} · {value.title} · {ledgerMoney(value.amountCents)} <button type="button" className="ui-btn sm ghost" disabled={busy} onClick={() => edit(value)}>更正</button></li>)}</ul>}
          <button type="button" className="ui-btn sm" disabled={busy} onClick={() => edit(original)}>更正原借款</button>
        </div></details>;
      })}
      {!!loans.unlinked.length && <div className="ledger-loan-unlinked"><h4>未关联原借款</h4><p>以下仅记录实际收付，尚未抵扣任何借款，剩余欠款未知。</p><ul>{loans.unlinked.map(value => <li key={value.id}>{value.date ?? value.month} · {value.counterparty || '对方待确认'} · {kinds[value.kind]} {ledgerMoney(value.amountCents)} <button type="button" className="ui-btn sm ghost" disabled={busy} onClick={() => edit(value)}>补充关联</button></li>)}</ul></div>}
    </details>
  </section>;
}
