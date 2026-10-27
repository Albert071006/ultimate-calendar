import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createRemoteService } from './service';
import { createRemoteHttpServer } from './http';
import { RemoteState } from './state';
import { createPushStore } from './push-store';
import { createPushHttpExtension } from './push-http';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(directory?: string) {
  const folder = directory ?? mkdtempSync(join(tmpdir(), 'planner-remote-test-'));
  if (!directory) cleanup.push(async () => { rmSync(folder, { recursive: true, force: true }); });
  const service = createRemoteService({ dataDirectory: folder, backupDirectory: join(folder, 'safe-exports'), getApiKey: async () => 'synthetic-api-key-never-send', controller: { fetch: async () => { throw Error('Tests must not call real AI'); } } });
  const pushStore = createPushStore(join(folder, 'notifications.sqlite'));
  const http = createRemoteHttpServer({ service, origin: 'http://localhost:3210', secureCookie: false, extension: createPushHttpExtension({ store: pushStore, publicKey: null }), onRevokeDevice: id => pushStore.revokeDevice(id) });
  const port = await http.listen(0);
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await http.close(); pushStore.close(); await service.close(); };
  cleanup.push(close);
  const call = (path: string, init: RequestInit = {}): Promise<Response> => new Promise((done, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method: init.method, headers: { Host: 'localhost:3210', ...init.headers as Record<string, string> } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => {
        const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        done(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    }); request.on('error', reject); if (init.body) request.write(init.body); request.end();
  });
  const pair = async () => {
    const code = service.state.createPairingCode();
    const response = await call('/api/v1/pair', { method: 'POST', headers: { Origin: 'http://localhost:3210', 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: '虚构手机' }) });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const session = await response.json();
    return { code, cookie, session, headers: { Cookie: cookie, Origin: 'http://localhost:3210', 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken } };
  };
  return { folder, service, call, pair, close };
}
const goalInput = (title = '虚构目标') => ({ operationId: 'goal-business-1', origin: 'manual', mutations: [{ type: 'create', entity: 'goal', values: { title } }] });

