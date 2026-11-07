import { expect, it } from 'vitest';
import { CommandResultSchema, SnapshotSchema } from '../../shared/contracts';
import { LEDGER_QUERY_HEADER, LEDGER_QUERY_VERSION } from '../../shared/ledger-query-compatibility';
import { createRemoteClient } from './client';
import { createMemoryStorage } from './storage';

it('advertises query-choice support in the browser and preserves choices through the next command history', async () => {
  const origin = 'https://synthetic-query.example';
  const session = { paired: true, identity: { protocolVersion: 1, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 },
    device: { id: '22222222-2222-4222-8222-222222222222', name: '合成手机' }, csrfToken: 'synthetic-csrf', aiConfigured: false };
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [],
    courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
  const answer = CommandResultSchema.parse({ reply: '合成查询选项', mutationResult: null, items: [], conversationState: {
    domain: 'ledger', phase: 'clarification', ledgerQueryChoices: [
      { label: '仅生日消费', query: { month: '2026-11', search: '生日', searchFields: ['note'] }, detail: 'entries' },
      { label: '当月全部', query: { month: '2026-11' }, detail: 'entries' },
    ],
  } });
  const commandInputs: unknown[] = [];
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); expect(url.origin).toBe(origin);
    expect(new Headers(init.headers).get(LEDGER_QUERY_HEADER)).toBe(LEDGER_QUERY_VERSION);
    if (url.pathname === '/api/v1/session') return json(session);
    if (url.pathname === '/api/v1/rpc/snapshot') return json({ ok: true, data: snapshot });
    if (url.pathname === '/api/v1/rpc/command') {
      commandInputs.push(JSON.parse(String(init.body)).input);
      return json({ ok: true, data: answer });
    }
    throw Error('Unexpected synthetic query request: ' + url.pathname);
  };
  const controller = createRemoteClient({ origin, storage: createMemoryStorage(), fetch: fetcher });
  try {
    await controller.initialize();
    expect(await controller.client.command({ operationId: 'synthetic-first', text: '生日消费' })).toEqual({ ok: true, data: answer });
    const history = [{ role: 'user' as const, text: '生日消费' }, { role: 'assistant' as const, text: answer.reply, outcome: answer.conversationState }];
    expect(await controller.client.command({ operationId: 'synthetic-second', text: '第一个', history })).toEqual({ ok: true, data: answer });
    expect(commandInputs).toHaveLength(2);
    expect(commandInputs[1]).toMatchObject({ text: '第一个', history });
  } finally { controller.dispose(); }
});
