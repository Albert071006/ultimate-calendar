import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createRemoteService } from '../../server/service';
import { RemoteFault } from '../../server/state';
import { MutationRequestSchema } from '../../shared/contracts';
import { LedgerMutationRequestSchema } from '../../shared/ledger';
import { RemoteMethodSchema, RemoteRequestSchema } from '../../shared/remote';
import { createRemoteClient } from './client';
import { createMemoryStorage, type OfflineStorage } from './storage';
import type { OfflinePartition, PendingWrite, RemoteController } from './types';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = 'https://safety-calendar.example';
const taskInput = (title: string) => MutationRequestSchema.parse({ operationId: crypto.randomUUID(), origin: 'manual', mutations: [{ type: 'create', entity: 'task', values: { title } }] });
const updateTask = (id: string, version: number, title: string) => MutationRequestSchema.parse({ operationId: crypto.randomUUID(), origin: 'manual', mutations: [{ type: 'update', entity: 'task', id, expectedVersion: version, values: { title } }] });
const expense = (id: string, revision: number, amount: number) => LedgerMutationRequestSchema.parse({ operationId: crypto.randomUUID(), expectedRevision: revision, month: '2020-01', changes: [{ type: 'putEntry', expectedVersion: null, entry: { id, kind: 'expense', date: '2020-01-10', month: '2020-01', title: `合成支出${id}`, category: '其他', amountCents: amount, personalCents: amount, cashflows: [{ accountId: 'wechat', deltaCents: -amount }] } }] });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uc-client-safety-'));
  cleanup.push(async () => { const rel = relative(tmpdir(), directory); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Unsafe synthetic test cleanup'); rmSync(directory, { recursive: true, force: true }); });
  const service = createRemoteService({ dataDirectory: directory, backupDirectory: join(directory, 'synthetic-backups'), getApiKey: async () => null, controller: { fetch: async () => { throw Error('No external AI or network is allowed in safety tests'); } } });
  cleanup.push(() => service.close());
  const memory = createMemoryStorage(); let failWrite: (key: string, value: unknown) => boolean = () => false;
  const storage: OfflineStorage = { read: memory.read, remove: memory.remove, async write(key, value) { if (failWrite(key, value)) throw Error('Synthetic IndexedDB interruption'); await memory.write(key, value); } };
  let token: string | undefined; let online = true; let afterCommittedWrite: (() => void) | undefined;
  const calls: { path: string; input: unknown }[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher: typeof fetch = async (input, init = {}) => {
    if (!online) throw TypeError('Synthetic offline');
    const url = new URL(input instanceof Request ? input.url : String(input)); if (url.origin !== origin) throw Error('Unexpected external request');
    const payload = typeof init.body === 'string' ? JSON.parse(init.body) : undefined; calls.push({ path: url.pathname, input: payload });
    try {
      if (url.pathname === '/api/v1/pair') {
        const paired = service.state.pair(payload.code, payload.name); token = paired.token;
        return json({ paired: true, identity: service.state.identity(), device: paired.device, csrfToken: paired.csrfToken, aiConfigured: false });
      }
      const session = service.state.session(token);
      if (url.pathname === '/api/v1/session') return json(session ? { paired: true, identity: service.state.identity(), device: session.device, csrfToken: session.csrfToken, aiConfigured: false } : { paired: false });
      if (!session) return json({ ok: false, error: { message: 'Synthetic expired session' } }, 401);
      const rpc = /^\/api\/v1\/rpc\/(.+)$/.exec(url.pathname);
      if (rpc) {
        const method = RemoteMethodSchema.parse(rpc[1]); const result = await service.rpc(method, RemoteRequestSchema.parse(payload), session.device.id);
        if (!['snapshot', 'ledgerSnapshot'].includes(method)) { const hook = afterCommittedWrite; afterCommittedWrite = undefined; hook?.(); }
        return json(result);
      }
      const operation = /^\/api\/v1\/operations\/(.+)$/.exec(url.pathname);
      if (operation) return json(service.state.operation(decodeURIComponent(operation[1]!), session.device.id));
      throw Error('Unexpected safety test route');
    } catch (error) { if (error instanceof RemoteFault) return json({ ok: false, error: { message: error.message } }, error.status); throw error; }
  };
  function open() { const controller = createRemoteClient({ origin, storage, fetch: fetcher, timeoutMs: 2000 }); cleanup.push(async () => controller.dispose()); return controller; }
  const controller = open(); await controller.initialize(); await controller.pair(service.state.createPairingCode(), '合成审计手机');
  const other = service.state.pair(service.state.createPairingCode(), '合成其他设备');
  const invokeOther = (method: 'mutate' | 'ledgerMutate' | 'ledgerSnapshot', input: unknown) => service.rpc(method, RemoteRequestSchema.parse({ requestId: crypto.randomUUID(), identity: service.state.identity(), input }), other.device.id);
  const setOnline = async (value: boolean, active: RemoteController = controller) => { online = value; await active.reconnect(); };
  return { service, controller, calls, open, invokeOther, setOnline, fault: (test: typeof failWrite) => { failWrite = test; }, afterCommit: (hook: () => void) => { afterCommittedWrite = hook; } };
}

describe('remote client safety regressions', () => {
  it('recovers a locally confirmed receipt after outbox cleanup fails without querying or resending the write', async () => {
    const f = await fixture(); let interrupted = false;
    f.fault((key, value) => {
      if (!key.startsWith('partition:') || !value || typeof value !== 'object') return false;
      const data = value as OfflinePartition;
      if (!interrupted && data.completed.length > 0 && data.queue.length === 0) { interrupted = true; return true; }
      return false;
    });
    expect(await f.controller.client.mutate(taskInput('合成已提交但清理失败'))).toMatchObject({ ok: false, error: { code: 'STORAGE' } });
    expect(f.service.snapshot().tasks).toHaveLength(1); expect(f.controller.getState().pending).toHaveLength(1);
    const requestId = f.controller.getState().pending[0]!.requestId;
    const projected = await f.controller.client.snapshot(); expect(projected.ok && projected.data.tasks).toHaveLength(1);
    f.controller.dispose(); const reopened = f.open(); await reopened.initialize();
    expect(reopened.getState().pending).toHaveLength(0); expect(f.service.snapshot().tasks).toHaveLength(1);
    expect(f.calls.filter(call => call.path === '/api/v1/rpc/mutate')).toHaveLength(1);
    expect(f.calls.some(call => call.path === '/api/v1/operations/' + requestId)).toBe(false);
  });

  it('lets an unsent blocked descendant be discarded before abandoning its conflicting parent', async () => {
    const f = await fixture(); await f.controller.client.mutate(taskInput('合成依赖链'));
    const task = f.service.snapshot().tasks[0]!; await f.setOnline(false);
    await f.controller.client.mutate(updateTask(task.id, task.version, '第一条离线修改'));
    await f.controller.client.mutate(updateTask(task.id, task.version + 1, '第二条依赖修改'));
    const [parent, child] = f.controller.getState().pending; expect(child!.dependencies).toContain(parent!.id);
    await f.invokeOther('mutate', updateTask(task.id, task.version, '另一设备的正式修改'));
    await f.setOnline(true);
    expect(f.controller.getState().pending.map(item => item.status)).toEqual(['conflict', 'blocked']);
    expect(f.controller.getState().pending[1]!.wireInput).toBeUndefined();
    await f.controller.resolve(child!.id, 'discard'); await f.controller.resolve(parent!.id, 'discard');
    expect(f.controller.getState().pending).toHaveLength(0); expect(f.service.snapshot().tasks[0]!.title).toBe('另一设备的正式修改');
  });

  it('saves two independent offline expenses once when only this confirmed outbox advances the ledger', async () => {
    const f = await fixture(); const before = await f.controller.client.ledgerSnapshot({ month: '2020-01' }); if (!before.ok) throw Error('Missing synthetic ledger');
    await f.setOnline(false);
    await f.controller.client.ledgerMutate(expense('offline-one', before.data.revision, 100));
    await f.controller.client.ledgerMutate(expense('offline-two', before.data.revision, 200));
    expect(f.controller.getState().pending).toHaveLength(2); await f.setOnline(true);
    const after = await f.controller.client.ledgerSnapshot({ month: '2020-01' }); if (!after.ok) throw Error('Missing synthetic ledger');
    expect(after.data.entries.map(entry => entry.id).sort()).toEqual(['offline-one', 'offline-two']);
    expect(f.controller.getState().pending).toHaveLength(0); await f.controller.reconnect();
    expect(f.calls.filter(call => call.path === '/api/v1/rpc/ledgerMutate')).toHaveLength(2);
  });

  it('does not automatically override an external ledger revision while synchronizing offline expenses', async () => {
    const f = await fixture(); const before = await f.controller.client.ledgerSnapshot({ month: '2020-01' }); if (!before.ok) throw Error('Missing synthetic ledger');
    await f.setOnline(false); await f.controller.client.ledgerMutate(expense('offline-one', before.data.revision, 100)); await f.controller.client.ledgerMutate(expense('offline-two', before.data.revision, 200));
    await f.invokeOther('ledgerMutate', expense('external', before.data.revision, 300)); await f.setOnline(true);
    const after = await f.controller.client.ledgerSnapshot({ month: '2020-01' }); if (!after.ok) throw Error('Missing synthetic ledger');
    expect(after.data.entries.map(entry => entry.id)).toEqual(['external']); expect(f.controller.getState().pending).toHaveLength(2);
    expect(f.controller.getState().pending.every(item => ['conflict', 'blocked'].includes(item.status))).toBe(true);
  });

  it('keeps the original generation queue active if archival indexing fails, then isolates it before new pairing', async () => {
    const f = await fixture(); await f.setOnline(false); await f.controller.client.mutate(taskInput('不可跨代际重放的合成草稿'));
    const original = f.controller.getState().pending[0]!; f.service.state.advanceGeneration();
    await expect(f.setOnline(true)).rejects.toThrow(/代际|授权/);
    f.fault(key => key.startsWith('archives:'));
    await expect(f.controller.archivePending()).rejects.toThrow('Synthetic IndexedDB');
    expect(f.controller.getState().pending[0]!.requestId).toBe(original.requestId);
    f.fault(() => false); const archived = await f.controller.archivePending(); expect(archived.pending[0]!.requestId).toBe(original.requestId);
    await f.controller.pair(f.service.state.createPairingCode(), '合成新代际设备');
    expect(f.controller.getState().pending).toHaveLength(0); expect(await f.controller.archives()).toHaveLength(1);
    expect(f.service.snapshot().tasks).toHaveLength(0); expect(f.calls.filter(call => call.path === '/api/v1/rpc/mutate')).toHaveLength(0);
  });

  it('does not downgrade an already confirmed receipt to a discardable conflict when canonical generation changes', async () => {
    const f = await fixture(); f.afterCommit(() => f.service.state.advanceGeneration());
    expect(await f.controller.client.mutate(taskInput('已确认后遇代际变化的合成任务'))).toMatchObject({ ok: true, data: { status: 'applied' } });
    expect(f.service.snapshot().tasks).toHaveLength(1);
    const item = f.controller.getState().pending[0]!; expect(item.result).toMatchObject({ ok: true, data: { status: 'applied' } });
    expect(item.status).toBe('uncertain');
    await expect(f.controller.resolve(item.id, 'discard')).rejects.toThrow(/未知|查询|确认/);
    await expect(f.controller.reconnect()).rejects.toThrow(/代际|授权/);
    expect(f.controller.getState().status).toBe('expired'); expect(f.controller.getState().pending[0]!.requestId).toBe(item.requestId);
    expect(f.calls.filter(call => call.path === '/api/v1/rpc/mutate')).toHaveLength(1);
  });

  it('replaces only a definitively invalid new expense when its form is corrected with a new operation', async () => {
    const f = await fixture(); const before = await f.controller.client.ledgerSnapshot({ month: '2020-01' }); if (!before.ok) throw Error('Missing synthetic ledger');
    const invalid = expense('corrected-entry', before.data.revision, 100); const change = invalid.changes[0]!;
    if (change.type !== 'putEntry') throw Error('Expected synthetic expense'); change.entry.personalCents = 101;
    expect(await f.controller.client.ledgerMutate(invalid)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const failed = structuredClone(f.controller.getState().pending[0]!); expect(failed.status).toBe('failed');
    const corrected = expense('corrected-entry', before.data.revision, 100); let durableCorrection: PendingWrite | undefined;
    f.fault((key, value) => {
      if (key.startsWith('partition:') && value && typeof value === 'object') {
        const candidate = (value as OfflinePartition).queue.find(item => item.method === 'ledgerMutate' && (item.input as { operationId?: string }).operationId === corrected.operationId);
        if (candidate) durableCorrection = structuredClone(candidate);
      }
      return false;
    });
    expect(await f.controller.client.ledgerMutate(corrected)).toMatchObject({ ok: true, data: { status: 'saved' } });
    expect(durableCorrection).toBeDefined(); expect(durableCorrection!.id).toBe(failed.id); expect(durableCorrection!.requestId).not.toBe(failed.requestId);
    expect(durableCorrection!.dependencies).not.toContain(failed.id); expect(f.controller.getState().pending).toHaveLength(0);
    const after = await f.controller.client.ledgerSnapshot({ month: '2020-01' }); if (!after.ok) throw Error('Missing synthetic ledger');
    expect(after.data.entries).toHaveLength(1); expect(after.data.entries[0]).toMatchObject({ id: 'corrected-entry', amountCents: 100, personalCents: 100 });
    const writes = f.calls.filter(call => call.path === '/api/v1/rpc/ledgerMutate'); expect(writes).toHaveLength(2);
    expect(RemoteRequestSchema.parse(writes[0]!.input).requestId).not.toBe(RemoteRequestSchema.parse(writes[1]!.input).requestId);
  });

  it('preserves an unknown same-entry write and checks its original receipt before attempting a correction', async () => {
    const f = await fixture(); const before = await f.controller.client.ledgerSnapshot({ month: '2020-01' }); if (!before.ok) throw Error('Missing synthetic ledger');
    const original = expense('unknown-entry', before.data.revision, 100);
    f.afterCommit(() => { throw TypeError('Synthetic response lost after ledger commit'); });
    await f.controller.client.ledgerMutate(original);
    const unknown = structuredClone(f.controller.getState().pending[0]!); expect(unknown.status).toBe('uncertain'); expect(unknown.result).toBeUndefined();
    const corrected = expense('unknown-entry', before.data.revision, 200);
    expect(await f.controller.client.ledgerMutate(corrected)).toMatchObject({ ok: true, data: { status: 'queued' } });
    const held = f.controller.getState().pending; expect(held).toHaveLength(2);
    expect(held[0]).toMatchObject({ id: unknown.id, requestId: unknown.requestId, input: original, status: 'uncertain' });
    expect(held[1]!.id).not.toBe(unknown.id); expect(held[1]!.dependencies).toContain(unknown.id); expect(held[1]!.wireInput).toBeUndefined();
    expect(f.calls.filter(call => call.path === '/api/v1/rpc/ledgerMutate')).toHaveLength(1);
    await f.setOnline(true);
    const queryIndex = f.calls.findIndex(call => call.path === '/api/v1/operations/' + unknown.requestId);
    const writeIndices = f.calls.map((call, index) => call.path === '/api/v1/rpc/ledgerMutate' ? index : -1).filter(index => index >= 0);
    expect(queryIndex).toBeGreaterThan(writeIndices[0]!); expect(queryIndex).toBeLessThan(writeIndices[1]!);
    const after = await f.controller.client.ledgerSnapshot({ month: '2020-01' }); if (!after.ok) throw Error('Missing synthetic ledger');
    expect(after.data.entries).toHaveLength(1); expect(after.data.entries[0]).toMatchObject({ id: 'unknown-entry', amountCents: 100 });
    expect(f.controller.getState().pending).toHaveLength(1); expect(f.controller.getState().pending[0]!.status).toBe('conflict');
  });

  it('does not create a dependency cycle when an unknown invalid draft acquires a held correction before another correction replaces it', async () => {
    const f = await fixture(); const before = await f.controller.client.ledgerSnapshot({ month: '2020-01' }); if (!before.ok) throw Error('Missing synthetic ledger');
    const invalid = expense('held-correction', before.data.revision, 100); const change = invalid.changes[0]!;
    if (change.type !== 'putEntry') throw Error('Expected synthetic expense'); change.entry.personalCents = 101;
    f.afterCommit(() => { throw TypeError('Synthetic invalid response lost'); }); await f.controller.client.ledgerMutate(invalid);
    const parentId = f.controller.getState().pending[0]!.id;
    await f.controller.client.ledgerMutate(expense('held-correction', before.data.revision, 100));
    const childId = f.controller.getState().pending[1]!.id; await f.setOnline(true);
    expect(f.controller.getState().pending.map(item => item.status)).toEqual(['failed', 'blocked']);
    expect(f.controller.getState().pending[0]!.result).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(f.controller.getState().pending[1]!.dependencies).toContain(parentId);
    expect(await f.controller.client.ledgerMutate(expense('held-correction', before.data.revision, 150))).toMatchObject({ ok: true, data: { status: 'saved' } });
    const after = await f.controller.client.ledgerSnapshot({ month: '2020-01' }); if (!after.ok) throw Error('Missing synthetic ledger');
    expect(after.data.entries).toHaveLength(1); expect(after.data.entries[0]).toMatchObject({ id: 'held-correction', amountCents: 150, personalCents: 150 });
    expect(f.controller.getState().pending).toHaveLength(1); expect(f.controller.getState().pending[0]).toMatchObject({ id: childId, status: 'conflict' });
    expect(f.controller.getState().pending[0]!.dependencies).toContain(parentId);
  });
});
