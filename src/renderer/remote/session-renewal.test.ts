import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapshotSchema } from '../../shared/contracts';
import { createRemoteClient } from './client';
import { createMemoryStorage } from './storage';

const day = 86400_000;
const origin = 'https://synthetic-calendar.example';
const identity = { protocolVersion: 1 as const, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 };
const session = { paired: true as const, identity, device: { id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic phone' }, csrfToken: 'synthetic-csrf', aiConfigured: false };
const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture() {
  let at = 1000, authorized = true, renewalStatus = 200, renewalSession = structuredClone(session), failRenew = false;
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); expect(url.origin).toBe(origin); calls.push({ path: url.pathname, init });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/v1/session') return json(authorized ? session : { paired: false });
    if (url.pathname === '/api/v1/session/renew') {
      expect(init.method).toBe('POST'); expect(init.body).toBeUndefined(); expect(init.credentials).toBe('same-origin'); expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).get('X-CSRF-Token')).toBe(session.csrfToken);
      if (failRenew) throw TypeError('Synthetic redirect rejected');
      return json(renewalStatus === 200 ? renewalSession : { ok: false, error: { message: 'Synthetic renewal denied' } }, renewalStatus);
    }
    if (url.pathname === '/api/v1/rpc/snapshot') return json({ ok: true, data: snapshot });
    throw Error('Unexpected business write: ' + url.pathname);
  };
  const storage = createMemoryStorage();
  const controller = createRemoteClient({ origin, storage, fetch: fetcher, now: () => at, timeoutMs: 1000 }); cleanup.push(() => controller.dispose());
  return { controller, calls, storage, advance: (amount: number) => { at += amount; }, setUnauthorized: () => { authorized = false; }, deny: (status: number) => { renewalStatus = status; }, changeIdentity: () => { renewalSession.identity.generation++; }, fail: (value: boolean) => { failRenew = value; } };
}

describe('browser session maintenance', () => {
  it('renews a live session on connection and throttles subsequent reconnects for twelve hours', async () => {
    const f = fixture(); await f.controller.initialize();
    expect(f.controller.getState().status).toBe('online');
    for (let index = 0; index < 4; index++) await f.controller.reconnect();
    expect(f.calls.filter(call => call.path === '/api/v1/session/renew')).toHaveLength(1);
    f.advance(day / 2); await f.controller.reconnect();
    expect(f.calls.filter(call => call.path === '/api/v1/session/renew')).toHaveLength(2);
    expect(f.controller.getState().session?.device.id).toBe(session.device.id);
    expect(f.controller.getState().pending).toEqual([]);
    expect(f.calls.every(call => ['/api/v1/session', '/api/v1/session/renew', '/api/v1/rpc/snapshot'].includes(call.path))).toBe(true);
  });
  it('keeps ordinary reads available after a lost renewal response and retries after backoff only', async () => {
    const f = fixture(); f.fail(true); await f.controller.initialize();
    expect(f.controller.getState().status).toBe('online'); expect((await f.controller.client.snapshot()).ok).toBe(true);
    await f.controller.reconnect(); expect(f.calls.filter(call => call.path === '/api/v1/session/renew')).toHaveLength(1);
    f.advance(5 * 60_000); f.fail(false); await f.controller.reconnect();
    expect(f.calls.filter(call => call.path === '/api/v1/session/renew')).toHaveLength(2);
    expect(f.controller.getState().status).toBe('online'); expect(f.controller.getState().pending).toEqual([]);
  });
  it('never renews a server-declared unpaired device', async () => {
    const f = fixture(); f.setUnauthorized(); await f.controller.initialize();
    expect(f.controller.getState().status).toBe('unpaired');
    expect(f.calls.filter(call => call.path === '/api/v1/session/renew')).toHaveLength(0);
  });
  it('makes renewal revocation sticky instead of starting canonical reads or restoring cached auth', async () => {
    const f = fixture(); f.deny(401); await f.controller.initialize();
    expect(f.controller.getState().status).toBe('expired'); expect(f.controller.getState().session).toBeNull();
    expect(f.calls.some(call => call.path.startsWith('/api/v1/rpc/'))).toBe(false);
    expect(await f.controller.client.snapshot()).toMatchObject({ ok: false, error: { code: 'AUTH' } });
  });
  it('rejects a renewal response for another data generation without replaying business operations', async () => {
    const f = fixture(); f.changeIdentity(); await f.controller.initialize();
    expect(f.controller.getState().status).toBe('expired'); expect(f.controller.getState().message).toContain('资料身份');
    expect(f.calls.some(call => call.path.startsWith('/api/v1/rpc/'))).toBe(false);
  });
  it('uses a bounded timer only while active and cancels it on dispose', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.controller.initialize();
    f.advance(day / 2); await vi.advanceTimersByTimeAsync(day / 2);
    expect(f.calls.filter(call => call.path === '/api/v1/session/renew')).toHaveLength(2);
    f.controller.dispose(); f.advance(day); await vi.advanceTimersByTimeAsync(day);
    expect(f.calls.filter(call => call.path === '/api/v1/session/renew')).toHaveLength(2);
  });
  it('does not keep a hidden page authorized indefinitely and renews on returning to the visible app', async () => {
    const documentState = { visibilityState: 'hidden', addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('document', documentState);
    const f = fixture(); await f.controller.initialize(); f.advance(day); await f.controller.reconnect();
    expect(f.calls.filter(call => call.path === '/api/v1/session/renew')).toHaveLength(0);
    documentState.visibilityState = 'visible'; await f.controller.reconnect();
    expect(f.calls.filter(call => call.path === '/api/v1/session/renew')).toHaveLength(1);
    expect(f.controller.getState().status).toBe('online');
  });
});
