import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Download, HeartHandshake, RefreshCw, Undo2, Wallet } from 'lucide-react';
import type { HostCapabilities, PlannerClient } from '../../shared/client';
import { LEDGER_ACCOUNTS, LedgerEntryDraftSchema, type LedgerAccountId, type LedgerEntry, type LedgerEntryKind, type LedgerMutationRequest, type LedgerRules, type LedgerSnapshot } from '../../shared/ledger';
import { operationId, todayDate } from '../calendar-layout';
import { localDateTime } from '../calendar-timeline';
import { Modal } from './Modal';
import { LedgerCategoryChart, LedgerDailyChart, ledgerMoney } from './LedgerCharts';
import './LedgerPage.css';

type Tab = 'overview' | 'details' | 'accounts' | 'rules';
type Change = LedgerMutationRequest['changes'][number];
const kinds: Record<LedgerEntryKind, string> = { expense: '消费', income: '普通收入', asset_sale: '资产变现', transfer: '账户转账', bonus: '赠送额度', refund: '退款', reimbursement: '费用报销', aa_return: 'AA / 代垫返款', repayment: '还款', adjustment: '个人开销调整' };
const accountName = (id: LedgerAccountId | null) => LEDGER_ACCOUNTS.find(value => value.id === id)?.name ?? '账户待确认';
const timeText = (value: string | null | undefined) => value ? localDateTime(Date.parse(value)).replace('T', ' ') : '时点未明确';
const inKinds: LedgerEntryKind[] = ['income', 'asset_sale', 'bonus', 'refund', 'reimbursement', 'aa_return'];
const centsInput = (value: number | null | undefined) => value == null ? '' : (value / 100).toFixed(2);
const parseMoney = (value: string, name: string, signed = false) => {
  if (!(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(value.trim())) throw new Error(`${name}请填写金额，最多两位小数。`);
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > 9_000_000_000_000) throw new Error(`${name}超出可记录范围。`);
  return amount;
};

