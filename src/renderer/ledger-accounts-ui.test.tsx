// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApiResult, DesktopAPI } from '../shared/contracts';
import { DEFAULT_LEDGER_RULES, LEDGER_ACCOUNTS, LedgerEntrySchema, LedgerSnapshotSchema, type LedgerAccount, type LedgerMutationRequest, type LedgerMutationResult } from '../shared/ledger';
import { summarizeLedger } from '../ledger/summary';
import { todayDate } from './calendar-layout';
import { LedgerPage } from './components/LedgerPage';
import { AccountEditor } from './components/ledger/AccountEditor';
import { EntryEditor, type Change } from './components/ledger/editors';
import { RulesEditor } from './components/ledger/Rules';
import { MobileProvider } from './mobile/layout';

afterEach(cleanup);
const bank: LedgerAccount = { id: 'synthetic-bank-1234', name: '合成银行 · 尾号 1234', kind: 'cash', aliases: ['合成银行', '1234'] };
const card: LedgerAccount = { id: 'synthetic-shop', name: '合成书店会员卡', kind: 'stored', aliases: ['合成书店'] };
const accounts = [...LEDGER_ACCOUNTS, bank, card];
const today = todayDate(), month = today.slice(0, 7), stamp = `${today}T12:00:00+08:00`;
const expense = LedgerEntrySchema.parse({ id: 'synthetic-book', kind: 'expense', title: '合成买书', category: '学习', date: today, month,
  amountCents: 2200, personalCents: 2200, cashflows: [{ accountId: bank.id, deltaCents: -2200 }], version: 1, createdAt: stamp, updatedAt: stamp });
function snapshot() {
  const data = { accounts, entries: [expense], balanceSnapshots: [] };
  return LedgerSnapshotSchema.parse({ ...data, revision: 1, rules: DEFAULT_LEDGER_RULES, audit: [], sources: [], summary: summarizeLedger(data, { month }) });
}
function page(mobile = false) {
  let current = snapshot();
  const ledgerMutate = vi.fn(async (request: LedgerMutationRequest): Promise<ApiResult<LedgerMutationResult>> => {
    const changedAccounts = [...(current.accounts ?? [])];
    for (const change of request.changes) if (change.type === 'putAccount') {
      const index = changedAccounts.findIndex(account => account.id === change.account.id);
      if (index < 0) changedAccounts.push(change.account); else changedAccounts[index] = change.account;
    }
    current = { ...current, accounts: changedAccounts, revision: current.revision + 1 };
    current.summary = summarizeLedger(current, { month });
    return { ok: true, data: { status: 'saved', operationId: request.operationId, snapshot: current, entryIds: [], message: '已保存账户', undoAvailable: true } };
  });
  const api = { ledgerSnapshot: vi.fn(async () => ({ ok: true as const, data: current })), ledgerMutate, onChanged: () => () => {} } as unknown as DesktopAPI;
  render(<MobileProvider mobile={mobile}><LedgerPage api={api} /></MobileProvider>);
  return { ledgerMutate };
}

