import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCaptureStore } from './store';
import { createRepository } from '../storage/repository';
import { inspectCaptureBackupFile, copyCaptureBackupFile } from './backup-file';
import { openDatabase } from '../storage/database';
import { analyzeCapture, prepareAnalysis } from './analysis';
import { recipientContext } from './recipients';
import * as recipients from './recipients';
import { createCaptureService, normalizeMessage, type CaptureBridge, type CaptureBridgeFactory } from './service';
import { createCandidateReader } from '../bridge/source-reader';
import { DistilledRequestSchema } from '../shared/distilled';
import { importDistilled } from '../server/distilled';
import { instantAt } from '../domain/time';
import { pollWechatHistory } from './wechat-history';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) close(); });
const at = '2026-10-27T19:30:00+08:00';
const wx = 'wechat:wxid_synthetic', group = 'synthetic@chatroom';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uc-wechat-test-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'planner.sqlite');
  const repo = createRepository(path, { automaticBackup: () => {} }); cleanup.push(() => repo.close());
  const qq = createCaptureStore(path), wechat = createCaptureStore(path, { platform: 'wechat' }); cleanup.push(() => { wechat.close(); qq.close(); });
  qq.saveConfig({ ...qq.config(), accountId: '100', groupIds: ['200'], enabled: true });
  wechat.saveConfig({ ...wechat.config(), accountId: wx, groupIds: [group], enabled: true });
  return { dir, path, repo, qq, wechat };
}
const incoming = (accountId = wx, groupId = group, messageId = 'server:1') => ({ accountId, groupId, messageId, sentAt: at, importedAt: at, text: '明天中午提交合成材料', attachments: [{ kind: 'file' as const, name: '合成材料.txt' }] });

function waitingForFile(store: ReturnType<typeof createCaptureStore>, messageId: string, sentAt: string, importedAt: string) {
  const [id] = store.ingest([{ ...incoming(wx, group, messageId), sentAt, importedAt }], importedAt).ids;
  const [batch] = store.sealBatches({ force: true, now: importedAt });
  expect(store.claimBatch(importedAt)?.id).toBe(batch!.id);
  const [file] = store.attachments(id!);
  store.setAttachmentStatus(file!.id, 'failed', '合成附件未下载', true);
  store.waitForAttachments(batch!.id, '合成附件未下载', true, importedAt);
  return batch!.id;
}

