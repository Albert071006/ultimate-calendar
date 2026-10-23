// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApiResult, DesktopAPI } from '../shared/contracts';
import { DEFAULT_LEDGER_RULES, LEDGER_ACCOUNTS, LedgerEntrySchema, LedgerSnapshotSchema, type LedgerMutationRequest, type LedgerMutationResult } from '../shared/ledger';
import { todayDate } from './calendar-layout';
import { LedgerPage } from './components/LedgerPage';

afterEach(cleanup);
const today = todayDate(), month = today.slice(0, 7), stamp = `${today}T12:00:00+08:00`;
const entry = LedgerEntrySchema.parse({ id: 'lunch', kind: 'expense', date: today, month, title: '午饭', category: '餐饮', amountCents: 2000, personalCents: 1200, cashflows: [{ accountId: null, deltaCents: -2000 }], sourceId: 'old-source', sourceKey: 'old-001', note: 'AA：本人承担 12 元', version: 1, createdAt: stamp, updatedAt: stamp });
function fixture() {
  const snapshot = LedgerSnapshotSchema.parse({ revision: 1, entries: [entry], balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [], summary: { month, from: null, to: null, actualPaidCents: 2000, personalCents: 1200, incomeCents: 0, assetSaleCents: 0, familyUsageCents: 0, pendingPersonalCount: 0, pendingAccountCount: 1, uncertainDateCents: 0, cashBalanceCents: null, storedBalanceCents: null, accounts: LEDGER_ACCOUNTS.map(account => ({ id: account.id, name: account.name, kind: account.kind, balanceCents: null, snapshotDate: null, snapshotAt: null, pendingEntryIds: [], periodChangeCents: 0, recordedUsageCents: 0 })), categories: [{ category: '餐饮', cents: 1200 }], days: [{ date: today, cents: 1200 }] } });
  const ledgerMutate = vi.fn(async (request: LedgerMutationRequest): Promise<ApiResult<LedgerMutationResult>> => ({ ok: true, data: { status: 'saved', operationId: request.operationId, snapshot, entryIds: [], message: '已记账', undoAvailable: true } }));
  const ledgerSnapshot = vi.fn(async () => ({ ok: true as const, data: snapshot }));
  const ledgerExport = vi.fn(async () => ({ ok: true as const, data: { path: 'C:\\fixture\\ledger.csv' } }));
  const api = { ledgerSnapshot, ledgerMutate, ledgerExport, onChanged: () => () => {} } as unknown as DesktopAPI;
  const view = render(<LedgerPage api={api} host={api} />);
  return { ...view, api, ledgerMutate, ledgerSnapshot, ledgerExport, snapshot, openNew: () => view.rerender(<LedgerPage api={api} host={api} createRequest={1} />) };
}

