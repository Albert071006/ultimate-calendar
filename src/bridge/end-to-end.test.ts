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
import { createEvidenceIndex, evidenceIndexPath, readEvidenceSourceIds } from './evidence-index';
import { projectDistilledFields } from './projection';
import { createCaptureStore } from '../capture/store';
import { normalizeMessage } from '../capture/service';
import { analyzeCapture, applyCaptureResult } from '../capture/analysis';
import { expandCaptureTable } from '../capture/request-wire';
import { nowInstant } from '../domain/time';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(accountId = '900010001', groupId = '900020002') {
  const root = mkdtempSync(join(tmpdir(), 'uc-bridge-e2e-'));
  cleanup.push(() => { const rel = relative(tmpdir(), root); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Unsafe synthetic cleanup'); rmSync(root, { recursive: true, force: true }); });
  const source = createRepository(join(root, 'synthetic-local.sqlite'), { automaticBackup: () => {} }); cleanup.push(() => source.close());
  const localSource = source.writeInternal({ operationId: 'synthetic-local-source', changes: [{ entity: 'source', values: { kind: 'text', text: 'RAW_NEVER_UPLOAD QQ 900010001 group 900020002 C:\\private\\raw.pdf', label: 'PRIVATE_GROUP_LABEL', importedAt: '2020-01-01T00:00:00+08:00', captureRef: { messageId: 'PRIVATE_MESSAGE', accountId, groupId, attachmentId: null, locator: 'PRIVATE_ATTACHMENT_LOCATION', transcribed: false } } }] }).entities[0]!;
  const values = { title: '提交合成报告', action: '整理材料后提交', sourceIds: [localSource.id], sourceQuote: 'RAW_NEVER_UPLOAD', temporalEvidence: [] };
  const candidate = source.writeInternal({ operationId: 'synthetic-candidate', changes: [{ entity: 'candidate', values }] }).entities[0]!;
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
  return { root, source, localSource, candidate, service, remote, client, config, requests };
}

describe('local synthetic QQ extraction to cloud inbox', () => {
  it('syncs a plain QQ notice alongside an unread attachment with warnings only on the owning notice', async () => {
    const accountId = '900010001', groupId = '900020002';
    const f = await setup(accountId, groupId);
    const bridge = createQQCloudBridge(f.config, f.remote); cleanup.push(() => bridge.close());
    await bridge.once();
    const store = createCaptureStore(f.source.path); cleanup.push(() => store.close());
    store.saveConfig({ ...store.config(), accountId, groupIds: [groupId], enabled: true, analysisEnabled: true });
    const owner = '请按附件领取实验用品', plain = '请预约阅览室座位', filename = '合成私有清单.pdf';
    const localError = '无法读取 C:\\private\\synthetic-error.log';
    const raw = { group_id: groupId, time: Math.floor(Date.now() / 1000), user_id: 'synthetic-sender' };
    const messages = [
      normalizeMessage({ ...raw, message_id: 'with-file', message: [
        { type: 'text', data: { text: owner } }, { type: 'file', data: { file: filename } },
      ] }, accountId, new Map())!,
      normalizeMessage({ ...raw, message_id: 'plain', message: plain }, accountId, new Map())!,
    ];
    const [ownerId] = store.ingest(messages).ids;
    const file = store.attachments(ownerId!)[0]!;
    store.setAttachmentStatus(file.id, 'failed', localError);
    store.sealBatches({ force: true }); const batch = store.claimBatch()!;
    expect(batch.messageIds).toHaveLength(2);
    const notice = '该来源的附件未完整读取，请在本机核对';
    await analyzeCapture({ store, repository: f.source, batch, getApiKey: async () => 'synthetic', canContinue: () => true,
      fetch: async (_url, init) => {
        const wire = JSON.parse(String(init?.body)).messages.find((m: { role: string }) => m.role === 'user');
        const input = JSON.parse(wire.content[0].text);
        expect(input.warnings).toBeUndefined();
        const units: { id: string; text: string; warnings?: string[] }[] = input.units;
        expect(units.find(unit => unit.text === owner)?.warnings).toEqual([notice]);
        expect(units.find(unit => unit.text === plain)?.warnings).toBeUndefined();
        expect(JSON.stringify(input)).not.toContain('synthetic-error.log');
        // Even an exact model echo of the diagnostic must follow verified source ownership.
        const candidates = units.map(unit => ({ title: unit.text, action: unit.text, benefit: '', potentialBenefit: '', benefitKind: 'unknown',
          conditions: [], uncertainties: [notice], sourceIds: [unit.id], sourceQuote: unit.text, deadline: null, eventStart: null,
          eventEnd: null, temporalEvidence: [], location: '', relation: { kind: 'new', candidateId: null } }));
        return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      } });
    expect(store.attachment(file.id)).toMatchObject({ name: filename, error: localError });
    expect(store.batch(batch.id)?.result).toMatchObject({ warnings: [{ kind: 'attachment-incomplete', messageId: ownerId, attachmentId: file.id }] });
    expect(await bridge.once()).toMatchObject({ accepted: 2, issue: null });
    const cloud = f.service.snapshot().candidates;
    expect(cloud.find(card => card.title === plain)?.uncertainties).toEqual([]);
    expect(cloud.find(card => card.title === owner)?.uncertainties).toEqual([notice]);
    const sends = f.requests.filter(request => request.path === '/api/v1/distilled').map(request => request.body).join('');
    expect(sends).not.toContain(filename); expect(sends).not.toContain('synthetic-error.log');
  });
  it('delivers a newly required WeChat assignment once when its companion report was ignored in the cloud', async () => {
    const accountId = 'wechat:synthetic-self', groupId = 'synthetic-class@chatroom';
    const f = await setup(accountId, groupId);
    const bridge = createQQCloudBridge(f.config, f.remote);
    cleanup.push(() => bridge.close());
    await bridge.once();
    const original = f.service.snapshot().candidates[0]!;
    const ignore = MutationRequestSchema.parse({ operationId: 'ignore-original-report', origin: 'manual',
      mutations: [{ type: 'ignoreCandidate', id: original.id, expectedVersion: original.version }] });
    const result = await f.remote.rpc('mutate', ignore);
    if (!result.ok) throw Error('Could not ignore synthetic report');
    if (result.data.status === 'preview') await f.remote.rpc('mutate', { ...ignore, confirmed: true, confirmationToken: result.data.confirmationToken });
    const ignored = f.service.snapshot().candidates[0]!;
    expect(ignored.status).toBe('ignored');
    expect(f.source.snapshot().candidates[0]!.status).toBe('pending');

    const store = createCaptureStore(f.source.path, { platform: 'wechat' });
    cleanup.push(() => store.close());
    store.saveConfig({ ...store.config(), accountId, groupIds: [groupId], enabled: true, analysisEnabled: true });
    const text = '请绘制线路图，和合成报告一起提交。';
    store.ingest([{ accountId, groupId, messageId: 'additional-drawing', sentAt: nowInstant(), text }]);
    store.sealBatches({ force: true });
    const batch = store.claimBatch()!;
    // Reproduce the original model mistake, including its explicit link to the old report.
    await analyzeCapture({ store, repository: f.source, batch, getApiKey: async () => 'synthetic', canContinue: () => true,
      fetch: async (_url, init) => {
        const wire = JSON.parse(String(init?.body)).messages.find((m: { role: string }) => m.role === 'user');
        const sent = JSON.parse(wire.content[0].text);
        const unitId = sent.units[0].id;
        const originalAlias = expandCaptureTable(sent.existingCandidates).find(card => card.title === original.title)?.id;
        expect(originalAlias).toBeDefined();
        const item = { title: '绘制线路图', action: text, benefit: '', benefitKind: 'unknown', potentialBenefit: '',
          conditions: [], uncertainties: [], sourceIds: [unitId], sourceQuote: text, deadline: null, eventStart: null,
          eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'supplement', candidateId: originalAlias } };
        return Response.json({ choices: [{ message: { content: JSON.stringify({ candidates: [item] }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      } });
    expect(await bridge.once()).toMatchObject({ accepted: 1, issue: null });
    const delivered = f.service.snapshot().candidates;
    expect(delivered).toHaveLength(2);
    expect(delivered.find(card => card.id === ignored.id)).toEqual(ignored);
    expect(delivered.find(card => card.id !== ignored.id)).toMatchObject({ title: expect.stringContaining('线路图'),
      status: 'pending', deadline: null, taskId: null, revisionOfId: null, duplicateOfId: null });
    applyCaptureResult(store, f.source, store.batch(batch.id)!);
    await bridge.once();
    expect(f.service.snapshot().candidates).toEqual(delivered);
  });
  it('recovers a lost HTTP receipt after bridge restart without duplicating an event', async () => {
    const f = await setup(); let now = 1000; let lose = true;
    const flaky: BridgeTransport = { origin: f.remote.origin, getSession: f.remote.getSession, async sendDistilled(request, options) {
      const result = await f.remote.sendDistilled(request, options); if (lose) { lose = false; throw Error('RAW_PRIVATE_PROVIDER_ERROR C:\\private'); } return result;
    } };
    const first = createQQCloudBridge(f.config, flaky, { now: () => now }); cleanup.push(() => first.close());
    const interrupted = await first.once(); expect(interrupted).toMatchObject({ queued: 1, duplicates: 0, issue: 'network', outbox: { pending: 1 } });
    expect(f.service.snapshot().candidates).toHaveLength(1); await first.close(); f.remote.close();
    now = 6000; const nextRemote = f.client(); const restarted = createQQCloudBridge(f.config, nextRemote, { now: () => now }); cleanup.push(() => restarted.close());
    expect(await restarted.once()).toMatchObject({ accepted: 1, outbox: { accepted: 1, pending: 0 } });
    await restarted.once(); expect(f.service.snapshot().candidates).toHaveLength(1);
    expect(readEvidenceSourceIds(evidenceIndexPath(f.source.path), f.service.snapshot().sources[0]!.id)).toEqual([f.localSource.id]);
    const sends = f.requests.filter(request => request.path === '/api/v1/distilled'); expect(sends).toHaveLength(2); expect(sends[0]!.body).toBe(sends[1]!.body);
    expect(sends[0]!.body).not.toContain(f.localSource.id); expect(sends[0]!.body).not.toContain(f.candidate.id); expect(sends[0]!.body).not.toContain('localLinks');
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
    expect(current.candidates.find(candidate => candidate.id !== original.id)).toMatchObject({ title: '提交变更后的合成报告', status: 'pending', revisionOfId: original.id });
  });
  it('migrates an edited legacy canonical card using its private alias and preserves ignored split cards', async () => {
    const f = await setup(), legacy = projectDistilledFields({ title: '提交合成报告', action: '整理材料后提交' });
    if (!legacy.ok) throw Error('Synthetic projection failed');
    const first = await f.remote.sendDistilled({ requestId: 'legacy-import', identity: f.config.identity, items: [legacy.value.item] });
    const extra = projectDistilledFields({ title: '拆分的次要步骤' }); if (!extra.ok) throw Error('Synthetic projection failed');
    const split = await f.remote.sendDistilled({ requestId: 'legacy-split', identity: f.config.identity, items: [extra.value.item] });
    const index = createEvidenceIndex(evidenceIndexPath(f.source.path)); index.remember([{ distilledId: legacy.value.item.distilledId, candidateId: f.candidate.id, sourceIds: [f.localSource.id] }]); index.close();
    const canonical = { title: '用户整理的完整通知', action: '完整的报名与参与步骤', conditions: ['需自行组队'], deadline: { date: '2027-01-03', time: null } };
    const request = MutationRequestSchema.parse({ operationId: 'repair-cloud-cards', origin: 'manual', mutations: [{ type: 'update', entity: 'candidate', id: first.candidateIds[0], expectedVersion: 1, values: canonical }, { type: 'ignoreCandidate', id: split.candidateIds[0], expectedVersion: 1 }] });
    const proposed = await f.remote.rpc('mutate', request); if (!proposed.ok) throw Error('Synthetic repair failed'); const result = MutationResultSchema.parse(proposed.data);
    if (result.status === 'preview') expect(await f.remote.rpc('mutate', { ...request, confirmed: true, confirmationToken: result.confirmationToken })).toMatchObject({ ok: true, data: { status: 'applied' } });
    const supplement = f.source.writeInternal({ operationId: 'local-supplement', changes: [{ entity: 'source', values: { kind: 'text', text: 'PRIVATE_SUPPLEMENT', importedAt: '2020-01-02T00:00:00+08:00' } }] }).entities[0]!;
    f.source.writeInternal({ operationId: 'repair-local-card', changes: [{ entity: 'candidate', id: f.candidate.id, expectedVersion: 1, values: { ...canonical, sourceIds: [f.localSource.id, supplement.id] } }] });
    const bridge = createQQCloudBridge(f.config, f.remote); cleanup.push(() => bridge.close());
    expect(await bridge.once()).toMatchObject({ queued: 1, accepted: 1, issue: null }); expect(await bridge.once()).toMatchObject({ queued: 0, accepted: 0 });
    const current = f.service.snapshot(); expect(current.candidates).toHaveLength(2);
    expect(current.candidates.find(candidate => candidate.id === first.candidateIds[0])).toMatchObject({ ...canonical, status: 'pending' });
    expect(current.candidates.find(candidate => candidate.id === split.candidateIds[0])!.status).toBe('ignored');
    expect(readEvidenceSourceIds(evidenceIndexPath(f.source.path), current.candidates.find(candidate => candidate.id === first.candidateIds[0])!.sourceIds[0]!)).toEqual([f.localSource.id, supplement.id].sort());
    const sent = JSON.parse(f.requests.filter(request => request.path === '/api/v1/distilled').at(-1)!.body);
    expect(sent.items[0].legacyDistilledIds).toContain(legacy.value.item.distilledId); expect(sent.items[0].eventRevision).toEqual([1, 2]);
    expect(JSON.stringify(sent)).not.toContain(f.candidate.id); expect(JSON.stringify(sent)).not.toContain(supplement.id);
  });
  it('keeps local revision descendants on the same cloud event while equal-text independent events stay separate', async () => {
    const f = await setup(), bridge = createQQCloudBridge(f.config, f.remote); cleanup.push(() => bridge.close()); await bridge.once();
    const cloudId = f.service.snapshot().candidates[0]!.id;
    f.source.writeInternal({ operationId: 'local-accepted', changes: [{ entity: 'candidate', id: f.candidate.id, expectedVersion: 1, values: { status: 'accepted' } }, { entity: 'candidate', values: { title: '完整的补充通知', sourceIds: [f.localSource.id], revisionOfId: f.candidate.id } }] });
    expect(await bridge.once()).toMatchObject({ accepted: 1, issue: null }); expect(f.service.snapshot().candidates).toMatchObject([{ id: cloudId, title: '完整的补充通知' }]);
    f.source.writeInternal({ operationId: 'independent-equal-text', changes: [{ entity: 'candidate', values: { title: '完整的补充通知', sourceIds: [f.localSource.id] } }] });
    expect(await bridge.once()).toMatchObject({ accepted: 1, issue: null }); expect(f.service.snapshot().candidates).toHaveLength(2);
  });
});
