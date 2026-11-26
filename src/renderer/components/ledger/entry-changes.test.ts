import { expect, it } from 'vitest';
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, type LedgerSnapshot } from '../../../shared/ledger';
import { summarizeLedger } from '../../../ledger/summary';
import { summarizeEntryChanges } from './entry-changes';

const month = '2026-03', date = '2026-03-01', stamp = `${date}T08:00:00+08:00`;
const original = LedgerEntrySchema.parse({ id: 'fixture', title: '合成材料', kind: 'expense', category: '材料', amountCents: 260,
  personalCents: null, cashflows: [{ accountId: null, deltaCents: -260 }], month, date, version: 1, createdAt: stamp, updatedAt: stamp });
const snapshot: LedgerSnapshot = { revision: 1, entries: [original], audit: [], sources: [], balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES,
  accounts: [{ id: 'sample', name: '示例账户', kind: 'cash', aliases: [] }], summary: summarizeLedger({ entries: [original], balanceSnapshots: [] }, { month }) };

it('uses the local account label and distinguishes actual amounts from a pending personal share', () => {
  const next = { ...original, amountCents: 300, cashflows: [{ accountId: 'sample', deltaCents: -300 }] };
  expect(summarizeEntryChanges(original, next, snapshot)).toBe('修改：支付账户 待确认 → 示例账户；金额 2.60 → 3.00');
  expect(summarizeEntryChanges(next, { ...next, personalCents: 0 }, snapshot)).toBe('修改：个人开销 待确认 → 0.00');
});

it('names changes to the transaction, month, date explanation, party and accounting classification', () => {
  const before = { ...original, kind: 'reimbursement' as const, incomeCents: 260, personalCents: 0,
    cashflows: [{ accountId: 'sample', deltaCents: 260 }], date: null, dateNote: '合成日期待核实', counterparty: '合成甲' };
  const after = { ...before, kind: 'asset_sale' as const, title: '合成变现', category: '旧物', date: '2026-04-01', month: '2026-04',
    dateNote: '', incomeCents: 0, assetSaleCents: 260, counterparty: '合成乙', note: '长备注'.repeat(5000) };
  expect(summarizeEntryChanges(before, after, snapshot)).toBe('修改：类型 费用报销 → 资产变现；项目 合成材料 → 合成变现；分类 材料 → 旧物；发生日期 2026-03（日期待确认） → 2026-04-01；日期说明 合成日期待核实 → 无；对方 合成甲 → 合成乙；额外收入 2.60 → 0.00；资产变现 0.00 → 2.60；修改备注');
  expect(summarizeEntryChanges(before, { ...before, month: '2026-04' }, snapshot)).toBe('修改：发生月份 2026-03（日期待确认） → 2026-04（日期待确认）');
});

it('distinguishes equal-title targets and disregards ordering in links and split payments', () => {
  const other = { ...original, id: 'fixture-2' };
  const data = { ...snapshot, entries: [original, other] };
  const before = { ...original, id: 'returned', kind: 'refund' as const, personalCents: 0, relatedEntryIds: [original.id], cashflows: [{ accountId: 'sample', deltaCents: 160 }, { accountId: null, deltaCents: 100 }] };
  expect(summarizeEntryChanges(before, { ...before, relatedEntryIds: [other.id] }, data))
    .toBe('修改：关联原消费 合成材料（fixture） → 合成材料（fixture-2）');
  const both = { ...before, relatedEntryIds: [original.id, other.id] };
  expect(summarizeEntryChanges(both, { ...both, relatedEntryIds: [...both.relatedEntryIds].reverse(), cashflows: [...both.cashflows].reverse() }, data))
    .toBe('手工核对保存');
});
