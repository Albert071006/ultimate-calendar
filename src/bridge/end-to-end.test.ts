import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createRepository } from '../storage/repository';
import { createRemoteService } from '../server/service';
import { createRemoteHttpServer } from '../server/http';
import { createNodeRemoteClient } from '../remote/node-client';
import { MutationRequestSchema, MutationResultSchema } from '../shared/contracts';
import { parseBridgeConfig } from './config';
import { createQQCloudBridge, type BridgeTransport } from './service';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'uc-bridge-e2e-'));
  cleanup.push(() => { const rel = relative(tmpdir(), root); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Unsafe synthetic cleanup'); rmSync(root, { recursive: true, force: true }); });
  const source = createRepository(join(root, 'synthetic-local.sqlite'), { automaticBackup: () => {} }); cleanup.push(() => source.close());
  const localSource = source.writeInternal({ operationId: 'synthetic-local-source', changes: [{ entity: 'source', values: { kind: 'text', text: 'RAW_NEVER_UPLOAD QQ 900010001 group 900020002 C:\\private\\raw.pdf', label: 'PRIVATE_GROUP_LABEL', importedAt: '2020-01-01T00:00:00+08:00', captureRef: { messageId: 'PRIVATE_MESSAGE', accountId: '900010001', groupId: '900020002', attachmentId: null, locator: 'PRIVATE_ATTACHMENT_LOCATION', transcribed: false } } }] }).entities[0]!;
  const values = { title: '提交合成报告', action: '整理材料后提交', sourceIds: [localSource.id], sourceQuote: 'RAW_NEVER_UPLOAD', temporalEvidence: [] };
  const candidate = source.writeInternal({ operationId: 'synthetic-candidate', changes: [{ entity: 'candidate', values }] }).entities[0]!;
  source.writeInternal({ operationId: 'synthetic-duplicate-candidate', changes: [{ entity: 'candidate', values }] });
  const service = createRemoteService({ dataDirectory: join(root, 'cloud-data'), backupDirectory: join(root, 'cloud-backups'), getApiKey: async () => null, controller: { fetch: async () => { throw Error('Synthetic bridge must not call any model or external network'); } } });
  cleanup.push(() => service.close());
  const origin = 'http://localhost:3327'; const http = createRemoteHttpServer({ service, origin, secureCookie: false }); const port = await http.listen(0); cleanup.push(() => http.close());
  const requests: { path: string; body: string }[] = [];
  const localFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); if (url.origin !== origin) throw Error('External network forbidden');
    requests.push({ path: url.pathname, body: typeof init.body === 'string' ? init.body : '' });
    return new Promise((done, reject) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const request = httpRequest(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { method: init.method, signal: init.signal ?? undefined, headers: { ...headers, Host: 'localhost:3327' } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('error', reject);
        response.on('end', () => {
          const resultHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) resultHeaders.append(name, item);
          done(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: resultHeaders }));
        });
      }); request.on('error', reject); request.end(typeof init.body === 'string' ? init.body : undefined);
    });
  };
  const credentialsFile = join(root, 'synthetic-credentials.json');
  function client() { const value = createNodeRemoteClient({ origin, credentialsFile, fetch: localFetch }); cleanup.push(() => value.close()); return value; }
  const remote = client(); const paired = await remote.pair(service.state.createPairingCode(), '合成QQ采集设备');
  const config = parseBridgeConfig({ version: 1, enabled: true, sourceDatabase: source.path, outboxDatabase: join(root, 'outbox.sqlite'), credentialsFile, origin, identity: paired.identity, deviceId: paired.deviceId });
  return { root, source, candidate, service, remote, client, config, requests };
}

describe('local synthetic QQ extraction to cloud inbox', () => {
  it('recovers a lost HTTP receipt after bridge restart and deduplicates across duplicate local candidates', async () => {
    const f = await setup(); let now = 1000; let lose = true;
    const flaky: BridgeTransport = { origin: f.remote.origin, getSession: f.remote.getSession, async sendDistilled(request, options) {
      const result = await f.remote.sendDistilled(request, options); if (lose) { lose = false; throw Error('RAW_PRIVATE_PROVIDER_ERROR C:\\private'); } return result;
    } };
    const first = createQQCloudBridge(f.config, flaky, { now: () => now }); cleanup.push(() => first.close());
    const interrupted = await first.once(); expect(interrupted).toMatchObject({ queued: 1, duplicates: 1, issue: 'network', outbox: { pending: 1 } });
    expect(f.service.snapshot().candidates).toHaveLength(1); await first.close(); f.remote.close();
    now = 6000; const nextRemote = f.client(); const restarted = createQQCloudBridge(f.config, nextRemote, { now: () => now }); cleanup.push(() => restarted.close());
    expect(await restarted.once()).toMatchObject({ accepted: 1, outbox: { accepted: 1, pending: 0 } });
    await restarted.once(); expect(f.service.snapshot().candidates).toHaveLength(1);
    const sends = f.requests.filter(request => request.path === '/api/v1/distilled'); expect(sends).toHaveLength(2); expect(sends[0]!.body).toBe(sends[1]!.body);
    const visible = sends.map(request => request.body).join('') + JSON.stringify(f.service.snapshot()) + readdirSync(f.root).filter(name => name.startsWith('outbox.sqlite')).map(name => readFileSync(join(f.root, name)).toString('utf8')).join('');
    const credential = JSON.parse(readFileSync(f.config.credentialsFile, 'utf8'));
    for (const secret of ['RAW_NEVER_UPLOAD', 'PRIVATE_GROUP_LABEL', 'PRIVATE_MESSAGE', 'PRIVATE_ATTACHMENT_LOCATION', '900010001', '900020002', 'C:\\private', 'RAW_PRIVATE_PROVIDER_ERROR', f.config.sourceDatabase, f.config.credentialsFile, credential.cookie]) expect(visible).not.toContain(secret);
  });

  it('exports a changed summary as a new candidate and leaves an already accepted task unchanged', async () => {
    const f = await setup(); const bridge = createQQCloudBridge(f.config, f.remote); cleanup.push(() => bridge.close()); await bridge.once();
    const original = f.service.snapshot().candidates[0]!; const operationId = crypto.randomUUID();
    const request = MutationRequestSchema.parse({ operationId, origin: 'manual', mutations: [{ type: 'acceptCandidate', id: original.id, expectedVersion: original.version }] });
    const proposed = await f.remote.rpc('mutate', request); if (!proposed.ok) throw Error('Synthetic acceptance failed');
    const result = MutationResultSchema.parse(proposed.data);
    if (result.status === 'preview') expect(await f.remote.rpc('mutate', { ...request, confirmed: true, confirmationToken: result.confirmationToken })).toMatchObject({ ok: true, data: { status: 'applied' } });
    else expect(result.status).toBe('applied');
    expect(f.service.snapshot().candidates[0]!.status).toBe('accepted'); const task = f.service.snapshot().tasks[0]!;
    f.source.writeInternal({ operationId: 'synthetic-summary-update', changes: [{ entity: 'candidate', id: f.candidate.id, expectedVersion: f.candidate.version, values: { title: '提交变更后的合成报告' } }] });
    await bridge.once(); const current = f.service.snapshot(); expect(current.candidates).toHaveLength(2);
    expect(current.candidates.find(candidate => candidate.id === original.id)!.status).toBe('accepted');
    expect(current.tasks.find(candidate => candidate.id === task.id)).toEqual(task);
    expect(current.candidates.find(candidate => candidate.id !== original.id)).toMatchObject({ title: '提交变更后的合成报告', status: 'pending' });
  });
});
