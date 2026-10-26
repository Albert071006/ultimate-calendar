import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createRemoteService } from './service';
import { createRemoteHttpServer, type RemoteHttpOptions } from './http';
import { RemoteState } from './state';

const primary = 'https://private.example.test', publicOrigin = 'https://calendar.example.test';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(overrides: Partial<Pick<RemoteHttpOptions, 'publicOrigin' | 'trustLoopbackProxy' | 'publicRateLimits'>> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'calendar-public-origin-'));
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const dataDirectory = join(root, 'data'), staticDirectory = join(root, 'web'); mkdirSync(dataDirectory); mkdirSync(staticDirectory);
  writeFileSync(join(staticDirectory, 'index.html'), '<!doctype html><title>Synthetic calendar</title>');
  let now = Date.parse('2030-01-01T00:00:00Z');
  const state = new RemoteState(join(dataDirectory, 'remote-state.sqlite'), () => now);
  const service = createRemoteService({ dataDirectory, state, startupBackup: false, getApiKey: async () => null,
    controller: { fetch: async () => { throw Error('No real AI in tests'); } } });
  const http = createRemoteHttpServer({ service, origin: primary, publicOrigin, staticDirectory, now: () => now, ...overrides });
  const port = await http.listen(0);
  cleanup.push(async () => { await http.close(); await service.close(); state.close(); });
  const call = (origin: string, path: string, init: RequestInit = {}): Promise<Response> => new Promise((done, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method: init.method,
      headers: { Host: new URL(origin).host, ...init.headers as Record<string, string> } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => {
        const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        done(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    }); request.on('error', reject); if (init.body) request.write(init.body); request.end();
  });
  const pair = async (origin = primary) => {
    const response = await call(origin, '/api/v1/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: state.createPairingCode(), name: 'Synthetic device' }) });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!, session = await response.json();
    return { cookie, session, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken } };
  };
  const attempt = (ip: string, code = 'synthetic-invalid-pairing-code-which-is-long-enough', origin = publicOrigin) => call(origin, '/api/v1/pair', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ code, name: 'Synthetic device' }),
  });
  return { service, state, call, pair, attempt, now: () => now, advance(ms: number) { now += ms; } };
}

describe('explicit public HTTPS origin', () => {
  it('shares one data service across exact hosts while rejecting mixed origins and unknown hosts', async () => {
    const f = await setup(), desktop = await f.pair(), phone = await f.pair(publicOrigin);
    expect(phone.session.identity).toEqual(desktop.session.identity);
    for (const origin of [primary, publicOrigin]) expect(await (await f.call(origin, '/')).text()).toContain('Synthetic calendar');
    const mutation = await f.call(primary, '/api/v1/rpc/mutate', { method: 'POST', headers: desktop.headers,
      body: JSON.stringify({ requestId: 'synthetic-public-goal', identity: desktop.session.identity,
        input: { operationId: 'synthetic-public-goal', origin: 'manual', mutations: [{ type: 'create', entity: 'goal', values: { title: 'Shared synthetic goal' } }] } }) });
    expect((await mutation.json()).data.status).toBe('applied');
    const read = await f.call(publicOrigin, '/api/v1/rpc/snapshot', { method: 'POST', headers: phone.headers,
      body: JSON.stringify({ requestId: 'synthetic-public-read', identity: phone.session.identity }) });
    expect((await read.json()).data.goals[0].title).toBe('Shared synthetic goal');
    expect((await f.call(publicOrigin, '/api/v1/session', { headers: { Origin: primary } })).status).toBe(403);
    expect((await f.call(primary, '/api/v1/session', { headers: { Origin: publicOrigin } })).status).toBe(403);
    expect((await f.call('https://unexpected.example.test', '/')).status).toBe(403);
    expect((await f.call(publicOrigin, '/api/v1/logout', { method: 'POST', headers: { ...phone.headers, Origin: primary } })).status).toBe(403);
    expect((await f.call(publicOrigin, '/api/v1/session', { headers: { Cookie: phone.cookie } })).status).toBe(200);
  });

  it('hides private collector and operational routes even from a paired public client', async () => {
    const f = await setup(), device = await f.pair(publicOrigin);
    for (const path of ['/healthz', '/readyz', '/api/v1/status', '/api/v1/distilled', '/api/v1/ai/receiver/sync']) {
      for (const suffix of ['', '/extra']) expect((await f.call(publicOrigin, path + suffix, { method: 'POST', headers: device.headers, body: '{}' })).status).toBe(404);
      expect((await f.call(publicOrigin, path)).status).toBe(404);
    }
    const privateDevice = await f.pair();
    for (const path of ['/healthz', '/readyz', '/api/v1/status']) expect((await f.call(primary, path, { headers: privateDevice.headers })).status).toBe(200);
    for (const path of ['/api/v1/distilled', '/api/v1/ai/receiver/sync']) expect((await f.call(primary, path, { method: 'POST', headers: privateDevice.headers, body: '{}' })).status).toBe(400);
    expect((await f.call(publicOrigin, '/api/v1/ai/config', { headers: device.headers })).status).toBe(200);
  });

  it('does not enable the public host implicitly or accept wildcard/plain HTTP public configuration', async () => {
    const f = await setup({ publicOrigin: undefined });
    expect((await f.call(publicOrigin, '/api/v1/session')).status).toBe(403);
    for (const value of [primary, 'https://*.example.test', 'http://calendar.example.test', `${publicOrigin}/`, `${publicOrigin}/path`, 'https://user:password@calendar.example.test']) {
      expect(() => createRemoteHttpServer({ service: f.service, origin: primary, publicOrigin: value })).toThrow();
    }
    expect(() => createRemoteHttpServer({ service: f.service, origin: primary, trustLoopbackProxy: true })).toThrow();
    expect(() => createRemoteHttpServer({ service: f.service, origin: 'http://localhost:3210', publicOrigin })).toThrow();
  });
});

