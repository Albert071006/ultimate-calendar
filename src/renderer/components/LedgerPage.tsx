import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Plus, Undo2 } from 'lucide-react';
import type { HostCapabilities, PlannerClient } from '../../shared/client';
import type { LedgerViewContext } from '../../shared/contracts';
import type { LedgerAccountId, LedgerEntry } from '../../shared/ledger';
import { Modal } from './Modal';
import { PageToolbar } from './shell/PageToolbar';
import { MoreMenu } from './shell/MoreMenu';
import { useLedger } from './ledger/useLedger';
import { Flows, noFilter, type FlowFilter } from './ledger/Flows';
import { Accounts } from './ledger/Accounts';
import { BalanceEditor, EntryEditor, VoidEditor, accountName } from './ledger/editors';
import './LedgerPage.css';

type Tab = 'flows' | 'accounts';

/** 账单: 收支 (totals, daily spending, categories, day-grouped details) and 账户 (balances and snapshots). */
export function LedgerPage({ api, host, createRequest = 0, onViewChange }: { api: PlannerClient; host?: HostCapabilities; createRequest?: number; onViewChange?: (view: LedgerViewContext | undefined) => void }) {
  const ledger = useLedger(api, host);
  const { month, snapshot, busy, error, notice } = ledger;
  const [tab, setTab] = useState<Tab>('flows');
  const [filter, setFilter] = useState<FlowFilter>(noFilter);
  const [editor, setEditor] = useState<LedgerEntry | 'new' | null>(null);
  const [voidTarget, setVoidTarget] = useState<LedgerEntry | null>(null);
  const [balanceAccount, setBalanceAccount] = useState<LedgerAccountId | null>(null);
  const createSeen = useRef(createRequest);
  useEffect(() => { if (createRequest !== createSeen.current) { createSeen.current = createRequest; setEditor('new'); } }, [createRequest]);
  useEffect(() => { onViewChange?.({ month, tab }); }, [month, tab, onViewChange]);
  useEffect(() => () => { onViewChange?.(undefined); }, [onViewChange]);
  const moveMonth = (direction: number) => { ledger.moveMonth(direction); setFilter(value => ({ ...value, day: '' })); };
  const title = `${Number(month.slice(0, 4))} 年 ${Number(month.slice(5))} 月`;
  return <div className="a2-page a2-ledger">
    <PageToolbar title={title} undo={false}
      lead={<div className="a2-cal-nav">
        <button className="ui-btn icon" aria-label="上个月" onClick={() => moveMonth(-1)}><ChevronLeft aria-hidden="true" /></button>
        <button className="ui-btn icon" aria-label="下个月" onClick={() => moveMonth(1)}><ChevronRight aria-hidden="true" /></button>
      </div>}>
      {host && <MoreMenu label="导出账本" trigger={<><Download aria-hidden="true" />导出</>} items={[
        { label: '导出本月 CSV', disabled: busy, onSelect: () => void ledger.exportLedger('csv') },
        { label: '导出完整账本', disabled: busy, onSelect: () => void ledger.exportLedger('json') },
      ]} />}
      <button className="ui-btn" disabled={!snapshot} onClick={() => setEditor('new')}><Plus aria-hidden="true" />记一笔</button>
      <button className="ui-btn ghost icon" aria-label="撤销账单操作" title="撤销上一次账单操作" disabled={busy || !snapshot?.audit.length} onClick={() => void ledger.undo()}><Undo2 aria-hidden="true" /></button>
    </PageToolbar>
    <div className="ui-tabs" role="tablist" aria-label="账单页面">
      {([['flows', '收支'], ['accounts', '账户']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}
      <p role={error ? 'alert' : 'status'} className={`a2-ledger-status${error ? ' error' : ''}`}>{error || notice}</p>
    </div>
    {!snapshot ? <div className="a2-ledger-empty"><div className="ui-empty center"><h4>正在载入本地账本…</h4><div className="actions"><button className="ui-btn" onClick={() => void ledger.refresh()}>重新载入账本</button></div></div></div>
      : <section className="a2-ledger-body" role="tabpanel" aria-label={tab === 'flows' ? '收支' : '账户'}>
        {tab === 'flows' ? <Flows snapshot={snapshot} month={month} busy={busy} filter={filter} setFilter={setFilter} create={() => setEditor('new')} edit={setEditor} voidEntry={setVoidTarget} />
          : <Accounts snapshot={snapshot} checkBalance={setBalanceAccount} showAccount={id => { setFilter({ ...noFilter, account: id }); setTab('flows'); }} />}
      </section>}
    {snapshot && editor && <Modal title={editor === 'new' ? '记一笔' : '更正账单'} onClose={() => { if (!busy) setEditor(null); }}><EntryEditor key={editor === 'new' ? 'new' : `${editor.id}:${editor.version}`} entry={editor === 'new' ? undefined : editor} snapshot={snapshot} busy={busy} error={error} save={ledger.save} close={() => setEditor(null)} /></Modal>}
    {voidTarget && <Modal title="作废账单" onClose={() => { if (!busy) setVoidTarget(null); }}><VoidEditor entry={voidTarget} busy={busy} error={error} save={ledger.save} close={() => setVoidTarget(null)} /></Modal>}
    {snapshot && balanceAccount && <Modal title={`核对余额 · ${accountName(balanceAccount)}`} onClose={() => { if (!busy) setBalanceAccount(null); }}><BalanceEditor accountId={balanceAccount} snapshot={snapshot} busy={busy} error={error} save={ledger.save} close={() => setBalanceAccount(null)} /></Modal>}
  </div>;
}
