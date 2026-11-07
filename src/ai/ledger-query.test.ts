import { describe, expect, it } from 'vitest';
import { CommandRequestSchema, ConversationStateSchema, type CommandRequest } from '../shared/contracts';
import { LedgerQueryChoicesSchema, type LedgerQuery, type LedgerQueryChoice } from '../shared/ledger';
import { ledgerQueryRangeDescription, ledgerQueryScopeDescription, normalizeLedgerQueryScope, resolveLedgerQueryChoice } from './ledger-query';

const choices: LedgerQueryChoice[] = [
  { label: '仅备注里的生日消费', query: { month: '2026-11', search: '生日', searchFields: ['note'], entryIds: ['a', 'b'] }, detail: 'entries' },
  { label: '当天全部账目', query: { from: '2026-11-01', to: '2026-11-01' }, detail: 'entries' },
];
function request(text: string): CommandRequest {
  return { operationId: 'synthetic-selection', text, history: [
    { role: 'user', text: '11月生日花了多少钱' },
    { role: 'assistant', text: '请选择：1.生日备注；2.当天全部', outcome: { domain: 'ledger', phase: 'clarification', ledgerQueryChoices: choices } },
  ] };
}

describe('ledger query interpretation helpers', () => {
  it('defaults new AI keyword queries to per-entry fields while preserving explicit source searches and other filters', () => {
    const input = { month: '2026-11', search: '生日', entryIds: ['a'] };
    expect(normalizeLedgerQueryScope(input)).toEqual({ ...input, searchFields: ['title', 'note', 'counterparty'] });
    expect(input).toEqual({ month: '2026-11', search: '生日', entryIds: ['a'] });
    const unchanged: LedgerQuery[] = [{ search: '生日', searchFields: ['originalText'] }, { entryIds: [] }, {}];
    for (const query of unchanged) {
      expect(normalizeLedgerQueryScope(query)).toEqual(query);
    }
  });

  it.each(['第一个', '第1个', '选第一个', '选择第一项', '1', '一', '1。'])('resolves the current option exactly for the short answer %s', text => {
    const parsed = CommandRequestSchema.parse(request(text));
    expect(resolveLedgerQueryChoice(parsed)).toEqual({ kind: 'query', query: choices[0]!.query, detail: 'entries' });
  });

  it('uses the second option without inheriting the first option’s keyword or record filters', () => {
    expect(resolveLedgerQueryChoice(request('第二个'))).toEqual({ kind: 'query', query: choices[1]!.query, detail: 'entries' });
  });

  it.each(['第一个，然后再记账10元', '不是第一个', '第一个？', '好的', '是', '第6个', '第3个', '看看生日'])('does not treat %s as a complete unambiguous selection', text => {
    expect(resolveLedgerQueryChoice(request(text))).toBeUndefined();
  });

  it('does not revive older choices after a new question, completed response or different domain', () => {
    for (const phase of ['query', 'saved', 'preview'] as const) {
      const value = request('第一个'); value.history![1]!.outcome!.phase = phase;
      expect(resolveLedgerQueryChoice(value)).toBeUndefined();
    }
    const calendar = request('第一个'); calendar.history![1]!.outcome!.domain = 'calendar';
    expect(resolveLedgerQueryChoice(calendar)).toBeUndefined();
    const changed = request('第一个'); changed.history!.push({ role: 'assistant', text: '付款账户是什么？', outcome: { domain: 'ledger', phase: 'clarification' } });
    expect(resolveLedgerQueryChoice(changed)).toBeUndefined();
    expect(resolveLedgerQueryChoice({ text: '第一个', history: [] })).toBeUndefined();
  });

  it('leaves a short answer with new attachments to the regular interpreter', () => {
    expect(resolveLedgerQueryChoice({ ...request('第一个'), documents: [{ label: '合成资料.txt', text: '新资料' }] })).toBeUndefined();
  });

  it('normalizes legacy keyword scopes and preserves empty exact selections in a choice', () => {
    const value = request('第一个');
    value.history![1]!.outcome!.ledgerQueryChoices = [{ label: '无匹配', query: { entryIds: [], search: '生日' }, detail: 'summary' }, choices[1]!];
    expect(resolveLedgerQueryChoice(value)).toEqual({ kind: 'query', query: { entryIds: [], search: '生日', searchFields: ['title', 'note', 'counterparty'] }, detail: 'summary' });
  });

  it('validates bounded read-only choices while accepting old conversation states', () => {
    expect(ConversationStateSchema.parse({ domain: 'ledger', phase: 'clarification' })).toEqual({ domain: 'ledger', phase: 'clarification' });
    for (const value of [[], [choices[0]], Array(6).fill(choices[0]), [{ ...choices[0], label: 'x'.repeat(201) }, choices[1]], [{ ...choices[0], changes: [] }, choices[1]]]) {
      expect(LedgerQueryChoicesSchema.safeParse(value).success).toBe(false);
    }
    const value = request('第一个'); value.history![1]!.outcome!.ledgerQueryChoices = [choices[0]!];
    expect(resolveLedgerQueryChoice(value)).toBeUndefined();
  });

  it('describes executed search fields and selected counts without leaking record IDs', () => {
    expect(ledgerQueryScopeDescription(choices[0]!.query)).toBe('筛选范围：关键词「生日」（备注）；指定 2 笔账目。');
    expect(ledgerQueryScopeDescription({ entryIds: [] })).toBe('筛选范围：指定 0 笔账目。');
    expect(ledgerQueryScopeDescription({})).toBeUndefined();
    expect(ledgerQueryScopeDescription({ search: '合成', searchFields: ['originalText'] })).toContain('来源原文');
  });

  it('labels an exact cross-month or empty selection without claiming it is the current month', () => {
    expect(ledgerQueryRangeDescription({ entryIds: ['old', 'older'] }, '2026-11')).toBe('指定账目（不限月份）');
    expect(ledgerQueryRangeDescription({ entryIds: [] }, '2026-11')).toBe('指定账目（不限月份）');
    expect(ledgerQueryRangeDescription({}, '2026-11')).toBe('2026-11');
    expect(ledgerQueryRangeDescription({ month: '2026-09', entryIds: ['old'] }, '2026-11')).toBe('2026-09');
    expect(ledgerQueryRangeDescription({ from: '2026-09-01', to: '2026-10-31', entryIds: ['old'] }, '2026-11')).toBe('2026-09-01 至 2026-10-31');
    expect(ledgerQueryRangeDescription({ to: '2026-10-31', entryIds: ['old'] }, '2026-11')).toBe('最早记录 至 2026-10-31');
    expect(ledgerQueryRangeDescription({ from: '2026-09-01', entryIds: ['old'] }, '2026-11')).toBe('2026-09-01 至 今天');
  });
});