describe('bounded public request rate limits', () => {
  it('ignores spoofed forwarded addresses unless loopback proxy trust was explicitly enabled', async () => {
    const f = await setup({ publicRateLimits: { unauthenticatedPerIp: 2 } });
    for (const ip of ['203.0.113.1', '203.0.113.2']) expect((await f.call(publicOrigin, '/api/v1/session', { headers: { 'X-Forwarded-For': ip } })).status).toBe(200);
    const limited = await f.call(publicOrigin, '/api/v1/session', { headers: { 'X-Forwarded-For': '203.0.113.3' } });
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
    expect((await f.call(primary, '/api/v1/session')).status).toBe(200);
    f.advance(60_001); expect((await f.call(publicOrigin, '/api/v1/session')).status).toBe(200);
  });

  it('normalizes trusted IPv6/mapped addresses and rejects lists, ports and zones', async () => {
    const f = await setup({ trustLoopbackProxy: true, publicRateLimits: { unauthenticatedPerIp: 1 } });
    for (const ip of ['203.0.113.4, 203.0.113.5', '203.0.113.4:443', 'fe80::1%eth0', 'invalid']) {
      expect((await f.call(publicOrigin, '/api/v1/session', { headers: { 'X-Forwarded-For': ip } })).status).toBe(400);
    }
    expect((await f.call(publicOrigin, '/api/v1/session', { headers: { 'X-Forwarded-For': '203.0.113.4' } })).status).toBe(200);
    expect((await f.call(publicOrigin, '/api/v1/session', { headers: { 'X-Forwarded-For': '::ffff:203.0.113.4' } })).status).toBe(429);
    expect((await f.call(publicOrigin, '/api/v1/session', { headers: { 'X-Forwarded-For': '2001:db8::1' } })).status).toBe(200);
    expect((await f.call(publicOrigin, '/api/v1/session', { headers: { 'X-Forwarded-For': '2001:0db8:0:0:0:0:0:1' } })).status).toBe(429);
  });

  it('limits pairing per client and globally without consuming the shared code or throttling the private entry', async () => {
    const f = await setup({ trustLoopbackProxy: true, publicRateLimits: { pairingPerIp: 2, pairingGlobal: 3 } });
    const code = f.state.createPairingCode();
    expect((await f.attempt('203.0.113.1')).status).toBe(403);
    expect((await f.attempt('203.0.113.1')).status).toBe(403);
    expect((await f.attempt('203.0.113.1', code)).status).toBe(429);
    expect((await f.attempt('203.0.113.2')).status).toBe(403);
    expect((await f.attempt('203.0.113.3', code)).status).toBe(429);
    expect((await f.attempt('203.0.113.1', code, primary)).status).toBe(200);
  });

  it('caps client tracking and reclaims expired buckets instead of evicting live limits', async () => {
    const f = await setup({ trustLoopbackProxy: true, publicRateLimits: { maxClients: 2 } });
    const call = (ip: string) => f.call(publicOrigin, '/api/v1/session', { headers: { 'X-Forwarded-For': ip } });
    expect((await call('203.0.113.1')).status).toBe(200); expect((await call('203.0.113.2')).status).toBe(200);
    expect((await call('203.0.113.3')).status).toBe(429); expect((await call('203.0.113.1')).status).toBe(200);
    f.advance(60_001); expect((await call('203.0.113.3')).status).toBe(200);
  });

  it('also limits authenticated public request floods without changing private requests', async () => {
    const f = await setup({ publicRateLimits: { requestsPerIp: 2 } }), device = await f.pair(publicOrigin);
    expect((await f.call(publicOrigin, '/api/v1/session', { headers: device.headers })).status).toBe(200);
    expect((await f.call(publicOrigin, '/api/v1/session', { headers: device.headers })).status).toBe(429);
    expect((await f.call(primary, '/api/v1/session', { headers: { Cookie: device.cookie } })).status).toBe(200);
  });
});

