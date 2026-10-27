import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationRequestSchema, SnapshotSchema, TaskSchema } from '../../shared/contracts';
import { DEFAULT_LEDGER_RULES, LedgerSnapshotSchema } from '../../shared/ledger';
import { createRemoteClient } from './client';
import { createMemoryStorage, emptyPartition, partitionKey, type OfflineStorage } from './storage';
import type { OfflinePartition, PairedSession, PendingWrite } from './types';

const origin = 'https://synthetic-startup.example';
const at = '2030-01-10T08:00:00+08:00';
const session: PairedSession = {
  paired: true, identity: { protocolVersion: 1, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 },
  device: { id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic startup phone' },
  csrfToken: 'synthetic-csrf', aiConfigured: false,
};
function calendar(title: string) {
  return SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [],
    tasks: [TaskSchema.parse({ id: 'synthetic-task', title, version: 1, createdAt: at, updatedAt: at })],
    blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
}
function ledger(month: string, revision: number) {
  return LedgerSnapshotSchema.parse({ revision, entries: [], balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [],
    summary: { month, from: null, to: null, actualPaidCents: 0, personalCents: 0, incomeCents: 0, assetSaleCents: 0,
      familyUsageCents: 0, pendingPersonalCount: 0, pendingAccountCount: 0, uncertainDateCents: 0,
      cashBalanceCents: null, storedBalanceCents: null, accounts: [], categories: [], days: [] } });
}
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.useRealTimers(); });

async function fixture(cached = true, storage: OfflineStorage = createMemoryStorage()) {
  let liveSession = structuredClone(session), online = true, sessionStatus = 200, paired = true;
  const calls: Array<{ path: string; input: unknown }> = [];
  const pauses = new Map<string, { wait: Promise<void>; release: () => void }>();
  if (cached) {
    const saved = emptyPartition(session); saved.snapshot = calendar('Synthetic cached calendar'); saved.cachedAt = at;
    await storage.write(partitionKey(origin, session), saved); await storage.write('active:' + origin, partitionKey(origin, session));
  }
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); expect(url.origin).toBe(origin);
    if (!online) throw TypeError('Synthetic offline');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, input: body });
    await pauses.get(url.pathname)?.wait;
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/v1/session') return json(sessionStatus === 401 ? { error: { message: 'Synthetic revoked authorization' } } : paired ? liveSession : { paired: false }, sessionStatus);
    if (url.pathname === '/api/v1/session/renew') return json(liveSession);
    if (url.pathname === '/api/v1/rpc/snapshot') return json({ ok: true, data: calendar('Synthetic fresh calendar') });
    if (url.pathname === '/api/v1/rpc/ledgerSnapshot') return json({ ok: true, data: ledger(body.input.month, 9) });
    throw Error('Unexpected write or external request in startup test: ' + url.pathname);
  };
  const open = (events?: (url: string) => EventSource, timeoutMs?: number) => {
    const controller = createRemoteClient({ origin, storage, fetch: fetcher, events, timeoutMs });
    cleanup.push(() => controller.dispose()); return controller;
  };
  cleanup.push(() => { for (const pause of pauses.values()) pause.release(); });
  return { storage, calls, open,
    hold(path: string) { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); pauses.set(path, { wait, release }); return release; },
    offline() { online = false; }, revoke() { sessionStatus = 401; }, unpair() { paired = false; },
    advanceGeneration() { liveSession = { ...liveSession, identity: { ...liveSession.identity, generation: 2 } }; },
    async alterCached(update: (value: OfflinePartition) => void) {
      const key = partitionKey(origin, session), value = await storage.read<OfflinePartition>(key);
      if (!value) throw Error('Expected synthetic cache'); update(value); await storage.write(key, value);
    },
  };
}

