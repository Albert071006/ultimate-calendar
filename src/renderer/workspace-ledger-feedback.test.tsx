// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LedgerError, LedgerService } from '../ledger/service';
import type { PlannerClient } from '../shared/client';
import { SnapshotSchema, TaskSchema, type ApiResult, type ChangedEvent, type MutationResult } from '../shared/contracts';
import { App } from './App';
import { todayDate } from './calendar-layout';
import { MobileApp } from './mobile/MobileApp';

const ledgers: LedgerService[] = [];
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const ledger of ledgers.splice(0)) ledger.close();
});

function setup(device: 'desktop' | 'phone') {
  const ledger = new LedgerService(':memory:');
  ledgers.push(ledger);
  const stamp = '2026-10-20T12:00:00+08:00';
  const planner = SnapshotSchema.parse({
    schemaVersion: 1, sources: [], candidates: [], tasks: [TaskSchema.parse({
      id: 'synthetic-task', title: '合成待办', version: 1, createdAt: stamp, updatedAt: stamp,
    })], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {},
    journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false },
  });
  const applied = (message: string): ApiResult<MutationResult> => ({
    ok: true, data: { status: 'applied', message, transactionId: 'synthetic-planner-transaction', changes: [], conflicts: [] },
  });
  const listeners = new Set<(event: ChangedEvent) => void>();
  const undo = vi.fn<PlannerClient['undo']>().mockResolvedValue(applied('已撤销合成待办'));
  const ledgerMutate = vi.fn<PlannerClient['ledgerMutate']>(async request => ({ ok: true, data: ledger.mutate(request) }));
  const ledgerUndo = vi.fn<PlannerClient['ledgerUndo']>(async request => {
    try { return { ok: true, data: ledger.undo(request) }; }
    catch (error) {
      if (!(error instanceof LedgerError) || error.code !== 'CONFLICT') throw error;
      return { ok: false, error: { code: error.code, message: error.message, retryable: false } };
    }
  });
  const ledgerExportData = vi.fn<NonNullable<PlannerClient['ledgerExportData']>>().mockResolvedValue({
    ok: true, data: { format: 'csv', content: '项目,金额\n合成装订,3.00' },
  });
  const client: PlannerClient = {
    snapshot: async () => ({ ok: true, data: planner }), changes: vi.fn(), command: vi.fn(), analyzeSource: vi.fn(), importSource: vi.fn(),
    mutate: async () => applied('已完成合成待办，可撤销'), undo,
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ledgerSnapshot: async request => ({ ok: true, data: ledger.snapshot(request?.month) }), ledgerMutate, ledgerUndo, ledgerExportData,
  };
  if (device === 'desktop') render(<App client={client} />);
  else render(<MobileApp client={client} connection={{ status: 'online', pending: [], cachedAt: null, storageError: '' }} />);
  return { ledger, undo, ledgerMutate, ledgerUndo, ledgerExportData, refreshLedger: () => {
    for (const listener of listeners) listener({ reason: 'mutation', domains: ['ledger'] });
  } };
}

function navigate(name: '今天' | '账单') {
  fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name }));
}
async function enterExpense() {
  await screen.findByRole('tabpanel', { name: '收支' });
  fireEvent.click(screen.getAllByRole('button', { name: '记一笔' })[0]!);
  const form = within(screen.getByRole('dialog', { name: '记一笔' }));
  fireEvent.change(form.getByLabelText('项目'), { target: { value: '合成装订' } });
  fireEvent.change(form.getByLabelText('实际支付（元）'), { target: { value: '3.00' } });
  fireEvent.click(form.getByRole('button', { name: '保存账单' }));
}
async function receipt(text: string) {
  const notice = (await screen.findByText(text)).closest<HTMLElement>('[role="status"]');
  expect(notice).toBeTruthy();
  return within(notice!);
}

