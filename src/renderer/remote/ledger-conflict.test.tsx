// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createLedgerService, LedgerError } from '../../ledger/service';
import { LedgerMutationRequestSchema } from '../../shared/ledger';
import { RemoteRequestSchema } from '../../shared/remote';
import { emptyState, stateSnapshot } from '../../storage/repository';
import { RemoteApp } from './RemoteApp';
import { createRemoteClient } from './client';
import { createMemoryStorage, partitionKey } from './storage';
import type { OfflinePartition } from './types';

vi.mock('../mobile/MobileApp', () => ({ MobileApp: ({ pendingView }: { pendingView: ReactNode }) => <main>{pendingView}</main> }));
afterEach(cleanup);

const origin = 'https://ledger-conflict.example', month = '2020-02';
const session = { paired: true as const, identity: { protocolVersion: 1 as const, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 },
  device: { id: '22222222-2222-4222-8222-222222222222', name: '合成手机' }, csrfToken: 'synthetic', aiConfigured: false };
const expense = (id: string, revision: number) => LedgerMutationRequestSchema.parse({
  operationId: 'op-' + id, expectedRevision: revision, changes: [{ type: 'putEntry', expectedVersion: null,
    entry: { id, kind: 'expense', title: id, category: '其他', date: month + '-01', month, amountCents: 100, personalCents: 100,
      cashflows: [{ accountId: 'wechat', deltaCents: -100 }] } }],
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function fixture() {
  const ledger = createLedgerService(':memory:'), storage = createMemoryStorage();
  const writes: { requestId: string; input: ReturnType<typeof expense> }[] = [], reads: string[] = [], queries: string[] = [];
  const network = { online: true, refuseRead: false, interrupted: false };
  const fetcher: typeof fetch = async (input, init = {}) => {
    if (!network.online) throw TypeError('合成断网');
    const url = new URL(String(input));
    if (url.origin !== origin) throw Error('仅接受合成资料服务');
    if (['/api/v1/session', '/api/v1/session/renew'].includes(url.pathname)) return json(session);
    if (url.pathname.startsWith('/api/v1/operations/')) {
      const requestId = url.pathname.slice('/api/v1/operations/'.length);
      queries.push(requestId); return json({ status: 'interrupted', requestId, method: 'ledgerMutate' });
    }
    const body = RemoteRequestSchema.parse(JSON.parse(String(init.body)));
    if (url.pathname.endsWith('/snapshot')) return json({ ok: true, data: stateSnapshot(emptyState()) });
    if (url.pathname.endsWith('/ledgerSnapshot')) {
      const target = (body.input as { month: string }).month; reads.push(target);
      if (network.refuseRead) return json({ ok: false, error: { code: 'STORAGE', retryable: true, message: '正式账本读取失败' } });
      return json({ ok: true, data: ledger.snapshot(target) });
    }
    if (!url.pathname.endsWith('/ledgerMutate')) throw Error('未知合成请求');
    const draft = LedgerMutationRequestSchema.parse(body.input);
    writes.push({ requestId: body.requestId, input: draft });
    if (network.interrupted) return json({ ok: false, error: { message: '原请求待核对' } }, 409);
    try { return json({ ok: true, data: ledger.mutate(draft) }); }
    catch (error) {
      if (!(error instanceof LedgerError)) throw error;
      return json({ ok: false, error: { code: error.code, message: error.message, retryable: false } });
    }
  };
  const open = () => createRemoteClient({ origin, storage, fetch: fetcher,
    events: () => ({ addEventListener() {}, close() {} }) as unknown as EventSource });
  return { ledger, storage, open, network, writes, reads, queries };
}

it('re-submits an offline expense from the conflict button only after obtaining the target month’s fresh official revision', async () => {
  const f = fixture(), phone = f.open();
  try {
    await phone.initialize();
    await phone.client.ledgerSnapshot({ month: '2020-01' });
    const cached = await phone.client.ledgerSnapshot({ month }); if (!cached.ok) throw Error('缺少合成月份');
    f.network.online = false; await phone.reconnect();
    const original = expense('手机草稿', cached.data.revision);
    expect(await phone.client.ledgerMutate(original)).toMatchObject({ ok: true, data: { status: 'queued' } });
    const fresh = f.ledger.mutate(expense('其他设备', cached.data.revision)).snapshot.revision;
    f.network.online = true; await phone.reconnect();
    const conflict = structuredClone(phone.getState().pending[0]!); expect(conflict.status).toBe('conflict');
    expect(f.writes).toHaveLength(1); f.reads.length = 0;
    render(<RemoteApp controller={phone} />);
    const button = screen.getByRole('button', { name: '按我的修改重新提交' });
    f.network.refuseRead = true; fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('正式账本读取失败');
    expect(phone.getState().pending).toEqual([conflict]); expect(f.writes).toHaveLength(1);
    f.network.refuseRead = false; fireEvent.click(button);
    await waitFor(() => expect(phone.getState().pending).toHaveLength(0));
    expect(f.reads).toEqual([month, month]); expect(f.writes).toHaveLength(2);
    const retry = f.writes[1]!;
    expect(retry.requestId).not.toBe(conflict.requestId); expect(retry.input.operationId).not.toBe(original.operationId);
    expect(retry.input).toMatchObject({ expectedRevision: fresh, month, changes: original.changes });
    expect(f.ledger.snapshot(month).entries.map(value => value.id)).toEqual(['其他设备', '手机草稿']);
  } finally { phone.dispose(); f.ledger.close(); }
});

it('queries the original request after a transport 409, including an old cache that marked it as a conflict', async () => {
  const f = fixture(); let phone = f.open();
  try {
    await phone.initialize(); f.network.interrupted = true;
    await phone.client.ledgerMutate(expense('待核对', 0));
    const [pending] = phone.getState().pending; expect(pending!.status).toBe('uncertain');
    const requestId = pending!.requestId;
    phone.dispose();
    const key = partitionKey(origin, session), legacy = (await f.storage.read<OfflinePartition>(key))!;
    legacy.queue[0]!.status = 'conflict'; await f.storage.write(key, legacy);
    phone = f.open(); await phone.initialize(); render(<RemoteApp controller={phone} />);
    expect(screen.queryByRole('button', { name: '按我的修改重新提交' })).toBeNull();
    await expect(phone.resolve(pending!.id, 'use-local')).rejects.toThrow(/明确的版本冲突/);
    fireEvent.click(screen.getByRole('button', { name: '查询结果' }));
    await waitFor(() => expect(f.queries).toEqual([requestId, requestId]));
    expect(f.writes).toHaveLength(1); expect(phone.getState().pending[0]!.requestId).toBe(requestId);
  } finally { phone.dispose(); f.ledger.close(); }
});