describe('dynamic ledger accounts', () => {
  it.each([false, true])('creates a named stored account without inventing a balance or changing old entries (mobile=%s)', async mobile => {
    const f = page(mobile);
    fireEvent.click(await screen.findByRole('tab', { name: '账户' }));
    fireEvent.click(screen.getByRole('button', { name: '新增账户' }));
    const dialog = screen.getByRole('dialog', { name: '新增账户' });
    fireEvent.change(within(dialog).getByLabelText('账户名称'), { target: { value: ' 合成茶店会员卡 ' } });
    fireEvent.change(within(dialog).getByLabelText('账户类型'), { target: { value: 'stored' } });
    fireEvent.change(within(dialog).getByLabelText('别名（可留空，每行一个）'), { target: { value: '茶店\n茶卡，茶店' } });
    expect(within(dialog).getByText(/新增后余额为未知/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存账户' }));
    const name = await screen.findByRole('button', { name: '合成茶店会员卡' });
    expect(name.closest('.row')!.querySelector('.bal')).toHaveProperty('textContent', '待确认');
    expect(f.ledgerMutate.mock.calls[0]![0].changes).toEqual([{ type: 'putAccount', account: { id: expect.any(String), name: '合成茶店会员卡', kind: 'stored', aliases: ['茶店', '茶卡'] } }]);
    fireEvent.click(screen.getByRole('button', { name: '记一笔' }));
    expect(within(screen.getByLabelText('支付账户')).getByRole('option', { name: '合成茶店会员卡' })).toBeTruthy();
  });

  it('renames an account in place and reflects the name in historical details, filters and balance dialogs', async () => {
    const f = page();
    fireEvent.click(await screen.findByRole('tab', { name: '账户' }));
    fireEvent.click(screen.getByRole('button', { name: `编辑账户 ${bank.name}` }));
    const dialog = screen.getByRole('dialog', { name: '编辑账户' });
    expect(within(dialog).getByLabelText('账户类型')).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('账户名称'), { target: { value: '合成银行 · 尾号 5678' } });
    fireEvent.change(within(dialog).getByLabelText('别名（可留空，每行一个）'), { target: { value: '合成银行\n5678' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存账户' }));
    const name = await screen.findByRole('button', { name: '合成银行 · 尾号 5678' });
    expect(f.ledgerMutate.mock.calls[0]![0].changes).toEqual([{ type: 'putAccount', account: { ...bank, name: '合成银行 · 尾号 5678', aliases: ['合成银行', '5678'] } }]);
    fireEvent.click(within(name.closest('.row') as HTMLElement).getByRole('button', { name: '核对余额' }));
    const balance = screen.getByRole('dialog', { name: '核对余额 · 合成银行 · 尾号 5678' });
    fireEvent.change(within(balance).getByLabelText('账户实际余额（元）'), { target: { value: '12.34' } });
    fireEvent.click(within(balance).getByRole('button', { name: '保存余额快照' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(2));
    expect(f.ledgerMutate.mock.calls[1]![0].changes[0]).toMatchObject({ type: 'setBalance', snapshot: { accountId: bank.id, balanceCents: 1234 } });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '合成银行 · 尾号 5678' }));
    expect(screen.getByRole('combobox', { name: '账户' })).toHaveProperty('value', bank.id);
    const row = screen.getByText('合成买书').closest('details')!;
    fireEvent.click(row.querySelector('summary')!);
    expect(within(row).getByText('合成银行 · 尾号 5678 −¥22.00')).toBeTruthy();
    expect(screen.queryByText(bank.name)).toBeNull();
  });

  it('keeps a new account identity on retry and accepts shared aliases but rejects an existing name', async () => {
    const save = vi.fn(async (_changes: Change[]) => false), close = vi.fn();
    render(<AccountEditor accounts={accounts} busy={false} error="" save={save} close={close} />);
    fireEvent.change(screen.getByLabelText('账户名称'), { target: { value: bank.name } });
    fireEvent.click(screen.getByRole('button', { name: '保存账户' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('已有同名账户'));
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('账户名称'), { target: { value: '合成银行 · 尾号 9999' } });
    fireEvent.change(screen.getByLabelText('别名（可留空，每行一个）'), { target: { value: '合成银行' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账户' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '保存账户' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0]).toEqual(save.mock.calls[0]![0]);
    expect(save.mock.calls[0]![0][0]).toMatchObject({ account: { kind: 'cash', aliases: ['合成银行'] } });
    expect(close).not.toHaveBeenCalled();
  });

  it('offers custom accounts in transfers and only cash accounts for loan principal', async () => {
    const save = vi.fn(async (_changes: Change[]) => true);
    render(<EntryEditor snapshot={snapshot()} busy={false} error="" save={save} close={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'transfer' } });
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '合成会员卡充值' } });
    fireEvent.change(screen.getByLabelText('转账金额（元）'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('转出账户'), { target: { value: bank.id } });
    fireEvent.change(screen.getByLabelText('转入账户'), { target: { value: card.id } });
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0][0]).toMatchObject({ entry: { kind: 'transfer', cashflows: [{ accountId: bank.id, deltaCents: -5000 }, { accountId: card.id, deltaCents: 5000 }] } });
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'loan_borrow' } });
    const loanAccount = screen.getByLabelText('收款账户');
    expect(within(loanAccount).getByRole('option', { name: bank.name })).toBeTruthy();
    expect(within(loanAccount).queryByRole('option', { name: card.name })).toBeNull();
    expect(within(loanAccount).queryByRole('option', { name: '亲情卡' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0][0]).toMatchObject({ entry: { kind: 'loan_borrow', cashflows: [{ accountId: bank.id, deltaCents: 5000 }] } });
  });

  it('uses the same dynamic directory in fixed allowance rules', async () => {
    const save = vi.fn(async (_changes: Change[]) => true);
    render(<RulesEditor rules={DEFAULT_LEDGER_RULES} accounts={accounts} busy={false} save={save} />);
    const select = screen.getByLabelText('到账账户');
    expect(within(select).getByRole('option', { name: bank.name })).toBeTruthy();
    expect(within(select).getByRole('option', { name: card.name })).toBeTruthy();
    expect(within(select).queryByRole('option', { name: '亲情卡' })).toBeNull();
    fireEvent.change(select, { target: { value: bank.id } });
    fireEvent.change(screen.getByLabelText('规则修改说明'), { target: { value: '合成规则' } });
    fireEvent.click(screen.getByRole('button', { name: '保存记账规则' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0][0]).toMatchObject({ rules: { monthlyAllowance: { accountId: bank.id } } });
  });
});
