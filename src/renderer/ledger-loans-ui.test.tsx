// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, LedgerSnapshotSchema, type LedgerEntry } from '../shared/ledger';
import { summarizeLedger } from '../ledger/summary';
import { EntryEditor, type Change } from './components/ledger/editors';
import { Flows, noFilter } from './components/ledger/Flows';
import { MobileProvider } from './mobile/layout';

afterEach(cleanup);
const stamp = '2026-01-15T12:00:00+08:00';
function loan(overrides: Partial<LedgerEntry> = {}) {
  return LedgerEntrySchema.parse({ id: 'borrowed', kind: 'loan_borrow', date: '2026-01-15', month: '2026-01', title: '合成借款', category: '借款', counterparty: '合成同学甲',
    amountCents: 18000, personalCents: 0, cashflows: [{ accountId: 'wechat', deltaCents: 18000 }], version: 1, createdAt: stamp, updatedAt: stamp, ...overrides });
}
function snapshot(entries: LedgerEntry[] = []) {
  return LedgerSnapshotSchema.parse({ revision: 1, entries, balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [], summary: summarizeLedger({ entries, balanceSnapshots: [] }, { month: '2026-03' }) });
}
function editor(entries: LedgerEntry[] = [], entry?: LedgerEntry) {
  const save = vi.fn(async (_changes: Change[]) => true);
  render(<EntryEditor snapshot={snapshot(entries)} entry={entry} busy={false} error="" save={save} close={vi.fn()} />);
  return save;
}

describe('loan recording and balances on desktop and mobile', () => {
  it.each([
    ['loan_borrow', '实际收到（元）', '收款账户', 1],
    ['loan_lend', '实际支付（元）', '支付账户', -1],
    ['loan_repay', '实际支付（元）', '支付账户', -1],
    ['loan_collect', '实际收到（元）', '收款账户', 1],
  ] as const)('records %s as principal with the correct cash direction and no personal expense or income', async (kind, amountLabel, accountLabel, direction) => {
    const save = editor();
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: kind } });
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '合成本金' } });
    fireEvent.change(screen.getByLabelText('对方（可留空）'), { target: { value: '合成同学乙' } });
    fireEvent.change(screen.getByLabelText(amountLabel), { target: { value: '95.20' } });
    const account = screen.getByLabelText(accountLabel);
    expect(within(account).queryByRole('option', { name: '亲情卡' })).toBeNull();
    expect(within(account).queryByRole('option', { name: '学校饭卡' })).toBeNull();
    fireEvent.change(account, { target: { value: 'wechat' } });
    expect(screen.queryByLabelText('个人开销（元）')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0][0]).toMatchObject({ entry: { kind, counterparty: '合成同学乙', amountCents: 9520, personalCents: 0, incomeCents: 0, assetSaleCents: 0,
      cashflows: [{ accountId: 'wechat', deltaCents: direction * 9520 }], relatedEntryIds: [], adjustments: [] } });
  });

  it('links a partial repayment to an older loan, rejects excess principal, and clears a link when changing direction', async () => {
    const borrowed = loan(), lent = loan({ id: 'lent', kind: 'loan_lend', counterparty: '合成同学乙', cashflows: [{ accountId: 'alipay', deltaCents: -18000 }] });
    const paid = loan({ id: 'paid', kind: 'loan_repay', month: '2026-02', date: '2026-02-15', amountCents: 8000, cashflows: [{ accountId: 'wechat', deltaCents: -8000 }], relatedEntryIds: ['borrowed'] });
    const save = editor([borrowed, lent, paid]);
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'loan_repay' } });
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '合成分次归还' } });
    const source = screen.getByLabelText('对应原借入');
    expect((source as HTMLSelectElement).value).toBe('');
    expect((source as HTMLSelectElement).options).toHaveLength(2);
    fireEvent.change(source, { target: { value: 'borrowed' } });
    expect((screen.getByLabelText('对方（可留空）') as HTMLInputElement).value).toBe('合成同学甲');
    expect(screen.getByText(/这笔本金剩余 ¥100.00/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('实际支付（元）'), { target: { value: '101' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('超过这笔借款的剩余金额'));
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'loan_collect' } });
    expect((screen.getByLabelText('对应原借出') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('对方（可留空）') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'loan_repay' } });
    fireEvent.change(screen.getByLabelText('对应原借入'), { target: { value: 'borrowed' } });
    fireEvent.change(screen.getByLabelText('实际支付（元）'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0][0]).toMatchObject({ entry: { kind: 'loan_repay', amountCents: 5000, relatedEntryIds: ['borrowed'] } });
  });

  it('edits a prior repayment without subtracting its old amount twice', async () => {
    const borrowed = loan(), paid = loan({ id: 'paid', kind: 'loan_repay', amountCents: 12000, cashflows: [{ accountId: 'wechat', deltaCents: -12000 }], relatedEntryIds: ['borrowed'] });
    const save = editor([borrowed, paid], paid);
    expect(screen.getByText(/这笔本金剩余 ¥180.00/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('更正说明'), { target: { value: '合成补充备注' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更正' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0][0]).toMatchObject({ expectedVersion: 1, entry: { id: 'paid', amountCents: 12000, relatedEntryIds: ['borrowed'] } });
  });

  it.each([false, true])('keeps cross-month balances and unlinked warnings visible in an empty month (mobile=%s)', mobile => {
    const borrowed = loan(), lent = loan({ id: 'lent', kind: 'loan_lend', title: '合成借出', counterparty: '合成同学乙', cashflows: [{ accountId: 'alipay', deltaCents: -18000 }] });
    const paid = loan({ id: 'paid', kind: 'loan_repay', title: '合成归还', amountCents: 8000, cashflows: [{ accountId: 'wechat', deltaCents: -8000 }], relatedEntryIds: ['borrowed'] });
    const collected = loan({ id: 'collected', kind: 'loan_collect', title: '合成收回', counterparty: '合成同学乙', amountCents: 3000, cashflows: [{ accountId: 'alipay', deltaCents: 3000 }], relatedEntryIds: ['lent'] });
    const unlinked = loan({ id: 'unlinked', kind: 'loan_repay', title: '合成历史归还', amountCents: 1000, cashflows: [{ accountId: null, deltaCents: -1000 }] });
    render(<MobileProvider mobile={mobile}><Flows snapshot={snapshot([borrowed, lent, paid, collected, unlinked])} month="2026-03" busy={false} filter={noFilter} setFilter={vi.fn()} create={vi.fn()} edit={vi.fn()} voidEntry={vi.fn()} /></MobileProvider>);
    const panel = screen.getByRole('region', { name: '借款往来' });
    expect(within(panel).getByText('待还本金').parentElement).toHaveProperty('textContent', '待还本金¥100.00');
    expect(within(panel).getByText('待收本金').parentElement).toHaveProperty('textContent', '待收本金¥150.00');
    fireEvent.click(within(panel).getByText('查看借款明细（2 笔，另有 1 笔未关联）'));
    expect(within(panel).getByText(/剩余欠款未知/)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '补充关联' })).toBeTruthy();
    expect(screen.getByText('本月还没有账目')).toBeTruthy();
  });
});