it.each(['desktop', 'phone'] as const)('%s keeps the receipt tied to its own undo stack after navigation', async device => {
  const f = setup(device);
  navigate('今天');
  fireEvent.click(await screen.findByRole('checkbox', { name: '完成 合成待办' }));
  const planner = await receipt('已完成合成待办');
  navigate('账单');
  await screen.findByRole('tabpanel', { name: '收支' });
  fireEvent.click(planner.getByRole('button', { name: '撤销' }));
  await receipt('已撤销合成待办');
  expect(f.undo).toHaveBeenCalledExactlyOnceWith('synthetic-planner-transaction');
  expect(f.ledgerUndo).not.toHaveBeenCalled();

  await enterExpense();
  const saved = await receipt('已保存并核对本地账本');
  const { revision, summary } = f.ledger.snapshot();
  expect(f.ledgerMutate.mock.calls[0]?.[0].expectedRevision).toBe(revision - 1);
  navigate('今天');
  fireEvent.click(saved.getByRole('button', { name: '撤销' }));
  expect((await receipt('已撤销上一次账本操作')).queryByRole('button', { name: '撤销' })).toBeNull();
  expect(f.ledgerUndo).toHaveBeenCalledExactlyOnceWith({ expectedRevision: revision, month: summary.month, operationId: expect.any(String) });
  expect(f.ledger.snapshot().entries).toHaveLength(0);
  expect(f.undo).toHaveBeenCalledTimes(1);
});

it.each(['desktop', 'phone'] as const)('%s protects a newer ledger change and keeps the conflict visible until dismissed', async device => {
  const f = setup(device);
  navigate('账单'); await enterExpense();
  const saved = await receipt('已保存并核对本地账本');
  const { revision, rules } = f.ledger.snapshot();
  f.ledger.mutate({ expectedRevision: revision, operationId: 'synthetic-second-write',
    changes: [{ type: 'updateRules', rules: { ...rules, notes: '合成并发修改' }, note: '合成规则说明' }] });
  await act(async () => { f.refreshLedger(); });
  navigate('今天');
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(saved.getByRole('button', { name: '撤销' })); });
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toContain('账本已更新');
  expect(f.ledgerUndo.mock.calls[0]?.[0].expectedRevision).toBe(revision);
  expect(f.ledger.snapshot().rules.notes).toBe('合成并发修改');
  act(() => { vi.advanceTimersByTime(5_000); });
  expect(screen.getByRole('alert')).toBe(alert);
  fireEvent.click(within(alert).getByRole('button', { name: /关闭/ }));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not offer the newer operation for undo when a retried save acknowledges an older receipt', async () => {
  const f = setup('desktop');
  f.ledgerMutate.mockImplementationOnce(async request => {
    f.ledger.mutate(request);
    throw new Error('Synthetic lost response');
  });
  navigate('账单'); await enterExpense();
  const form = within(screen.getByRole('dialog', { name: '记一笔' }));
  expect((await form.findByRole('alert')).textContent).toContain('尚未确认保存完成');
  const { revision, rules } = f.ledger.snapshot();
  f.ledger.mutate({ expectedRevision: revision, operationId: 'synthetic-newer-rule',
    changes: [{ type: 'updateRules', rules: { ...rules, notes: '合成规则更新' }, note: '合成规则说明' }] });
  fireEvent.click(form.getByRole('button', { name: '保存账单' }));
  const retried = await receipt('此前已保存，本次重试未重复记账');
  expect(await f.ledgerMutate.mock.results[1]!.value).toMatchObject({ ok: true, data: { status: 'already_saved', undoAvailable: true } });
  expect(f.ledger.snapshot().audit.at(-1)?.operationId).toBe('synthetic-newer-rule');
  expect(retried.queryByRole('button', { name: '撤销' })).toBeNull();
  expect(screen.getByRole('button', { name: '撤销账单操作' })).toHaveProperty('disabled', false);
});

it('shows phone CSV downloads and queued ledger saves without offering the previous undo', async () => {
  const f = setup('phone');
  navigate('账单'); await enterExpense();
  const saved = await receipt('已保存并核对本地账本');
  expect(saved.getByRole('button', { name: '撤销' })).toBeTruthy();
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-export');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByRole('button', { name: '账单选项' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '导出本月 CSV' }));
  expect((await receipt('已开始下载本月 CSV')).queryByRole('button', { name: '撤销' })).toBeNull();
  const month = todayDate().slice(0, 7);
  expect(f.ledgerExportData).toHaveBeenCalledExactlyOnceWith({ format: 'csv', month });
  expect(click.mock.contexts[0]).toHaveProperty('download', `账本-${month}.csv`);
  expect(await (createUrl.mock.calls[0]![0] as Blob).text()).toContain('合成装订,3.00');
  f.ledgerMutate.mockResolvedValueOnce({ ok: true, data: { status: 'queued', requestId: 'synthetic-draft', message: '已暂存，等待同步' } });
  await enterExpense();
  expect((await receipt('已暂存，等待同步')).queryByRole('button', { name: '撤销' })).toBeNull();
  expect(f.ledgerUndo).not.toHaveBeenCalled();
});
