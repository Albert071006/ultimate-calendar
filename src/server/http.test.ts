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
import { LedgerEntryDraftSchema, LedgerSnapshotSchema } from '../shared/ledger';
import { ledgerLoans } from '../shared/ledger-loans';
import { LEDGER_API_HEADER, LEDGER_API_VERSION } from '../shared/ledger-compatibility';
import { AI_SETTINGS_HEADER, AI_SETTINGS_VERSION } from '../shared/ai-reasoning';

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
    return { code, cookie, session, headers: { Cookie: cookie, Origin: 'http://localhost:3210', 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken, [LEDGER_API_HEADER]: LEDGER_API_VERSION } };
  };
  return { folder, service, call, pair, close };
}
const goalInput = (title = '虚构目标') => ({ operationId: 'goal-business-1', origin: 'manual', mutations: [{ type: 'create', entity: 'goal', values: { title } }] });

describe('remote HTTP boundary', () => {
  it('shares effort with new clients while legacy reads, saves and replayed receipts preserve it', async () => {
    const f = await setup(), device = await f.pair(); let sequence=0;
    const rpc = async (method:string,input?:unknown,modern=true,id=`reasoning-${++sequence}`) => {
      const response=await f.call(`/api/v1/rpc/${method}`,{method:'POST',headers:{...device.headers,...(modern?{[AI_SETTINGS_HEADER]:AI_SETTINGS_VERSION}:{})},body:JSON.stringify({requestId:id,identity:device.session.identity,input})});
      expect(response.status).toBe(200);return response.json();
    };
    const initial=(await rpc('snapshot')).data.settings;
    expect(initial.reasoningEffort).toBeUndefined();
    const request={settings:{...initial,reasoningEffort:'max'},expectedSettings:initial};
    expect((await rpc('saveSettings',request,true,'effort-set')).data.reasoningEffort).toBe('max');
    expect((await rpc('snapshot')).data.settings.reasoningEffort).toBe('max');
    expect(await rpc('saveSettings',{settings:{...initial,reasoningEffort:'none',campus:'stale modern form'},expectedSettings:initial})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
    expect((await rpc('snapshot')).data.settings.reasoningEffort).toBe('max');
    const legacy=(await rpc('snapshot',undefined,false)).data.settings;
    expect(legacy.reasoningEffort).toBeUndefined();
    expect(await rpc('saveSettings',{settings:{...legacy,campus:'合成校园'},expectedSettings:legacy},false,'legacy-save')).toMatchObject({ok:true,data:{campus:'合成校园'}});
    const after=(await rpc('snapshot')).data.settings;
    expect(after).toMatchObject({campus:'合成校园',reasoningEffort:'max'});
    const receipt=await f.call('/api/v1/operations/legacy-save',{headers:device.headers});
    expect((await receipt.json()).result.data.reasoningEffort).toBeUndefined();
    expect((await rpc('saveSettings',request,false,'effort-set')).data.reasoningEffort).toBeUndefined();
    expect((await rpc('snapshot')).data.settings.reasoningEffort).toBe('max');
    expect((await rpc('saveSettings',{settings:{...after,reasoningEffort:'none'},expectedSettings:after})).data.reasoningEffort).toBe('none');
  });
  it('shares independent account catalogs across devices, backup and restart, rejecting version 2 before a write', async () => {
    let fixture = await setup();
    const desktop = await fixture.pair(), mobile = await fixture.pair();
    let sequence = 0;
    const rpc = async (method: string, input?: unknown, device = desktop, version = LEDGER_API_VERSION) => {
      const response = await fixture.call(`/api/v1/rpc/${method}`, { method: 'POST',
        headers: { ...device.headers, [LEDGER_API_HEADER]: version },
        body: JSON.stringify({ requestId: `accounts-http-${++sequence}`, identity: device.session.identity, input }) });
      expect(response.status).toBe(200); return response.json();
    };
    const account = { id: 'account:synthetic-bank', name: '合成乙银行', kind: 'cash', aliases: ['合成乙行'] };
    const member = { id: 'account:synthetic-shop', name: '合成花店会员卡', kind: 'stored', aliases: ['合成花店'] };
    const entry = LedgerEntryDraftSchema.parse({ id: 'synthetic-account-transfer', kind: 'transfer', date: '2026-08-10', month: '2026-08',
      title: '合成账户转账', category: '转账', amountCents: 12000, personalCents: 0,
      cashflows: [{ accountId: 'cmb', deltaCents: -12000 }, { accountId: account.id, deltaCents: 12000 }] });
    const input = { operationId: 'accounts-http-create', expectedRevision: 0, changes: [
      { type: 'putAccount', account }, { type: 'putAccount', account: member }, { type: 'putEntry', entry, expectedVersion: null }] };
    expect(await rpc('ledgerMutate', input, desktop, '2')).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect((await rpc('ledgerSnapshot')).data).toMatchObject({ revision: 0, entries: [] });
    const saved = await rpc('ledgerMutate', input); expect(saved.ok).toBe(true);
    const snapshot = LedgerSnapshotSchema.parse((await rpc('ledgerSnapshot', { month: '2026-08' }, mobile)).data);
    expect(snapshot.accounts).toEqual(expect.arrayContaining([account, member]));
    expect(snapshot.summary.accounts.find(value => value.id === account.id)).toMatchObject({ name: account.name, periodChangeCents: 12000, balanceCents: null });
    expect(snapshot.summary.accounts.find(value => value.id === 'cmb')?.periodChangeCents).toBe(-12000);
    expect(JSON.stringify(JSON.parse((await rpc('backupExportData')).data.content))).toContain(member.name);
    await fixture.close(); fixture = await setup(fixture.folder);
    const restored = LedgerSnapshotSchema.parse((await rpc('ledgerSnapshot', { month: '2026-08' }, mobile)).data);
    expect(restored.accounts).toEqual(snapshot.accounts); expect(restored.entries).toEqual(snapshot.entries);
    const replay = await rpc('ledgerMutate', input); expect(replay.data.status).toBe('already_saved');
    expect((await rpc('ledgerSnapshot', undefined, mobile)).data.entries).toHaveLength(1);
  });
  it('shares loan principal and partial repayment across devices and restart, while old clients get an update message before writes', async () => {
    let fixture = await setup();
    const first = await fixture.pair(), second = await fixture.pair();
    let sequence = 0;
    const rpc = async (method: string, input?: unknown, device = first, requestId = `loan-http-${++sequence}`, legacy = false) => {
      const headers: Record<string, string> = { ...device.headers };
      if (legacy) delete headers[LEDGER_API_HEADER];
      const response = await fixture.call(`/api/v1/rpc/${method}`, { method: 'POST', headers,
        body: JSON.stringify({ requestId, identity: device.session.identity, input }) });
      expect(response.status).toBe(200); return response.json();
    };
    const entry = LedgerEntryDraftSchema.parse({ id: 'synthetic-borrow', kind: 'loan_borrow', date: '2026-08-10', month: '2026-08',
      title: '合成借入本金', category: '借款', counterparty: '合成人甲', amountCents: 18000, personalCents: 0,
      cashflows: [{ accountId: 'wechat', deltaCents: 18000 }] });
    const input = { operationId: 'loan-http-borrow', expectedRevision: 0, changes: [{ type: 'putEntry', expectedVersion: null, entry }] };
    const legacy = await rpc('ledgerMutate', input, first, 'old-client-loan', true);
    expect(legacy).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: expect.stringContaining('重新打开手机日历') } });
    expect((await rpc('ledgerSnapshot')).data.entries).toHaveLength(0);
    const saved = await rpc('ledgerMutate', input, first, 'loan-borrow-once'); expect(saved.ok).toBe(true);
    expect(await rpc('ledgerMutate', input, first, 'loan-borrow-once')).toEqual(saved);
    const repayment = { ...entry, id: 'synthetic-partial', kind: 'loan_repay', date: '2026-09-11', month: '2026-09',
      title: '合成部分归还', amountCents: 7000, cashflows: [{ accountId: 'alipay', deltaCents: -7000 }], relatedEntryIds: [entry.id] };
    const paid = await rpc('ledgerMutate', { operationId: 'loan-http-repay', expectedRevision: 1,
      changes: [{ type: 'putEntry', expectedVersion: null, entry: repayment }] }, second);
    expect(paid.ok).toBe(true);
    const snapshot = LedgerSnapshotSchema.parse((await rpc('ledgerSnapshot', { month: '2026-09' }, second)).data);
    expect(ledgerLoans(snapshot.entries).payableCents).toBe(11000);
    expect(snapshot.summary).toMatchObject({ personalCents: 0, incomeCents: 0, actualPaidCents: 7000 });
    const backup = JSON.parse((await rpc('backupExportData')).data.content);
    expect(JSON.stringify(backup)).toContain('loan_borrow');
    await fixture.close(); fixture = await setup(fixture.folder);
    const restored = LedgerSnapshotSchema.parse((await rpc('ledgerSnapshot', { month: '2026-09' }, second)).data);
    expect(restored.entries).toEqual(snapshot.entries);
    expect(ledgerLoans(restored.entries).payableCents).toBe(11000);
    expect(await rpc('ledgerMutate', input, first, 'loan-borrow-once')).toEqual(saved);
    expect(await rpc('ledgerSnapshot', undefined, first, 'old-client-read', true)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  });
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
