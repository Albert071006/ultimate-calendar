import { describe, expect, it } from 'vitest';
import { LEDGER_CATEGORY_SUGGESTIONS, ledgerCategorySuggestions } from '../shared/ledger-categories';
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, type LedgerSnapshot } from '../shared/ledger';
import { LedgerService } from '../ledger/service';
import { ledgerContext, ledgerMessages } from './ledger';

const now = '2026-10-23T21:30:00+08:00';
function snapshot(): LedgerSnapshot {
  const ledger = new LedgerService(':memory:', { now: () => new Date(now) });
  try { return ledger.snapshot('2026-10'); } finally { ledger.close(); }
}

describe('open ledger categories', () => {
  it('offers common choices in an empty ledger and retains custom names without creating entries', () => {
    expect(ledgerCategorySuggestions([])).toEqual(LEDGER_CATEGORY_SUGGESTIONS);
    const entries = [{ category: '餐饮' }, { category: '  合成赛事材料 ' }, { category: '合成赛事材料' }, { category: '' }];
    expect(ledgerCategorySuggestions(entries)).toEqual([...LEDGER_CATEGORY_SUGGESTIONS, '合成赛事材料']);
    expect(entries[1]!.category).toBe('  合成赛事材料 ');
  });

  it('keeps history separate from stable category guidance and accepts names outside suggestions', () => {
    const empty = snapshot();
    const meal = LedgerEntrySchema.parse({ id: 'synthetic-meal', kind: 'expense', date: '2026-10-23', month: '2026-10', title: '合成早餐', category: '餐饮',
      amountCents: 800, personalCents: 800, cashflows: [{ accountId: 'alipay', deltaCents: -800 }], version: 1, createdAt: now, updatedAt: now });
    const custom = LedgerEntrySchema.parse({ ...meal, id: 'synthetic-material', title: '合成材料', category: '合成赛事材料' });
    const request = { operationId: 'synthetic-categories', text: '快递费12元支付宝' };
    const emptyContext = ledgerContext(empty, request, now);
    const onlyMeals = ledgerContext({ ...empty, entries: [meal] }, request, now);
    const withCustom = ledgerContext({ ...empty, rules: { ...DEFAULT_LEDGER_RULES, notes: '合成赛事材料统一归合成赛事材料' }, entries: [meal, custom] }, request, now);
    expect(emptyContext.categories).toEqual([]);
    expect(onlyMeals.categories).toEqual(['餐饮']);
    expect(withCustom.categories).toEqual(['餐饮', '合成赛事材料']);
    const system = ledgerMessages(onlyMeals, request)[0]!;
    expect(ledgerMessages(emptyContext, request)[0]).toEqual(system);
    expect(ledgerMessages(withCustom, request)[0]).toEqual(system);
    expect(system.content).toContain('不是白名单');
    expect(system.content).toContain('无需createCategory');
    expect(system.content).toContain('“快递费12元支付宝”应归快递物流');
    expect(system.content).toContain('不能只看到“快递”一词就机械归为快递物流');
    expect(system.content).toContain('更正金额时保留原分类');
    expect(system.content).toContain('信息不足时用其他，不默认餐饮');
  });
});
