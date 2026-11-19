import { describe, expect, it } from 'vitest';
import { LedgerService } from '../ledger/service';
import { LedgerEntryDraftSchema, type LedgerMutationRequest } from '../shared/ledger';
import { ledgerAmountQuestion } from './ledger-amounts';

const ledger = new LedgerService(':memory:');
const snapshot = ledger.snapshot('2026-01');
ledger.close();
function payment(cents: number, accountId = 'alipay', title = '合成消费'): LedgerMutationRequest['changes'][number] {
  const entry = LedgerEntryDraftSchema.parse({ id: 'synthetic-' + accountId, kind: 'expense', title, category: '其他',
    date: '2026-01-01', month: '2026-01', amountCents: cents, personalCents: cents, cashflows: [{ accountId, deltaCents: -cents }] });
  return { type: 'putEntry', entry, expectedVersion: null, note: '', confirmDuplicate: false };
}
const check = (text: string, cents: number) => ledgerAmountQuestion({ operationId: 'synthetic-check', text }, [payment(cents)], snapshot);

describe('user-stated ledger amounts', () => {
  it.each([
    ['合成费用1万到支付宝', 1000000], ['合成费用2万3千', 2300000], ['合成付款三块五', 350],
    ['合成付款一元五角二分', 152], ['合成付款一千二', 120000], ['合成付款一千零二', 100200],
    ['合成付款1,234.19元', 123419], ['11月2日18点30分用尾号2345的银行卡付款73.16', 7316],
    ['原价80优惠10，实付70', 7000], ['原价80优惠10', 7000], ['10美元，折合人民币72.36', 7236],
  ] as const)('keeps exact units independently of the AI (%s)', (text, cents) => {
    expect(check(text, cents)).toBeUndefined();
    expect(check(text, 100)).toBeTruthy();
  });
  it('asks for the actual RMB amount when only foreign currency, a list price, or an identifier is stated', () => {
    for (const text of ['支付12美元', '合成消费原价90元', '合成消费用尾号2345的银行卡']) expect(check(text, 1200)).toBeTruthy();
  });
  it.each([false, true])('matches a split payment to its actual accounts (swapped=%s)', swapped => {
    const change = payment(10000);
    if (change.type !== 'putEntry') throw new Error('Expected a payment');
    change.entry.cashflows = [{ accountId: 'alipay', deltaCents: swapped ? -2000 : -8000 }, { accountId: 'wechat', deltaCents: swapped ? -8000 : -2000 }];
    const question = ledgerAmountQuestion({ operationId: 'synthetic-split', text: '合成消费实付100元，微信20元，支付宝80元' }, [change], snapshot);
    expect(!!question).toBe(swapped);
  });
  it('checks separate payments even when one uses the words 实付', () => {
    expect(check('合成午饭实付20，合成晚饭30', 2000)).toBeTruthy();
  });
  it('ties each amount to its uniquely named account even when proposal order changes', () => {
    const request = { operationId: 'synthetic-batch', text: '第一项支出19元微信，第二项支出23元支付宝' };
    expect(ledgerAmountQuestion(request, [payment(2300), payment(1900, 'wechat')], snapshot)).toBeUndefined();
    expect(ledgerAmountQuestion(request, [payment(1900), payment(2300, 'wechat')], snapshot)).toBeTruthy();
  });
});
