import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapshotSchema } from '../../shared/contracts';
import { DEFAULT_LEDGER_RULES, LedgerSnapshotSchema } from '../../shared/ledger';
import { createRemoteClient } from './client';
import { createMemoryStorage, emptyPartition, partitionKey } from './storage';
import type { PairedSession } from './types';

const origin = 'https://synthetic-startup.example';
const session: PairedSession = {
  paired: true, identity: { protocolVersion: 1, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 },
  device: { id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic phone' }, csrfToken: 'synthetic-csrf', aiConfigured: false,
};
const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [],
  courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
const close: Array<() => void> = [];
afterEach(() => { for (const dispose of close.splice(0).reverse()) dispose(); vi.useRealTimers(); });

function fixture(storage = createMemoryStorage(), events?: (url: string) => EventSource) {
  const calls: string[] = [], waiting = new Map<string, Promise<void>>(), releases: Array<() => void> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe(origin);
    calls.push(url.pathname); await waiting.get(url.pathname);
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/v1/session' || url.pathname === '/api/v1/session/renew') return json(session);
    if (url.pathname === '/api/v1/rpc/snapshot') return json({ ok: true, data: snapshot });
    if (url.pathname === '/api/v1/rpc/ledgerSnapshot') {
      const month = JSON.parse(String(init?.body)).input.month;
      return json({ ok: true, data: ledger(month) });
    }
    throw Error('Unexpected request: ' + url.pathname);
  };
  const controller = createRemoteClient({ origin, storage, fetch: fetcher, events });
  close.push(() => { releases.forEach(release => release()); controller.dispose(); });
  return { controller, calls, hold(path: string) { let release!: () => void; waiting.set(path, new Promise(resolve => { release = resolve; })); releases.push(release); return release; } };
}
function ledger(month: string) {
  return LedgerSnapshotSchema.parse({ revision: 0, entries: [], balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [],
    summary: { month, from: null, to: null, actualPaidCents: 0, personalCents: 0, incomeCents: 0, assetSaleCents: 0, familyUsageCents: 0,
      pendingPersonalCount: 0, pendingAccountCount: 0, uncertainDateCents: 0, cashBalanceCents: null, storedBalanceCents: null, accounts: [], categories: [], days: [] } });
}

describe('calendar startup does not wait for background maintenance', () => {
  it('delivers the first calendar while session renewal is still pending', async () => {
    const f = fixture(), release = f.hold('/api/v1/session/renew');
    const startup = f.controller.initialize();
    await vi.waitFor(() => expect(f.calls).toContain('/api/v1/session/renew'));
    let displayed = false;
    const reading = f.controller.client.snapshot().then(value => { expect(value).toEqual({ ok: true, data: snapshot }); displayed = true; });
    try {
      await vi.waitFor(() => expect(displayed).toBe(true));
      expect(f.calls.filter(path => path === '/api/v1/rpc/snapshot')).toHaveLength(1);
    } finally { release(); await startup; await reading; }
  });

  it('combines overlapping foreground reconnects without duplicate session requests', async () => {
    const f = fixture(), release = f.hold('/api/v1/session');
    const startup = f.controller.initialize();
    await vi.waitFor(() => expect(f.calls).toContain('/api/v1/session'));
    const first = f.controller.reconnect(), second = f.controller.reconnect();
    release(); await Promise.all([startup, first, second]);
    expect(f.calls.filter(path => path === '/api/v1/session')).toHaveLength(1);
  });

  it('releases a read that began before the session arrived without waiting for renewal', async () => {
    const f = fixture(), releaseSession = f.hold('/api/v1/session'), releaseRenewal = f.hold('/api/v1/session/renew');
    const startup = f.controller.initialize();
    await vi.waitFor(() => expect(f.calls).toContain('/api/v1/session'));
    let displayed = false;
    const reading = f.controller.client.snapshot().then(value => { expect(value.ok).toBe(true); displayed = true; });
    releaseSession();
    try { await vi.waitFor(() => expect(displayed).toBe(true)); }
    finally { releaseRenewal(); await startup; await reading; }
  });

  it('retains an event-stream retry that arrives during a pending reconnect', async () => {
    vi.useFakeTimers();
    const sources: Array<{ close: ReturnType<typeof vi.fn>; onerror: ((event: Event) => unknown) | null; addEventListener: ReturnType<typeof vi.fn> }> = [];
    const f = fixture(createMemoryStorage(), url => {
      expect(url).toBe(origin + '/api/v1/events');
      const source = { close: vi.fn(), onerror: null, addEventListener: vi.fn() }; sources.push(source);
      return source as unknown as EventSource;
    });
    const release = f.hold('/api/v1/session/renew'), startup = f.controller.initialize();
    await vi.waitFor(() => expect(f.calls).toContain('/api/v1/session/renew'));
    sources[0]!.onerror?.(new Event('error'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sources[0]!.close).toHaveBeenCalledOnce();
    expect(f.calls.filter(path => path === '/api/v1/session')).toHaveLength(1);
    release(); await startup;
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    await vi.waitFor(() => expect(f.calls.filter(path => path === '/api/v1/rpc/snapshot')).toHaveLength(2));
    expect(f.calls.filter(path => path === '/api/v1/session')).toHaveLength(2);
    expect(f.controller.getState().pending).toEqual([]);
  });

  it('loads historical ledger months only when requested, without discarding their caches', async () => {
    const storage = createMemoryStorage(), cached = emptyPartition(session);
    cached.snapshot = snapshot; cached.ledgers['2020-01'] = ledger('2020-01');
    const key = partitionKey(origin, session);
    await storage.write(key, cached); await storage.write('active:' + origin, key);
    const f = fixture(storage); await f.controller.initialize();
    expect(f.calls).not.toContain('/api/v1/rpc/ledgerSnapshot');
    expect(await storage.read(key)).toMatchObject({ ledgers: cached.ledgers });
    expect((await f.controller.client.ledgerSnapshot({ month: '2020-01' })).ok).toBe(true);
    expect(f.calls.filter(path => path === '/api/v1/rpc/ledgerSnapshot')).toHaveLength(1);
  });
});
