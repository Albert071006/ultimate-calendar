import { HeartHandshake } from 'lucide-react';
import { useState } from 'react';
import { ledgerAccounts, type LedgerAccount, type LedgerAccountId, type LedgerSnapshot } from '../../../shared/ledger';
import { ledgerChange, ledgerMoney } from './money';
import { accountName, timeText, type Save } from './editors';
import { AccountEditor } from './AccountEditor';
import { Modal } from '../Modal';

/** Book balances from recorded flows and balance snapshots, with the snapshot history. */
export function Accounts({ snapshot, busy, error, save, checkBalance, showAccount }: {
  snapshot: LedgerSnapshot;
  busy: boolean; error: string; save: Save;
  checkBalance: (id: LedgerAccountId) => void;
  showAccount: (id: string) => void;
}) {
  const { summary, rules } = snapshot;
  const accounts = ledgerAccounts(snapshot);
  const [editor, setEditor] = useState<LedgerAccount | 'new' | null>(null);
  const history = [...snapshot.balanceSnapshots].sort((a, b) => b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt));
  return <div className="a2-ledger-accounts">
    <div className="a2-ledger-sum three">
      <div><div className="k">现金类账面合计</div><div className="v">{ledgerMoney(summary.cashBalanceCents)}</div><div className="d">来自已记流水与快照，不是支付平台实时余额</div></div>
      <div><div className="k">储值卡余额</div><div className="v">{ledgerMoney(summary.storedBalanceCents)}</div><div className="d">饭卡、会员卡等</div></div>
      <div><div className="k"><HeartHandshake aria-hidden="true" />亲情卡本月已用</div><div className="v">{ledgerMoney(summary.familyUsageCents)}</div>
        <div className="d">真实剩余 {rules.familyActualRemainingCents == null ? '未知' : ledgerMoney(rules.familyActualRemainingCents)} · {rules.familyRefreshDay ? `每月 ${rules.familyRefreshDay} 日刷新` : '刷新日未知'} · 不计入资产</div></div>
    </div>
    <section aria-label="账户余额">
      <div className="a2-sec-h"><h3>账户</h3><button type="button" className="ui-btn sm" disabled={busy} onClick={() => setEditor('new')}>新增账户</button></div>
      <div className="a2-ledger-account-list">
        {accounts.map(account => { const value = summary.accounts.find(value => value.id === account.id);
          return <div className="row" key={account.id}>
          <button className="name" onClick={() => showAccount(account.id)} title="查看这个账户本月的明细">{account.name}</button>
          <span className="bal">{account.kind === 'family' ? '不计资产' : ledgerMoney(value?.balanceCents ?? null)}</span>
          <span className="meta">{account.kind === 'family' ? '亲情卡使用单独统计' : <>{value?.snapshotDate ? `快照 ${value.snapshotDate}` : '尚无余额快照'} · 本月变化 {ledgerChange(value?.periodChangeCents ?? 0)}
            {!!value?.pendingEntryIds.length && <b> · {value.pendingEntryIds.length} 笔与快照先后待核对</b>}</>}
            {!!account.aliases.length && <small>别名：{account.aliases.join('、')}</small>}</span>
          <div className="ledger-account-actions">{account.kind !== 'family' && <button className="ui-btn sm" disabled={busy} onClick={() => checkBalance(account.id)}>核对余额</button>}<button className="ui-btn sm ghost" disabled={busy} aria-label={`编辑账户 ${account.name}`} onClick={() => setEditor(account)}>编辑账户</button></div>
        </div>; })}
      </div>
    </section>
    <section aria-label="余额快照历史">
      <div className="a2-sec-h"><h3>余额快照</h3><span className="ui-hint">快照是某一时点的余额，不算收入</span></div>
      {history.length ? <div className="table-scroll"><table className="a2-ledger-table"><thead><tr><th>账户</th><th>日期 / 时点</th><th>余额</th><th>已覆盖</th><th>备注</th></tr></thead><tbody>
        {history.map(value => <tr key={value.id}><td>{accountName(value.accountId, accounts)}</td><td>{value.date}<small>{value.asOf ? timeText(value.asOf) : '具体时点未知'}</small></td><td>{ledgerMoney(value.balanceCents)}</td><td>{value.coveredEntryIds.length} 笔</td><td>{value.note || '—'}</td></tr>)}
      </tbody></table></div> : <p className="ui-hint">还没有余额快照。点账户旁的「核对余额」记下你看到的余额。</p>}
    </section>
    {editor && <Modal title={editor === 'new' ? '新增账户' : '编辑账户'} closeDisabled={busy} onClose={() => setEditor(null)}><AccountEditor key={editor === 'new' ? 'new' : editor.id} account={editor === 'new' ? undefined : editor} accounts={accounts} busy={busy} error={error} save={save} close={() => setEditor(null)} /></Modal>}
  </div>;
}
