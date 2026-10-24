import { HeartHandshake } from 'lucide-react';
import type { LedgerAccountId, LedgerSnapshot } from '../../../shared/ledger';
import { ledgerMoney } from './money';
import { accountName, timeText } from './editors';

/** Book balances from recorded flows and balance snapshots, with the snapshot history. */
export function Accounts({ snapshot, checkBalance, showAccount }: {
  snapshot: LedgerSnapshot;
  checkBalance: (id: LedgerAccountId) => void;
  showAccount: (id: string) => void;
}) {
  const { summary, rules } = snapshot;
  const history = [...snapshot.balanceSnapshots].sort((a, b) => b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt));
  return <div className="a2-ledger-accounts">
    <div className="a2-ledger-sum three">
      <div><div className="k">现金类账面合计</div><div className="v">{ledgerMoney(summary.cashBalanceCents)}</div><div className="d">来自已记流水与快照，不是支付平台实时余额</div></div>
      <div><div className="k">储值卡余额</div><div className="v">{ledgerMoney(summary.storedBalanceCents)}</div><div className="d">饭卡、会员卡等</div></div>
      <div><div className="k"><HeartHandshake aria-hidden="true" />亲情卡本月已用</div><div className="v">{ledgerMoney(summary.familyUsageCents)}</div>
        <div className="d">真实剩余 {rules.familyActualRemainingCents == null ? '未知' : ledgerMoney(rules.familyActualRemainingCents)} · {rules.familyRefreshDay ? `每月 ${rules.familyRefreshDay} 日刷新` : '刷新日未知'} · 不计入资产</div></div>
    </div>
    <section aria-label="账户余额">
      <div className="a2-sec-h"><h3>账户</h3></div>
      <div className="a2-ledger-account-list">
        {summary.accounts.filter(value => value.kind !== 'family').map(value => <div className="row" key={value.id}>
          <button className="name" onClick={() => showAccount(value.id)} title="查看这个账户本月的明细">{value.name}</button>
          <span className="bal">{ledgerMoney(value.balanceCents)}</span>
          <span className="meta">{value.snapshotDate ? `快照 ${value.snapshotDate}` : '尚无余额快照'} · 本月变化 {ledgerMoney(value.periodChangeCents)}
            {value.pendingEntryIds.length > 0 && <b> · {value.pendingEntryIds.length} 笔与快照先后待核对</b>}</span>
          <button className="ui-btn sm" onClick={() => checkBalance(value.id)}>核对余额</button>
        </div>)}
      </div>
    </section>
    <section aria-label="余额快照历史">
      <div className="a2-sec-h"><h3>余额快照</h3><span className="ui-hint">快照是某一时点的余额，不算收入</span></div>
      {history.length ? <div className="table-scroll"><table className="a2-ledger-table"><thead><tr><th>账户</th><th>日期 / 时点</th><th>余额</th><th>已覆盖</th><th>备注</th></tr></thead><tbody>
        {history.map(value => <tr key={value.id}><td>{accountName(value.accountId)}</td><td>{value.date}<small>{value.asOf ? timeText(value.asOf) : '具体时点未知'}</small></td><td>{ledgerMoney(value.balanceCents)}</td><td>{value.coveredEntryIds.length} 笔</td><td>{value.note || '—'}</td></tr>)}
      </tbody></table></div> : <p className="ui-hint">还没有余额快照。点账户旁的「核对余额」记下你看到的余额。</p>}
    </section>
  </div>;
}
