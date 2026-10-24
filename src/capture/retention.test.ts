import { afterEach, describe, expect, it } from 'vitest';
import { createCaptureStore } from './store';
import { openDatabase } from '../storage/database';

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });
const now = '2026-03-01T12:00:00+08:00';
const old = '2026-01-01T12:00:00+08:00';
const recent = '2026-02-20T12:00:00+08:00';
const policy = { retentionDays: 30, maxBytes: 1024 ** 3, now };
function setup() {
  const db = openDatabase(':memory:');
  const store = createCaptureStore(':memory:', { database: db });
  closers.push(() => db.close());
  store.saveConfig({ ...store.config(), enabled: true, accountId: 'test-account', groupIds: ['test-group'] });
  function add(id: string, at = old, content = Buffer.from(`synthetic-${id}`)) {
    const messageId = store.ingest([{ accountId: 'test-account', groupId: 'test-group', messageId: id, sentAt: at, importedAt: at, text: `通知 ${id}`, attachments: [{ name: `${id}.pdf`, kind: 'file' }] }]).ids[0]!;
    const attachment = store.attachments(messageId)[0]!;
    store.putAttachment(attachment.id, content);
    store.saveExtraction(attachment.id, { extractorVersion: 'synthetic-v1', chunks: [{ ordinal: 0, location: '第1页', text: `完整通知 ${id}`, imageDataUrl: null, status: 'ready', error: null }] });
    store.sealBatches({ now: at, force: true });
    const batch = store.claimBatch(at)!;
    store.saveResult(batch.id, { version: 2, units: [{ id: 'unit', text: 'duplicate-input'.repeat(50), imageDataUrl: 'duplicate-image' }], context: [{ text: 'context' }], completed: [{ key: 'key', value: { candidates: [{ sourceQuote: '已提炼的证据' }] } }], final: true }, at);
    store.markApplied(batch.id, at);
    return { messageId, attachmentId: attachment.id, batchId: batch.id };
  }
  function status(id: string, status: string) {
    db.prepare("UPDATE capture_batches SET status=?,payload=json_set(payload,'$.status',?) WHERE id=?").run(status, status, id);
  }
  return { db, store, add, status };
}

