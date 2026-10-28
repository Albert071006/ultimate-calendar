import { useState } from 'react';
import { ledgerAccounts, LedgerEntryDraftSchema, type LedgerAccount, type LedgerAccountId, type LedgerEntry, type LedgerEntryKind, type LedgerMutationRequest, type LedgerSnapshot } from '../../../shared/ledger';
import { isLedgerLoanKind as isLoanKind, ledgerLoans } from '../../../shared/ledger-loans';
import { operationId, todayDate } from '../../calendar-layout';
import { localDateTime } from '../../calendar-timeline';
import { ledgerMoney } from './money';

export type Change = LedgerMutationRequest['changes'][number];
export type Save = (changes: Change[]) => Promise<boolean>;
export const kinds: Record<LedgerEntryKind, string> = { expense: '消费', income: '普通收入', asset_sale: '资产变现', transfer: '账户转账', bonus: '赠送额度', refund: '退款', reimbursement: '费用报销', aa_return: 'AA / 代垫返款', loan_borrow: '借入', loan_lend: '借出', loan_repay: '归还借款', loan_collect: '收回借款', repayment: '其他还款（信用卡等）', adjustment: '个人开销调整' };
export const accountName = (id: LedgerAccountId | null, accounts: readonly LedgerAccount[]) => accounts.find(value => value.id === id)?.name ?? '账户待确认';
export const timeText = (value: string | null | undefined) => value ? localDateTime(Date.parse(value)).replace('T', ' ') : '时点未明确';
export const inKinds: LedgerEntryKind[] = ['income', 'asset_sale', 'bonus', 'refund', 'reimbursement', 'aa_return', 'loan_borrow', 'loan_collect'];
export { isLoanKind };
export const centsInput = (value: number | null | undefined) => value == null ? '' : (value / 100).toFixed(2);
export const parseMoney = (value: string, name: string, signed = false) => {
  if (!(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(value.trim())) throw new Error(`${name}请填写金额，最多两位小数。`);
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > 9_000_000_000_000) throw new Error(`${name}超出可记录范围。`);
  return amount;
};

