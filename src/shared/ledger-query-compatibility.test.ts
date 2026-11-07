import { describe, expect, it } from 'vitest';
import { CommandResultSchema, ConversationStateSchema } from './contracts';
import { legacyLedgerQueryResult } from './ledger-query-compatibility';

const legacyCommand = CommandResultSchema.extend({ conversationState: ConversationStateSchema.omit({ ledgerQueryChoices: true }).optional() });
const result = { ok: true, data: { reply: '请选择生日消费或当天全部账目。', mutationResult: null, items: [], conversationState: {
  domain: 'ledger', phase: 'clarification', ledgerQueryChoices: [
    { label: '生日消费', query: { search: '生日', searchFields: ['note'] }, detail: 'entries' },
    { label: '当天全部', query: { from: '2026-11-01', to: '2026-11-01' }, detail: 'entries' },
  ],
} }, sync: { synthetic: 'preserved' } };

describe('legacy ledger query response compatibility', () => {
  it('removes only structured query choices and leaves the canonical result unchanged', () => {
    const before = structuredClone(result);
    expect(legacyCommand.safeParse(result.data).success).toBe(false);
    const compatible = legacyLedgerQueryResult('command', result) as typeof result;
    expect(legacyCommand.parse(compatible.data)).toEqual({ ...result.data, conversationState: { domain: 'ledger', phase: 'clarification' } });
    expect(compatible.sync).toBe(result.sync);
    expect(result).toEqual(before);
    expect(compatible).not.toBe(result);
    expect(compatible.data).not.toBe(result.data);
    expect(compatible.data.conversationState).not.toBe(result.data.conversationState);
    expect(CommandResultSchema.parse(result.data).conversationState!.ledgerQueryChoices).toHaveLength(2);
  });

  it('does not strip other methods, errors, or old command states', () => {
    expect(legacyLedgerQueryResult('snapshot', result)).toBe(result);
    const old = { ok: true, data: { ...result.data, conversationState: { domain: 'ledger', phase: 'saved' } } };
    const error = { ok: false, error: { code: 'VALIDATION', message: '合成失败', retryable: false } };
    for (const value of [undefined, null, {}, error, old, { ok: true, data: {} }, { ok: true, data: { conversationState: null } }]) {
      expect(legacyLedgerQueryResult('command', value)).toBe(value);
    }
  });
});