describe('remote HTTP boundary', () => {
  it('shares single-slot completion atomically across devices and keeps explicit multi-slot mode after restart', async () => {
    let fixture = await setup();
    const first = await fixture.pair(), second = await fixture.pair();
    let serial = 0;
    const rpc = async (method: string, input?: unknown, device = first, requestId = `slot-http-${++serial}`) => {
      const response = await fixture.call(`/api/v1/rpc/${method}`, { method: 'POST', headers: device.headers,
        body: JSON.stringify({ requestId, identity: device.session.identity, input }) });
      expect(response.status).toBe(200); const result = await response.json(); expect(result.ok).toBe(true); return result.data;
    };
    const mutate = (mutations: unknown[]) => rpc('mutate', { operationId: `slot-operation-${++serial}`, origin: 'manual', confirmed: false, mutations });
    await mutate([{ type: 'create', entity: 'task', values: { title: '合成单时段任务' } }]);
    const taskId = fixture.service.snapshot().tasks[0]!.id;
    const slot = (hour: string) => ({ title: '合成执行时段', kind: 'work', taskId, start: `2040-01-01T${hour}:00:00+08:00`, end: `2040-01-01T${hour}:30:00+08:00` });
    await mutate([{ type: 'create', entity: 'block', values: slot('09') }]);
    const block = fixture.service.snapshot().blocks[0]!;
    const input = { operationId: 'slot-completion-once', origin: 'manual', confirmed: false,
      mutations: [{ type: 'finishBlock', id: block.id, expectedVersion: block.version, completed: true }] };
    const completed = await rpc('mutate', input, first, 'slot-completion-request');
    expect(completed.status).toBe('applied');
    const remoteSnapshot = await rpc('snapshot', undefined, second);
    expect(remoteSnapshot.tasks[0].status).toBe('done'); expect(remoteSnapshot.blocks[0].completed).toBe(true);
    expect(await rpc('mutate', input, first, 'slot-completion-request')).toEqual(completed);
    expect(fixture.service.snapshot().tasks).toEqual(remoteSnapshot.tasks);
    expect((await rpc('undo', completed.transactionId)).status).toBe('applied');
    expect(fixture.service.snapshot().tasks[0]!.status).toBe('open'); expect(fixture.service.snapshot().blocks[0]!.completed).toBe(false);
    expect((await mutate([{ type: 'create', entity: 'block', values: slot('10') }])).status).toBe('clarification');
    expect(fixture.service.snapshot().blocks).toHaveLength(1);
    await mutate([{ type: 'update', entity: 'task', id: taskId, expectedVersion: fixture.service.snapshot().tasks[0]!.version, values: { scheduleMode: 'multiple' } }]);
    expect((await mutate([{ type: 'create', entity: 'block', values: slot('10') }])).status).toBe('applied');
    const current = fixture.service.snapshot().blocks[0]!;
    await mutate([{ type: 'finishBlock', id: current.id, expectedVersion: current.version, completed: true }]);
    expect(fixture.service.snapshot().tasks[0]!.status).toBe('open');
    const beforeRestart = fixture.service.snapshot();
    const exported = JSON.parse((await rpc('backupExportData')).content);
    expect(exported.planner.entities.task[0].scheduleMode).toBe('multiple');
    await fixture.close(); fixture = await setup(fixture.folder);
    const restored = await rpc('snapshot', undefined, second);
    expect(restored.tasks).toEqual(beforeRestart.tasks); expect(restored.blocks).toEqual(beforeRestart.blocks);
  });

  it('requires pairing, exact host/origin and CSRF; serves a narrow method allowlist', async () => {
    const { call, pair } = await setup();
    expect(await (await call('/api/v1/session')).json()).toEqual({ paired: false });
    expect((await call('/api/v1/devices')).status).toBe(401);
    const { cookie, session, headers, code } = await pair();
    expect(session).toMatchObject({ paired: true, aiConfigured: true });
    expect((await call('/api/v1/session', { headers: { Host: 'evil.example' } })).status).toBe(403);
    expect((await call('/api/v1/session', { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call('/api/v1/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'http://localhost:3210' } })).status).toBe(403);
    expect((await call('/api/v1/rpc/setApiKey', { method: 'POST', headers, body: '{}' })).status).toBe(400);
    for (const method of ['saveSettings', 'accountSnapshot', 'refreshAccount', 'importCourses', 'ledgerExportData', 'backupExportData', 'restorePreview', 'restoreConfirm']) {
      const path = `/api/v1/rpc/${method}`, body = JSON.stringify({ requestId: `boundary-${method}`, identity: session.identity });
      expect((await call(path, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3210' } })).status).toBe(401);
      expect((await call(path, { method: 'POST', body, headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'http://localhost:3210' } })).status).toBe(403);
      expect((await call(path, { method: 'POST', body, headers: { ...headers, Origin: 'https://evil.example' } })).status).toBe(403);
    }
    expect((await call('/api/v1/pair', { method: 'POST', headers, body: JSON.stringify({ code, name: '另一个虚构手机' }) })).status).toBe(429);
    const raw = JSON.stringify(await (await call('/api/v1/session', { headers: { Cookie: cookie } })).json());
    expect(raw).not.toContain('synthetic-api-key');
    const logout = await call('/api/v1/logout', { method: 'POST', headers }); expect(logout.status).toBe(200);
    expect((await call('/api/v1/devices', { headers: { Cookie: cookie } })).status).toBe(401);
  });
  it('durably replays writes once and rejects changed fingerprints and stale generations', async () => {
    const fixture = await setup(); const { headers, session } = await fixture.pair();
    const envelope = { requestId: 'retry-one', identity: session.identity, input: goalInput() };
    const rpc = () => fixture.call('/api/v1/rpc/mutate', { method: 'POST', headers, body: JSON.stringify(envelope) });
    const first = await (await rpc()).json(); expect(first).toMatchObject({ ok: true, data: { status: 'applied' } });
    expect(await (await rpc()).json()).toEqual(first);
    expect(fixture.service.snapshot().goals).toHaveLength(1);
    const changed = { ...envelope, input: goalInput('不同目标') };
    expect((await fixture.call('/api/v1/rpc/mutate', { method: 'POST', headers, body: JSON.stringify(changed) })).status).toBe(409);
    expect(await (await fixture.call('/api/v1/operations/retry-one', { headers })).json()).toMatchObject({ status: 'completed', result: first });
    await fixture.close();
    const restarted = await setup(fixture.folder);
    expect(await (await restarted.call('/api/v1/rpc/mutate', { method: 'POST', headers, body: JSON.stringify(envelope) })).json()).toEqual(first);
    expect(restarted.service.snapshot().goals).toHaveLength(1);
    restarted.service.state.advanceGeneration();
    expect((await restarted.call('/api/v1/rpc/mutate', { method: 'POST', headers, body: JSON.stringify({ ...envelope, requestId: 'after-restore' }) })).status).toBe(409);
  });
  it('rejects targetless undo, never leaks private receipts, and enforces payload limits', async () => {
    const { service, call, pair } = await setup(); const { headers, session } = await pair();
    const request = { requestId: 'undo-without-target', identity: session.identity };
    expect((await call('/api/v1/rpc/undo', { method: 'POST', headers, body: JSON.stringify(request) })).status).toBe(400);
    const snapshot = await (await call('/api/v1/rpc/snapshot', { method: 'POST', headers, body: JSON.stringify({ requestId: 'read-snapshot', identity: session.identity }) })).json();
    expect(snapshot.ok).toBe(true);
    const serialized = JSON.stringify(snapshot); expect(serialized).not.toContain('synthetic-api-key'); expect(serialized).not.toContain('fingerprint'); expect(serialized).not.toContain('ledgerProposal');
    expect(service.state.operation('read-snapshot', session.device.id)).toEqual({ status: 'unknown' });
    for (let index = 0; index < 4; index++) {
      const requestId = `read-ledger-${index}`;
      expect((await call('/api/v1/rpc/ledgerSnapshot', { method: 'POST', headers, body: JSON.stringify({ requestId, identity: session.identity }) })).status).toBe(200);
      expect(service.state.operation(requestId, session.device.id)).toEqual({ status: 'unknown' });
    }
    expect(service.snapshot().goals).toEqual([]);
    expect((await call('/api/v1/pair', { method: 'POST', headers, body: JSON.stringify({ code: 'x'.repeat(2000), name: '虚构' }) })).status).toBe(413);
  });
  it('stores only pairing hashes, persists failed attempts and expires sessions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'planner-pair-test-')); let now = 1000;
    const path = join(directory, 'private.sqlite'); let state = new RemoteState(path, () => now);
    try {
      const code = state.createPairingCode(); expect(code.length).toBeGreaterThanOrEqual(32);
      expect(readFileSync(path).includes(Buffer.from(code))).toBe(false);
      for (let index = 0; index < 10; index++) expect(() => state.pair('wrong-code-is-long-enough', '虚构')).toThrow();
      expect(() => state.pair(code, '虚构')).toThrow(/尝试过多/);
      const next = state.createPairingCode(), session = state.pair(next, '虚构'); expect(state.session(session.token)).not.toBeNull();
      state.close(); state = new RemoteState(path, () => now);
      expect(state.session(session.token)).not.toBeNull(); now += 31 * 86400_000; expect(state.session(session.token)).toBeNull();
      const expired = state.createPairingCode(); now += 11 * 60_000; expect(() => state.pair(expired, '虚构')).toThrow();
    } finally { state.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('keeps interrupted work blocked after restart instead of resending AI', async () => {
    const fixture = await setup(); const { session, headers } = await fixture.pair();
    const input = { operationId: 'ai-business', text: '虚构提问', selected: [], history: [] };
    const fingerprint = createHash('sha256').update(JSON.stringify({ method: 'command', identity: session.identity, input })).digest('hex');
    fixture.service.state.begin('crashed-ai', session.device.id, 'command', fingerprint);
    await fixture.close(); const restarted = await setup(fixture.folder);
    expect(await (await restarted.call('/api/v1/operations/crashed-ai', { headers })).json()).toMatchObject({ status: 'interrupted' });
    const result = await restarted.call('/api/v1/rpc/command', { method: 'POST', headers, body: JSON.stringify({ requestId: 'crashed-ai', identity: session.identity, input }) });
    expect(result.status).toBe(409); expect(await result.text()).toContain('未自动重新执行');
  });
  it('refuses insecure public configuration', async () => {
    const { service } = await setup();
    expect(() => createRemoteHttpServer({ service, origin: 'http://calendar.example' })).toThrow(/HTTPS/);
    expect(() => createRemoteHttpServer({ service, origin: 'https://calendar.example', secureCookie: false })).toThrow(/本机/);
    expect(() => createRemoteHttpServer({ service, origin: 'http://localhost', staticDirectory: service.dataDirectory })).toThrow(/分开/);
  });
  it('runs two cookie devices against one authority with versions, retry protection, distilled dedupe and disabled push', async () => {
    const fixture = await setup(); const first = await fixture.pair(), second = await fixture.pair();
    expect(first.cookie).not.toBe(second.cookie);
    const rpc = async (device: typeof first, method: string, requestId: string, input?: unknown) => {
      const response = await fixture.call(`/api/v1/rpc/${method}`, { method: 'POST', headers: device.headers, body: JSON.stringify({ requestId, identity: device.session.identity, input }) }); expect(response.status).toBe(200); return response.json();
    };
    const create = { operationId: 'two-device-create', origin: 'manual', mutations: [{ type: 'create', entity: 'task', values: { title: '虚构跨端任务' } }] };
    const saved = await rpc(first, 'mutate', 'two-device-write', create); expect(saved.data.status).toBe('applied');
    expect(await rpc(first, 'mutate', 'two-device-write', create)).toEqual(saved);
    const snapshot = await rpc(second, 'snapshot', 'two-device-read'); expect(snapshot.data.tasks).toHaveLength(1);
    const task = snapshot.data.tasks[0]; expect(task.title).toBe('虚构跨端任务');
    const edit = (title: string, operationId: string) => ({ operationId, origin: 'manual', mutations: [{ type: 'update', entity: 'task', id: task.id, expectedVersion: task.version, values: { title } }] });
    expect((await rpc(first, 'mutate', 'two-device-edit', edit('第一台已保存', 'first-edit'))).data.status).toBe('applied');
    const conflict = await rpc(second, 'mutate', 'two-device-stale', edit('第二台旧版本', 'stale-edit'));
    expect(conflict.data).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'version' }] });
    const distilled = { requestId: 'desktop-extraction-one', identity: first.session.identity, items: [{ distilledId: 'synthetic-extract-id-0001', title: '虚构采集结果' }] };
    const upload = async (device: typeof first, input: unknown) => { const response = await fixture.call('/api/v1/distilled', { method: 'POST', headers: device.headers, body: JSON.stringify(input) }); expect(response.status).toBe(200); return response.json(); };
    expect((await upload(first, distilled)).data.created).toBe(1);
    expect((await upload(second, { ...distilled, requestId: 'desktop-extraction-retry' })).data.created).toBe(0);
    const final = await rpc(second, 'snapshot', 'two-device-final'); expect(final.data.tasks).toHaveLength(1); expect(final.data.tasks[0].title).toBe('第一台已保存'); expect(final.data.candidates).toHaveLength(1);
    const savedLedger = await rpc(first, 'ledgerMutate', 'two-device-ledger', { operationId: 'two-device-ledger', expectedRevision: 0, changes: [{ type: 'putEntry', expectedVersion: null, entry: { id: 'two-device-expense', kind: 'expense', date: '2020-01-02', month: '2020-01', title: '虚构午餐', category: '餐饮', amountCents: 1000, personalCents: 1000, cashflows: [{ accountId: 'alipay', deltaCents: -1000 }] } }] });
    expect(savedLedger.data.message).toBe('已保存并核对资料服务账本');
    expect(await (await fixture.call('/api/v1/operations/two-device-write', { headers: second.headers })).json()).toEqual({ status: 'unknown' });
    expect(await (await fixture.call('/api/v1/push', { headers: second.headers })).json()).toMatchObject({ enabled: false, publicKey: null });
    const devices = await (await fixture.call('/api/v1/devices', { headers: first.headers })).json(); expect(devices.devices).toHaveLength(2);
    expect((await fixture.call(`/api/v1/devices/${second.session.device.id}`, { method: 'DELETE', headers: first.headers })).status).toBe(200);
    expect((await fixture.call('/api/v1/devices', { headers: second.headers })).status).toBe(401);
  });
});
