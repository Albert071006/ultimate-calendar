import { describe, expect, it } from 'vitest';
import type { CommandRequest } from '../shared/contracts';
import { compactLedgerRouteMessages } from './ledger-routing';

describe('compact ledger routing during multi-turn clarification', () => {
  it('keeps purchase, amount and pending account question while excluding a completed old operation', () => {
    const request: CommandRequest = { operationId: 'synthetic-routing', text: '支付宝', history: [
      { role: 'user', text: '撤销合成旧账' }, { role: 'assistant', text: '合成旧撤销已完成', outcome: { domain: 'ledger', phase: 'saved' } },
      { role: 'user', text: '买了合成书，记一笔' }, { role: 'assistant', text: '付了多少？', outcome: { domain: 'ledger', phase: 'clarification' } },
      { role: 'user', text: '42元' }, { role: 'assistant', text: '用哪个账户？', outcome: { domain: 'ledger', phase: 'clarification' } },
    ] };
    const wire = JSON.stringify(compactLedgerRouteMessages(request).slice(1));
    for (const text of ['买了合成书，记一笔', '42元', '用哪个账户？', '支付宝']) expect(wire).toContain(text);
    expect(wire).not.toContain('合成旧撤销');
  });

  it('keeps reimbursement targets and earlier receipt facts for the allocation answer', () => {
    const request: CommandRequest = { operationId: 'synthetic-allocation', text: '两笔各80和120', history: [
      { role: 'user', text: '两张合成车票一共报销200元到微信' },
      { role: 'assistant', text: '是此前A和B两笔吗？', outcome: { domain: 'ledger', phase: 'clarification' } },
      { role: 'user', text: '是' },
      { role: 'assistant', text: '分别报销多少？', outcome: { domain: 'ledger', phase: 'clarification' } },
    ] };
    const wire = JSON.stringify(compactLedgerRouteMessages(request).slice(1));
    for (const text of ['两张合成车票一共报销200元到微信', '是此前A和B两笔吗', '分别报销多少', '两笔各80和120']) expect(wire).toContain(text);
  });
});
