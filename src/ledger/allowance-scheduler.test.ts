import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLedgerService, type LedgerService } from './service';
import { startAllowanceScheduler } from './allowance-scheduler';

const cleanup: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T15:59:50Z')); });
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.useRealTimers(); });
function fixture(enabled = true, startMonth = '2026-11') {
  const ledger = createLedgerService(':memory:'); cleanup.push(() => ledger.close());
  ledger.mutate({ operationId: 'synthetic-rule', expectedRevision: 0, changes: [{ type: 'updateRules', rules: {
    ...ledger.snapshot().rules, monthlyAllowance: { enabled, amountCents: 100000, accountId: 'alipay', startMonth },
  }, note: '合成规则' }] });
  const onChanged = vi.fn(), onError = vi.fn();
  const scheduler = startAllowanceScheduler({ ledger, onChanged, onError }); cleanup.push(scheduler.stop);
  return { ledger, scheduler, onChanged, onError };
}
describe('automatic monthly allowance', () => {
  it('records the Beijing month boundary without a page read and adds the amount to the configured account once', () => {
    const { ledger, onChanged, onError } = fixture();
    ledger.mutate({ operationId: 'synthetic-balance', expectedRevision: 1, changes: [{ type: 'setBalance', snapshot: {
      id: 'synthetic-alipay', accountId: 'alipay', date: '2026-10-31', asOf: '2026-10-31T15:00:00Z', balanceCents: 1234, coveredEntryIds: [], sourceId: null, note: '合成余额',
    } }] });
    expect(ledger.snapshot().entries).toEqual([]);
    vi.advanceTimersByTime(30_000);
    expect(ledger.snapshot().entries).toMatchObject([{ ruleKey: 'rule:monthly-allowance:2026-11', date: '2026-11-01', cashflows: [{ accountId: 'alipay', deltaCents: 100000 }] }]);
    expect(ledger.snapshot().summary.accounts.find(a => a.id === 'alipay')?.balanceCents).toBe(101234);
    const revision = ledger.snapshot().revision;
    vi.advanceTimersByTime(90_000);
    expect(ledger.snapshot().revision).toBe(revision);
    expect(onChanged).toHaveBeenCalledTimes(1); expect(onError).not.toHaveBeenCalled();
  });
  it('checks on startup and after sleep, respects disabled months and does not recreate an undone month', () => {
    const { ledger, scheduler, onChanged } = fixture(false);
    vi.advanceTimersByTime(30_000); expect(ledger.snapshot().entries).toEqual([]);
    ledger.mutate({ operationId: 'enable', expectedRevision: ledger.snapshot().revision, changes: [{ type: 'updateRules', rules: {
      ...ledger.snapshot().rules, monthlyAllowance: { ...ledger.snapshot().rules.monthlyAllowance, enabled: true },
    }, note: '恢复合成规则' }] });
    vi.advanceTimersByTime(30_000);
    ledger.undo({ operationId: 'undo-november', expectedRevision: ledger.snapshot().revision });
    vi.advanceTimersByTime(30_000); expect(ledger.snapshot().entries).toEqual([]);
    vi.setSystemTime(new Date('2026-12-01T02:00:00Z'));
    scheduler.check(); expect(ledger.snapshot().entries.map(e => e.month)).toEqual(['2026-12']);
    scheduler.stop();
    const restarted = startAllowanceScheduler({ ledger, onChanged, onError: vi.fn() }); cleanup.push(restarted.stop);
    expect(ledger.snapshot().entries.map(e => e.month)).toEqual(['2026-12']);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
  it('defers busy writes, retries failed checks and cancels cleanly on shutdown', () => {
    const ensure = vi.fn<LedgerService['ensureMonthlyAllowance']>().mockImplementationOnce(() => { throw Error('synthetic storage failure'); }).mockReturnValue(null);
    let idle = false;
    const onError = vi.fn();
    const scheduler = startAllowanceScheduler({ ledger: { ensureMonthlyAllowance: ensure }, isIdle: () => idle, onChanged: vi.fn(), onError }); cleanup.push(scheduler.stop);
    vi.advanceTimersByTime(30_000); expect(ensure).not.toHaveBeenCalled();
    idle = true; vi.advanceTimersByTime(30_000); expect(onError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000); expect(ensure).toHaveBeenCalledTimes(2);
    scheduler.stop(); vi.advanceTimersByTime(60_000); scheduler.check(); expect(ensure).toHaveBeenCalledTimes(2);
  });
});
