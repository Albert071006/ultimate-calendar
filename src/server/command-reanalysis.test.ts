import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRemoteService } from './service';
import type { ApiResult } from '../shared/contracts';
import type { LedgerSnapshot } from '../shared/ledger';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const envelope = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));

describe('explicit assistant reanalysis across durable service receipts', () => {
  it.each(['schema', 'ledger-business'] as const)('keeps an old %s failed receipt stable and saves a fresh reanalysis only once, including after restart', async failure => {
    const root = mkdtempSync(join(tmpdir(), 'planner-reanalysis-'));
    cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
    const entries = Array.from({ length: failure === 'ledger-business' ? 4 : 1 }, (_, index) => ({ type: 'createEntry', key: `new:${index}`, values: { kind: 'expense', date: '2026-10-28', month: '2026-10', title: `合成茶饮${index}`, category: '餐饮', amountCents: 620, personalCents: 620, cashflows: [{ accountId: 'alipay', deltaCents: -620 }] } }));
    const invalidEntries = structuredClone(entries);
    invalidEntries.at(-1)!.values.cashflows[0]!.deltaCents = 620;
    const responses = [
      { kind: 'ledger', reply: '交由账本处理' },
      { kind: 'mutate', changes: failure === 'schema' ? [{ type: 'createEntry', values: { amountCents: 'invalid' } }] : invalidEntries },
      { kind: 'ledger', reply: '交由账本处理' },
      { kind: 'mutate', changes: entries },
    ];
    let calls = 0;
    const options = { dataDirectory: join(root, 'data'), backupDirectory: join(root, 'backups'), getApiKey: async () => 'synthetic-key', controller: {
      fetch: async () => { calls++; if (!responses.length) throw Error('Unexpected extra AI request'); return envelope(responses.shift()); },
    } };
    let service = createRemoteService(options);
    cleanup.push(async () => { await service.close(); });
    const identity = service.state.identity();
    const request = { requestId: 'failed-wire', identity, input: { operationId: 'failed-business', text: '合成茶饮6.20元支付宝' } };
    const ledger = async () => {
      const result = await service.rpc('ledgerSnapshot', { requestId: 'read-only', identity, input: { month: '2026-10' } }, 'synthetic-device') as ApiResult<LedgerSnapshot>;
      if (!result.ok) throw Error(result.error.message);
      return result.data;
    };
    const before = await ledger();
    const failed = await service.rpc('command', request, 'synthetic-device');
    expect(failed).toMatchObject({ ok: false, error: { code: 'AI_RESPONSE' } });
    if (failure === 'ledger-business') expect(failed).toMatchObject({ error: { message: expect.stringContaining('本次整批账目均未保存') } });
    expect(await ledger()).toEqual(before);
    expect(calls).toBe(2);
    expect(await service.rpc('command', request, 'synthetic-device')).toEqual(failed);
    expect(calls).toBe(2);

    const retry = { ...request, requestId: 'reanalyzed-wire', input: { ...request.input, operationId: 'reanalyzed-business' } };
    const saved = await service.rpc('command', retry, 'synthetic-device');
    expect(saved).toMatchObject({ ok: true, data: { conversationState: { domain: 'ledger', phase: 'saved' } } });
    expect((await ledger()).entries).toMatchObject(entries.map(entry => ({ title: entry.values.title, amountCents: 620 })));
    expect(calls).toBe(4);
    expect(await service.rpc('command', retry, 'synthetic-device')).toEqual(saved);
    expect(await service.rpc('command', { ...retry, requestId: 'same-business-other-wire' }, 'synthetic-device')).toEqual(saved);

    await service.close();
    service = createRemoteService(options);
    expect(await service.rpc('command', request, 'synthetic-device')).toEqual(failed);
    expect(await service.rpc('command', retry, 'synthetic-device')).toEqual(saved);
    expect((await ledger()).entries).toHaveLength(entries.length);
    expect(calls).toBe(4);
  });
});