export function AccountSelect({ value, onChange, label, accounts, excludeFamily = false, cashOnly = false }: { value: string; onChange: (value: string) => void; label: string; accounts: readonly LedgerAccount[]; excludeFamily?: boolean; cashOnly?: boolean }) {
  return <label>{label}<select value={value} onChange={event => onChange(event.target.value)}><option value="">账户待确认</option>{accounts.filter(account => (!excludeFamily || account.kind !== 'family') && (!cashOnly || account.kind === 'cash')).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>;
}

export function EntryEditor({ entry, snapshot, busy, error, save, close }: { entry?: LedgerEntry; snapshot: LedgerSnapshot; busy: boolean; error: string; save: (changes: Change[]) => Promise<boolean>; close: () => void }) {
  const accounts = ledgerAccounts(snapshot);
  const [entryId] = useState(entry?.id ?? operationId());
  const [kind, setKind] = useState<LedgerEntryKind>(entry?.kind ?? 'expense'), [title, setTitle] = useState(entry?.title ?? ''), [category, setCategory] = useState(entry?.category ?? '餐饮');
  const [date, setDate] = useState(entry?.date ?? todayDate()), [unknownDate, setUnknownDate] = useState(entry ? !entry.date : false), [month, setMonth] = useState(entry?.month ?? todayDate().slice(0, 7)), [dateNote, setDateNote] = useState(entry?.dateNote ?? '');
  const [amount, setAmount] = useState(centsInput(entry?.amountCents)), [personal, setPersonal] = useState(centsInput(entry?.personalCents)), [personalUnknown, setPersonalUnknown] = useState(entry?.personalCents === null), [personalTouched, setPersonalTouched] = useState(!!entry);
  const [account, setAccount] = useState(entry?.cashflows[0]?.accountId ?? ''), [toAccount, setToAccount] = useState(entry?.cashflows.find(value => value.deltaCents > 0)?.accountId ?? '');
  const [extraIncome, setExtraIncome] = useState(centsInput(entry?.incomeCents ?? 0));
  const [note, setNote] = useState(entry?.note ?? ''), [reason, setReason] = useState(''), [formError, setFormError] = useState('');
  const [related, setRelated] = useState<string[]>(entry?.adjustments.length ? entry.adjustments.flatMap(value => value.targetEntryIds) : entry?.relatedEntryIds ?? []), [reduction, setReduction] = useState(centsInput(entry?.adjustments.reduce((sum, value) => sum + value.amountCents, 0) ?? 0));
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [counterparty, setCounterparty] = useState(entry?.counterparty ?? '');
  const loanKind = isLoanKind(kind), settlingLoan = kind === 'loan_repay' || kind === 'loan_collect';
  const loanOrigins = snapshot.entries.filter(value => !value.voided && value.id !== entry?.id && value.kind === (kind === 'loan_repay' ? 'loan_borrow' : 'loan_lend'));
  const loanBalances = ledgerLoans(snapshot.entries.filter(value => value.id !== entry?.id));
  const selectedLoan = loanBalances.items.find(value => value.entryId === related[0]);
  const changeKind = (next: LedgerEntryKind) => {
    if (next === kind) return;
    setKind(next); setRelated([]); setReduction('0'); setCounterparty('');
    if (isLoanKind(next)) { setCategory('借款'); if (account && !accounts.some(value => value.id === account && value.kind === 'cash')) setAccount(''); }
  };
  const linkedKind = ['refund', 'reimbursement', 'aa_return', 'adjustment'].includes(kind);
  const canAdjust = ['refund', 'reimbursement', 'adjustment'].includes(kind);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setFormError('');
    try {
      const amountCents = kind === 'adjustment' ? 0 : parseMoney(amount, '实际金额'), personalCents = loanKind ? 0 : kind === 'expense' ? personalUnknown ? null : parseMoney(personalTouched ? personal : amount, '个人开销') : entry?.kind === kind ? entry.personalCents : 0;
      const unchangedCashflow = entry && kind === entry.kind && amountCents === entry.amountCents && account === (entry.cashflows[0]?.accountId ?? '') && toAccount === (entry.cashflows.find(value => value.deltaCents > 0)?.accountId ?? '');
      if (entry && !reason.trim()) throw new Error('请写一句更正说明，保留修改依据。');
      const reductionCents = canAdjust ? parseMoney(reduction || '0', '冲减金额') : 0;
      if (reductionCents && !related.length) throw new Error('冲减个人开销时，请选择原消费；原消费不在账本中则保持冲减为 0。');
      if (loanKind && amountCents <= 0) throw new Error('借款本金须大于 0。');
      if (loanKind && account && !accounts.some(value => value.id === account && value.kind === 'cash')) throw new Error('借款请选择现金账户或保留账户待确认。');
      if (settlingLoan && related.length && !loanOrigins.some(value => value.id === related[0])) throw new Error('请选择方向对应的原借款。');
      if (settlingLoan && selectedLoan && amountCents > selectedLoan.outstandingCents) throw new Error('还收本金超过这笔借款的剩余金额；利息或手续费请另记一笔。');
      const draft = LedgerEntryDraftSchema.parse({
        ...(entry ? Object.fromEntries(Object.entries(entry).filter(([key]) => !['version', 'createdAt', 'updatedAt', 'voided', 'sameDayBalanceOrder', 'counterparty'].includes(key))) : {}),
        id: entryId, kind, date: unknownDate ? null : date, month: unknownDate ? month : date.slice(0, 7), dateNote: unknownDate ? dateNote : '',
        occurredAt: entry?.date === date && !unknownDate ? entry.occurredAt : null,
        title, category, amountCents, personalCents, ...(loanKind && counterparty.trim() ? { counterparty: counterparty.trim() } : {}), incomeCents: loanKind ? 0 : kind === 'income' ? amountCents : kind === 'reimbursement' ? parseMoney(extraIncome || '0', '已确认额外收入') : entry?.kind === kind ? entry.incomeCents : 0, assetSaleCents: loanKind ? 0 : kind === 'asset_sale' ? amountCents : entry?.kind === kind ? entry.assetSaleCents : 0,
        cashflows: unchangedCashflow ? entry.cashflows : kind === 'adjustment' ? [] : kind === 'transfer' ? [{ accountId: account || null, deltaCents: -amountCents }, { accountId: toAccount || null, deltaCents: amountCents }] : [{ accountId: account || null, deltaCents: (inKinds.includes(kind) ? 1 : -1) * amountCents }],
        relatedEntryIds: settlingLoan ? related.slice(0, 1) : loanKind ? [] : linkedKind ? [...new Set(related)] : entry?.kind === kind ? entry.relatedEntryIds : [], adjustments: loanKind ? [] : linkedKind ? reductionCents ? entry && JSON.stringify(related) === JSON.stringify(entry.adjustments.flatMap(value => value.targetEntryIds)) && reductionCents === entry.adjustments.reduce((sum, value) => sum + value.amountCents, 0) ? entry.adjustments : [{ targetEntryIds: [...new Set(related)], amountCents: reductionCents, note: reason || note }] : [] : entry?.kind === kind ? entry.adjustments : [], note,
      });
      if (await save([{ type: 'putEntry', entry: draft, expectedVersion: entry?.version ?? null, confirmDuplicate, note: entry ? reason : '手工记账' }])) close();
    } catch (value) { setFormError(value instanceof Error ? value.message : '请检查填写内容。'); }
  };
  return <form className="editor-form ledger-form" onSubmit={event => void submit(event)}><div className="form-grid"><label>类型<select value={kind} onChange={event => changeKind(event.target.value as LedgerEntryKind)}>{Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label>项目<input required maxLength={500} value={title} onChange={event => setTitle(event.target.value)} /></label><label>分类<input required maxLength={100} value={category} onChange={event => setCategory(event.target.value)} list="ledger-category-options" /><datalist id="ledger-category-options">{Array.from(new Set(['餐饮', '交通', '购物', '软件服务', '水费', '生活费', '借款', ...snapshot.entries.map(value => value.category)])).map(value => <option key={value} value={value} />)}</datalist></label><label>{unknownDate ? '发生月份' : '发生日期'}<input required type={unknownDate ? 'month' : 'date'} value={unknownDate ? month : date} onChange={event => unknownDate ? setMonth(event.target.value) : setDate(event.target.value)} /></label></div>
    <label className="ledger-checkbox"><input type="checkbox" checked={unknownDate} onChange={event => setUnknownDate(event.target.checked)} />仅确定月份，日期待确认</label>{unknownDate && <label>日期说明<input value={dateNote} onChange={event => setDateNote(event.target.value)} placeholder="例如：10 月 4 日或 5 日" /></label>}
    {kind !== 'adjustment' && <div className="form-grid"><label>{kind === 'transfer' ? '转账金额（元）' : inKinds.includes(kind) ? '实际收到（元）' : '实际支付（元）'}<input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" /></label>{kind === 'expense' && <label>个人开销（元）<input inputMode="decimal" disabled={personalUnknown} value={personalTouched ? personal : amount} onChange={event => { setPersonalTouched(true); setPersonal(event.target.value); }} placeholder={personalUnknown ? '待确认' : '只计自己承担的部分'} /></label>}<AccountSelect label={kind === 'transfer' ? '转出账户' : inKinds.includes(kind) ? '收款账户' : '支付账户'} value={account} onChange={setAccount} accounts={accounts} cashOnly={loanKind} />{kind === 'transfer' && <AccountSelect label="转入账户" value={toAccount} onChange={setToAccount} accounts={accounts} />}{kind === 'reimbursement' && <label>其中已确认的额外收入（元）<input inputMode="decimal" value={extraIncome} onChange={event => setExtraIncome(event.target.value)} /></label>}</div>}
    {loanKind && <fieldset><legend>借款本金</legend><label>对方（可留空）<input maxLength={200} value={counterparty} onChange={event => setCounterparty(event.target.value)} placeholder="姓名或便于区分的称呼" /></label>
      {settlingLoan && <><label>{kind === 'loan_repay' ? '对应原借入' : '对应原借出'}<select value={related[0] ?? ''} onChange={event => { const id = event.target.value; setRelated(id ? [id] : []); const original = loanOrigins.find(value => value.id === id); setCounterparty(original?.counterparty ?? ''); }}><option value="">未关联原借款</option>{loanOrigins.map(value => { const remaining = loanBalances.items.find(item => item.entryId === value.id)?.outstandingCents ?? 0; return <option key={value.id} value={value.id}>{value.date ?? value.month} · {value.counterparty || '对方待确认'} · {value.title} · 剩余 {ledgerMoney(remaining)}</option>; })}</select></label><p className="ledger-form-note">{selectedLoan ? <>这笔本金剩余 {ledgerMoney(selectedLoan.outstandingCents)}，可分次归还或收回。</> : '未关联时仅记录本次真实资金收付，剩余欠款未知；不会抵扣其他借款。'}</p></>}
      <p className="ledger-form-note">这里只记本金，不计个人开销或普通收入。利息、手续费请分别记消费或收入。</p>
    </fieldset>}
    {kind === 'expense' && <label className="ledger-checkbox"><input type="checkbox" checked={personalUnknown} onChange={event => setPersonalUnknown(event.target.checked)} />个人承担金额还不明确（例如 AA 比例待定）</label>}
    {!account && kind !== 'adjustment' && <p className="ledger-form-note">账户待确认：保存真实交易和已明确的个人开销，不扣任何已知账户余额。</p>}
    {kind === 'transfer' && <p className="ledger-form-note">饭卡、会员卡充值使用账户转账；水卡充值请选消费，分类为水费。</p>}
    {linkedKind && <fieldset><legend>关联原消费</legend><label>原消费（按住 Ctrl 可选多笔）<select multiple size={4} value={related} onChange={event => setRelated(Array.from(event.target.selectedOptions).map(value => value.value))}>{snapshot.entries.filter(value => !value.voided && value.kind === 'expense' && value.id !== entry?.id).map(value => <option key={value.id} value={value.id}>{value.date ?? value.month} · {value.title} · {ledgerMoney(value.amountCents)}</option>)}</select></label>{canAdjust && <label>冲减原消费个人开销（元）<input inputMode="decimal" value={reduction} onChange={event => setReduction(event.target.value)} /></label>}<p className="ledger-form-note">{kind === 'aa_return' ? 'AA 返款只记录资金回流，不重复冲减已排除代垫的个人开销；需要调整个人承担时请更正原消费。' : '原消费已扣除这笔返款时填 0，不重复冲减；原消费未入账时也填 0。跨月会修正原消费月份。'}</p>{kind === 'adjustment' && <p className="ledger-form-note">只调整个人开销，不产生新的付款或收款。</p>}</fieldset>}
    <label>备注<textarea rows={2} value={note} onChange={event => setNote(event.target.value)} /></label>{entry && <label>更正说明<input required value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：补充支付账户为支付宝" /></label>}
    {(/重复|已有相同|另一笔/.test(error) || confirmDuplicate) && <label className="ledger-checkbox"><input type="checkbox" checked={confirmDuplicate} onChange={event => setConfirmDuplicate(event.target.checked)} />我已核对，这是另一笔真实交易</label>}
    {(formError || error) && <p role="alert" className="error">{formError || error}</p>}<footer className="form-footer"><button type="button" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy}>{busy ? '保存中…' : entry ? '保存更正' : '保存账单'}</button></footer>
  </form>;
}

export function VoidEditor({ entry, busy, error, save, close }: { entry: LedgerEntry; busy: boolean; error: string; save: (changes: Change[]) => Promise<boolean>; close: () => void }) {
  const [note, setNote] = useState('');
  return <form className="editor-form ledger-form" onSubmit={event => { event.preventDefault(); void save([{ type: 'voidEntry', id: entry.id, expectedVersion: entry.version, note }]).then(saved => { if (saved) close(); }); }}><p>作废“{entry.title}” {ledgerMoney(entry.amountCents)} 后，这笔不再计入开销与账户变化，原记录和更正历史仍会保留。</p><label>作废说明<input required value={note} onChange={event => setNote(event.target.value)} placeholder="例如：误记，实际没有发生" /></label>{error && <p className="error" role="alert">{error}</p>}<footer className="form-footer"><button type="button" disabled={busy} onClick={close}>保留</button><button className="danger" disabled={busy}>确认作废</button></footer></form>;
}

export function BalanceEditor({ accountId, snapshot, busy, error, save, close }: { accountId: LedgerAccountId; snapshot: LedgerSnapshot; busy: boolean; error: string; save: (changes: Change[]) => Promise<boolean>; close: () => void }) {
  const [id] = useState(operationId());
  const [balance, setBalance] = useState(''), [asOf, setAsOf] = useState(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19)), [note, setNote] = useState(''), [includeDay, setIncludeDay] = useState(false), [formError, setFormError] = useState('');
  const dayEntries = snapshot.entries.filter(entry => !entry.voided && entry.date === asOf.slice(0, 10) && !entry.occurredAt && entry.cashflows.some(flow => flow.accountId === accountId));
  return <form className="editor-form ledger-form" onSubmit={event => { event.preventDefault(); setFormError(''); try {
    const amount = parseMoney(balance, '余额', true), instant = `${asOf}${asOf.length === 16 ? ':00' : ''}+08:00`;
    if (!asOf || !Number.isFinite(Date.parse(instant))) throw new Error('请填写快照时点。');
    const coveredEntryIds = snapshot.entries.filter(entry => !entry.voided && entry.cashflows.some(flow => flow.accountId === accountId) && (entry.occurredAt ? Date.parse(entry.occurredAt) <= Date.parse(instant) : entry.date && (entry.date < asOf.slice(0, 10) || includeDay && entry.date === asOf.slice(0, 10)))).map(entry => entry.id);
    if (!ledgerAccounts(snapshot).some(account => account.id === accountId && account.kind !== 'family')) throw new Error('请选择可核对余额的现金或储值账户。');
    void save([{ type: 'setBalance', snapshot: { id, accountId, balanceCents: amount, date: asOf.slice(0, 10), asOf: instant, coveredEntryIds, note, sourceId: null } }]).then(saved => { if (saved) close(); });
  } catch (value) { setFormError(value instanceof Error ? value.message : '请检查内容。'); } }}><p className="ledger-form-note">填写你实际看到的余额。这是余额快照，不会当成收入；已覆盖的历史交易不会再次扣除。</p><div className="form-grid"><label>账户实际余额（元）<input required inputMode="decimal" value={balance} onChange={event => setBalance(event.target.value)} /></label><label>余额对应时点（北京时间）<input required type="datetime-local" step={1} value={asOf} onChange={event => setAsOf(event.target.value)} /></label></div>{!!dayEntries.length && <><label className="ledger-checkbox"><input type="checkbox" checked={includeDay} onChange={event => setIncludeDay(event.target.checked)} />这份余额已包含当天全部 {dayEntries.length} 笔未标具体时刻的已记交易</label><p className="ledger-form-note">不勾选时保留这些同日交易的先后关系待核对，不假定已扣或未扣。</p></>}<label>快照备注<textarea rows={2} value={note} onChange={event => setNote(event.target.value)} /></label>{(formError || error) && <p role="alert" className="error">{formError || error}</p>}<footer className="form-footer"><button type="button" disabled={busy} onClick={close}>取消</button><button disabled={busy} className="primary">保存余额快照</button></footer></form>;
}
