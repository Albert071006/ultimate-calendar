import { ChevronDown, Plus, X } from 'lucide-react';
import { LEDGER_ACCOUNTS, type LedgerEntry, type LedgerSnapshot } from '../../../shared/ledger';
import { ledgerReceivable } from '../../../ledger/receivable';
import { todayDate } from '../../calendar-layout';
import { localDateTime } from '../../calendar-timeline';
import { fullDay } from '../inbox/format';
import { ledgerMoney } from './money';
import { accountName, inKinds, kinds, timeText } from './editors';

export interface FlowFilter { account: string; category: string; day: string; search: string; showVoided: boolean }
export const noFilter: FlowFilter = { account: '', category: '', day: '', search: '', showVoided: false };

const plain = (cents: number) => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDay = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;

function Sum({ label, cents, note, warn = false }: { label: string; cents: number | null; note: string; warn?: boolean }) {
  return <div className={warn ? 'warn' : ''}><div className="k">{label}</div><div className="v">{cents == null ? '待确认' : <><small>¥</small>{plain(cents)}</>}</div><div className="d">{note}</div></div>;
}

function DailyBars({ month, values, unknownDateCents, selected, onSelect }: { month: string; values: Array<{ date: string; cents: number }>; unknownDateCents: number; selected: string; onSelect: (date: string) => void }) {
  const current = todayDate(), end = new Date(`${month}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  const days = month === current.slice(0, 7) ? Number(current.slice(8)) : month > current.slice(0, 7) ? 0 : end.getUTCDate();
  const byDate = new Map(values.map(value => [value.date, value.cents]));
  const maximum = Math.max(1, ...values.map(value => value.cents));
  const top = values.filter(value => value.cents > 0).sort((a, b) => b.cents - a.cents)[0];
  return <section className="a2-ledger-daily" aria-label="每日开销">
    <div className="a2-sec-h"><h3>每日开销</h3><span className="ui-hint">{top ? `最高 ${shortDay(top.date)} ${ledgerMoney(top.cents)}` : '个人承担金额'}</span></div>
    {days ? <>
      <div className="bars" role="group" aria-label="每日个人开销，点击查看当天明细">
        {Array.from({ length: days }, (_, index) => {
          const date = `${month}-${String(index + 1).padStart(2, '0')}`, cents = byDate.get(date) ?? 0;
          return <button type="button" key={date} className={`${top && cents === top.cents ? 'hi' : ''}${date === current ? ' today' : ''}${date === selected ? ' on' : ''}`}
            onClick={() => onSelect(date === selected ? '' : date)} aria-label={`${date} 个人开销 ${ledgerMoney(cents)}`} aria-pressed={date === selected} title={`${shortDay(date)} · ${ledgerMoney(cents)}`}>
            <i style={{ height: `${Math.max(cents ? 2 : 0, cents / maximum * 100)}%` }} />
          </button>;
        })}
      </div>
      <div className="axis" aria-hidden="true">{[1, 8, 15, 22, 29].filter(day => day <= days).map(day => <span key={day} style={{ left: `${(day - 0.5) / days * 100}%` }}>{day}日</span>)}</div>
    </> : <p className="ui-hint">尚未到来的月份没有开销</p>}
    {unknownDateCents !== 0 && <p className="ui-hint">另有 {ledgerMoney(unknownDateCents)} 日期待确认，已计入月合计</p>}
  </section>;
}

function Categories({ values, selected, onSelect }: { values: Array<{ category: string; cents: number }>; selected: string; onSelect: (category: string) => void }) {
  const positive = values.filter(value => value.cents > 0).sort((a, b) => b.cents - a.cents);
  const top = positive[0]?.cents ?? 1;
  return <section className="a2-ledger-cats" aria-label="开销分类">
    <div className="a2-sec-h"><h3>分类</h3><span className="ui-hint">个人开销</span></div>
    {positive.length ? positive.map(value => (
      <button type="button" key={value.category} className={`cat${value.category === selected ? ' on' : ''}`} onClick={() => onSelect(value.category === selected ? '' : value.category)}
        aria-label={`查看${value.category}明细 ${ledgerMoney(value.cents)}`} aria-pressed={value.category === selected}>
        <span>{value.category}</span><span className="bar"><i style={{ width: `${value.cents / top * 100}%` }} /></span><span>{ledgerMoney(value.cents)}</span>
      </button>
    )) : <p className="ui-hint">这个月还没有已确认的个人开销</p>}
  </section>;
}

/** The label beside an amount: advances, returns and the other non-expense kinds. */
function tagOf(entry: LedgerEntry, owed: Set<string>): [string, string] | null {
  if (entry.voided) return ['已作废', ''];
  if (entry.kind === 'expense') {
    if (entry.personalCents === null) return ['个人承担待定', 'owe'];
    if (entry.amountCents > entry.personalCents) return owed.has(entry.id) ? ['代垫 · 待收回', 'owe'] : ['含代垫', ''];
    return null;
  }
  if (entry.kind === 'aa_return') return ['代垫收回', ''];
  return [kinds[entry.kind], ''];
}

export function LedgerRow({ entry, snapshot, owed, busy, onEdit, onVoid }: { entry: LedgerEntry; snapshot: LedgerSnapshot; owed: Set<string>; busy: boolean; onEdit: () => void; onVoid: () => void }) {
  const linked = snapshot.entries.filter(value => !value.voided && value.id !== entry.id && (entry.relatedEntryIds.includes(value.id) || value.relatedEntryIds.includes(entry.id) || value.adjustments.some(adjustment => adjustment.targetEntryIds.includes(entry.id)) || entry.adjustments.some(adjustment => adjustment.targetEntryIds.includes(value.id))));
  const audit = snapshot.audit.filter(value => value.entryIds.includes(entry.id));
  const adjustments = snapshot.entries.filter(value => !value.voided).flatMap(value => value.adjustments.filter(adjustment => adjustment.targetEntryIds.includes(entry.id)).map(adjustment => ({ ...adjustment, entry: value })));
  const singleReduction = adjustments.filter(value => value.targetEntryIds.length === 1).reduce((sum, value) => sum + value.amountCents, 0);
  const groupReduction = adjustments.some(value => value.targetEntryIds.length > 1);
  const amountLabel = entry.kind === 'transfer' ? '转账金额' : inKinds.includes(entry.kind) ? '实际收到' : '实际支付';
  const accounts = Array.from(new Set(entry.cashflows.map(value => accountName(value.accountId)))).join(' → ');
  const tag = tagOf(entry, owed);
  const sign = entry.kind === 'transfer' || entry.kind === 'adjustment' ? '' : inKinds.includes(entry.kind) ? '+' : '−';
  return <details className={`a2-tx${entry.voided ? ' void' : ''}`}><summary>
    <span className="n">{entry.title}<small>{[entry.category, accounts || (entry.kind === 'adjustment' ? '只调整个人开销' : '无账户资金变化')].join(' · ')}</small></span>
    {tag ? <span className={`tag ${tag[1]}`}>{tag[0]}</span> : <span />}
    <span className={`amt${sign === '+' ? ' in' : ''}`}>{entry.kind === 'adjustment' ? '调整' : `${sign}${plain(entry.amountCents)}`}</span>
    <ChevronDown className="chev" aria-hidden="true" />
  </summary><div className="a2-tx-detail"><dl>
    <dt>{amountLabel}</dt><dd>{ledgerMoney(entry.amountCents)}</dd>
    <dt>{groupReduction ? '个人开销（组内待分摊）' : '个人开销'}</dt><dd>{ledgerMoney(entry.personalCents == null ? null : entry.personalCents - singleReduction)}</dd>
    <dt>类型</dt><dd>{kinds[entry.kind]}</dd>
    <dt>发生日期</dt><dd>{entry.date ?? `${entry.month} · ${entry.dateNote || '日期待确认'}`}{entry.occurredAt && ` ${timeText(entry.occurredAt).slice(11)}`}</dd>
    <dt>登记时间</dt><dd>{timeText(entry.createdAt)}{entry.date && entry.date !== localDateTime(Date.parse(entry.createdAt)).slice(0, 10) ? ' · 补录' : ''}</dd>
    <dt>账户资金变化</dt><dd>{entry.cashflows.length ? entry.cashflows.map((value, index) => <div key={index}>{accountName(value.accountId)} {value.deltaCents >= 0 ? '+' : '−'}{ledgerMoney(Math.abs(value.deltaCents))}</div>) : '不改变账户余额'}</dd>
    {entry.incomeCents > 0 && <><dt>普通收入</dt><dd>{ledgerMoney(entry.incomeCents)}</dd></>}
    {entry.assetSaleCents > 0 && <><dt>资产变现</dt><dd>{ledgerMoney(entry.assetSaleCents)}</dd></>}
    {entry.sourceKey && <><dt>旧账编号</dt><dd>{entry.sourceKey}</dd></>}
    {entry.ruleKey && <><dt>记录来源</dt><dd>固定生活费规则（未向支付平台核验到账）</dd></>}
    {entry.note && <><dt>备注</dt><dd>{entry.note}</dd></>}
    {entry.originalText && <><dt>原始描述</dt><dd>{entry.originalText}</dd></>}
  </dl>
    {adjustments.map((value, index) => <p key={`${value.entry.id}:${index}`}>{value.entry.title} · {value.targetEntryIds.length > 1 ? `关联 ${value.targetEntryIds.length} 笔消费，共冲减` : '冲减原消费'} {ledgerMoney(value.amountCents)}{value.note ? ` · ${value.note}` : ''}</p>)}
    {entry.adjustments.map((value, index) => <p key={index}>冲减关联原消费 {ledgerMoney(value.amountCents)} · {value.targetEntryIds.map(id => snapshot.entries.find(item => item.id === id)?.title ?? id).join('、')}</p>)}
    {!!linked.length && <><strong>关联款项</strong><ul>{linked.map(value => <li key={value.id}>{value.date ?? value.month} · {value.title} · {kinds[value.kind]} {ledgerMoney(value.amountCents)}{value.note && ` · ${value.note}`}</li>)}</ul></>}
    {!!audit.length && <details><summary>修改记录（{audit.length}）</summary><ul>{audit.map(value => <li key={value.id}>{timeText(value.at)} · {value.action} · {value.note || '保存记录'}{value.beforeEntries.find(previous => previous.id === entry.id) && <span> · 修改前：{value.beforeEntries.find(previous => previous.id === entry.id)!.title} {ledgerMoney(value.beforeEntries.find(previous => previous.id === entry.id)!.amountCents)}</span>}</li>)}</ul></details>}
    {!entry.voided && <div className="acts"><button className="ui-btn sm" disabled={busy} onClick={onEdit}>{entry.cashflows.some(value => value.accountId === null) ? '补充账户 / 更正' : '更正这笔'}</button><button className="ui-btn sm ghost danger-text" disabled={busy} onClick={onVoid}>作废</button></div>}
  </div></details>;
}

export function Flows({ snapshot, month, busy, filter, setFilter, create, edit, voidEntry }: {
  snapshot: LedgerSnapshot; month: string; busy: boolean;
  filter: FlowFilter; setFilter: (filter: FlowFilter) => void;
  create: () => void; edit: (entry: LedgerEntry) => void; voidEntry: (entry: LedgerEntry) => void;
}) {
  const { summary } = snapshot;
  const monthEntries = snapshot.entries.filter(entry => entry.month === month);
  if (!monthEntries.length) return <div className="a2-ledger-empty"><div className="ui-empty center">
    <h4>本月还没有账目</h4>
    <p>点「记一笔」，或者对助手说"午饭 15 元，微信付的"。</p>
    <div className="actions"><button className="ui-btn" onClick={create}><Plus aria-hidden="true" />记一笔</button></div>
  </div></div>;
  const receivable = ledgerReceivable(snapshot.entries, month), owed = new Set(receivable.entryIds);
  const { account, category, day, search, showVoided } = filter;
  const entries = monthEntries.filter(entry => (showVoided || !entry.voided)
    && (!account || (account === 'unknown' ? entry.cashflows.some(flow => flow.accountId === null) : entry.cashflows.some(flow => flow.accountId === account)))
    && (!category || entry.category === category) && (!day || entry.date === day)
    && (!search || `${entry.title} ${entry.note} ${entry.originalText}`.toLowerCase().includes(search.toLowerCase())))
    .sort((a, b) => (b.date ?? b.month).localeCompare(a.date ?? a.month) || b.createdAt.localeCompare(a.createdAt));
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) groups.set(entry.date ?? '', [...(groups.get(entry.date ?? '') ?? []), entry]);
  const categories = Array.from(new Set(monthEntries.map(entry => entry.category))).sort();
  const set = (patch: Partial<FlowFilter>) => setFilter({ ...filter, ...patch });
  const filtered = account || category || day || search;
  return <div className="a2-ledger-flows">
    <div className="a2-ledger-sum">
      <Sum label="支出" cents={summary.actualPaidCents} note="实际付款，含代垫" />
      <Sum label="个人开销" cents={summary.personalCents} note={summary.pendingPersonalCount ? `${summary.pendingPersonalCount} 笔个人承担待确认` : '扣除代垫和报销'} />
      <Sum label="收入" cents={summary.incomeCents} note={summary.assetSaleCents ? `另有资产变现 ${ledgerMoney(summary.assetSaleCents)}` : '不含退款、返款和变现'} />
      <Sum label="待收回" cents={receivable.cents} warn={receivable.cents > 0} note={receivable.entryIds.length ? `代垫 ${receivable.entryIds.length} 笔，按已关联的返款计算` : '没有待收回的代垫'} />
    </div>
    <div className="a2-ledger-cols">
      <section aria-label="收支明细">
        <DailyBars month={month} values={summary.days} unknownDateCents={summary.uncertainDateCents} selected={day} onSelect={value => set({ day: value })} />
        <div className="a2-sec-h detail-h"><h3>明细</h3><span className="ui-hint">{entries.length} 笔</span>
          {day && <button className="ui-chip ddl" onClick={() => set({ day: '' })} aria-label={`取消日期筛选 ${shortDay(day)}`}>{shortDay(day)} <X aria-hidden="true" /></button>}
        </div>
        <div className="a2-ledger-filters">
          <input aria-label="搜索项目或备注" value={search} onChange={event => set({ search: event.target.value })} placeholder="搜索项目或备注" />
          <label>账户<select value={account} onChange={event => set({ account: event.target.value })}><option value="">全部账户</option><option value="unknown">账户待确认</option>{LEDGER_ACCOUNTS.map(value => <option value={value.id} key={value.id}>{value.name}</option>)}</select></label>
          <label>分类<select value={category} onChange={event => set({ category: event.target.value })}><option value="">全部分类</option>{categories.map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="a2-check"><input type="checkbox" checked={showVoided} onChange={event => set({ showVoided: event.target.checked })} />显示已作废</label>
          {filtered && <button className="ui-btn sm ghost" onClick={() => setFilter({ ...noFilter, showVoided })}>清除筛选</button>}
        </div>
        {summary.pendingAccountCount > 0 && <p className="ui-hint a2-ledger-note">本月 {summary.pendingAccountCount} 笔账户待确认；展开记录，点「补充账户 / 更正」完善原笔。</p>}
        {entries.length ? [...groups].map(([date, list]) => {
          const paid = list.filter(entry => !entry.voided && (entry.kind === 'expense' || entry.kind === 'repayment')).reduce((sum, entry) => sum + entry.amountCents, 0);
          return <div className="a2-ledger-day" key={date || 'unknown'}>
            <div className="day-h"><b>{date ? fullDay(date) : '日期待确认'}</b>{paid > 0 && <span title="当天实际支付">{ledgerMoney(paid)}</span>}</div>
            {list.map(entry => <LedgerRow key={entry.id} entry={entry} snapshot={snapshot} owed={owed} busy={busy} onEdit={() => edit(entry)} onVoid={() => voidEntry(entry)} />)}
          </div>;
        }) : <p className="ui-hint a2-ledger-note">没有符合筛选的账目。</p>}
      </section>
      <Categories values={summary.categories} selected={category} onSelect={value => set({ category: value })} />
    </div>
  </div>;
}