describe('concurrent QQ and WeChat collection', () => {
  it('expires the retry window against sentAt to the millisecond, independently of the recent import time', () => {
    const { wechat } = fixture();
    const now = Date.parse(at), cutoff = now - 72 * 3600_000;
    const imported = instantAt(now - 60_000);
    const expired = waitingForFile(wechat, 'outside-window', instantAt(cutoff - 1), imported);
    const exact = waitingForFile(wechat, 'exact-window', instantAt(cutoff), imported);
    const recent = waitingForFile(wechat, 'within-window', instantAt(cutoff + 1), imported);
    expect(wechat.retryWaitingAttachments(at)).toBe(2);
    expect(wechat.batch(expired)).toMatchObject({ status: 'failed', waitingForAttachments: false, error: expect.stringContaining('已超过 3 天') });
    expect(wechat.batch(exact)?.status).toBe('pending');
    expect(wechat.batch(recent)?.status).toBe('pending');
  });

  it.each(['waiting', 'pending', 'preparing', 'downloading'])('parks an expired legacy %s retry when the WeChat store restarts', state => {
    const { path, wechat } = fixture();
    const now = Date.parse(at), earlier = instantAt(now - 60_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(earlier));
    const id = waitingForFile(wechat, 'already-tried', instantAt(now - 72 * 3600_000 - 1), earlier);
    if (state !== 'waiting') {
      expect(wechat.retryWaitingAttachments(earlier)).toBe(1);
      if (state === 'preparing' || state === 'downloading') expect(wechat.claimBatch(earlier)?.id).toBe(id);
      if (state === 'downloading') {
        const [message] = wechat.batchMessages(id);
        const [file] = wechat.attachments(message!.id);
        wechat.setAttachmentStatus(file!.id, 'downloading');
      }
    }
    vi.setSystemTime(new Date(at));
    const restarted = createCaptureStore(path, { platform: 'wechat' });
    cleanup.push(() => restarted.close());
    expect(restarted.batch(id)).toMatchObject({ status: 'failed', waitingForAttachments: false, error: expect.stringContaining('已超过 3 天') });
    expect(restarted.retryWaitingAttachments(at)).toBe(0);
    expect(restarted.claimBatch(at)).toBeNull();
  });

  it('reads no attachments for duplicate text and uses indexed lookups when a file arrives later', () => {
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    const store = createCaptureStore(':memory:', { database: db, platform: 'wechat' });
    store.saveConfig({ ...store.config(), accountId: wx, groupIds: [group], enabled: true });
    const page = Array.from({ length: 64 }, (_, index) => ({
      ...incoming(wx, group, 'duplicate-' + index), origin: 'history' as const, attachments: [],
    }));
    const firstId = store.ingest(page).ids[0]!;
    const statements = Object.getPrototypeOf(db.prepare('SELECT 1')) as ReturnType<typeof db.prepare>;
    const get = vi.spyOn(statements, 'get'), all = vi.spyOn(statements, 'all');
    const attachmentReads = () => [...get.mock.contexts, ...all.mock.contexts]
      .map(statement => (statement as typeof statements).sourceSQL).filter(sql => /capture_attachments|sourceMessageId/.test(sql));
    try {
      expect(store.ingest(page)).toEqual({ inserted: 0, duplicates: page.length, ignored: 0, ids: [] });
      expect(attachmentReads()).toEqual([]);
      const withFile = { ...page[0]!, attachments: [{ kind: 'file' as const, name: '合成作业.txt', locator: { file: 'mock-file' } }] };
      expect(store.ingest([withFile])).toMatchObject({ inserted: 0, duplicates: 1 });
      const reads = attachmentReads();
      expect(reads).toHaveLength(1);
      const plan = db.prepare('EXPLAIN QUERY PLAN ' + reads[0]).all(firstId, wx, group, withFile.messageId);
      expect(plan.map(row => row.detail).join('\n')).toContain('USING INDEX capture_messages_source');
      expect(store.ingest([withFile])).toMatchObject({ inserted: 0, duplicates: 1 });
      expect(store.attachments(firstId).map(file => file.name)).toEqual(['合成作业.txt']);
    } finally { get.mockRestore(); all.mockRestore(); }
  });

  it('enriches uncharged placeholders but keeps paid text checkpoints immutable when media arrives later', () => {
    const f = fixture(), raw = { ...incoming(), text: '明天中午提交合成材料：请按附件要求提交', attachments: [] };
    const id = f.wechat.ingest([raw]).ids[0]!;
    const batch = f.wechat.sealBatches({ force: true })[0]!;
    const media = { ...raw, attachments: [{ kind: 'file' as const, name: '材料.docx', locator: { type: 'file', data: { file: 'wm1:document' } } }], segments: [{ type: 'file', data: { file: 'wm1:document' } }] };
    expect(f.wechat.ingest([media])).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(f.wechat.attachments(id)).toHaveLength(1);
    expect(f.wechat.listBatches({ messageId: id }).items.map(value => value.id)).toEqual([batch.id]);
    expect(f.qq.listBatches({ messageId: id }).items).toEqual([]);
    f.wechat.claimBatch(); f.wechat.startAttempt(batch.id, 'paid-fingerprint'); f.wechat.saveResult(batch.id, { paid: 'unchanged' }); f.wechat.markApplied(batch.id);
    const paid = JSON.stringify(f.wechat.batch(batch.id));
    const second = { ...media, attachments: [...media.attachments, { kind: 'image' as const, name: '图片.png', locator: { type: 'image', data: { file: 'wm1:image' } } }], segments: [...media.segments, { type: 'image', data: { file: 'wm1:image' } }] };
    const added = f.wechat.ingest([second]); expect(added.inserted).toBe(1);
    const supplemental = f.wechat.message(added.ids[0]!)!;
    expect(supplemental).toMatchObject({ sourceMessageId: raw.messageId, sentAt: raw.sentAt, text: '' });
    expect(f.wechat.attachments(supplemental.id).map(value => value.kind)).toEqual(['image']);
    expect(f.wechat.ingest([second])).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(JSON.stringify(f.wechat.batch(batch.id))).toBe(paid);
    const next = f.wechat.sealBatches({ force: true })[0]!;
    const plan = prepareAnalysis(f.wechat, next);
    expect(plan.units).toEqual([]);
    expect(plan.context.find(value => value.id === id)).toMatchObject({ text: raw.text, sentAt: raw.sentAt });
    expect(f.wechat.listBatches({ messageId: supplemental.id }).items.map(value => value.id)).toEqual([next.id]);
    expect(f.wechat.listBatches({ messageId: 'missing' }).items).toEqual([]);
    const restored = f.wechat.exportState().state; f.wechat.replaceState(restored);
    expect(f.wechat.message(supplemental.id)?.sourceMessageId).toBe(raw.messageId);
    expect(JSON.stringify(f.wechat.batch(batch.id))).toBe(paid);
  });

  it('does not enrich a different sending date or automatically retry after a request was charged', () => {
    const f = fixture(), raw = { ...incoming(), attachments: [] };
    const id = f.wechat.ingest([raw]).ids[0]!;
    expect(f.wechat.ingest([{ ...incoming(), sentAt: '2026-10-28T19:30:00+08:00' }])).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(f.wechat.attachments(id)).toEqual([]);
    const batch = f.wechat.sealBatches({ force: true })[0]!;
    f.wechat.claimBatch(); f.wechat.startAttempt(batch.id, 'charged'); f.wechat.checkpointResult(batch.id, { charged: true });
    f.wechat.waitForAttachments(batch.id, 'missing', true);
    expect(f.wechat.retryWaitingAttachments()).toBe(0);
    expect(f.wechat.batch(batch.id)?.waitingForAttachments).toBe(false);
  });

  it('isolates selection, reads, attachments, queues, cleanup, stats and credential pause', () => {
    const f = fixture();
    const qid = f.qq.ingest([incoming('100', '200')]).ids[0]!;
    const wid = f.wechat.ingest([incoming()]).ids[0]!;
    expect(qid.startsWith('qqm:')).toBe(true); expect(wid.startsWith('wxm:')).toBe(true);
    expect(f.wechat.ingest([incoming(), incoming('100', '200')])).toMatchObject({ duplicates: 1, ignored: 1 });
    expect(f.qq.message(wid)).toBeNull(); expect(f.wechat.message(qid)).toBeNull();
    expect(f.qq.listMessages({ accountId: wx }).items).toEqual([]);
    expect(f.qq.stats().messages).toBe(1); expect(f.wechat.stats().messages).toBe(1);
    const attachment = f.wechat.attachments(wid)[0]!;
    f.wechat.putAttachment(attachment.id, Buffer.from('synthetic private content'));
    expect(f.qq.attachment(attachment.id)).toBeNull(); expect(f.qq.readAttachmentBytes(attachment.id)).toBeNull();
    expect(() => f.qq.cleanup({ accountId: wx, groupId: group })).toThrow('平台');
    const qb = f.qq.sealBatches({ force: true })[0]!, wb = f.wechat.sealBatches({ force: true })[0]!;
    expect(f.qq.batch(wb.id)).toBeNull(); expect(f.wechat.batch(qb.id)).toBeNull();
    expect(f.qq.claimBatch()?.id).toBe(qb.id); expect(f.wechat.claimBatch()?.id).toBe(wb.id);
    f.wechat.failBatch(wb.id, 'no key'); f.wechat.pauseForCredentials('NO_API_KEY', wb.id);
    expect(f.qq.config().analysisEnabled).toBe(true); expect(f.qq.credentialPause()).toBeNull();
    expect(f.wechat.config().analysisEnabled).toBe(false);
    const change = { configured: true, sourceId: '1'.repeat(64), revision: '11111111-1111-4111-8111-111111111111' };
    expect(f.qq.applyCredentialChange(change).changed).toBe(true);
    expect(f.wechat.applyCredentialChange(change)).toMatchObject({ changed: true, resumed: true });
    expect(f.wechat.claimBatch()?.id).toBe(wb.id);
    expect(f.qq.config().groupIds).toEqual(['200']);
  });

  it('does not recover another running platform and rejects cross-platform attachment IDs', () => {
    const f = fixture(); f.qq.ingest([incoming('100', '200')]);
    const qb = f.qq.sealBatches({ force: true })[0]!; f.qq.claimBatch(); f.qq.startAttempt(qb.id, 'synthetic');
    const another = createCaptureStore(f.path, { platform: 'wechat' }); cleanup.push(() => another.close());
    expect(f.qq.batch(qb.id)?.status).toBe('requesting');
    const attachment = f.qq.attachments(f.qq.listMessages().items[0]!.id)[0]!;
    expect(() => f.wechat.ingest([{ ...incoming(), attachments: [{ id: attachment.id, name: 'conflict.txt', kind: 'file' }] }])).toThrow('附件标识重复');
    expect(f.qq.attachment(attachment.id)?.name).toBe('合成材料.txt');
  });

  it('backs up both platforms and restores both paused through in-memory and streaming paths', () => {
    const f = fixture(); f.qq.ingest([incoming('100', '200')]); f.wechat.ingest([incoming()]);
    const backup = f.qq.exportState().state;
    expect(backup.messages).toHaveLength(2); expect(backup.wechatConfig?.groupIds).toEqual([group]);
    f.wechat.replaceState(backup);
    expect(f.qq.config()).toMatchObject({ enabled: false, analysisEnabled: false, accountId: '100' });
    expect(f.wechat.config()).toMatchObject({ enabled: false, analysisEnabled: false, accountId: wx });
    const destinationPath = join(f.dir, 'restored.sqlite'); const target = createCaptureStore(destinationPath); cleanup.push(() => target.close());
    const targetWx = createCaptureStore(destinationPath, { platform: 'wechat' }); cleanup.push(() => targetWx.close());
    const sourceDb = openDatabase(f.path), targetDb = openDatabase(destinationPath); cleanup.push(() => { sourceDb.close(); targetDb.close(); });
    const summary = inspectCaptureBackupFile(sourceDb)!;
    targetDb.exec('BEGIN IMMEDIATE'); copyCaptureBackupFile(sourceDb, targetDb, summary); targetDb.exec('COMMIT');
    expect(target.stats().messages).toBe(1); expect(targetWx.stats().messages).toBe(1);
    expect(targetWx.config()).toMatchObject({ enabled: false, analysisEnabled: false, accountId: wx });
    const legacy = { ...backup }; delete legacy.wechatConfig; legacy.messages = legacy.messages.filter(m => m.accountId === '100'); legacy.attachments = legacy.attachments.filter(a => legacy.messages.some(m => m.id === a.messageId));
    target.replaceState(legacy); expect(targetWx.config()).toMatchObject({ enabled: false, analysisEnabled: false, accountId: null });
  });

  it('keeps source times, source labels and verified wxid mentions distinct from QQ mentions', () => {
    const f = fixture();
    const raw = { group_id: group, message_id: 'server:2', time: Date.parse(at) / 1000, sender: { user_id: wx, nickname: '合成成员' }, message: [{ type: 'at', data: { wechat: wx } }, { type: 'text', data: { text: '明天中午提交材料' } }] };
    const parsed = normalizeMessage(raw, wx, new Map([[group, '合成微信群']]))!;
    expect(Date.parse(parsed.sentAt)).toBe(Date.parse(at)); expect(parsed.text).toContain('@我');
    expect(recipientContext({ ...parsed, segments: parsed.segments! })).toMatchObject({ audience: 'self', sender: 'self' });
    expect(recipientContext({ accountId: wx, segments: [{ type: 'at', data: { wechat: 'wxid_someone_else' } }] }).audience).toBe('others');
    expect(recipientContext({ accountId: wx, segments: [{ type: 'at', data: { qq: '100' } }] }).audience).toBe('unknown');
    f.wechat.ingest([parsed]); const batch = f.wechat.sealBatches({ force: true })[0]!;
    expect(prepareAnalysis(f.wechat, batch).units[0]).toMatchObject({ sentAt: parsed.sentAt, label: '微信 · 合成微信群 · 合成成员' });
  });

  it('passes the full-list WeChat audience to analysis and keeps an unverified legacy prefix eligible', async () => {
    const { wechat, repo } = fixture();
    const first100 = Array.from({ length: 100 }, (_, i) => ({ type: 'at', data: { wechat: 'wxid_other_' + i } }));
    const summary = (audience: string, truncated: boolean) => ({ type: 'wechat_mentions', data: { audience, truncated } });
    const rosters = {
      self: [summary('self', true)], all: [summary('all', true)], others: [summary('others', true)],
      unknown: [summary('unknown', true)], legacy: first100, complete: [...first100, summary('others', false)], reread: first100,
    };
    for (const [id, segments] of Object.entries(rosters)) {
      const raw = { group_id: group, message_id: id, time: Date.parse(at) / 1000,
        message: [{ type: 'text', data: { text: '请提交合成材料 ' + id } }, ...segments] };
      wechat.ingest([normalizeMessage(raw, wx, new Map())!]);
    }
    const corrected = normalizeMessage({ group_id: group, message_id: 'reread', time: Date.parse(at) / 1000,
      message: [{ type: 'text', data: { text: '请提交合成材料 reread' } }, summary('self', true)] }, wx, new Map())!;
    expect(wechat.ingest([corrected])).toMatchObject({ duplicates: 1, inserted: 0 });
    wechat.sealBatches({ force: true });
    const audiences: Record<string, string> = {};
    await analyzeCapture({ store: wechat, repository: repo, batch: wechat.claimBatch()!, getApiKey: async () => 'synthetic', canContinue: () => true,
      fetch: async (_url, request) => {
        const input = JSON.parse(JSON.parse(String(request?.body)).messages[1].content[0].text);
        for (const unit of input.units) {
          const id = unit.text.match(/请提交合成材料 (\w+)/)[1];
          audiences[id] = unit.recipient.audience;
          expect(unit.recipient.truncated).toBe(true);
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"candidates":[]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      },
    });
    expect(audiences).toEqual({ self: 'self', all: 'all', unknown: 'unknown', legacy: 'unknown', reread: 'self' });
    const paid = wechat.messageByKey(wx, group, 'legacy');
    wechat.ingest([{ ...corrected, messageId: 'legacy' }]);
    expect(wechat.messageByKey(wx, group, 'legacy')).toEqual(paid);
    expect(wechat.sealBatches({ force: true })).toEqual([]);
  });

  it.each([false, true])('recovers only the previously excluded source from a completed legacy batch (paid companion: %s)', async companion => {
    const { wechat, repo } = fixture();
    const roster = Array.from({ length: 100 }, (_, i) => ({ type: 'at', data: { wechat: 'wxid_other_' + i } }));
    const raw = (id: string, segments: unknown[]) => normalizeMessage({ group_id: group, message_id: id, time: Date.parse(at) / 1000,
      message: [{ type: 'text', data: { text: '请提交材料 ' + id } }, ...segments] }, wx, new Map())!;
    const original = wechat.ingest([raw('hidden', roster)]).ids[0]!;
    if (companion) wechat.ingest([raw('companion', [])]);
    const sent: string[][] = [];
    const run = async () => {
      wechat.sealBatches({ force: true });
      const batch = wechat.claimBatch()!;
      await analyzeCapture({ store: wechat, repository: repo, batch, canContinue: () => true, getApiKey: async () => 'synthetic',
        fetch: async (_url, request) => {
          const input = JSON.parse(JSON.parse(String(request?.body)).messages[1].content[0].text);
          sent.push(input.units.map((unit: { text: string }) => unit.text));
          return new Response(JSON.stringify({ choices: [{ message: { content: '{"candidates":[]}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        } });
      return wechat.batch(batch.id)!;
    };
    // Generate the actual old final checkpoint and receipts with the previous
    // audience decision; the fixture otherwise uses the ordinary capture path.
    const classify = recipients.recipientContext;
    const legacy = vi.spyOn(recipients, 'recipientContext').mockImplementation(message => {
      const result = classify(message);
      return message.segments.length === 101 ? { ...result, audience: 'others', truncated: false } : result;
    });
    let before;
    try { before = await run(); } finally { legacy.mockRestore(); }
    expect(before.status).toBe('applied');
    expect(before.attempts).toHaveLength(companion ? 1 : 0);
    expect(sent).toEqual(companion ? [['请提交材料 companion']] : []);
    const restored = raw('hidden', [{ type: 'wechat_mentions', data: { audience: 'self', truncated: true } }]);
    const added = wechat.ingest([restored]);
    expect(added.inserted).toBe(1);
    expect(wechat.message(added.ids[0]!)).toMatchObject({ sourceMessageId: 'hidden', text: expect.stringContaining('@我') });
    expect(wechat.ingest([restored]).inserted).toBe(0);
    expect((await run()).messageIds).toEqual(added.ids);
    expect(sent.at(-1)).toEqual([expect.stringContaining('请提交材料 hidden')]);
    expect(wechat.ingest([restored]).inserted).toBe(0);
    expect(wechat.batch(before.id)).toEqual(before);
    expect(wechat.message(original)!.segments).toHaveLength(101);
  });

  it('sends only compatible opaque summaries from a wxm source to the unchanged cloud importer', () => {
    const f = fixture(), messageId = f.wechat.ingest([incoming()]).ids[0]!;
    const source = f.repo.writeInternal({ operationId: 'synthetic-source', changes: [{ entity: 'source', values: { kind: 'text', text: 'PRIVATE_WECHAT_ORIGINAL', importedAt: at, sentAt: at, label: '微信 · 合成群', captureRef: { accountId: wx, groupId: group, messageId, attachmentId: null, locator: '消息正文1', transcribed: false } } }] }).entities[0]!;
    f.repo.writeInternal({ operationId: 'synthetic-candidate', changes: [{ entity: 'candidate', values: { title: '提交合成材料', sourceIds: [source.id] } }] });
    f.repo.writeInternal({ operationId: 'synthetic-private-candidate', changes: [{ entity: 'candidate', values: { title: '联系 wxid_synthetic 提交材料', sourceIds: [source.id] } }] });
    const reader = createCandidateReader(f.path); cleanup.push(() => reader.close());
    const projected = reader.scan(); expect(projected.items).toHaveLength(1); expect(projected.privacyRejected).toBe(1);
    const request = DistilledRequestSchema.parse({ requestId: 'synthetic-wechat-import', identity: { protocolVersion: 1, dataInstanceId: 'e7028f3d-072b-4ab2-bfd2-b915956318d3', generation: 1 }, items: projected.items.map(item => item.item) });
    expect(request.items[0]!.eventId).toMatch(/^qqe_/); expect(request.items[0]!.distilledId).toMatch(/^qqd_/);
    for (const privateValue of [wx, group, messageId, 'PRIVATE_WECHAT_ORIGINAL']) expect(JSON.stringify(request)).not.toContain(privateValue);
    const cloud = createRepository(':memory:', { automaticBackup: () => {} }); cleanup.push(() => cloud.close());
    expect(importDistilled(cloud, request).created).toBe(1);
    expect(importDistilled(cloud, request).created).toBe(1); expect(cloud.snapshot().candidates).toHaveLength(1);
  });

  function pollingFixture(history: CaptureBridge['history']) {
    const f = fixture(); f.wechat.saveConfig({ ...f.wechat.config(), enabled: false, analysisEnabled: false });
    const factory: CaptureBridgeFactory = options => ({
      async start() { const state = { state: 'online' as const, connected: true, online: true, accountId: wx, maskedAccount: '合成账号', nickname: '合成微信', lastEventAt: null, error: null }; options.onHealth?.(state); return state; },
      stop() {}, getGroups: async () => [{ id: group, name: '合成群' }], history, rememberMessage: () => false,
      getReferencedMessage: async () => ({}), getForward: async () => [], getImage: async () => { throw Error('unused'); }, getFileUrl: async () => { throw Error('unused'); },
    });
    const token = vi.fn(async () => null);
    const service = createCaptureService({ platform: 'wechat', store: f.wechat, repository: f.repo, bridgeFactory: factory, credentials: { get: token, set: async () => {}, status: () => ({ configured: false }) }, getApiKey: async () => null, extract: async () => ({ status: 'ready', parts: [], warnings: [] }) });
    cleanup.push(() => service.stop());
    return { f, service, token };
  }

  it('polls only selected groups every two minutes without requiring a QQ token', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(at));
    const history = vi.fn(async (groupId: string) => ({ messages: [{ group_id: groupId, message_id: 'poll-message', time: Date.now() / 1000, message: '明天中午提交合成材料' }], nextCursor: null, complete: false as const }));
    const { f, service, token } = pollingFixture(history);
    await service.start(); await service.connect(); expect(history).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
    await service.configure({ ...f.wechat.config(), enabled: true }); await vi.advanceTimersByTimeAsync(0);
    expect(history).toHaveBeenCalledTimes(1); expect(f.wechat.stats().messages).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000); expect(history).toHaveBeenCalledTimes(2); expect(f.wechat.stats().messages).toBe(1);
    await service.configure({ ...f.wechat.config(), enabled: false }); await vi.advanceTimersByTimeAsync(120_000); expect(history).toHaveBeenCalledTimes(2);
    expect(history.mock.calls.every(([id]) => id === group)).toBe(true);
  });

  it('rotates mid-window pages across manual and automatic polls while keeping a separate latest key', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(at));
    const keys = [20, 18, 16, 14, 12, 10, 8, 6, 4, 2], reads: string[] = [];
    const sent = Math.floor(Date.parse(at) / 1000) - 86400;
    const { f, service } = pollingFixture(async (groupId, cursor, limit, window) => {
      expect(limit).toBe(100); expect(window!.since).toBeLessThan(sent);
      const newer = window!.direction === 'newer';
      const visible = keys.filter(key => cursor == null || (newer ? key > Number(cursor) : key < Number(cursor)))
        .sort((a, b) => newer ? a - b : b - a);
      const key = visible[0];
      reads.push(window!.direction + ':' + (cursor ?? 'head'));
      return { messages: key ? [{ group_id: groupId, message_id: 'key-' + key, time: sent, message: '合成通知' }] : [],
        latestCursor: key ? String(key) : null, nextCursor: visible.length > 1 ? String(key) : null, complete: false };
    });
    // Old coverage has only the deepest cursor. It cannot establish a latest key.
    f.wechat.saveCoverage({ accountId: wx, groupId: group, status: 'partial', earliestAt: at, cursor: '2',
      windowStart: instantAt(Date.parse(at) - 7 * 86400_000), windowEnd: at, fetchedCount: 0, updatedAt: at, error: null });
    await service.start(); await service.connect();
    await service.configure({ ...f.wechat.config(), enabled: true }); await vi.advanceTimersByTimeAsync(2200);
    expect(reads).toHaveLength(10);
    expect(f.wechat.getCoverage(wx, group)).toMatchObject({ status: 'partial', cursor: null, wechatLatestCursor: '20' });
    keys.push(9, 22, 24, 26);
    reads.length = 0; service.action({ action: 'backfill' }); await vi.advanceTimersByTimeAsync(2000);
    expect(reads).toEqual(['older:head', 'newer:20', 'newer:22', 'newer:24', 'older:26', 'older:24', 'older:22']);
    expect(f.wechat.getCoverage(wx, group)).toMatchObject({ cursor: '20', wechatLatestCursor: '26' });
    expect(f.wechat.messageByKey(wx, group, 'key-9')).toBeNull();
    const backup = f.wechat.exportState().state;
    expect(backup.coverage).toContainEqual(expect.objectContaining({ accountId: wx, groupId: group, cursor: '20', wechatLatestCursor: '26' }));
    f.wechat.replaceState(backup, { pause: false });
    reads.length = 0; await vi.advanceTimersByTimeAsync(150_000);
    expect(reads).toEqual(['newer:26', 'older:20', 'older:18', 'older:16', 'older:14']);
    reads.length = 0; service.action({ action: 'backfill' }); await vi.advanceTimersByTimeAsync(1500);
    expect(reads).toEqual(['newer:26', 'older:12', 'older:10', 'older:9', 'older:8']);
    expect(Date.parse(f.wechat.messageByKey(wx, group, 'key-9')!.sentAt)).toBe(sent * 1000);
    expect(f.wechat.stats().messages).toBe(keys.length);
  });

  it('reserves inspection pages even when catching up with more than 200 new pages', async () => {
    const directions: string[] = [];
    let checkpoint = { latest: '2000' as string | null, inspection: '1000' as string | null };
    const pass = () => pollWechatHistory(checkpoint, async (cursor, direction) => {
      directions.push(direction);
      const next = String(Number(cursor) + (direction === 'newer' ? 1 : -1));
      return { latestCursor: next, nextCursor: next };
    }, progress => { checkpoint = progress; });
    await pass();
    expect(directions).toHaveLength(200);
    expect(directions.slice(-4)).toEqual(['older', 'older', 'older', 'older']);
    expect(checkpoint).toEqual({ latest: '2196', inspection: '996' });
    directions.length = 0; await pass();
    expect(directions).toHaveLength(200);
    expect(checkpoint).toEqual({ latest: '2392', inspection: '992' });
  });
});
