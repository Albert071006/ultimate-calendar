import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCaptureStore } from './store';
import { createRepository } from '../storage/repository';
import { inspectCaptureBackupFile, copyCaptureBackupFile } from './backup-file';
import { openDatabase } from '../storage/database';
import { prepareAnalysis } from './analysis';
import { recipientContext } from './recipients';
import { createCaptureService, normalizeMessage, type CaptureBridgeFactory } from './service';
import { createCandidateReader } from '../bridge/source-reader';
import { DistilledRequestSchema } from '../shared/distilled';
import { importDistilled } from '../server/distilled';

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

describe('concurrent QQ and WeChat collection', () => {
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

  it('polls only selected groups every two minutes without requiring a QQ token', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(at));
    const f = fixture(); f.wechat.saveConfig({ ...f.wechat.config(), enabled: false, analysisEnabled: false });
    const history = vi.fn(async (groupId: string) => ({ messages: [{ group_id: groupId, message_id: 'poll-message', time: Date.now() / 1000, message: '明天中午提交合成材料' }], nextCursor: null, complete: false as const }));
    const factory: CaptureBridgeFactory = options => ({
      async start() { const state = { state: 'online' as const, connected: true, online: true, accountId: wx, maskedAccount: '合成账号', nickname: '合成微信', lastEventAt: null, error: null }; options.onHealth?.(state); return state; },
      stop() {}, getGroups: async () => [{ id: group, name: '合成群' }], history, rememberMessage: () => false,
      getReferencedMessage: async () => ({}), getForward: async () => [], getImage: async () => { throw Error('unused'); }, getFileUrl: async () => { throw Error('unused'); },
    });
    const token = vi.fn(async () => null);
    const service = createCaptureService({ platform: 'wechat', store: f.wechat, repository: f.repo, bridgeFactory: factory, credentials: { get: token, set: async () => {}, status: () => ({ configured: false }) }, getApiKey: async () => null, extract: async () => ({ status: 'ready', parts: [], warnings: [] }) });
    cleanup.push(() => service.stop());
    await service.start(); await service.connect(); expect(history).not.toHaveBeenCalled(); expect(token).not.toHaveBeenCalled();
    await service.configure({ ...f.wechat.config(), enabled: true }); await vi.advanceTimersByTimeAsync(0);
    expect(history).toHaveBeenCalledTimes(1); expect(f.wechat.stats().messages).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000); expect(history).toHaveBeenCalledTimes(2); expect(f.wechat.stats().messages).toBe(1);
    await service.configure({ ...f.wechat.config(), enabled: false }); await vi.advanceTimersByTimeAsync(120_000); expect(history).toHaveBeenCalledTimes(2);
    expect(history.mock.calls.every(([id]) => id === group)).toBe(true);
  });
});