describe('attachment retention', () => {
  it('previews without writes, clears only expired attachment caches, preserves text and AI output, and cannot re-bill cleared inputs', () => {
    const { db, store, add } = setup(); const a = add('old'), b = add('recent', recent);
    const revision = String(db.prepare("SELECT payload FROM capture_meta WHERE id='revision'").get()!['payload']);
    const preview = store.previewAttachmentRetention(policy);
    expect(preview.selectedAttachments).toBe(1); expect(preview.reclaimableBytes).toBeGreaterThan(0);
    expect(String(db.prepare("SELECT payload FROM capture_meta WHERE id='revision'").get()!['payload'])).toBe(revision);
    expect(store.cleanAttachments(policy)).toEqual(preview);
    expect(store.message(a.messageId)).toMatchObject({ text: '通知 old', deleted: false });
    expect(store.attachment(a.attachmentId)).toMatchObject({ status: 'deleted', hash: null, locator: null });
    expect(store.listChunks(a.attachmentId).total).toBe(0);
    expect(store.readAttachmentBytes(b.attachmentId)).not.toBeNull();
    expect(store.batch(a.batchId)?.result).toMatchObject({ completed: [{ value: { candidates: [{ sourceQuote: '已提炼的证据' }] } }], attachmentsCleared: true });
    expect(JSON.stringify(store.batch(a.batchId)?.result)).not.toContain('duplicate-input');
    expect(() => store.reanalyzeBatch(a.batchId)).toThrow('附件缓存已清理');
    expect(store.claimBatch()).toBeNull();
    expect(store.cleanAttachments(policy)).toMatchObject({ selectedAttachments: 0, reclaimableBytes: 0 });
  });

  it.each(['pending', 'preparing', 'requesting', 'uncertain', 'result-ready', 'failed'])('protects %s batches even when over budget', batchStatus => {
    const { store, add, status } = setup(); const a = add('protected'); status(a.batchId, batchStatus);
    const result = store.cleanAttachments({ ...policy, maxBytes: 1 });
    expect(result).toMatchObject({ selectedAttachments: 0, protectedAttachments: 1, reclaimableBytes: 0 });
    expect(result.overBudgetBytes).toBeGreaterThan(0);
    expect(store.readAttachmentBytes(a.attachmentId)).not.toBeNull();
  });

  it('retains a shared BLOB when a protected batch still uses it', () => {
    const { store, add, status } = setup(); const shared = Buffer.from('same-document');
    const a = add('old', old, shared), b = add('pending', old, shared); status(b.batchId, 'pending');
    const result = store.cleanAttachments(policy);
    expect(result).toMatchObject({ selectedAttachments: 1, protectedAttachments: 1 });
    expect(store.readAttachmentBytes(a.attachmentId)).toBeNull();
    expect(store.readAttachmentBytes(b.attachmentId)).toEqual(shared);
    expect(store.stats().attachmentBytes).toBe(shared.length);
  });

  it('frees shared BLOBs only after every eligible reference is selected', () => {
    const { store, add } = setup(); const shared = Buffer.from('same-document');
    add('first', old, shared); add('second', old, shared);
    const result = store.cleanAttachments(policy);
    expect(result.selectedAttachments).toBe(2); expect(result.remainingBytes).toBe(0);
    expect(store.stats().attachmentBytes).toBe(0);
  });

  it('protects pending candidates and unfinished task evidence without touching any formal records', () => {
    const { db, store, add } = setup(); const pending = add('pending'), active = add('active'), finished = add('finished');
    db.exec('CREATE TABLE records(kind TEXT,id TEXT,payload TEXT); CREATE TABLE ledger_state(id TEXT,payload TEXT);');
    const insert = (kind: string, id: string, value: unknown) => db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind, id, JSON.stringify(value));
    for (const [name, data] of [['pending', pending], ['active', active], ['finished', finished]] as const) {
      insert('source', `s-${name}`, { captureRef: { messageId: data.messageId, attachmentId: data.attachmentId }, text: '正式提炼正文', status: 'needs-review' });
      insert('candidate', `c-${name}`, { sourceIds: [`s-${name}`], status: name === 'pending' ? 'pending' : 'accepted', taskId: name });
    }
    insert('task', 'active', { status: 'open', candidateId: 'c-active' });
    insert('task', 'finished', { status: 'done', candidateId: 'c-finished' });
    insert('course', 'course', { title: '合成课程' });
    db.prepare('INSERT INTO ledger_state VALUES(?,?)').run('ledger', '{"synthetic":true}');
    const beforeRecords = db.prepare('SELECT * FROM records').all(), beforeLedger = db.prepare('SELECT * FROM ledger_state').all();
    expect(store.cleanAttachments(policy)).toMatchObject({ selectedAttachments: 1, protectedAttachments: 2 });
    expect(store.readAttachmentBytes(pending.attachmentId)).not.toBeNull();
    expect(store.readAttachmentBytes(active.attachmentId)).not.toBeNull();
    expect(store.readAttachmentBytes(finished.attachmentId)).toBeNull();
    expect(db.prepare('SELECT * FROM records').all()).toEqual(beforeRecords);
    expect(db.prepare('SELECT * FROM ledger_state').all()).toEqual(beforeLedger);
  });

  it('uses elapsed retention days and stops capacity cleanup as soon as the target is reached', () => {
    const { store, add } = setup(); const boundary = '2026-01-30T12:00:00+08:00';
    const first = add('first', boundary, Buffer.alloc(4096, 1)), second = add('second', recent, Buffer.alloc(4096, 2));
    expect(store.previewAttachmentRetention(policy).selectedAttachments).toBe(0);
    expect(store.previewAttachmentRetention({ ...policy, now: '2026-03-01T12:00:01+08:00' }).selectedAttachments).toBe(1);
    const total = store.previewAttachmentRetention(policy).totalBytes;
    expect(store.cleanAttachments({ ...policy, maxBytes: total - 1 }).selectedAttachments).toBe(1);
    expect(store.readAttachmentBytes(first.attachmentId)).toBeNull();
    expect(store.readAttachmentBytes(second.attachmentId)).not.toBeNull();
  });
});