const ledgerRulesText = [
  '每次记录和查询读取最新本地账本；保存并核对成功后才确认已记账。失败重试不重复录入。',
  '默认人民币、北京时间当天，金额保留两位小数。补录保留发生日期和登记时间；日期不明确则保留待确认。',
  '支付宝、微信默认指余额账户；亲情卡与信用卡分开理解，不擅自映射信用卡账户或生成债务。仅说“余额”不猜具体账户。',
  '只记录实际提供的交易。金额、收支方向不清楚先询问；计划和举例不记成真实交易。疑似重复先核实。',
  '账户不明的真实消费先记录，个人承担金额明确时计入开销，不擅自扣余额；补充账户更正同一笔。',
  '实际付款与个人开销分开；AA、代垫分别保留付款和返款，已排除代垫的个人开销不再扣返款。个人承担不明时保留未知。',
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

export function LedgerPage({ api, host, createRequest = 0 }: { api: PlannerClient; host?: HostCapabilities; createRequest?: number }) {
  const [month, setMonth] = useState(todayDate().slice(0, 7));
  const [tab, setTab] = useState<Tab>('overview');
  const [snapshot, setSnapshot] = useState<LedgerSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<LedgerEntry | 'new' | null>(null);
  const [voidTarget, setVoidTarget] = useState<LedgerEntry | null>(null);
  const [balanceAccount, setBalanceAccount] = useState<LedgerAccountId | null>(null);
  const [account, setAccount] = useState(''), [category, setCategory] = useState(''), [day, setDay] = useState(''), [search, setSearch] = useState(''), [showVoided, setShowVoided] = useState(false);
  const requestSequence = useRef(0), createSeen = useRef(createRequest), pendingMutation = useRef<{ signature: string; request: LedgerMutationRequest } | null>(null);
  const refresh = useCallback(async (preserveError = false) => {
    const sequence = ++requestSequence.current;
    try {
      const result = await api.ledgerSnapshot({ month });
      if (sequence !== requestSequence.current) return;
      if (result.ok) { setSnapshot(result.data); if (!preserveError) setError(''); }
      else setError(result.error.message);
    } catch { setError('本地账本暂未读取成功，请重新载入。'); }
  }, [api, month]);
  useEffect(() => { void refresh(); return api.onChanged(() => void refresh()); }, [api, refresh]);
  useEffect(() => { if (createRequest !== createSeen.current) { createSeen.current = createRequest; setEditor('new'); } }, [createRequest]);
  const save = async (changes: Change[]) => {
    if (!snapshot || busy) return false;
    const signature = JSON.stringify(changes);
    const request = pendingMutation.current?.signature === signature ? pendingMutation.current.request : { operationId: operationId(), expectedRevision: snapshot.revision, changes, month };
    pendingMutation.current = { signature, request }; setBusy(true); setError('');
    try {
      const result = await api.ledgerMutate(request);
      if (!result.ok) { setError(result.error.message); if (result.error.code === 'CONFLICT') { pendingMutation.current = null; void refresh(true); } return false; }
      pendingMutation.current = null; setSnapshot(result.data.snapshot); setNotice(result.data.message); return true;
    } catch { setError('尚未确认保存完成。请保留内容并重试，同一操作不会重复记账。'); return false; }
    finally { setBusy(false); }
  };
  const undo = async () => {
    if (!snapshot || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.ledgerUndo({ operationId: operationId(), expectedRevision: snapshot.revision, month });
      if (result.ok) { setSnapshot(result.data.snapshot); setNotice(result.data.message); } else setError(result.error.message);
    } catch { setError('撤销尚未确认完成，请重新载入账本后核对。'); }
    finally { setBusy(false); }
  };
  const exportLedger = async (format: 'csv' | 'json') => {
    setBusy(true); setError('');
    try {
      if (!host) return;
      const result = await host.ledgerExport({ format, ...(format === 'csv' ? { month } : {}) });
      if (result.ok) { if (result.data) setNotice(`已导出${format === 'csv' ? '本月 CSV' : '完整账本'}：${result.data.path}`); }
      else if (result.error.code !== 'CANCELLED') setError(result.error.message);
    } catch { setError('导出尚未完成，请重试。'); }
    finally { setBusy(false); }
  };
  const filterDetails = (filter: { category?: string; account?: string; day?: string }) => { setCategory(filter.category ?? ''); setAccount(filter.account ?? ''); setDay(filter.day ?? ''); setSearch(''); setTab('details'); };
  const moveMonth = (direction: number) => { const value = new Date(`${month}-01T00:00:00Z`); value.setUTCMonth(value.getUTCMonth() + direction); setMonth(value.toISOString().slice(0, 7)); setDay(''); };
  if (!snapshot) return <div className="page-scroll ledger-page"><div className="service-state"><h2>正在载入本地账本…</h2>{error && <p role="alert" className="error">{error}</p>}<button onClick={() => void refresh()}>重新载入账本</button></div></div>;
  const summary = snapshot.summary;
  const entries = snapshot.entries.filter(entry => entry.month === month && (showVoided || !entry.voided)
    && (!account || (account === 'unknown' ? entry.cashflows.some(flow => flow.accountId === null) : entry.cashflows.some(flow => flow.accountId === account)))
    && (!category || entry.category === category) && (!day || entry.date === day)
    && (!search || `${entry.title} ${entry.note} ${entry.originalText}`.toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => (b.date ?? b.month).localeCompare(a.date ?? a.month) || b.createdAt.localeCompare(a.createdAt));
  const recent = snapshot.entries.filter(entry => entry.month === month && !entry.voided).sort((a, b) => (b.date ?? b.month).localeCompare(a.date ?? a.month) || b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  const categories = Array.from(new Set(snapshot.entries.filter(entry => entry.month === month).map(entry => entry.category))).sort();
  const rows = (values: LedgerEntry[]) => <div className="ledger-list">{values.length ? values.map(entry => <LedgerRow key={entry.id} entry={entry} snapshot={snapshot} busy={busy} onEdit={() => setEditor(entry)} onVoid={() => setVoidTarget(entry)} />) : <div className="empty-state"><h3>这里还没有账单</h3><p>可以点击“记一笔”，或在下方对话框直接告诉助手。</p></div>}</div>;
  return <div className="page-scroll ledger-page">
    <div className="ledger-navigation">
      <div className="tabs" role="tablist" aria-label="账单页面">{([['overview', '概览'], ['details', '明细'], ['accounts', '账户'], ['rules', '规则']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
      <div className="ledger-period"><button aria-label="上个月" onClick={() => moveMonth(-1)}><ChevronLeft size={16} /></button><input type="month" aria-label="账单月份" value={month} onChange={event => { if (event.target.value) { setMonth(event.target.value); setDay(''); } }} /><button aria-label="下个月" onClick={() => moveMonth(1)}><ChevronRight size={16} /></button></div>
    </div>
    <div className="ledger-status"><p role={error ? 'alert' : 'status'} className={error ? 'error' : 'muted'}>{error || notice || (snapshot.sources.length ? `本地账本 · 已保留 ${snapshot.sources.length} 份导入来源` : '本地账本 · 也可以直接在下方对话框记账')}</p><div className="ledger-toolbar"><button aria-label="刷新账本" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13} /></button><button disabled={busy || !snapshot.audit.length} onClick={() => void undo()}><Undo2 size={13} />撤销账单操作</button></div></div>
    <section role="tabpanel" aria-label={{ overview: '账单概览', details: '账单明细', accounts: '账单账户', rules: '记账规则' }[tab]}>
      {tab === 'overview' && <>
        <div className="ledger-metrics"><div className="ledger-metric"><span>本月个人开销</span><strong>{ledgerMoney(summary.personalCents)}</strong><small>{summary.pendingPersonalCount ? `${summary.pendingPersonalCount} 笔个人承担金额待确认` : '已按原消费扣除关联退款、报销'}</small></div><div className="ledger-metric"><span>普通收入</span><strong>{ledgerMoney(summary.incomeCents)}</strong><small>与退款、返款及资产变现分开</small></div><div className="ledger-metric"><span>资产变现</span><strong>{ledgerMoney(summary.assetSaleCents)}</strong><small>出售资产所得，单独统计</small></div></div>
        <div className="ledger-charts"><LedgerCategoryChart values={summary.categories} onSelect={value => filterDetails({ category: value })} /><LedgerDailyChart month={month} values={summary.days} unknownDateCents={summary.uncertainDateCents} onSelect={value => filterDetails({ day: value })} /></div>
        <section className="ledger-account-section"><div className="ledger-section-heading"><h3>账户总览</h3><button onClick={() => setTab('accounts')}>余额与历史快照<ArrowUpRight size={14} /></button></div><AccountCards snapshot={snapshot} onAccount={value => filterDetails({ account: value })} /></section>
        <div className="ledger-section-heading"><h3>最近账单</h3><button onClick={() => filterDetails({})}>查看全部明细<ArrowUpRight size={14} /></button></div>{rows(recent)}
      </>}
      {tab === 'details' && <>
        <div className="ledger-section-heading"><h3>{entries.length} 笔明细 {day && <span className="ledger-tag">{day}</span>}</h3>{host && <div className="ledger-toolbar"><button disabled={busy} onClick={() => void exportLedger('csv')}><Download size={14} />导出本月 CSV</button><button disabled={busy} onClick={() => void exportLedger('json')}>完整账本备份</button></div>}</div>
        <div className="ledger-filters"><label>搜索项目或备注<input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索账单" /></label><label>账户<select value={account} onChange={event => setAccount(event.target.value)}><option value="">全部账户</option><option value="unknown">账户待确认</option>{LEDGER_ACCOUNTS.map(value => <option value={value.id} key={value.id}>{value.name}</option>)}</select></label><label>分类<select value={category} onChange={event => setCategory(event.target.value)}><option value="">全部分类</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label><label className="ledger-checkbox"><input type="checkbox" checked={showVoided} onChange={event => setShowVoided(event.target.checked)} />显示已作废</label>{(account || category || day || search) && <button onClick={() => filterDetails({})}>清除筛选</button>}</div>
        {summary.pendingAccountCount > 0 && <p className="ledger-form-note">本月 {summary.pendingAccountCount} 笔账户待确认；展开记录，点击“补充账户 / 更正”完善原笔。</p>}{rows(entries)}
      </>}
      {tab === 'accounts' && <>
        <div className="ledger-section-heading"><h3>账户账面余额</h3><small>来自已记流水与快照，不是支付平台实时余额</small></div><AccountCards snapshot={snapshot} onAccount={value => filterDetails({ account: value })} />
        <div className="ledger-accounts-grid" style={{ marginTop: 14 }}>{summary.accounts.filter(value => value.kind !== 'family').map(value => <div key={value.id} className="ledger-account-card"><span>{value.name}</span><small>本月资金变化 {ledgerMoney(value.periodChangeCents)}</small><button onClick={() => setBalanceAccount(value.id)}>核对余额</button>{value.pendingEntryIds.length > 0 && <small className="warning">{value.pendingEntryIds.length} 笔与快照先后关系待核对</small>}</div>)}</div>
        <section className="ledger-account-history"><div className="ledger-section-heading"><h3>余额快照历史</h3>{host && <div className="ledger-toolbar"><button disabled={busy} onClick={() => void exportLedger('json')}><Download size={14} />导出完整账本</button></div>}</div><div className="table-scroll"><table><thead><tr><th>账户</th><th>快照日期 / 时点</th><th>余额</th><th>已覆盖记录</th><th>备注</th></tr></thead><tbody>{[...snapshot.balanceSnapshots].sort((a, b) => b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt)).map(value => <tr key={value.id}><td>{accountName(value.accountId)}</td><td>{value.date}<small style={{ display: 'block' }}>{value.asOf ? timeText(value.asOf) : '具体时点未知'}</small></td><td>{ledgerMoney(value.balanceCents)}</td><td>{value.coveredEntryIds.length} 笔</td><td>{value.note || '—'}</td></tr>)}</tbody></table>{!snapshot.balanceSnapshots.length && <p className="ledger-form-note">尚无余额快照。点击账户的“核对余额”记录当前余额。</p>}</div></section>
      </>}
      {tab === 'rules' && <><RulesEditor key={snapshot.revision} rules={snapshot.rules} busy={busy} save={save} /><section className="ledger-card"><div className="ledger-section-heading"><h3>记账口径</h3><small>修订保留历史说明</small></div><ol className="ledger-rule-list">{ledgerRulesText.map(value => <li key={value}>{value}</li>)}</ol></section><section className="ledger-account-history"><h3>账户名称与别名</h3>{LEDGER_ACCOUNTS.map(value => <p className="ledger-form-note" key={value.id}>{value.name}：{value.aliases.join('、')}</p>)}</section></>}
    </section>
    {editor && <Modal title={editor === 'new' ? '记一笔' : '更正账单'} onClose={() => { if (!busy) setEditor(null); }}><EntryEditor key={editor === 'new' ? 'new' : `${editor.id}:${editor.version}`} entry={editor === 'new' ? undefined : editor} snapshot={snapshot} busy={busy} error={error} save={save} close={() => setEditor(null)} /></Modal>}
    {voidTarget && <Modal title="作废账单" onClose={() => { if (!busy) setVoidTarget(null); }}><VoidEditor entry={voidTarget} busy={busy} error={error} save={save} close={() => setVoidTarget(null)} /></Modal>}
    {balanceAccount && <Modal title={`核对余额 · ${accountName(balanceAccount)}`} onClose={() => { if (!busy) setBalanceAccount(null); }}><BalanceEditor accountId={balanceAccount} snapshot={snapshot} busy={busy} error={error} save={save} close={() => setBalanceAccount(null)} /></Modal>}
  </div>;
}

function AccountCards({ snapshot, onAccount }: { snapshot: LedgerSnapshot; onAccount: (id: string) => void }) {
  const { summary, rules } = snapshot;
  return <><div className="ledger-accounts-grid">{summary.accounts.filter(value => value.kind !== 'family').map(value => <button className="ledger-account-card" key={value.id} onClick={() => onAccount(value.id)}><span><Wallet size={14} />{value.name}</span><strong>{ledgerMoney(value.balanceCents)}</strong><small>{value.snapshotDate ? `快照 ${value.snapshotDate}${value.pendingEntryIds.length ? ` · ${value.pendingEntryIds.length} 笔待核对` : ''}` : '尚无余额快照'}</small></button>)}</div><div className="ledger-family"><span><HeartHandshake size={16} />亲情卡本月已记录 <strong>{ledgerMoney(summary.familyUsageCents)}</strong></span><small>真实剩余：{rules.familyActualRemainingCents == null ? '未知' : ledgerMoney(rules.familyActualRemainingCents)} · 刷新日：{rules.familyRefreshDay ? `每月 ${rules.familyRefreshDay} 日` : '未知'}</small></div><p className="ledger-assets-note"><span>现金类账面合计 {ledgerMoney(summary.cashBalanceCents)}</span><span>储值卡余额 {ledgerMoney(summary.storedBalanceCents)}</span><span>亲情卡额度不计入资产</span></p></>;
}

function LedgerRow({ entry, snapshot, busy, onEdit, onVoid }: { entry: LedgerEntry; snapshot: LedgerSnapshot; busy: boolean; onEdit: () => void; onVoid: () => void }) {
  const linked = snapshot.entries.filter(value => !value.voided && value.id !== entry.id && (entry.relatedEntryIds.includes(value.id) || value.relatedEntryIds.includes(entry.id) || value.adjustments.some(adjustment => adjustment.targetEntryIds.includes(entry.id)) || entry.adjustments.some(adjustment => adjustment.targetEntryIds.includes(value.id))));
  const audit = snapshot.audit.filter(value => value.entryIds.includes(entry.id));
  const adjustments = snapshot.entries.filter(value => !value.voided).flatMap(value => value.adjustments.filter(adjustment => adjustment.targetEntryIds.includes(entry.id)).map(adjustment => ({ ...adjustment, entry: value })));
  const singleReduction = adjustments.filter(value => value.targetEntryIds.length === 1).reduce((sum, value) => sum + value.amountCents, 0);
  const groupReduction = adjustments.some(value => value.targetEntryIds.length > 1);
  const amountLabel = entry.kind === 'transfer' ? '转账金额' : inKinds.includes(entry.kind) ? '实际收到' : '实际支付';
  return <details className={`ledger-row${entry.voided ? ' ledger-row-void' : ''}`}><summary>
    <time>{entry.date?.slice(5) ?? `${entry.month.slice(5)} 月`}<small>{entry.date ? '' : '日期待确认'}</small></time>
    <span className="ledger-row-title"><strong>{entry.title}</strong><small>{entry.category} · {kinds[entry.kind]}{entry.voided ? ' · 已作废' : ''}</small></span>
    <span className="ledger-row-account">{Array.from(new Set(entry.cashflows.map(value => accountName(value.accountId)))).join(' → ') || '无账户资金变化'}</span>
    <span className="ledger-row-amount"><small>{amountLabel}</small><strong>{ledgerMoney(entry.amountCents)}</strong></span><span className="ledger-row-amount ledger-personal"><small>{groupReduction ? '个人开销（组内待分摊）' : '个人开销'}</small><strong>{ledgerMoney(entry.personalCents == null ? null : entry.personalCents - singleReduction)}</strong></span><ChevronDown size={14} />
    </summary><div className="ledger-row-detail"><dl><dt>发生日期</dt><dd>{entry.date ?? `${entry.month} · ${entry.dateNote || '日期待确认'}`}{entry.occurredAt && ` ${timeText(entry.occurredAt).slice(11)}`}</dd><dt>登记时间</dt><dd>{timeText(entry.createdAt)}{entry.date && entry.date !== localDateTime(Date.parse(entry.createdAt)).slice(0, 10) ? ' · 补录' : ''}</dd><dt>账户资金变化</dt><dd>{entry.cashflows.length ? entry.cashflows.map((value, index) => <div key={index}>{accountName(value.accountId)} {value.deltaCents >= 0 ? '+' : '−'}{ledgerMoney(Math.abs(value.deltaCents))}</div>) : '不改变账户余额'}</dd>{entry.incomeCents > 0 && <><dt>普通收入</dt><dd>{ledgerMoney(entry.incomeCents)}</dd></>}{entry.assetSaleCents > 0 && <><dt>资产变现</dt><dd>{ledgerMoney(entry.assetSaleCents)}</dd></>}{entry.sourceKey && <><dt>旧账编号</dt><dd>{entry.sourceKey}</dd></>}{entry.ruleKey && <><dt>记录来源</dt><dd>固定生活费规则（未向支付平台核验到账）</dd></>}{entry.note && <><dt>备注</dt><dd>{entry.note}</dd></>}{entry.originalText && <><dt>原始描述</dt><dd>{entry.originalText}</dd></>}</dl>
      {adjustments.map((value, index) => <p key={`${value.entry.id}:${index}`}>{value.entry.title} · {value.targetEntryIds.length > 1 ? `关联 ${value.targetEntryIds.length} 笔消费，共冲减` : '冲减原消费'} {ledgerMoney(value.amountCents)}{value.note ? ` · ${value.note}` : ''}</p>)}
      {entry.adjustments.map((value, index) => <p key={index}>冲减关联原消费 {ledgerMoney(value.amountCents)} · {value.targetEntryIds.map(id => snapshot.entries.find(item => item.id === id)?.title ?? id).join('、')}</p>)}
      {!!linked.length && <><strong>关联款项</strong><ul>{linked.map(value => <li key={value.id}>{value.date ?? value.month} · {value.title} · {kinds[value.kind]} {ledgerMoney(value.amountCents)}{value.note && ` · ${value.note}`}</li>)}</ul></>}
      {!!audit.length && <details><summary>修改记录（{audit.length}）</summary><ul>{audit.map(value => <li key={value.id}>{timeText(value.at)} · {value.action} · {value.note || '保存记录'}{value.beforeEntries.find(previous => previous.id === entry.id) && <span> · 修改前：{value.beforeEntries.find(previous => previous.id === entry.id)!.title} {ledgerMoney(value.beforeEntries.find(previous => previous.id === entry.id)!.amountCents)}</span>}</li>)}</ul></details>}
      {!entry.voided && <div className="ledger-toolbar" style={{ marginTop: 12 }}><button disabled={busy} onClick={onEdit}>{entry.cashflows.some(value => value.accountId === null) ? '补充账户 / 更正' : '更正这笔'}</button><button disabled={busy} className="danger-text" onClick={onVoid}>作废</button></div>}
    </div></details>;
}

function AccountSelect({ value, onChange, label, excludeFamily = false }: { value: string; onChange: (value: string) => void; label: string; excludeFamily?: boolean }) {
  return <label>{label}<select value={value} onChange={event => onChange(event.target.value)}><option value="">账户待确认</option>{LEDGER_ACCOUNTS.filter(account => !excludeFamily || account.id !== 'family').map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>;
}

function EntryEditor({ entry, snapshot, busy, error, save, close }: { entry?: LedgerEntry; snapshot: LedgerSnapshot; busy: boolean; error: string; save: (changes: Change[]) => Promise<boolean>; close: () => void }) {
  const [entryId] = useState(entry?.id ?? operationId());
  const [kind, setKind] = useState<LedgerEntryKind>(entry?.kind ?? 'expense'), [title, setTitle] = useState(entry?.title ?? ''), [category, setCategory] = useState(entry?.category ?? '餐饮');
  const [date, setDate] = useState(entry?.date ?? todayDate()), [unknownDate, setUnknownDate] = useState(entry ? !entry.date : false), [month, setMonth] = useState(entry?.month ?? todayDate().slice(0, 7)), [dateNote, setDateNote] = useState(entry?.dateNote ?? '');
  const [amount, setAmount] = useState(centsInput(entry?.amountCents)), [personal, setPersonal] = useState(centsInput(entry?.personalCents)), [personalUnknown, setPersonalUnknown] = useState(entry?.personalCents === null), [personalTouched, setPersonalTouched] = useState(!!entry);
  const [account, setAccount] = useState(entry?.cashflows[0]?.accountId ?? ''), [toAccount, setToAccount] = useState(entry?.cashflows.find(value => value.deltaCents > 0)?.accountId ?? '');
  const [extraIncome, setExtraIncome] = useState(centsInput(entry?.incomeCents ?? 0));
  const [note, setNote] = useState(entry?.note ?? ''), [reason, setReason] = useState(''), [formError, setFormError] = useState('');
  const [related, setRelated] = useState<string[]>(entry?.adjustments.length ? entry.adjustments.flatMap(value => value.targetEntryIds) : entry?.relatedEntryIds ?? []), [reduction, setReduction] = useState(centsInput(entry?.adjustments.reduce((sum, value) => sum + value.amountCents, 0) ?? 0));
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const linkedKind = ['refund', 'reimbursement', 'aa_return', 'adjustment'].includes(kind);
  const canAdjust = ['refund', 'reimbursement', 'adjustment'].includes(kind);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setFormError('');
    try {
      const amountCents = kind === 'adjustment' ? 0 : parseMoney(amount, '实际金额'), personalCents = kind === 'expense' ? personalUnknown ? null : parseMoney(personalTouched ? personal : amount, '个人开销') : entry?.kind === kind ? entry.personalCents : 0;
      const unchangedCashflow = entry && kind === entry.kind && amountCents === entry.amountCents && account === (entry.cashflows[0]?.accountId ?? '') && toAccount === (entry.cashflows.find(value => value.deltaCents > 0)?.accountId ?? '');
      if (entry && !reason.trim()) throw new Error('请写一句更正说明，保留修改依据。');
      const reductionCents = canAdjust ? parseMoney(reduction || '0', '冲减金额') : 0;
      if (reductionCents && !related.length) throw new Error('冲减个人开销时，请选择原消费；原消费不在账本中则保持冲减为 0。');
      const draft = LedgerEntryDraftSchema.parse({
        ...(entry ? Object.fromEntries(Object.entries(entry).filter(([key]) => !['version', 'createdAt', 'updatedAt', 'voided', 'sameDayBalanceOrder'].includes(key))) : {}),
        id: entryId, kind, date: unknownDate ? null : date, month: unknownDate ? month : date.slice(0, 7), dateNote: unknownDate ? dateNote : '',
        occurredAt: entry?.date === date && !unknownDate ? entry.occurredAt : null,
        title, category, amountCents, personalCents, incomeCents: kind === 'income' ? amountCents : kind === 'reimbursement' ? parseMoney(extraIncome || '0', '已确认额外收入') : entry?.kind === kind ? entry.incomeCents : 0, assetSaleCents: kind === 'asset_sale' ? amountCents : entry?.kind === kind ? entry.assetSaleCents : 0,
        cashflows: unchangedCashflow ? entry.cashflows : kind === 'adjustment' ? [] : kind === 'transfer' ? [{ accountId: account || null, deltaCents: -amountCents }, { accountId: toAccount || null, deltaCents: amountCents }] : [{ accountId: account || null, deltaCents: (inKinds.includes(kind) ? 1 : -1) * amountCents }],
        relatedEntryIds: linkedKind ? [...new Set(related)] : entry?.relatedEntryIds ?? [], adjustments: linkedKind ? reductionCents ? entry && JSON.stringify(related) === JSON.stringify(entry.adjustments.flatMap(value => value.targetEntryIds)) && reductionCents === entry.adjustments.reduce((sum, value) => sum + value.amountCents, 0) ? entry.adjustments : [{ targetEntryIds: [...new Set(related)], amountCents: reductionCents, note: reason || note }] : [] : entry?.adjustments ?? [], note,
      });
      if (await save([{ type: 'putEntry', entry: draft, expectedVersion: entry?.version ?? null, confirmDuplicate, note: entry ? reason : '手工记账' }])) close();
    } catch (value) { setFormError(value instanceof Error ? value.message : '请检查填写内容。'); }
  };
  return <form className="editor-form ledger-form" onSubmit={event => void submit(event)}><div className="form-grid"><label>类型<select value={kind} onChange={event => setKind(event.target.value as LedgerEntryKind)}>{Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label>项目<input required maxLength={500} value={title} onChange={event => setTitle(event.target.value)} /></label><label>分类<input required maxLength={100} value={category} onChange={event => setCategory(event.target.value)} list="ledger-category-options" /><datalist id="ledger-category-options">{Array.from(new Set(['餐饮', '交通', '购物', '软件服务', '水费', '生活费', ...snapshot.entries.map(value => value.category)])).map(value => <option key={value} value={value} />)}</datalist></label><label>{unknownDate ? '发生月份' : '发生日期'}<input required type={unknownDate ? 'month' : 'date'} value={unknownDate ? month : date} onChange={event => unknownDate ? setMonth(event.target.value) : setDate(event.target.value)} /></label></div>
    <label className="ledger-checkbox"><input type="checkbox" checked={unknownDate} onChange={event => setUnknownDate(event.target.checked)} />仅确定月份，日期待确认</label>{unknownDate && <label>日期说明<input value={dateNote} onChange={event => setDateNote(event.target.value)} placeholder="例如：10 月 4 日或 5 日" /></label>}
    {kind !== 'adjustment' && <div className="form-grid"><label>{kind === 'transfer' ? '转账金额（元）' : inKinds.includes(kind) ? '实际收到（元）' : '实际支付（元）'}<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" /></label>{kind === 'expense' && <label>个人开销（元）<input inputMode="decimal" disabled={personalUnknown} value={personalTouched ? personal : amount} onChange={event => { setPersonalTouched(true); setPersonal(event.target.value); }} placeholder={personalUnknown ? '待确认' : '只计自己承担的部分'} /></label>}<AccountSelect label={kind === 'transfer' ? '转出账户' : inKinds.includes(kind) ? '收款账户' : '支付账户'} value={account} onChange={setAccount} />{kind === 'transfer' && <AccountSelect label="转入账户" value={toAccount} onChange={setToAccount} />}{kind === 'reimbursement' && <label>其中已确认的额外收入（元）<input inputMode="decimal" value={extraIncome} onChange={event => setExtraIncome(event.target.value)} /></label>}</div>}
    {kind === 'expense' && <label className="ledger-checkbox"><input type="checkbox" checked={personalUnknown} onChange={event => setPersonalUnknown(event.target.checked)} />个人承担金额还不明确（例如 AA 比例待定）</label>}
    {!account && kind !== 'adjustment' && <p className="ledger-form-note">账户待确认：保存真实交易和已明确的个人开销，不扣任何已知账户余额。</p>}
    {kind === 'transfer' && <p className="ledger-form-note">饭卡、会员卡充值使用账户转账；水卡充值请选消费，分类为水费。</p>}
    {linkedKind && <fieldset><legend>关联原消费</legend><label>原消费（按住 Ctrl 可选多笔）<select multiple size={4} value={related} onChange={event => setRelated(Array.from(event.target.selectedOptions).map(value => value.value))}>{snapshot.entries.filter(value => !value.voided && value.kind === 'expense' && value.id !== entry?.id).map(value => <option key={value.id} value={value.id}>{value.date ?? value.month} · {value.title} · {ledgerMoney(value.amountCents)}</option>)}</select></label>{canAdjust && <label>冲减原消费个人开销（元）<input inputMode="decimal" value={reduction} onChange={event => setReduction(event.target.value)} /></label>}<p className="ledger-form-note">{kind === 'aa_return' ? 'AA 返款只记录资金回流，不重复冲减已排除代垫的个人开销；需要调整个人承担时请更正原消费。' : '原消费已扣除这笔返款时填 0，不重复冲减；原消费未入账时也填 0。跨月会修正原消费月份。'}</p>{kind === 'adjustment' && <p className="ledger-form-note">只调整个人开销，不产生新的付款或收款。</p>}</fieldset>}
    <label>备注<textarea rows={2} value={note} onChange={event => setNote(event.target.value)} /></label>{entry && <label>更正说明<input required value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：补充支付账户为支付宝" /></label>}
    {(/重复|已有相同|另一笔/.test(error) || confirmDuplicate) && <label className="ledger-checkbox"><input type="checkbox" checked={confirmDuplicate} onChange={event => setConfirmDuplicate(event.target.checked)} />我已核对，这是另一笔真实交易</label>}
    {(formError || error) && <p role="alert" className="error">{formError || error}</p>}<footer className="form-footer"><button type="button" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy}>{busy ? '保存中…' : entry ? '保存更正' : '保存账单'}</button></footer>
  </form>;
}

function VoidEditor({ entry, busy, error, save, close }: { entry: LedgerEntry; busy: boolean; error: string; save: (changes: Change[]) => Promise<boolean>; close: () => void }) {
  const [note, setNote] = useState('');
  return <form className="editor-form ledger-form" onSubmit={event => { event.preventDefault(); void save([{ type: 'voidEntry', id: entry.id, expectedVersion: entry.version, note }]).then(saved => { if (saved) close(); }); }}><p>作废“{entry.title}” {ledgerMoney(entry.amountCents)} 后，这笔不再计入开销与账户变化，原记录和更正历史仍会保留。</p><label>作废说明<input required value={note} onChange={event => setNote(event.target.value)} placeholder="例如：误记，实际没有发生" /></label>{error && <p className="error" role="alert">{error}</p>}<footer className="form-footer"><button type="button" disabled={busy} onClick={close}>保留</button><button className="danger" disabled={busy}>确认作废</button></footer></form>;
}

function BalanceEditor({ accountId, snapshot, busy, error, save, close }: { accountId: LedgerAccountId; snapshot: LedgerSnapshot; busy: boolean; error: string; save: (changes: Change[]) => Promise<boolean>; close: () => void }) {
  const [id] = useState(operationId());
  const [balance, setBalance] = useState(''), [asOf, setAsOf] = useState(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19)), [note, setNote] = useState(''), [includeDay, setIncludeDay] = useState(false), [formError, setFormError] = useState('');
  const dayEntries = snapshot.entries.filter(entry => !entry.voided && entry.date === asOf.slice(0, 10) && !entry.occurredAt && entry.cashflows.some(flow => flow.accountId === accountId));
  return <form className="editor-form ledger-form" onSubmit={event => { event.preventDefault(); setFormError(''); try {
    const amount = parseMoney(balance, '余额', true), instant = `${asOf}${asOf.length === 16 ? ':00' : ''}+08:00`;
    if (!asOf || !Number.isFinite(Date.parse(instant))) throw new Error('请填写快照时点。');
    const coveredEntryIds = snapshot.entries.filter(entry => !entry.voided && entry.cashflows.some(flow => flow.accountId === accountId) && (entry.occurredAt ? Date.parse(entry.occurredAt) <= Date.parse(instant) : entry.date && (entry.date < asOf.slice(0, 10) || includeDay && entry.date === asOf.slice(0, 10)))).map(entry => entry.id);
    void save([{ type: 'setBalance', snapshot: { id, accountId: accountId as Exclude<LedgerAccountId, 'family'>, balanceCents: amount, date: asOf.slice(0, 10), asOf: instant, coveredEntryIds, note, sourceId: null } }]).then(saved => { if (saved) close(); });
  } catch (value) { setFormError(value instanceof Error ? value.message : '请检查内容。'); } }}><p className="ledger-form-note">填写你实际看到的余额。这是余额快照，不会当成收入；已覆盖的历史交易不会再次扣除。</p><div className="form-grid"><label>账户实际余额（元）<input required inputMode="decimal" value={balance} onChange={event => setBalance(event.target.value)} /></label><label>余额对应时点（北京时间）<input required type="datetime-local" step={1} value={asOf} onChange={event => setAsOf(event.target.value)} /></label></div>{!!dayEntries.length && <><label className="ledger-checkbox"><input type="checkbox" checked={includeDay} onChange={event => setIncludeDay(event.target.checked)} />这份余额已包含当天全部 {dayEntries.length} 笔未标具体时刻的已记交易</label><p className="ledger-form-note">不勾选时保留这些同日交易的先后关系待核对，不假定已扣或未扣。</p></>}<label>快照备注<textarea rows={2} value={note} onChange={event => setNote(event.target.value)} /></label>{(formError || error) && <p role="alert" className="error">{formError || error}</p>}<footer className="form-footer"><button type="button" disabled={busy} onClick={close}>取消</button><button disabled={busy} className="primary">保存余额快照</button></footer></form>;
}

function RulesEditor({ rules, busy, save }: { rules: LedgerRules; busy: boolean; save: (changes: Change[]) => Promise<boolean> }) {
  const [enabled, setEnabled] = useState(rules.monthlyAllowance.enabled), [amount, setAmount] = useState(centsInput(rules.monthlyAllowance.amountCents)), [account, setAccount] = useState(rules.monthlyAllowance.accountId ?? ''), [startMonth, setStartMonth] = useState(rules.monthlyAllowance.startMonth);
  const [sameDayNewEntryOrder, setSameDayNewEntryOrder] = useState<'after' | 'ask'>(rules.sameDayNewEntryOrder ?? 'after');
  const [limit, setLimit] = useState(centsInput(rules.familyMonthlyLimitCents)), [remaining, setRemaining] = useState(centsInput(rules.familyActualRemainingCents)), [refreshDay, setRefreshDay] = useState(rules.familyRefreshDay?.toString() ?? ''), [notes, setNotes] = useState(rules.notes), [reason, setReason] = useState(''), [error, setError] = useState('');
  return <form className="editor-form ledger-form" style={{ marginBottom: 24 }} onSubmit={event => { event.preventDefault(); setError(''); try {
    const next: LedgerRules = { monthlyAllowance: { enabled, amountCents: parseMoney(amount, '生活费'), accountId: account ? account as Exclude<LedgerAccountId, 'family'> : null, startMonth }, sameDayNewEntryOrder, familyMonthlyLimitCents: parseMoney(limit, '亲情卡月额度'), familyActualRemainingCents: remaining ? parseMoney(remaining, '真实剩余额度') : null, familyRefreshDay: refreshDay ? Number(refreshDay) : null, notes };
    if (next.familyRefreshDay != null && (!Number.isInteger(next.familyRefreshDay) || next.familyRefreshDay < 1 || next.familyRefreshDay > 31)) throw new Error('刷新日填写 1–31，未知则留空。');
    void save([{ type: 'updateRules', rules: next, note: reason }]);
  } catch (value) { setError(value instanceof Error ? value.message : '请检查规则。'); } }}><div className="ledger-rules-grid"><section className="ledger-card ledger-rule-editor"><h3>固定生活费</h3><label className="ledger-checkbox"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />每月 1 日按约定记录生活费</label><div className="form-grid"><label>每月金额（元）<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></label><label>规则起始月份<input required type="month" value={startMonth} onChange={event => setStartMonth(event.target.value)} /></label></div><AccountSelect label="到账账户" value={account} onChange={setAccount} excludeFamily /><p>按月份查重，不提前录未来月份。暂停后重新启用时从本月或指定的更晚月份恢复，不补暂停期间。账户不明时保留待确认；这是已约定记录规则，不代表银行到账验证。</p></section><section className="ledger-card ledger-rule-editor"><h3>亲情卡</h3><div className="form-grid"><label>每月约定额度（元）<input required inputMode="decimal" value={limit} onChange={event => setLimit(event.target.value)} /></label><label>真实剩余额度（元，可留空）<input inputMode="decimal" value={remaining} onChange={event => setRemaining(event.target.value)} placeholder="未知" /></label></div><label>额度刷新日（1–31，可留空）<input inputMode="numeric" value={refreshDay} onChange={event => setRefreshDay(event.target.value)} placeholder="未知" /></label><p>额度不计收入或资产，不按“月额度减已记录使用”推算真实剩余，未用完不结转。</p></section></div>
    <div className="form-grid"><label>新记交易与余额核对的先后<select value={sameDayNewEntryOrder} onChange={event => setSameDayNewEntryOrder(event.target.value as 'after' | 'ask')}><option value="after">按核对之后处理</option><option value="ask">先核对再更新余额</option></select></label><p className="ledger-form-note">仅用于本地当天新记、没有明确先后或时刻的交易。历史导入及余额已覆盖的交易不重复扣减。也可以在对话框说“新记交易默认按核对之后处理”或“新记交易先核对再更新余额”。</p></div>
    <label>补充记账规则<textarea rows={3} value={notes} onChange={event => setNotes(event.target.value)} placeholder="你可以补充账户称呼、分类习惯或需要特别留意的约定" /></label><label>规则修改说明<input required value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：下月起生活费调整为 1200 元" /></label><p className="ledger-form-note">保存后按新规则处理后续记录。旧账保留原记录；需要变更某笔生活费时，在明细中更正或作废，并保留说明。</p>{error && <p className="error" role="alert">{error}</p>}<footer className="form-footer"><button className="primary" disabled={busy}>保存记账规则</button></footer></form>;
}