describe('mobile startup under a slow connection', () => {
  it('normalizes older cached defaults before showing the calendar while keeping durable records intact', async () => {
    const f = await fixture();
    await f.alterCached(value => { value.snapshot!.settings = {} as NonNullable<OfflinePartition['snapshot']>['settings']; });
    const before = await f.storage.read<OfflinePartition>(partitionKey(origin, session));
    const release = f.hold('/api/v1/session'), controller = f.open(), connecting = controller.initialize();
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    try {
      const result = await controller.client.snapshot();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.settings.termWeeks).toBeGreaterThan(0);
      expect(await f.storage.read(partitionKey(origin, session))).toEqual(before);
    } finally { release(); await connecting; }
  });

  it('does not render malformed cached data or delete it when offline', async () => {
    const f = await fixture();
    await f.alterCached(value => { delete (value.snapshot as unknown as Record<string, unknown>).journal; });
    const before = await f.storage.read<OfflinePartition>(partitionKey(origin, session));
    f.offline(); const controller = f.open(); await controller.initialize();
    expect(await controller.client.snapshot()).toMatchObject({ ok: false, error: { code: 'NETWORK' } });
    expect(await f.storage.read(partitionKey(origin, session))).toEqual(before);
  });

  it('shows the matching cached calendar while the session check is still pending', async () => {
    const f = await fixture(), release = f.hold('/api/v1/session'), controller = f.open();
    const connecting = controller.initialize();
    await vi.waitFor(() => expect(f.calls.some(call => call.path === '/api/v1/session')).toBe(true));
    expect(controller.getState()).toMatchObject({ status: 'connecting', session: { device: { id: session.device.id } }, cachedAt: at });
    let displayed = false;
    const reading = controller.client.snapshot().then(value => { expect(value).toMatchObject({ ok: true, data: { tasks: [{ title: 'Synthetic cached calendar' }] } }); displayed = true; });
    try { await vi.waitFor(() => expect(displayed).toBe(true)); expect(f.calls).toHaveLength(1); }
    finally { release(); await connecting; await reading; }
  });

  it('publishes the fresh calendar before a slow renewal and avoids a duplicate calendar RPC', async () => {
    const f = await fixture(), release = f.hold('/api/v1/session/renew'), controller = f.open();
    const connecting = controller.initialize();
    await vi.waitFor(() => expect(f.calls.some(call => call.path === '/api/v1/session/renew')).toBe(true));
    let displayed = false;
    const reading = controller.client.snapshot().then(value => { expect(value).toMatchObject({ ok: true, data: { tasks: [{ title: 'Synthetic fresh calendar' }] } }); displayed = true; });
    try {
      await vi.waitFor(() => expect(displayed).toBe(true));
      expect(f.calls.filter(call => call.path === '/api/v1/rpc/snapshot')).toHaveLength(1);
    } finally { release(); await connecting; await reading; }
  });

  it('lets an already waiting cold-start read finish as soon as the first calendar arrives', async () => {
    const f = await fixture(false), releaseSession = f.hold('/api/v1/session'), releaseRenew = f.hold('/api/v1/session/renew'), controller = f.open();
    const connecting = controller.initialize();
    await vi.waitFor(() => expect(f.calls.some(call => call.path === '/api/v1/session')).toBe(true));
    let displayed = false;
    const reading = controller.client.snapshot().then(value => { expect(value).toMatchObject({ ok: true, data: { tasks: [{ title: 'Synthetic fresh calendar' }] } }); displayed = true; });
    releaseSession();
    try {
      await vi.waitFor(() => expect(f.calls.some(call => call.path === '/api/v1/session/renew')).toBe(true));
      await vi.waitFor(() => expect(displayed).toBe(true));
      expect(f.calls.filter(call => call.path === '/api/v1/rpc/snapshot')).toHaveLength(1);
    } finally { releaseRenew(); await connecting; await reading; }
  });

  it('coalesces overlapping foreground reconnects into one session and calendar request', async () => {
    const f = await fixture(), release = f.hold('/api/v1/session'), controller = f.open();
    const connecting = controller.initialize();
    await vi.waitFor(() => expect(f.calls.some(call => call.path === '/api/v1/session')).toBe(true));
    const first = controller.reconnect(), second = controller.reconnect(), third = controller.reconnect();
    expect(first).toBe(second); expect(second).toBe(third);
    expect(f.calls.filter(call => call.path === '/api/v1/session')).toHaveLength(1);
    release(); await Promise.all([connecting, first, second, third]);
    expect(f.calls.filter(call => call.path === '/api/v1/session')).toHaveLength(1);
    expect(f.calls.filter(call => call.path === '/api/v1/rpc/snapshot')).toHaveLength(1);
  });

  it('reopens the event stream after its retry fires during a pending renewal without sending business writes', async () => {
    vi.useFakeTimers();
    const f = await fixture(), release = f.hold('/api/v1/session/renew');
    const sources: Array<{ close: ReturnType<typeof vi.fn>; onerror: ((event: Event) => unknown) | null; addEventListener: ReturnType<typeof vi.fn> }> = [];
    const events = (url: string) => {
      expect(url).toBe(origin + '/api/v1/events');
      const source = { close: vi.fn(), onerror: null, addEventListener: vi.fn() }; sources.push(source);
      return source as unknown as EventSource;
    };
    const controller = f.open(events, 60_000), connecting = controller.initialize();
    await vi.waitFor(() => expect(f.calls.some(call => call.path === '/api/v1/session/renew')).toBe(true));
    expect(sources).toHaveLength(1);
    sources[0]!.onerror?.(new Event('error'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sources[0]!.close).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.path === '/api/v1/session')).toHaveLength(1);
    release(); await connecting;
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    await vi.waitFor(() => expect(f.calls.filter(call => call.path === '/api/v1/rpc/snapshot')).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.filter(call => call.path === '/api/v1/session')).toHaveLength(2);
    expect(f.calls.filter(call => call.path === '/api/v1/rpc/snapshot')).toHaveLength(2);
    expect(f.calls.every(call => ['/api/v1/session', '/api/v1/session/renew', '/api/v1/rpc/snapshot'].includes(call.path))).toBe(true);
    expect(controller.getState().pending).toEqual([]);
  });

  it('does not refresh every historical ledger at startup but still refreshes an explicitly opened month', async () => {
    const f = await fixture();
    await f.alterCached(value => { for (let month = 1; month <= 10; month++) { const key = `2020-${String(month).padStart(2, '0')}`; value.ledgers[key] = ledger(key, 1); } });
    const controller = f.open(); await controller.initialize();
    expect(f.calls.some(call => call.path === '/api/v1/rpc/ledgerSnapshot')).toBe(false);
    expect(await controller.client.ledgerSnapshot({ month: '2020-03' })).toMatchObject({ ok: true, data: { revision: 9, summary: { month: '2020-03' } } });
    expect(f.calls.filter(call => call.path === '/api/v1/rpc/ledgerSnapshot')).toHaveLength(1);
  });

  it.each(['401', 'unpaired'] as const)('does not revive cached authorization offline after a known %s response and reload', async kind => {
    const f = await fixture(); kind === '401' ? f.revoke() : f.unpair();
    const first = f.open(); await first.initialize(); expect(first.getState().status).toBe('expired'); first.dispose();
    f.offline(); const reopened = f.open(); await reopened.initialize();
    expect(reopened.getState()).toMatchObject({ status: 'expired', session: null });
    expect(await reopened.client.snapshot()).toMatchObject({ ok: false, error: { code: 'AUTH' } });
    expect(f.calls.some(call => call.path.startsWith('/api/v1/rpc/'))).toBe(false);
  });

  it('preserves an old generation outbox without replaying it after the authoritative identity changes', async () => {
    const f = await fixture();
    const item: PendingWrite = { id: 'synthetic-queued-write', requestId: '33333333-3333-4333-8333-333333333333', method: 'mutate',
      input: MutationRequestSchema.parse({ operationId: '44444444-4444-4444-8444-444444444444', origin: 'manual', mutations: [{ type: 'create', entity: 'task', values: { title: 'Synthetic unsubmitted draft' } }] }),
      identity: session.identity, createdAt: at, status: 'queued', label: 'Synthetic draft', message: '', base: [], dependencies: [], targets: [] };
    await f.alterCached(value => { value.queue.push(item); }); f.advanceGeneration();
    const controller = f.open(); await expect(controller.initialize()).rejects.toThrow(/代际|授权/);
    expect(controller.getState()).toMatchObject({ status: 'expired', session: null, pending: [{ requestId: item.requestId }] });
    expect(f.calls.some(call => call.path.startsWith('/api/v1/rpc/'))).toBe(false);
    const saved = await f.storage.read<OfflinePartition>(partitionKey(origin, session));
    expect(saved?.queue[0]).toEqual(item);
  });
});
