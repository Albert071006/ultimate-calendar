export const LEDGER_QUERY_HEADER = 'X-Planner-Ledger-Query-Version';
export const LEDGER_QUERY_VERSION = '1';

/** Adapt only the response copy; the durable command receipt retains its choices. */
export function legacyLedgerQueryResult(method: string, result: unknown): unknown {
  if (method !== 'command' || !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('data' in result)) return result;
  const data = result.data;
  if (!data || typeof data !== 'object' || !('conversationState' in data)) return result;
  const state = data.conversationState;
  if (!state || typeof state !== 'object' || !Object.hasOwn(state, 'ledgerQueryChoices')) return result;
  const { ledgerQueryChoices: _choices, ...conversationState } = state as Record<string, unknown>;
  return { ...result, data: { ...data, conversationState } };
}
