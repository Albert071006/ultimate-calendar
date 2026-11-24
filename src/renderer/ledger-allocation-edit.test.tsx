// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, type LedgerEntry } from '../shared/ledger';
import { ledgerReceivable } from '../ledger/receivable';
import { summarizeLedger } from '../ledger/summary';
import { EntryEditor, type Change } from './components/ledger/editors';

afterEach(cleanup);
const month = '2026-05', stamp = '2026-05-01T12:00:00+08:00';
function expense(id: string, amountCents: number, personalCents: number): LedgerEntry {
  return LedgerEntrySchema.parse({ id, title: id, kind: 'expense', category: '差旅', date: '2026-05-01', month, amountCents, personalCents,
    cashflows: [{ accountId: 'wechat', deltaCents: -amountCents }], version: 1, createdAt: stamp, updatedAt: stamp });
}
function edit(entry: LedgerEntry, entries = [entry]) {
  const save = vi.fn(async (_changes: Change[]) => true);
  const snapshot = { revision: 1, entries, accounts: undefined, audit: [], sources: [], balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES,
    summary: summarizeLedger({ entries, balanceSnapshots: [] }, { month }) };
  render(<EntryEditor entry={entry} snapshot={snapshot} busy={false} error="" save={save} close={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('更正说明'), { target: { value: '合成更正' } });
  return save;
}
const setField = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: '保存更正' }));
function savedEntry(save: ReturnType<typeof edit>) {
  expect(save).toHaveBeenCalledTimes(1);
  const change = save.mock.calls[0]![0][0]!;
  if (change.type !== 'putEntry') throw Error('Expected the edited ledger entry');
  return change.entry;
}

it('retains the expense adjustment and the separate settled advance when only a reimbursement note changes', () => {
  const personal = expense('合成个人消费', 1000, 1000), advance = expense('合成代垫', 2000, 0);
  const receipt = LedgerEntrySchema.parse({ ...expense('合成报销', 3000, 0), kind: 'reimbursement', cashflows: [{ accountId: 'alipay', deltaCents: 3000 }],
    relatedEntryIds: [personal.id, advance.id], adjustments: [{ targetEntryIds: [personal.id], amountCents: 1000, note: '已核实的个人部分' }], counterparty: '合成单位' });
  expect(ledgerReceivable([personal, advance, receipt], month).cents).toBe(0);
  const save = edit(receipt, [personal, advance, receipt]);
  setField('备注', '只补充备注');
  submit();
  const after = savedEntry(save);
  const { version, createdAt, updatedAt, voided, sameDayBalanceOrder, ...originalDraft } = receipt;
  expect(after).toEqual({ ...originalDraft, note: '只补充备注' });
  expect(ledgerReceivable([personal, advance, { ...receipt, ...after }], month).cents).toBe(0);
});

it('edits one adjustment without regrouping any other allocation or rewriting the linked advance', () => {
  const first = expense('合成甲', 1000, 1000), second = expense('合成乙', 1500, 1500), advance = expense('合成代付', 2000, 0);
  const receipt = LedgerEntrySchema.parse({ ...expense('合成组合报销', 4500, 0), kind: 'reimbursement', cashflows: [{ accountId: 'alipay', deltaCents: 4500 }],
    relatedEntryIds: [advance.id], adjustments: [
      { targetEntryIds: [first.id], amountCents: 1000, note: '第一项' }, { targetEntryIds: [second.id], amountCents: 1500, note: '第二项' },
    ] });
  const save = edit(receipt, [first, second, advance, receipt]);
  setField('第 2 项冲减金额（元）', '12');
  submit();
  const after = savedEntry(save);
  expect(after.relatedEntryIds).toEqual([advance.id]);
  expect(after.adjustments).toEqual([receipt.adjustments[0], { ...receipt.adjustments[1], amountCents: 1200 }]);
});

it('keeps the original cashflow allocation when only editing metadata', () => {
  const entry = expense('合成拆分付款', 10000, 8000);
  entry.cashflows = [{ accountId: 'wechat', deltaCents: -6000 }, { accountId: null, deltaCents: -4000 }];
  const save = edit(entry);
  setField('备注', '分项账户稍后核对');
  submit();
  expect(savedEntry(save).cashflows).toEqual(entry.cashflows);
});

it('requires allocations to sum to the edited expense and preserves the individual accounts', () => {
  const entry = expense('合成拆分付款', 10000, 8000);
  entry.cashflows = [{ accountId: 'wechat', deltaCents: -6000 }, { accountId: 'alipay', deltaCents: -4000 }];
  const save = edit(entry);
  setField('实际支付（元）', '90');
  submit();
  expect(screen.getByRole('alert').textContent).toContain('分项合计须等于实际金额');
  expect(save).not.toHaveBeenCalled();
  setField('第 2 项金额（元）', '30');
  submit();
  expect(savedEntry(save)).toMatchObject({ amountCents: 9000, personalCents: 8000, cashflows: [
    { accountId: 'wechat', deltaCents: -6000 }, { accountId: 'alipay', deltaCents: -3000 },
  ] });
});

it('preserves each side of a split transfer when correcting its total', () => {
  const entry = LedgerEntrySchema.parse({ ...expense('合成转账', 10000, 0), kind: 'transfer', cashflows: [
    { accountId: 'alipay', deltaCents: 10000 }, { accountId: 'wechat', deltaCents: -6000 }, { accountId: 'cmb', deltaCents: -4000 },
  ] });
  const save = edit(entry);
  setField('转账金额（元）', '90');
  setField('第 1 项金额（元）', '90');
  submit();
  expect(screen.getByRole('alert').textContent).toContain('转出分项和转入分项');
  expect(save).not.toHaveBeenCalled();
  setField('第 3 项金额（元）', '30');
  submit();
  expect(savedEntry(save).cashflows).toEqual([
    { accountId: 'alipay', deltaCents: 9000 }, { accountId: 'wechat', deltaCents: -6000 }, { accountId: 'cmb', deltaCents: -3000 },
  ]);
});
