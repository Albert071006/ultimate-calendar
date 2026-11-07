import { describe, expect, it } from 'vitest';
import type { CommandRequest } from './contracts';
import { isLedgerClarificationAnswer, pendingClarificationHistory, pendingUserEvidence } from './command-continuation';

type History = NonNullable<CommandRequest['history']>;
const chain: History = [
  { role: 'user', text: '已付款，帮我记合成礼物，用杭州银行' },
  { role: 'assistant', text: '实际付了多少？', outcome: { domain: 'ledger', phase: 'clarification' } },
  { role: 'user', text: '80元' },
  { role: 'assistant', text: '全部由你承担吗？', outcome: { domain: 'ledger', phase: 'clarification' } },
];

describe('pending command clarification chains', () => {
  it('retains the original request and every answer but stops at completed actions', () => {
    const old: History = [{ role: 'user', text: '撤销以前那笔' }, { role: 'assistant', text: '已撤销', outcome: { domain: 'ledger', phase: 'saved' } }];
    const request = { text: '是', history: [...old, ...chain] };
    expect(pendingClarificationHistory(request)).toEqual(chain);
    expect(pendingUserEvidence(request)).toBe('已付款，帮我记合成礼物，用杭州银行\n80元\n是');
    expect(pendingUserEvidence(request)).not.toContain('撤销');
    expect(pendingUserEvidence(request)).not.toContain('全部由你承担');
  });

  it('includes a prior calendar-to-ledger clarification without using assistant examples as evidence', () => {
    const history: History = [
      { role: 'user', text: '合成礼物80支付宝' },
      { role: 'assistant', text: '记账还是日历？比如中国银行也可记账。', outcome: { domain: 'calendar', phase: 'clarification' } },
      { role: 'user', text: '记账' },
      { role: 'assistant', text: '个人承担多少？', outcome: { domain: 'ledger', phase: 'clarification' } },
    ];
    expect(pendingClarificationHistory({ text: '80', history })).toEqual(history);
    expect(pendingUserEvidence({ text: '80', history })).toBe('合成礼物80支付宝\n记账\n80');
  });

  it.each(['saved', 'query', 'preview'] as const)('does not resume a %s outcome', phase => {
    const history: History = [...chain.slice(0, 2), { role: 'user', text: '已补全' }, { role: 'assistant', text: '完成', outcome: { domain: 'ledger', phase } }];
    expect(pendingClarificationHistory({ text: '是', history })).toEqual([]);
    expect(isLedgerClarificationAnswer({ text: '是', history })).toBe(false);
    expect(pendingUserEvidence({ text: '是', history })).toBe('是');
  });

  it('stops at malformed or legacy unmarked history without dropping the immediately pending pair', () => {
    const old: History = [{ role: 'user', text: '旧事项' }, { role: 'assistant', text: '旧回复没有状态' }];
    expect(pendingClarificationHistory({ text: '是', history: [...old, ...chain] })).toEqual(chain);
    expect(pendingClarificationHistory({ text: '是', history: [...chain, { role: 'user', text: '孤立消息' }] })).toEqual([]);
  });

  it('respects explicit topic changes in both the current turn and the pending history', () => {
    for (const text of ['取消', '算了', '换个问题', '另外记早餐10元', '另一个问题', '另一件事']) expect(pendingClarificationHistory({ text, history: chain })).toEqual([]);
    const next: History = [{ role: 'user', text: '另外，记合成车票' }, { role: 'assistant', text: '金额多少？', outcome: { domain: 'ledger', phase: 'clarification' } }];
    expect(pendingClarificationHistory({ text: '30', history: [...chain, ...next] })).toEqual(next);
  });

  it.each(['另一笔120元', '另外一笔120元', '另一个账户是微信'])('retains the pending allocation or account context for %s', text => {
    expect(pendingClarificationHistory({ text, history: chain })).toEqual(chain);
    expect(pendingUserEvidence({ text, history: chain })).toBe(`已付款，帮我记合成礼物，用杭州银行\n80元\n${text}`);
    const continued: History = [...chain, { role: 'user', text }, { role: 'assistant', text: '请确认已到账', outcome: { domain: 'ledger', phase: 'clarification' } }];
    expect(pendingClarificationHistory({ text: '是', history: continued })).toEqual(continued);
  });

  it.each(['是', '确认', '都是不同笔', '第一个', '80', '80元', '一共80元', '支付宝', '用微信', '杭州银行', '中国银行尾号1234', '14 支付宝', '微信 14元'])('routes the unambiguous short answer %s only to the ledger parser', text => {
    expect(isLedgerClarificationAnswer({ text, history: chain })).toBe(true);
  });

  it.each(['取消', '不用了', '今天有课吗', '明天提醒我去银行', '另外再记20元', '不是第一笔', '撤销', '好的，然后删除旧账', '这个怎么回事'])('does not shortcut %s', text => {
    expect(isLedgerClarificationAnswer({ text, history: chain })).toBe(false);
  });

  it('does not route attachment-only or selected-object commands as a plain clarification answer', () => {
    expect(isLedgerClarificationAnswer({ text: '是', history: chain, documents: [{ label: '合成.txt', text: '新内容' }] })).toBe(false);
    expect(isLedgerClarificationAnswer({ text: '是', history: chain, selected: [{ entity: 'task', id: 'a' }] })).toBe(false);
    expect(isLedgerClarificationAnswer({ text: '是', history: chain.slice(0, -1) })).toBe(false);
  });
});