describe('local ledger UI', () => {
  it('drills chart categories into real details and keeps actual payment distinct from personal expense', async () => {
    const f = fixture();
    await screen.findByRole('tab', { name: '概览' });
    fireEvent.click(screen.getByRole('button', { name: '查看餐饮明细 ¥12.00' }));
    expect((screen.getByRole('combobox', { name: '分类' }) as HTMLSelectElement).value).toBe('餐饮');
    const row = screen.getByText('午饭').closest('details')!;
    expect(within(row).getByText('¥20.00')).toBeTruthy();
    expect(within(row).getByText('¥12.00')).toBeTruthy();
    expect(within(row).getByText('实际支付')).toBeTruthy();
    expect(within(row).getByText('个人开销')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '导出本月 CSV' }));
    await waitFor(() => expect(f.ledgerExport).toHaveBeenCalledWith({ format: 'csv', month }));
  });

  it('records a real expense with an unknown account without guessing a balance account', async () => {
    const f = fixture(); await screen.findByRole('tab', { name: '概览' }); f.openNew();
    const dialog = screen.getByRole('dialog', { name: '记一笔' });
    fireEvent.change(within(dialog).getByLabelText('项目'), { target: { value: '晚饭' } });
    fireEvent.change(within(dialog).getByLabelText('实际支付（元）'), { target: { value: '18.50' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存账单' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(1));
    expect(f.ledgerMutate.mock.calls[0]![0].changes[0]).toMatchObject({ type: 'putEntry', expectedVersion: null, entry: { title: '晚饭', amountCents: 1850, personalCents: 1850, cashflows: [{ accountId: null, deltaCents: -1850 }] } });
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '已记账');
  });

  it('retries an unconfirmed save with the same operation ID instead of duplicating the expense', async () => {
    const f = fixture(); await screen.findByRole('tab', { name: '概览' });
    f.ledgerMutate.mockRejectedValueOnce(new Error('IPC reply lost')); f.openNew();
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '车费' } });
    fireEvent.change(screen.getByLabelText('实际支付（元）'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    await screen.findAllByText(/尚未确认保存完成/);
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(2));
    expect(f.ledgerMutate.mock.calls[1]![0]).toEqual(f.ledgerMutate.mock.calls[0]![0]);
  });

  it('supplements the account on the same original entry and retains personal share, source, and audit note', async () => {
    const f = fixture(); await screen.findByText('午饭');
    const row = screen.getByText('午饭').closest('details')!; fireEvent.click(row.querySelector('summary')!);
    fireEvent.click(within(row).getByRole('button', { name: '补充账户 / 更正' }));
    const dialog = screen.getByRole('dialog', { name: '更正账单' });
    fireEvent.change(within(dialog).getByLabelText('支付账户'), { target: { value: 'alipay' } });
    fireEvent.change(within(dialog).getByLabelText('更正说明'), { target: { value: '补充账户为支付宝' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更正' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(1));
    expect(f.ledgerMutate.mock.calls[0]![0].changes[0]).toMatchObject({ type: 'putEntry', expectedVersion: 1, note: '补充账户为支付宝', entry: { id: 'lunch', personalCents: 1200, amountCents: 2000, sourceId: 'old-source', sourceKey: 'old-001', cashflows: [{ accountId: 'alipay', deltaCents: -2000 }] } });
  });

  it('keeps duplicate clarification visible after refreshing and only proceeds after explicit verification', async () => {
    const f = fixture(); await screen.findByRole('tab', { name: '概览' }); f.openNew();
    f.ledgerMutate.mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: '已有相同日期、项目和金额的“午饭”，请先确认是否确实是另一笔', retryable: false } });
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '午饭' } });
    fireEvent.change(screen.getByLabelText('实际支付（元）'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    const confirm = await screen.findByLabelText('我已核对，这是另一笔真实交易');
    await waitFor(() => expect(f.ledgerSnapshot).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText(/已有相同日期/).length).toBeGreaterThan(0);
    fireEvent.click(confirm); fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(2));
    expect(f.ledgerMutate.mock.calls[1]![0].changes[0]).toMatchObject({ confirmDuplicate: true });
  });

  it('allows a pure personal expense adjustment without inventing a payment', async () => {
    const f = fixture(); await screen.findByRole('tab', { name: '概览' }); f.openNew();
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'adjustment' } });
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '核对个人承担' } });
    const original = screen.getByLabelText('原消费（按住 Ctrl 可选多笔）') as HTMLSelectElement;
    original.options[0]!.selected = true; fireEvent.change(original);
    fireEvent.change(screen.getByLabelText('冲减原消费个人开销（元）'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(1));
    expect(f.ledgerMutate.mock.calls[0]![0].changes[0]).toMatchObject({ entry: { kind: 'adjustment', amountCents: 0, personalCents: 0, cashflows: [], adjustments: [{ targetEntryIds: ['lunch'], amountCents: 200 }] } });
  });

  it('keeps an unknown AA personal share null and requires a real original expense before adjustment', async () => {
    const f = fixture(); await screen.findByRole('tab', { name: '概览' }); f.openNew();
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '聚餐代付' } });
    fireEvent.change(screen.getByLabelText('实际支付（元）'), { target: { value: '100' } });
    fireEvent.click(screen.getByLabelText('个人承担金额还不明确（例如 AA 比例待定）'));
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(1));
    expect(f.ledgerMutate.mock.calls[0]![0].changes[0]).toMatchObject({ entry: { personalCents: null } });
    f.rerender(<LedgerPage api={f.api} host={f.api} createRequest={2} />);
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'refund' } });
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: '退款' } });
    fireEvent.change(screen.getByLabelText('实际收到（元）'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('冲减原消费个人开销（元）'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账单' }));
    expect(await screen.findByText(/冲减个人开销时，请选择原消费/)).toBeTruthy();
    expect(f.ledgerMutate).toHaveBeenCalledTimes(1);
  });

  it('voids an entry only with an explicit reason and records a balance snapshot separately from income', async () => {
    const f = fixture(); await screen.findByText('午饭');
    const row = screen.getByText('午饭').closest('details')!; fireEvent.click(row.querySelector('summary')!);
    fireEvent.click(within(row).getByRole('button', { name: '作废' }));
    fireEvent.change(screen.getByLabelText('作废说明'), { target: { value: '误记了' } });
    fireEvent.click(screen.getByRole('button', { name: '确认作废' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(1));
    expect(f.ledgerMutate.mock.calls[0]![0].changes).toEqual([{ type: 'voidEntry', id: 'lunch', expectedVersion: 1, note: '误记了' }]);
    fireEvent.click(screen.getByRole('tab', { name: '账户' }));
    fireEvent.click(screen.getAllByRole('button', { name: '核对余额' })[0]!);
    fireEvent.change(screen.getByLabelText('账户实际余额（元）'), { target: { value: '123.45' } });
    fireEvent.click(screen.getByRole('button', { name: '保存余额快照' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(2));
    expect(f.ledgerMutate.mock.calls[1]![0].changes[0]).toMatchObject({ type: 'setBalance', snapshot: { accountId: 'alipay', balanceCents: 12345 } });
  });

  it('edits explicit allowance and family rules while preserving unknown real remaining amount', async () => {
    const f = fixture(); await screen.findByRole('tab', { name: '规则' });
    fireEvent.click(screen.getByRole('tab', { name: '规则' }));
    expect((screen.getByLabelText('新记交易与余额核对的先后') as HTMLSelectElement).value).toBe('after');
    fireEvent.change(screen.getByLabelText('每月金额（元）'), { target: { value: '1200' } });
    fireEvent.change(screen.getByLabelText('规则修改说明'), { target: { value: '生活费调整' } });
    fireEvent.click(screen.getByRole('button', { name: '保存记账规则' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(1));
    expect(f.ledgerMutate.mock.calls[0]![0].changes[0]).toMatchObject({ type: 'updateRules', note: '生活费调整', rules: { sameDayNewEntryOrder: 'after', monthlyAllowance: { amountCents: 120000, accountId: null }, familyActualRemainingCents: null, familyRefreshDay: null } });
  });

  it('saves the balance ordering preference without changing other bookkeeping rules', async () => {
    const f = fixture(); await screen.findByRole('tab', { name: '规则' });
    fireEvent.click(screen.getByRole('tab', { name: '规则' }));
    fireEvent.change(screen.getByLabelText('新记交易与余额核对的先后'), { target: { value: 'ask' } });
    fireEvent.change(screen.getByLabelText('规则修改说明'), { target: { value: '以后先核对余额先后' } });
    fireEvent.click(screen.getByRole('button', { name: '保存记账规则' }));
    await waitFor(() => expect(f.ledgerMutate).toHaveBeenCalledTimes(1));
    expect(f.ledgerMutate.mock.calls[0]![0].changes).toEqual([{ type: 'updateRules', note: '以后先核对余额先后', rules: { ...f.snapshot.rules, sameDayNewEntryOrder: 'ask' } }]);
  });
});
