import { describe, expect, it } from 'vitest';
import { assistantRequestHistory } from './assistant-history';
import type { ConversationEntry } from './assistant-conversation';

const pending: ConversationEntry[] = [
  { id: 'original', role: 'user', text: '合成车票报销200元到微信' },
  { id: 'question', role: 'assistant', text: '两笔分别多少？', outcome: { domain: 'ledger', phase: 'clarification' } },
];
const failed = (delivery: 'unknown' | 'not-sent', errorCode = 'NETWORK' as const): ConversationEntry[] => [
  { id: 'answer', role: 'user', text: '各80和120' },
  { id: 'failure', role: 'assistant', text: '合成失败', status: 'failed', delivery, errorCode },
];
describe('assistant history failure boundaries', () => {
  it('does not resurrect an old pending question after an unknown or unedited unsent answer', () => {
    for (const delivery of ['unknown', 'not-sent'] as const) {
      expect(assistantRequestHistory([...pending, ...failed(delivery)])).toEqual([]);
    }
    expect(assistantRequestHistory([...pending, ...failed('unknown')], 'failure')).toEqual([]);
  });
  it('preserves the original chain only for the latest explicitly edited unsent reply', () => {
    expect(assistantRequestHistory([...pending, ...failed('not-sent')], 'failure')).toEqual(pending);
    expect(assistantRequestHistory([...pending, ...failed('not-sent')], 'other')).toEqual([]);
  });
  it('keeps new completed pairs after the failure, without their older discarded request', () => {
    const newer: ConversationEntry[] = [{ id: 'new', role: 'user', text: '新话题' }, { id: 'reply', role: 'assistant', text: '新回复', outcome: { domain: 'calendar', phase: 'query' } }];
    expect(assistantRequestHistory([...pending, ...failed('unknown'), ...newer])).toEqual(newer);
    expect(assistantRequestHistory([...pending, ...failed('not-sent'), ...newer], 'failure')).toEqual(newer);
  });
  it('treats unclassified failures and interrupted pending responses as boundaries too', () => {
    for (const status of ['failed', 'pending'] as const) {
      expect(assistantRequestHistory([...pending, { id: 'later', role: 'user', text: '80' }, { id: 'failed', role: 'assistant', text: '处理中', status }])).toEqual([]);
    }
  });
});
