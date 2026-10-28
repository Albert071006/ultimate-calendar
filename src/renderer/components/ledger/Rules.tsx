import { useEffect, useState } from 'react';
import type { PlannerClient } from '../../../shared/client';
import { ledgerAccounts, type LedgerAccount, type LedgerRules } from '../../../shared/ledger';
import { AccountSelect, centsInput, parseMoney, type Save } from './editors';
import { useLedger } from './useLedger';
import { useMobile } from '../../mobile/layout';
import '../LedgerPage.css';

function fields(rules: LedgerRules) {
  return { enabled: rules.monthlyAllowance.enabled, amount: centsInput(rules.monthlyAllowance.amountCents),
    account: rules.monthlyAllowance.accountId ?? '', startMonth: rules.monthlyAllowance.startMonth,
    sameDayNewEntryOrder: rules.sameDayNewEntryOrder ?? 'after', limit: centsInput(rules.familyMonthlyLimitCents),
    remaining: centsInput(rules.familyActualRemainingCents), refreshDay: rules.familyRefreshDay?.toString() ?? '', notes: rules.notes };
}
type Fields = ReturnType<typeof fields>;
type Draft = { base: Fields; values: Fields; reason: string };
// Retain unfinished edits across navigation in this open app, scoped to its client/connection.
// Nothing is written to the ledger or browser storage before the explicit save.
const drafts = new WeakMap<PlannerClient, Draft>();
const same = (left: Fields, right: Fields) => JSON.stringify(left) === JSON.stringify(right);
function reconcile(draft: Draft, rules: LedgerRules): Draft {
  const current = fields(rules);
  if (same(draft.base, current)) return draft;
  const values = Object.fromEntries(Object.keys(current).map(name => {
    const key = name as keyof Fields;
    return [key, draft.values[key] === draft.base[key] ? current[key] : draft.values[key]];
  })) as Fields;
  return { base: current, values, reason: same(values, current) ? '' : draft.reason };
}

