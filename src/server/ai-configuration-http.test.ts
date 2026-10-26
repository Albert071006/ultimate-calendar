import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createRemoteService } from './service';
import { createRemoteHttpServer } from './http';
import { createManagedApiKeyConfiguration } from './ai-configuration';
import { RemoteSessionSchema } from '../shared/remote';

const origin = 'http://localhost:3210', endpoint = '/api/v1/ai/config';
const firstKey = 'sk-synthetic-private-key-first-1234', secondKey = 'sk-synthetic-private-key-second-5678';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(options: { directory?: string; external?: string; fetch?: typeof fetch } = {}) {
  const folder = options.directory ?? mkdtempSync(join(tmpdir(), 'planner-ai-config-http-'));
  if (!options.directory) cleanup.push(async () => { rmSync(folder, { recursive: true, force: true }); });
  const credentials = createManagedApiKeyConfiguration(join(folder, 'ai-credentials.json'));
  const transport = vi.fn(options.fetch ?? (async () => { throw Error('Tests must not call real AI'); }));
  const service = createRemoteService({
    dataDirectory: folder, backupDirectory: join(folder, 'safe-exports'),
    apiKeyConfiguration: options.external === undefined ? credentials : undefined,
    // A managed configuration must take precedence over this legacy provider.
    getApiKey: async () => options.external ?? 'synthetic-unused-legacy-provider',
    controller: { fetch: transport, now: () => '2026-10-22T20:00:00+08:00' },
  });
  const http = createRemoteHttpServer({ service, origin, secureCookie: false });
  const port = await http.listen(0);
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await http.close(); await service.close(); };
  cleanup.push(close);
  const call = (path: string, init: RequestInit = {}): Promise<Response> => new Promise((done, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method: init.method, headers: { Host: 'localhost:3210', ...(typeof init.body === 'string' ? { 'Content-Length': String(Buffer.byteLength(init.body)) } : {}), ...init.headers as Record<string, string> } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => {
        const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        done(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on('error', reject); if (init.body) request.write(init.body); request.end();
  });
  const pair = async () => {
    const response = await call('/api/v1/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: service.state.createPairingCode(), name: '虚构配置设备' }) });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const session = RemoteSessionSchema.parse(await response.json());
    if (!session.paired) throw Error('Expected paired fixture');
    return { session, cookie, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken } };
  };
  return { folder, credentials, service, transport, call, pair, close };
}

describe('private AI configuration HTTP contract', () => {
  it('requires a paired session and the existing same-origin/CSRF protection for changes', async () => {
    const { call, pair, credentials, transport } = await setup();
    expect((await call(endpoint)).status).toBe(401);
    expect((await call(endpoint, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    const { headers, cookie, session } = await pair();
    const body = JSON.stringify({ identity: session.identity, expectedRevision: null, apiKey: firstKey });
    for (const method of ['PUT', 'DELETE']) {
      expect((await call(endpoint, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body })).status).toBe(403);
      expect((await call(endpoint, { method, headers: { ...headers, Origin: 'https://untrusted.example' }, body })).status).toBe(403);
      expect((await call(endpoint, { method, headers: { ...headers, Origin: '' }, body })).status).toBe(403);
    }
    expect((await call(endpoint, { headers: { ...headers, Host: 'untrusted.example' } })).status).toBe(403);
    expect((await call(endpoint, { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await call(endpoint, { method: 'POST', headers, body })).status).toBe(405);
    expect((await call('/api/v1/rpc/setApiKey', { method: 'POST', headers, body })).status).toBe(400);
    const response = await call(endpoint, { headers });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, identity: session.identity, configuration: { provider: 'deepseek', configured: false, editable: true, source: 'none', revision: null } });
    expect(await credentials.getApiKey()).toBeNull(); expect(transport).not.toHaveBeenCalled();
  });

  it('persists saves and clear tombstones across restarts and updates session/snapshot state', async () => {
    const fixture = await setup(); const { headers, session } = await fixture.pair();
    const events: unknown[] = []; fixture.service.subscribe(event => events.push(event));
    const saved = await fixture.call(endpoint, { method: 'PUT', headers, body: JSON.stringify({ identity: session.identity, expectedRevision: null, apiKey: `  ${firstKey}\n` }) });
    expect(saved.status).toBe(200); const result = await saved.json();
    expect(result).toMatchObject({ ok: true, configuration: { configured: true, editable: true, source: 'managed', revision: expect.any(String) } });
    expect(await fixture.credentials.getApiKey()).toBe(firstKey); expect(events).toEqual([{ reason: 'key' }]);
    expect(await (await fixture.call('/api/v1/session', { headers })).json()).toMatchObject({ aiConfigured: true });
    const snapshot = await fixture.call('/api/v1/rpc/snapshot', { method: 'POST', headers, body: JSON.stringify({ identity: session.identity, requestId: 'configured-snapshot' }) });
    expect(await snapshot.json()).toMatchObject({ ok: true, data: { keyStatus: { configured: true, sessionOnly: false } } });
    await fixture.close();
    const restarted = await setup({ directory: fixture.folder });
    expect(await (await restarted.call(endpoint, { headers })).json()).toEqual(result);
    const cleared = await restarted.call(endpoint, { method: 'DELETE', headers, body: JSON.stringify({ identity: session.identity, expectedRevision: result.configuration.revision }) });
    expect(cleared.status).toBe(200); const deleted = await cleared.json();
    expect(deleted.configuration).toMatchObject({ configured: false, source: 'none', revision: expect.any(String) });
    expect(deleted.configuration.revision).not.toBe(result.configuration.revision);
    expect(await restarted.credentials.getApiKey()).toBeNull();
    expect(await (await restarted.call('/api/v1/session', { headers })).json()).toMatchObject({ aiConfigured: false });
    await restarted.close();
    const third = await setup({ directory: fixture.folder });
    expect(await (await third.call(endpoint, { headers })).json()).toEqual(deleted);
    expect((await third.call(endpoint, { method: 'PUT', headers, body: JSON.stringify({ identity: session.identity, expectedRevision: null, apiKey: firstKey }) })).status).toBe(409);
    expect(await third.credentials.getApiKey()).toBeNull();
    expect(fixture.transport).not.toHaveBeenCalled(); expect(restarted.transport).not.toHaveBeenCalled();
  });

  it('rejects invalid, oversized, stale-generation and conflicting writes without replacing the accepted key', async () => {
    const { call, pair, credentials, service } = await setup(); const { headers, session } = await pair();
    const input = { identity: session.identity, expectedRevision: null, apiKey: firstKey };
    const outcomes = await Promise.all([firstKey, secondKey].map(apiKey => call(endpoint, { method: 'PUT', headers, body: JSON.stringify({ ...input, apiKey }) })));
    expect(outcomes.map(response => response.status).sort()).toEqual([200, 409]);
    const initial = await (await call(endpoint, { headers })).json(), current = await credentials.getApiKey();
    const valid = { ...input, expectedRevision: initial.configuration.revision };
    for (const invalid of [
      { body: { ...valid, apiKey: 'short' }, status: 400 },
      { body: { ...valid, apiKey: `${firstKey}\nextra` }, status: 400 },
      { body: { ...valid, apiKey: firstKey, baseUrl: 'https://untrusted.example' }, status: 400 },
      { body: { ...valid, identity: { ...session.identity, generation: session.identity.generation + 1 } }, status: 409 },
    ]) {
      const response = await call(endpoint, { method: 'PUT', headers, body: JSON.stringify(invalid.body) });
      expect(response.status).toBe(invalid.status);
      expect(await response.text()).not.toContain(firstKey);
    }
    expect((await call(endpoint, { method: 'PUT', headers, body: JSON.stringify({ ...valid, apiKey: 'x'.repeat(5000) }) })).status).toBe(413);
    expect((await call(endpoint, { method: 'PUT', headers: { ...headers, 'Content-Type': 'text/plain' }, body: JSON.stringify(valid) })).status).toBe(415);
    expect((await call(endpoint, { method: 'DELETE', headers, body: JSON.stringify({ identity: session.identity, expectedRevision: null }) })).status).toBe(409);
    expect(await credentials.getApiKey()).toBe(current);
    expect(await (await call(endpoint, { headers })).json()).toEqual(initial);
    service.state.advanceGeneration();
    expect((await call(endpoint, { method: 'DELETE', headers, body: JSON.stringify({ identity: session.identity, expectedRevision: initial.configuration.revision }) })).status).toBe(409);
    expect(await credentials.getApiKey()).toBe(current);
  });

  it('uses the saved key for subsequent model requests without leaking it into responses, receipts or backups', async () => {
    const authorization: (string | null)[] = [];
    const fixture = await setup({ fetch: async (_url, init) => {
      authorization.push(new Headers(init?.headers).get('authorization'));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'query', reply: '合成查询', fromDate: '2026-10-22', toDate: '2026-10-23' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80 } }), { status: 200 });
    } });
    const { headers, session } = await fixture.pair(); let revision: string | null = null;
    const publicResponses: string[] = [];
    for (const [index, apiKey] of [firstKey, secondKey].entries()) {
      const save = await fixture.call(endpoint, { method: 'PUT', headers, body: JSON.stringify({ identity: session.identity, expectedRevision: revision, apiKey }) });
      expect(save.status).toBe(200); const status = await save.json(); revision = status.configuration.revision; publicResponses.push(JSON.stringify(status));
      expect(fixture.transport).toHaveBeenCalledTimes(index);
      const response = await fixture.call('/api/v1/rpc/command', { method: 'POST', headers, body: JSON.stringify({ identity: session.identity, requestId: `query-${index}`, input: { operationId: `query-${index}`, text: '今天有什么安排' } }) });
      const result = await response.json(); expect(result.ok).toBe(true); publicResponses.push(JSON.stringify(result));
      publicResponses.push(await (await fixture.call(`/api/v1/operations/query-${index}`, { headers })).text());
    }
    expect(authorization).toEqual([`Bearer ${firstKey}`, `Bearer ${secondKey}`]);
    publicResponses.push(await (await fixture.call('/api/v1/session', { headers })).text());
    publicResponses.push(await (await fixture.call('/api/v1/status', { headers })).text());
    publicResponses.push(await (await fixture.call('/api/v1/rpc/snapshot', { method: 'POST', headers, body: JSON.stringify({ identity: session.identity, requestId: 'privacy-snapshot' }) })).text());
    fixture.service.backup(); await fixture.close();
    function walk(directory: string): string[] { return readdirSync(directory).flatMap(name => { const path = join(directory, name); return statSync(path).isDirectory() ? walk(path) : [path]; }); }
    const persisted = walk(fixture.folder).filter(path => path !== join(fixture.folder, 'ai-credentials.json'));
    for (const key of [firstKey, secondKey]) {
      for (const response of publicResponses) expect(response).not.toContain(key);
      for (const file of persisted) expect(readFileSync(file).includes(Buffer.from(key))).toBe(false);
    }
    expect(persisted.some(path => path.includes('safe-exports'))).toBe(true);
  });

  it('keeps administrator-supplied keys read-only and refuses configuration changes while draining', async () => {
    const external = await setup({ external: firstKey }); const { headers, session } = await external.pair();
    const status = await (await external.call(endpoint, { headers })).json();
    expect(status.configuration).toEqual({ provider: 'deepseek', configured: true, editable: false, source: 'external', revision: null });
    for (const method of ['PUT', 'DELETE']) {
      const response = await external.call(endpoint, { method, headers, body: JSON.stringify({ identity: session.identity, expectedRevision: null, ...(method === 'PUT' ? { apiKey: secondKey } : {}) }) });
      expect(response.status).toBe(403); expect(await response.text()).not.toContain(firstKey);
    }
    expect(await external.service.aiConfigured()).toBe(true);
    external.service.beginShutdown();
    expect((await external.call(endpoint, { headers })).status).toBe(503);
    expect((await external.call(endpoint, { method: 'PUT', headers, body: JSON.stringify({ identity: session.identity, expectedRevision: null, apiKey: secondKey }) })).status).toBe(503);
    expect(external.transport).not.toHaveBeenCalled();
  });
});
