import { useState } from 'react';
import type { PlannerClient } from '../../../shared/client';
import { ledgerAccounts, type LedgerAccount, type LedgerRules } from '../../../shared/ledger';
import { AccountSelect, centsInput, parseMoney, type Save } from './editors';
import { useLedger } from './useLedger';
import { useMobile } from '../../mobile/layout';
import '../LedgerPage.css';

export const ledgerRulesText = [
  '每次记录和查询读取最新本地账本；保存并核对成功后才确认已记账。失败重试不重复录入。',
  '默认人民币、北京时间当天，金额保留两位小数。补录保留发生日期和登记时间；日期不明确则保留待确认。',
  '支付宝、微信默认指余额账户；亲情卡与信用卡分开理解，不擅自映射信用卡账户或生成债务。仅说“余额”不猜具体账户。',
  '只记录实际提供的交易。金额、收支方向不清楚先询问；计划和举例不记成真实交易。疑似重复先核实。',
  '账户不明的真实消费先记录，个人承担金额明确时计入开销，不擅自扣余额；补充账户更正同一笔。',
  '实际付款与个人开销分开；AA、代垫分别保留付款和返款，已排除代垫的个人开销不再扣返款。个人承担不明时保留未知。',
  '借入、借出、归还和收回本金只改变账户与借款余额，不计普通收入或个人开销。还收本金关联对应原借款，支持分次及跨月结清；原借款未登记时只记真实收付并保留剩余未知，不猜测抵扣。利息、手续费单独记消费或收入。',
  '退款、费用报销关联原消费，只冲减一次。跨月回改原消费月份，到账月份只记录资金回流；原消费未入账则不冲减其他消费。',
  '账户间转账不算收入或消费。饭卡、会员卡充值为转账，实际刷卡才计开销；赠送增加卡余额，不计现金收入。',
  '水卡充值一次计入水费开支，不追踪水卡余额或逐日重记；DeepSeek 充值按软件服务开支。',
  '固定生活费默认关闭，用户启用并填写金额后，每月 1 日按约定记录，按规则和月份查重，不提前记未来月份。未到账、金额改变或暂停时可更正，到账账户不明不猜测。',
  '亲情卡每月额度不结转，不算收入或资产；已记录使用额与真实剩余额度分开，未知剩余和刷新日保留未知。',
  '余额快照是该时点余额，不是收入。本地当天新记、未说明先后或具体时刻的交易，默认按余额核对之后处理，可在规则中修改；历史导入和快照已覆盖交易不重复扣减。',
  '个人开销包括本人通过亲情卡、饭卡、会员卡支付的消费，排除代垫并扣相关退款和报销。还款不与原消费重复计算。',
  '普通收入、资产变现、个人开销、亲情卡使用和账户资金变化分别统计。卖电脑不是工资或利润，返款、退款、报销不混成收入。',
  '导入旧账先核对原始备注、关联交易与既有调整；已经冲减的报销或退款只处理一次，不冲减无关的新消费，不将储值卡退回资金算作收入。',
  '账本保存在电脑并自动备份，可导出 CSV 和完整账本。自然语言理解使用已配置的 DeepSeek；手工记账与查看本地记录可离线。',
];