export function RulesEditor({ rules, accounts, busy, save, draftClient }: {
  rules: LedgerRules; accounts: readonly LedgerAccount[]; busy: boolean; save: Save; draftClient?: PlannerClient;
}) {
  const mobile = useMobile();
  const [draft, setDraft] = useState<Draft>(() => reconcile(draftClient && drafts.get(draftClient) || { base: fields(rules), values: fields(rules), reason: '' }, rules));
  const [error, setError] = useState('');
  const keep = (next: Draft) => { if (draftClient) drafts.set(draftClient, next); setDraft(next); };
  useEffect(() => { const next = reconcile(draft, rules); if (next !== draft) keep(next); }, [rules]);
  const edit = <K extends keyof Fields>(key: K, value: Fields[K]) => { setError(''); keep({ ...draft, values: { ...draft.values, [key]: value } }); };
  const { enabled, amount, account, startMonth, sameDayNewEntryOrder, limit, remaining, refreshDay, notes } = draft.values;
  const dirty = !same(draft.values, fields(rules));
  return <form className="editor-form ledger-form" style={{ marginBottom: 24 }} onSubmit={event => {
    event.preventDefault(); setError(''); if (busy || !dirty) return;
    try {
      const next: LedgerRules = { monthlyAllowance: { enabled, amountCents: parseMoney(amount, '生活费'), accountId: account || null, startMonth },
        sameDayNewEntryOrder, familyMonthlyLimitCents: parseMoney(limit, '亲情卡月额度'), familyActualRemainingCents: remaining.trim() ? parseMoney(remaining, '真实剩余额度') : null,
        familyRefreshDay: refreshDay.trim() ? Number(refreshDay) : null, notes };
      if (next.familyRefreshDay != null && (!Number.isInteger(next.familyRefreshDay) || next.familyRefreshDay < 1 || next.familyRefreshDay > 31)) throw new Error('刷新日填写 1–31，未知则留空。');
      // Normalize valid amounts, but retain the draft until the saved snapshot confirms it.
      keep({ ...draft, values: fields(next) });
      void save([{ type: 'updateRules', rules: next, note: draft.reason.trim() || '在记账设置中更新规则' }])
        .catch(() => setError('尚未确认保存完成，请保留内容并重试。'));
    } catch (value) { setError(value instanceof Error ? value.message : '请检查规则。'); }
  }}>
    <p className="ui-hint" aria-live="polite">{busy ? '正在保存记账规则…' : dirty ? '有未保存的修改。切换页面会保留草稿，请点击“保存记账规则”生效。' : '当前显示的是已保存的记账规则。'}</p>
    <div className="ledger-rules-grid">
      <section className="ledger-card ledger-rule-editor"><h3>固定生活费</h3>
        <label className="ledger-checkbox"><input type="checkbox" checked={enabled} onChange={event => edit('enabled', event.target.checked)} />每月 1 日按约定记录生活费</label>
        <div className="form-grid"><label>{mobile ? '每月金额' : '每月金额（元）'}<input required inputMode="decimal" value={amount} onChange={event => edit('amount', event.target.value)} /></label>
          <label>{mobile ? '起始月份' : '规则起始月份'}<input required type="month" value={startMonth} onChange={event => edit('startMonth', event.target.value)} /></label></div>
        <AccountSelect label="到账账户" value={account} onChange={value => edit('account', value)} accounts={accounts} excludeFamily />
        <p>按月份查重，不提前录未来月份。暂停后重新启用时从本月或指定的更晚月份恢复，不补暂停期间。账户不明时保留待确认；这是已约定记录规则，不代表银行到账验证。</p>
      </section>
      <section className="ledger-card ledger-rule-editor"><h3>亲情卡</h3><div className="form-grid">
        <label>{mobile ? '每月额度' : '每月约定额度（元）'}<input required inputMode="decimal" value={limit} onChange={event => edit('limit', event.target.value)} /></label>
        <label>{mobile ? '真实剩余' : '真实剩余额度（元，可留空）'}<input inputMode="decimal" value={remaining} onChange={event => edit('remaining', event.target.value)} placeholder="未知" /></label></div>
        <label>{mobile ? '每月刷新日' : '额度刷新日（1–31，可留空）'}<input inputMode="numeric" value={refreshDay} onChange={event => edit('refreshDay', event.target.value)} placeholder="未知" /></label>
        <p>额度不计收入或资产，不按“月额度减已记录使用”推算真实剩余，未用完不结转。</p>
      </section>
    </div>
    <div className="form-grid"><label>新记交易与余额核对的先后<select value={sameDayNewEntryOrder} onChange={event => edit('sameDayNewEntryOrder', event.target.value as 'after' | 'ask')}><option value="after">按核对之后处理</option><option value="ask">先核对再更新余额</option></select></label>
      <p className="ledger-form-note">仅用于本地当天新记、没有明确先后或时刻的交易。历史导入及余额已覆盖的交易不重复扣减。也可以在对话框说“新记交易默认按核对之后处理”或“新记交易先核对再更新余额”。</p></div>
    <label>补充记账规则<textarea rows={3} value={notes} onChange={event => edit('notes', event.target.value)} placeholder="你可以补充分类习惯或需要特别留意的约定" /></label>
    <label>规则修改说明<input value={draft.reason} onChange={event => keep({ ...draft, reason: event.target.value })} placeholder="可选，例如：下月起生活费调整为 1200 元" /></label>
    <p className="ledger-form-note">保存后按新规则处理后续记录。旧账保留原记录；需要变更某笔生活费时，在明细中更正或作废，并保留说明。</p>
    <p className="ledger-form-note">账户名称和别名可在“账单 → 账户”中选择对应账户的“编辑账户”修改。</p>
    {error && <p className="error" role="alert">{error}</p>}
    <footer className="form-footer"><button type="button" disabled={busy || !dirty} onClick={() => { setError(''); keep({ base: fields(rules), values: fields(rules), reason: '' }); }}>放弃未保存修改</button><button className="primary" disabled={busy || !dirty}>保存记账规则</button></footer>
  </form>;
}

/** 我的 › 设置 › 记账. Account names and aliases are edited with their accounts. */
export function LedgerRulesSettings({ api }: { api: PlannerClient }) {
  const ledger = useLedger(api);
  if (!ledger.snapshot) return <div className="ui-empty"><h4>正在载入账本…</h4>{ledger.error && <p role="alert" className="error">{ledger.error}</p>}</div>;
  return <div className="a2-ledger-rules">
    <p role={ledger.error ? 'alert' : 'status'} className={ledger.error ? 'error' : 'ui-hint'}>{ledger.error || ledger.notice}</p>
    <RulesEditor rules={ledger.snapshot.rules} accounts={ledgerAccounts(ledger.snapshot)} busy={ledger.busy} save={ledger.save} draftClient={api} />
  </div>;
}
