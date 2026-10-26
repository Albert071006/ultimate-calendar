import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createCaptureStore, emptyCaptureState, readCaptureDatabaseState, replaceCaptureDatabaseState, validateCaptureState, type CaptureStore } from './store';
import { CaptureConfigSchema, LoopbackEndpointSchema } from '../shared/capture';
import { openDatabase } from '../storage/database';

const account = '900719925474099312345'; const group = '1234567890123456789';
const t0 = '2026-10-23T12:00:00+08:00'; const t1 = '2026-10-23T12:01:00+08:00'; const t2 = '2026-10-23T12:02:00+08:00';
const stores: CaptureStore[] = []; const dirs: string[] = [];
function make(path = ':memory:') { const store = createCaptureStore(path); stores.push(store); return store; }
function enabled(store: CaptureStore) { store.saveConfig({ ...store.config(), enabled: true, accountId: account, groupIds: [group] }); }
function incoming(messageId: string, overrides = {}) { return { accountId: account, groupId: group, messageId, sentAt: t0, importedAt: t0, text: '明天 18 点提交报告', ...overrides }; }
function close(store: CaptureStore) { store.close(); stores.splice(stores.indexOf(store), 1); }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('capture store', () => {
  it.each(['', 'AA==', 'AAA=', 'AAAA', '+/8='])('accepts canonical attachment encoding %j', encoded => {
    const state = emptyCaptureState(), bytes = Buffer.from(encoded, 'base64');
    state.blobs.push({ hash: createHash('sha256').update(bytes).digest('hex'), bytes: encoded });
    expect(validateCaptureState(state).blobs[0]?.bytes).toBe(encoded);
  });
  it.each(['AA', 'AAA', 'A', 'AA===', 'AA==AAAA', 'AA==\n', 'A A==', 'AA$=', '-_8=', 'AB==', 'AAB='])('rejects malformed or noncanonical attachment encoding %j even with a matching decoded hash', encoded => {
    const state = emptyCaptureState();
    state.blobs.push({ hash: createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex'), bytes: encoded });
    expect(() => validateCaptureState(state)).toThrow('附件内容编码无效');
  });
  it('rejects decoded attachments exceeding 25 MiB even with valid encoding and a matching hash', () => {
    const state = emptyCaptureState(), bytes = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
    state.blobs.push({ hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.toString('base64') });
    expect(() => validateCaptureState(state)).toThrow('附件内容校验失败');
  });
  it('defaults to no collection and validates loopback endpoints without hidden credentials', () => {
    const store = make(); expect(store.config()).toMatchObject({ enabled: false, analysisEnabled: true, groupIds: [], flavor: 'napcat', historyDays: 7, intervalSeconds: 120 });
    expect(store.ingest([incoming('m1')])).toMatchObject({ inserted: 0, ignored: 1 });
    for (const url of ['ws://example.com:3001', 'http://localhost:3000', 'http://localhost.example.com', 'ws://user:secret@127.0.0.1', 'ws://127.0.0.1/?token=secret', 'file:///C:/secret']) expect(LoopbackEndpointSchema.safeParse(url).success).toBe(false);
    for (const url of ['ws://127.0.0.1:3001', 'wss://localhost:3000', 'ws://[::1]:3001']) expect(LoopbackEndpointSchema.safeParse(url).success).toBe(true);
    expect(CaptureConfigSchema.safeParse({ enabled: true }).success).toBe(false);
  });
  it('persists local credential pauses and resumes only the exact rejected batch after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-credential-pause-')); dirs.push(dir); const path = join(dir, 'planner.sqlite');
    let store = make(path); enabled(store);
    const failures = ['credential', 'unknown', 'balance'].map((id, index) => {
      store.ingest([incoming(id)]); const pending = store.sealBatches({ force: true })[0]!;
      store.claimBatch(); store.startAttempt(pending.id, `input-${index}`);
      return store.failBatch(pending.id, id, id === 'unknown');
    });
    expect(store.pauseForCredentials('AUTH', failures[0]!.id)).toBe(true);
    expect(store.config()).toMatchObject({ enabled: true, analysisEnabled: false });
    expect(JSON.stringify(store.exportState().state)).not.toContain('credentialPause');
    close(store); store = make(path);
    expect(store.credentialPause()?.reason).toBe('AUTH');
    store.saveConfig({ ...store.config(), enabled: false });
    expect(store.resumeAfterCredentials(t2)).toBe(true);
    expect(store.config()).toMatchObject({ enabled: false, analysisEnabled: true });
    expect(failures.map(batch => store.batch(batch.id)?.status)).toEqual(['pending', 'uncertain', 'failed']);
    expect(store.credentialPause()).toBeNull(); expect(store.resumeAfterCredentials()).toBe(false);
  });
  it('does not infer resume permission for manual pauses or restore it from backups', () => {
    const store = make(); enabled(store); store.ingest([incoming('credential')]);
    const batch = store.sealBatches({ force: true })[0]!; store.claimBatch(); store.failBatch(batch.id, 'key rejected');
    store.pauseForCredentials('AUTH', batch.id);
    store.failBatch(batch.id, 'later non-credential failure');
    store.resumeAfterCredentials(); expect(store.batch(batch.id)?.status).toBe('failed');
    store.pauseForCredentials('NO_API_KEY'); store.clearCredentialPause();
    expect(store.pauseForCredentials('NO_API_KEY')).toBe(false);
    expect(store.resumeAfterCredentials()).toBe(false); expect(store.config().analysisEnabled).toBe(false);
    store.saveConfig({ ...store.config(), analysisEnabled: true }); store.pauseForCredentials('NO_API_KEY');
    store.replaceState(store.exportState().state);
    expect(store.credentialPause()).toBeNull(); expect(store.resumeAfterCredentials()).toBe(false);
  });
  it('atomically acknowledges a credential revision and never resumes it twice after another rejection or restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-credential-receipt-')); dirs.push(dir); const path = join(dir, 'planner.sqlite');
    let store = make(path); enabled(store); store.ingest([incoming('credential')]);
    const batch = store.sealBatches({ force: true })[0]!; store.claimBatch(); store.failBatch(batch.id, 'first rejected key');
    store.pauseForCredentials('AUTH', batch.id);
    const change = { sourceId: '1'.repeat(64), revision: '11111111-1111-4111-8111-111111111111', configured: true };
    const database = openDatabase(path);
    database.exec("CREATE TRIGGER reject_sync_ack BEFORE INSERT ON capture_meta WHEN NEW.id='credentialChange' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;");
    expect(() => store.applyCredentialChange(change)).toThrow('synthetic receipt failure');
    expect(store.config().analysisEnabled).toBe(false); expect(store.credentialPause()?.reason).toBe('AUTH');
    expect(store.batch(batch.id)?.status).toBe('failed');
    database.exec('DROP TRIGGER reject_sync_ack'); database.close();
    expect(store.applyCredentialChange(change)).toEqual({ changed: true, resumed: true, paused: false });
    store.claimBatch(); store.failBatch(batch.id, 'replacement key also rejected'); store.pauseForCredentials('AUTH', batch.id);
    close(store); store = make(path);
    expect(store.applyCredentialChange(change)).toEqual({ changed: false, resumed: false, paused: false });
    expect(store.config().analysisEnabled).toBe(false); expect(store.batch(batch.id)?.status).toBe('failed');
    expect(store.credentialPause()?.reason).toBe('AUTH');
    expect(store.applyCredentialChange({ ...change, revision: '22222222-2222-4222-8222-222222222222' }).resumed).toBe(true);
    expect(store.batch(batch.id)?.status).toBe('pending');
  });
  it('persists protocol selection and invalidates provider cursors without deleting collected messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-protocol-store-')); dirs.push(dir); const path = join(dir, 'planner.sqlite');
    let store = make(path); enabled(store); store.ingest([incoming('m1')]);
    const coverage = { accountId: account, groupId: group, status: 'partial', windowStart: t0, windowEnd: t2, earliestAt: t1, cursor: 'napcat-sequence', fetchedCount: 1, updatedAt: t2, error: null };
    store.saveCoverage(coverage);
    store.saveConfig({ ...store.config(), analysisEnabled: false });
    expect(store.getCoverage(account, group)?.cursor).toBe('napcat-sequence');
    store.saveConfig({ ...store.config(), flavor: 'snowluma' });
    expect(store.getCoverage(account, group)).toMatchObject({ status: 'not-started', cursor: null, fetchedCount: 0 });
    expect(store.messageByKey(account, group, 'm1')?.text).toBe('明天 18 点提交报告');
    close(store); store = make(path); expect(store.config().flavor).toBe('snowluma');
    store.saveCoverage({ ...coverage, cursor: 'snow-message-id' });
    store.saveConfig({ ...store.config(), endpoint: 'ws://127.0.0.1:43132' });
    expect(store.getCoverage(account, group)?.cursor).toBeNull(); expect(store.stats().messages).toBe(1);
  });
  it('persists account selection, string IDs and deduplication across real SQLite restarts without changing planner user_version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-store-')); dirs.push(dir); const path = join(dir, 'planner.sqlite');
    const planner = openDatabase(path); planner.exec('PRAGMA user_version=1'); planner.close();
    let store = make(path); enabled(store);
    expect(store.ingest([incoming('9007199254740993001'), incoming('9007199254740993001'), incoming('other', { accountId: 'other' }), incoming('other', { groupId: 'unselected' })])).toMatchObject({ inserted: 1, duplicates: 1, ignored: 2 });
    close(store); store = make(path);
    expect(store.selectedGroups(account)).toEqual([group]);
    expect(store.ingest([incoming('9007199254740993001')])).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(store.listMessages().items[0]).toMatchObject({ accountId: account, groupId: group, messageId: '9007199254740993001' });
    const verifier = openDatabase(path); expect(verifier.prepare('PRAGMA user_version').get()!['user_version']).toBe(1); verifier.close();
    store.saveConfig({ ...store.config(), enabled: false, accountId: 'new-account', groupIds: [] });
    expect(store.selectedGroups(account)).toEqual([group]); expect(store.ingest([incoming('m2')]).ignored).toBe(1);
  });
  it('keeps raw attachment locators and message segments out of renderer message pages', () => {
    const store = make(); enabled(store);
    const result = store.ingest([incoming('m1', { senderId: 'private-id', segments: [{ type: 'file', data: { url: 'https://private.invalid', path: 'C:/private.docx' } }], attachments: [{ name: '通知.docx', kind: 'file', locator: { url: 'https://private.invalid', path: 'C:/private.docx' } }] })]);
    const serialized = JSON.stringify(store.listMessages());
    expect(serialized).not.toContain('private.invalid'); expect(serialized).not.toContain('C:/'); expect(serialized).not.toContain('private-id');
    expect(store.message(result.ids[0]!)!.segments).toHaveLength(1);
    expect(store.attachments(result.ids[0]!)[0]!.locator).toMatchObject({ path: 'C:/private.docx' });
  });
  it('seals at the first two-minute deadline even during continuing traffic and fixes membership', () => {
    const store = make(); enabled(store); store.ingest([incoming('m1')]);
    expect(store.sealBatches({ now: t1 })).toEqual([]);
    store.ingest([incoming('m2', { importedAt: t1 })]);
    const [batch] = store.sealBatches({ now: t2 }); expect(batch!.messageIds).toHaveLength(2);
    store.ingest([incoming('m3', { importedAt: t2 })]);
    expect(store.batch(batch!.id)!.messageIds).toEqual(batch!.messageIds); expect(store.sealBatches({ now: t2 })).toEqual([]);
    const [next] = store.sealBatches({ now: t2, force: true }); expect(next!.messageIds).toHaveLength(1);
    expect(store.sealBatches({ now: t2, force: true })).toEqual([]);
    expect(store.listBatches().total).toBe(2);
  });
  it('keeps individual send dates while limiting batch size and separating accounts/groups', () => {
    const store = make(); enabled(store);
    store.ingest([incoming('m1', { sentAt: '2026-10-21T23:00:00+08:00' }), incoming('m2'), incoming('m3')]);
    const batches = store.sealBatches({ now: t2, maxMessages: 2 }); expect(batches.map(item => item.messageIds.length)).toEqual([2, 1]);
    expect(store.batchMessages(batches[0]!.id).some(item => item.sentAt.startsWith('2026-10-21'))).toBe(true);
    expect(store.listMessages({ offset: 1, limit: 1 }).items).toHaveLength(1);
  });
  it('never automatically repeats a request after a crash but resumes preparation and local result application', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-recovery-')); dirs.push(dir); const path = join(dir, 'planner.sqlite');
    let store = make(path); enabled(store);
    store.ingest([incoming('m1'), incoming('m2'), incoming('m3')]);
    const batches = store.sealBatches({ now: t2, maxMessages: 1 });
    const first = store.claimBatch(t2)!; store.startAttempt(first.id, 'fingerprint-a', t2);
    const second = store.claimBatch(t2)!; store.startAttempt(second.id, 'fingerprint-b', t2); store.saveResult(second.id, { candidates: [] }, t2);
    store.claimBatch(t2); // saved result remains eligible for local application; claim explicit next pending below
    store.markApplied(second.id, t2);
    const third = store.claimBatch(t2)!; expect(third.status).toBe('preparing');
    close(store); store = make(path);
    expect(store.batch(first.id)!.status).toBe('uncertain'); expect(store.batch(first.id)!.attempts[0]!.status).toBe('uncertain');
    expect(store.batch(second.id)!.status).toBe('applied'); expect(store.batch(second.id)!.result).toEqual({ candidates: [] });
    expect(store.batch(third.id)!.status).toBe('pending'); expect(store.claimBatch(t2)!.id).toBe(third.id);
    store.retryBatch(first.id, t2); expect(store.batch(first.id)!.status).toBe('pending');
    expect(batches).toHaveLength(3);
  });
  it('retains saved results and stable operation IDs across restart without another request attempt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-result-')); dirs.push(dir); const path = join(dir, 'planner.sqlite');
    let store = make(path); enabled(store); store.ingest([incoming('m1')]); store.sealBatches({ now: t2 });
    const batch = store.claimBatch(t2)!; store.startAttempt(batch.id, 'fingerprint', t2); store.saveResult(batch.id, { candidates: [{ title: '交报告' }] }, t2);
    close(store); store = make(path); const resumed = store.claimBatch(t2)!;
    expect(resumed.status).toBe('result-ready'); expect(resumed.operationId).toBe(batch.operationId); expect(resumed.attempts).toHaveLength(1);
    expect(() => store.startAttempt(resumed.id, 'new')).toThrow(); store.markApplied(resumed.id, t2); store.markApplied(resumed.id, t2);
    expect(store.claimBatch(t2)).toBeNull();
  });
  it('checkpoints successful paid chunks before another request and preserves them when a later request becomes uncertain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-checkpoint-')); dirs.push(dir); const path = join(dir, 'planner.sqlite');
    let store = make(path); enabled(store); store.ingest([incoming('m1')]); store.sealBatches({ now: t2 });
    const batch = store.claimBatch(t2)!;
    store.startAttempt(batch.id, 'document-plan-v1', t2);
    const partial = { version: 1, completed: [{ key: 'page-1', value: { text: '已完成' } }] };
    store.checkpointResult(batch.id, partial, 'document-plan-v1', t2);
    expect(store.batch(batch.id)!.attempts[0]!.status).toBe('succeeded');
    store.startAttempt(batch.id, 'document-plan-v1', t2);
    close(store); store = make(path);
    expect(store.batch(batch.id)!.status).toBe('uncertain'); expect(store.batch(batch.id)!.result).toEqual(partial);
    store.retryBatch(batch.id, t2); expect(store.batch(batch.id)!.status).toBe('pending');
    expect(store.claimBatch(t2)!.result).toEqual(partial);
  });
  it('stores attachment bytes in SQLite, caches extraction by content/version and preserves partial chunk progress', () => {
    const store = make(); enabled(store);
    const ingested = store.ingest([incoming('m1', { attachments: [{ name: '通知.txt', kind: 'file' }, { name: '同内容.txt', kind: 'file' }] })]);
    const [a, b] = store.attachments(ingested.ids[0]!); const bytes = Buffer.from('附件正文');
    const saved = store.putAttachment(a!.id, bytes); store.putAttachment(b!.id, bytes);
    expect(store.stats().attachmentBytes).toBe(bytes.length); expect(store.readAttachmentBytes(a!.id)).toEqual(bytes);
    store.saveChunk(a!.id, { ordinal: 0, location: '第 1 行', text: '附件正文', status: 'ready', error: null, imageDataUrl: null });
    expect(store.chunks(a!.id)).toHaveLength(1);
    store.saveExtraction(a!.id, { extractorVersion: 'text-v1', chunks: [{ ordinal: 0, location: '第 1 行', text: '附件正文', status: 'ready', error: null, imageDataUrl: null }] });
    expect(store.findExtraction(saved.hash!, 'text-v1')!.chunks[0]!.location).toBe('第 1 行'); expect(store.findExtraction(saved.hash!, 'text-v2')).toBeNull();
    expect(() => store.putAttachment(a!.id, new Uint8Array(25 * 1024 * 1024 + 1))).toThrow('25 MB');
  });
  it('backs up full capture state, validates references and pauses restored work by default', () => {
    const store = make(); enabled(store);
    const [id] = store.ingest([incoming('m1', { attachments: [{ name: '通知.txt', kind: 'file' }] })]).ids;
    const a = store.attachments(id!)[0]!; store.putAttachment(a.id, Buffer.from('正文')); store.sealBatches({ now: t2 });
    const batch = store.claimBatch(t2)!; store.startAttempt(batch.id, 'fingerprint', t2);
    const exported = store.exportState(); const restored = make(); restored.replaceState(exported.state);
    expect(restored.config()).toMatchObject({ enabled: false, analysisEnabled: false });
    expect(restored.readAttachmentBytes(a.id)).toEqual(Buffer.from('正文')); expect(restored.batch(batch.id)!.status).toBe('uncertain');
    expect(() => restored.replaceState(exported.state, { expectedFingerprint: 'stale' })).toThrow('已变化');
    const bad = structuredClone(exported.state); bad.attachments[0]!.messageId = 'missing';
    expect(() => restored.inspectState(bad)).toThrow('附件来源');
    const corrupted = structuredClone(exported.state); corrupted.blobs[0]!.bytes = Buffer.from('changed').toString('base64');
    expect(() => restored.inspectState(corrupted)).toThrow('校验');
  });
  it('clears original text and attachment bytes while retaining deduplication tombstones and candidate-independent batch identity', () => {
    const store = make(); enabled(store);
    const ids = store.ingest([incoming('m1', { attachments: [{ name: '通知.txt', kind: 'file' }] }), incoming('m2', { sentAt: t2 })]).ids;
    const a = store.attachments(ids[0]!)[0]!; store.putAttachment(a.id, Buffer.from('正文'));
    store.sealBatches({ now: t2 });
    const result = store.cleanup({ accountId: account, groupId: group, before: t1 });
    expect(result.messages).toBe(1); expect(store.message(ids[0]!)!.deleted).toBe(true); expect(store.message(ids[0]!)!.text).toBe('');
    expect(store.readAttachmentBytes(a.id)).toBeNull(); expect(store.stats().attachmentBytes).toBe(0);
    expect(store.ingest([incoming('m1')]).duplicates).toBe(1);
    expect(store.listBatches().items[0]!.status).toBe('failed'); expect(() => store.retryBatch(store.listBatches().items[0]!.id)).toThrow('原文已清理');
    expect(store.message(ids[1]!)!.deleted).toBe(false);
  });
  it('rejects cleanup while a model request is in progress without partially deleting messages', () => {
    const store = make(); enabled(store); const ids = store.ingest([incoming('m1'), incoming('m2')]).ids; store.sealBatches({ now: t2 });
    const batch = store.claimBatch(t2)!; store.startAttempt(batch.id, 'fp', t2);
    expect(() => store.cleanup({ accountId: account, groupId: group })).toThrow('正在处理');
    expect(ids.every(id => !store.message(id)!.deleted)).toBe(true);
  });
  it('stores partial history coverage without inferring completeness from an empty response', () => {
    const store = make();
    const value = { accountId: account, groupId: group, status: 'partial', windowStart: '2026-10-16T12:00:00+08:00', windowEnd: t0, earliestAt: null, cursor: null, fetchedCount: 0, updatedAt: t0, error: '桥接未返回历史，无法确认覆盖' };
    store.saveCoverage(value); expect(store.getCoverage(account, group)!.status).toBe('partial'); expect(store.listCoverage(account)).toHaveLength(1);
  });
  it('cleans full text and images out of both applied results and uncertain checkpoints', () => {
    const store = make(); enabled(store); store.ingest([incoming('m1'), incoming('m2')]); store.sealBatches({ now: t2, maxMessages: 1 });
    const applied = store.claimBatch(t2)!; store.saveResult(applied.id, { units: [{ text: 'private-original', imageDataUrl: 'private-image' }], final: true }, t2); store.markApplied(applied.id, t2);
    const uncertain = store.claimBatch(t2)!; store.checkpointResult(uncertain.id, { units: [{ text: 'private-original', imageDataUrl: 'private-image' }] }, 'fp', t2);
    store.startAttempt(uncertain.id, 'fp', t2); store.failBatch(uncertain.id, 'unknown', true, t2);
    store.cleanup({ accountId: account, groupId: group });
    expect(store.batch(applied.id)!.result).toEqual({ cleaned: true }); expect(store.batch(uncertain.id)!.result).toBeNull();
    expect(JSON.stringify(store.exportState().state)).not.toContain('private-original'); expect(JSON.stringify(store.exportState().state)).not.toContain('private-image');
    expect(() => store.reanalyzeBatch(applied.id)).toThrow('原文已清理');
  });
  it('requires explicit reanalysis to replace a saved plan, resets failed attachments and uses a new local operation ID', () => {
    const store = make(); enabled(store); const [id] = store.ingest([incoming('m1', { attachments: [{ name: '通知.txt', kind: 'file' }] })]).ids;
    store.sealBatches({ now: t2 }); const batch = store.claimBatch(t2)!; store.startAttempt(batch.id, 'old-model', t2);
    store.checkpointResult(batch.id, { oldPlan: true }, 'old-model', t2); store.failBatch(batch.id, 'file failed', false, t2);
    const attachment = store.attachments(id!)[0]!; store.setAttachmentStatus(attachment.id, 'failed', 'temporary failure');
    store.reanalyzeBatch(batch.id, t2); const next = store.batch(batch.id)!;
    expect(next.operationId).not.toBe(batch.operationId); expect(next.result).toBeNull(); expect(next.status).toBe('pending');
    expect(next.attempts).toHaveLength(1); expect(store.attachment(attachment.id)!.status).toBe('pending');
  });
  it('replaces capture state inside the caller transaction and revisions detect changes without reading attachment bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-transaction-')); dirs.push(dir); const path = join(dir, 'planner.sqlite');
    const store = make(path); enabled(store); const before = store.fingerprint(); store.ingest([incoming('m1')]); expect(store.fingerprint()).not.toBe(before);
    const db = openDatabase(path); const original = readCaptureDatabaseState(db);
    db.exec('BEGIN IMMEDIATE');
    replaceCaptureDatabaseState(db, { ...original, messages: [] }, { recover: true });
    expect(readCaptureDatabaseState(db).messages).toHaveLength(0); db.exec('ROLLBACK');
    expect(store.stats().messages).toBe(1);
    db.exec('BEGIN IMMEDIATE'); replaceCaptureDatabaseState(db, original, { recover: true }); db.exec('COMMIT');
    expect(store.config()).toMatchObject({ enabled: false, analysisEnabled: false }); expect(store.stats().messages).toBe(1); db.close();
  });
  it('prioritizes live batches while guaranteeing historical work a turn, including across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-priority-')); dirs.push(dir); const path = join(dir, 'planner.sqlite');
    let store = make(path); enabled(store);
    store.ingest(Array.from({ length: 4 }, (_, index) => incoming(`history-${index}`, { origin: 'history', sentAt: '2026-10-20T12:00:00+08:00' })));
    store.sealBatches({ now: t2, maxMessages: 1 });
    store.ingest(Array.from({ length: 4 }, (_, index) => incoming(`live-${index}`)));
    store.sealBatches({ now: t2, maxMessages: 1 });
    for (let index = 0; index < 3; index++) { const batch = store.claimBatch(t2)!; expect(batch.origin).toBe('live'); store.saveResult(batch.id, { candidates: [] }, t2); store.markApplied(batch.id, t2); }
    close(store); store = make(path);
    const historical = store.claimBatch(t2)!; expect(historical.origin).toBe('history'); store.saveResult(historical.id, { candidates: [] }, t2); store.markApplied(historical.id, t2);
    expect(store.claimBatch(t2)!.origin).toBe('live');
  });
});