describe('session renewal HTTP contract', () => {
  it('requires pairing, matching origin and CSRF and renews an aging valid cookie without changing device identity', async () => {
    const f = await setup(), device = await f.pair(publicOrigin);
    const empty = { method: 'POST', headers: { Origin: publicOrigin } };
    expect((await f.call(publicOrigin, '/api/v1/session/renew', empty)).status).toBe(401);
    expect((await f.call(publicOrigin, '/api/v1/session/renew', { method: 'POST', headers: { Cookie: device.cookie, Origin: publicOrigin } })).status).toBe(403);
    expect((await f.call(publicOrigin, '/api/v1/session/renew', { method: 'POST', headers: { ...device.headers, Origin: primary } })).status).toBe(403);
    f.advance(86400_000);
    const early = await f.call(publicOrigin, '/api/v1/session/renew', { method: 'POST', headers: device.headers });
    expect(early.status).toBe(200); expect(early.headers.get('set-cookie')).toContain(`Max-Age=${29 * 86400};`);
    f.advance(15 * 86400_000);
    const renewed = await f.call(publicOrigin, '/api/v1/session/renew', { method: 'POST', headers: device.headers });
    expect(renewed.status).toBe(200); expect(await renewed.json()).toEqual(device.session);
    expect(renewed.headers.get('set-cookie')).toContain(`${device.cookie};`);
    expect(renewed.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict; Max-Age=2592000; Secure');
    expect((await f.call(publicOrigin, '/api/v1/session/renew', { method: 'POST', headers: device.headers, body: '{}' })).status).toBe(400);
    f.advance(15 * 86400_000);
    expect((await f.call(publicOrigin, '/api/v1/session', { headers: device.headers })).status).toBe(200);
    expect((await (await f.call(publicOrigin, '/api/v1/session', { headers: device.headers })).json()).paired).toBe(true);
    f.state.revoke(device.session.device.id);
    expect((await f.call(publicOrigin, '/api/v1/session/renew', { method: 'POST', headers: device.headers })).status).toBe(401);
  });

  it('recovers a lost renewal response with a cookie bounded by the already committed database expiry', async () => {
    const f = await setup(), device = await f.pair(publicOrigin);
    const token = device.cookie.slice(device.cookie.indexOf('=') + 1);
    f.advance(16 * 86400_000);
    const lost = await f.call(publicOrigin, '/api/v1/session/renew', { method: 'POST', headers: device.headers });
    expect(lost.status).toBe(200);
    const committedExpiry = f.state.renewSession(token)!.expiresAt;
    // The client did not apply the previous Set-Cookie. It retries using its unchanged valid cookie.
    f.advance(86400_000 + 2345);
    const retried = await f.call(publicOrigin, '/api/v1/session/renew', { method: 'POST', headers: device.headers });
    expect(retried.status).toBe(200); expect(await retried.json()).toEqual(device.session);
    expect(retried.headers.get('set-cookie')).toContain(`${device.cookie};`);
    const remaining = Math.floor((Date.parse(committedExpiry) - f.now()) / 1000);
    expect(retried.headers.get('set-cookie')).toContain(`Max-Age=${remaining};`);
    expect(remaining).toBe(29 * 86400 - 3);
    expect(f.state.renewSession(token)).toMatchObject({ renewed: false, expiresAt: committedExpiry });
  });
});