export function RulesEditor({ rules, accounts, busy, save }: { rules: LedgerRules; accounts: readonly LedgerAccount[]; busy: boolean; save: Save }) {
  // The phone row has room for a short label beside its value; the units and hints are in the desktop labels.
  const mobile = useMobile();
  const [enabled, setEnabled] = useState(rules.monthlyAllowance.enabled), [amount, setAmount] = useState(centsInput(rules.monthlyAllowance.amountCents)), [account, setAccount] = useState(rules.monthlyAllowance.accountId ?? ''), [startMonth, setStartMonth] = useState(rules.monthlyAllowance.startMonth);
  const [sameDayNewEntryOrder, setSameDayNewEntryOrder] = useState<'after' | 'ask'>(rules.sameDayNewEntryOrder ?? 'after');
  const [limit, setLimit] = useState(centsInput(rules.familyMonthlyLimitCents)), [remaining, setRemaining] = useState(centsInput(rules.familyActualRemainingCents)), [refreshDay, setRefreshDay] = useState(rules.familyRefreshDay?.toString() ?? ''), [notes, setNotes] = useState(rules.notes), [reason, setReason] = useState(''), [error, setError] = useState('');
  return <form className="editor-form ledger-form" style={{ marginBottom: 24 }} onSubmit={event => { event.preventDefault(); setError(''); try {
    const next: LedgerRules = { monthlyAllowance: { enabled, amountCents: parseMoney(amount, '生活费'), accountId: account || null, startMonth }, sameDayNewEntryOrder, familyMonthlyLimitCents: parseMoney(limit, '亲情卡月额度'), familyActualRemainingCents: remaining ? parseMoney(remaining, '真实剩余额度') : null, familyRefreshDay: refreshDay ? Number(refreshDay) : null, notes };
    if (next.familyRefreshDay != null && (!Number.isInteger(next.familyRefreshDay) || next.familyRefreshDay < 1 || next.familyRefreshDay > 31)) throw new Error('刷新日填写 1–31，未知则留空。');
    void save([{ type: 'updateRules', rules: next, note: reason }]);
  } catch (value) { setError(value instanceof Error ? value.message : '请检查规则。'); } }}><div className="ledger-rules-grid"><section className="ledger-card ledger-rule-editor"><h3>固定生活费</h3><label className="ledger-checkbox"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />每月 1 日按约定记录生活费</label><div className="form-grid"><label>{mobile ? '每月金额' : '每月金额（元）'}<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></label><label>{mobile ? '起始月份' : '规则起始月份'}<input required type="month" value={startMonth} onChange={event => setStartMonth(event.target.value)} /></label></div><AccountSelect label="到账账户" value={account} onChange={setAccount} accounts={accounts} excludeFamily /><p>按月份查重，不提前录未来月份。暂停后重新启用时从本月或指定的更晚月份恢复，不补暂停期间。账户不明时保留待确认；这是已约定记录规则，不代表银行到账验证。</p></section><section className="ledger-card ledger-rule-editor"><h3>亲情卡</h3><div className="form-grid"><label>{mobile ? '每月额度' : '每月约定额度（元）'}<input required inputMode="decimal" value={limit} onChange={event => setLimit(event.target.value)} /></label><label>{mobile ? '真实剩余' : '真实剩余额度（元，可留空）'}<input inputMode="decimal" value={remaining} onChange={event => setRemaining(event.target.value)} placeholder="未知" /></label></div><label>{mobile ? '每月刷新日' : '额度刷新日（1–31，可留空）'}<input inputMode="numeric" value={refreshDay} onChange={event => setRefreshDay(event.target.value)} placeholder="未知" /></label><p>额度不计收入或资产，不按“月额度减已记录使用”推算真实剩余，未用完不结转。</p></section></div>
    <div className="form-grid"><label>新记交易与余额核对的先后<select value={sameDayNewEntryOrder} onChange={event => setSameDayNewEntryOrder(event.target.value as 'after' | 'ask')}><option value="after">按核对之后处理</option><option value="ask">先核对再更新余额</option></select></label><p className="ledger-form-note">仅用于本地当天新记、没有明确先后或时刻的交易。历史导入及余额已覆盖的交易不重复扣减。也可以在对话框说“新记交易默认按核对之后处理”或“新记交易先核对再更新余额”。</p></div>
    <label>补充记账规则<textarea rows={3} value={notes} onChange={event => setNotes(event.target.value)} placeholder="你可以补充账户称呼、分类习惯或需要特别留意的约定" /></label><label>规则修改说明<input required value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：下月起生活费调整为 1200 元" /></label><p className="ledger-form-note">保存后按新规则处理后续记录。旧账保留原记录；需要变更某笔生活费时，在明细中更正或作废，并保留说明。</p>{error && <p className="error" role="alert">{error}</p>}<footer className="form-footer"><button className="primary" disabled={busy}>保存记账规则</button></footer></form>;
}

/** 我的 › 设置 › 记账: the bookkeeping rules, the written conventions and account aliases. */
export function LedgerRulesSettings({ api }: { api: PlannerClient }) {
  const ledger = useLedger(api);
  if (!ledger.snapshot) return <div className="ui-empty"><h4>正在载入本地账本…</h4>{ledger.error && <p role="alert" className="error">{ledger.error}</p>}</div>;
  return <div className="a2-ledger-rules">
    <p role={ledger.error ? 'alert' : 'status'} className={ledger.error ? 'error' : 'ui-hint'}>{ledger.error || ledger.notice}</p>
    <RulesEditor key={ledger.snapshot.revision} rules={ledger.snapshot.rules} accounts={ledgerAccounts(ledger.snapshot)} busy={ledger.busy} save={ledger.save} />
    <details className="a2-ledger-conventions"><summary>记账口径</summary><ol>{ledgerRulesText.map(value => <li key={value}>{value}</li>)}</ol></details>
    <details className="a2-ledger-conventions"><summary>账户名称与别名</summary>{ledgerAccounts(ledger.snapshot).map(value => <p key={value.id}>{value.name}：{value.aliases.join('、')}</p>)}</details>
  </div>;
}
