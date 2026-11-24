import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCaptureStore } from './store';
import { createRepository } from '../storage/repository';
import { openDatabase } from '../storage/database';
import { createBackup, openBackupFile, restoreOpenedBackup } from '../storage/backups';
import { createLocalEvidenceResolver } from '../electron/local-evidence';
import { CLEARED_CAPTURE_TEXT } from '../shared/capture-evidence';
import { privateOperationFingerprint } from '../storage/operation-fingerprint';

const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0).reverse()) cleanup(); });
const at = '2026-01-01T10:00:00+08:00', accountId = 'synthetic-account';
const removed = 'synthetic original to erase', kept = 'independent synthetic quotation';
function fixture() {
  const workspace = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const directory = mkdtempSync(join(workspace, '.capture-evidence-test-'));
  close.push(() => {
    const path = realpathSync(directory);
    if (dirname(path) !== workspace || !basename(path).startsWith('.capture-evidence-test-')) throw Error('Invalid capture test directory');
    rmSync(path, { recursive: true, force: true });
  });
  const path = join(directory, 'planner.sqlite');
  const repo = createRepository(path, { automaticBackup() {} }); close.push(() => repo.close());
  const store = createCaptureStore(path); close.push(() => store.close());
  const db = openDatabase(path); close.push(() => db.close());
  store.saveConfig({ ...store.config(), accountId, enabled: true, groupIds: ['first', 'second'] });
  function source(groupId: string, text: string) {
    const messageId = store.ingest([{ accountId, groupId, messageId: 'm', sentAt: at, text }]).ids[0]!;
    const request = { operationId: 'write-' + groupId, journal: true, changes: [{ entity: 'source' as const, values: {
      kind: 'text', text, importedAt: at,
      captureRef: { messageId, accountId, groupId, locator: '正文', attachmentId: null, transcribed: false },
    } }] };
    return { id: repo.writeInternal(request).entities[0]!.id, request, messageId };
  }
  const target = source('first', removed), survivor = source('second', kept);
  const candidate = repo.writeInternal({ operationId: 'capture-candidate', journal: true, changes: [{ entity: 'candidate', values: {
    title: 'synthetic task', sourceIds: [target.id, survivor.id], sourceQuote: removed,
    deadline: { date: '2026-02-01', time: null },
    temporalEvidence: [{ field: 'deadline', basis: 'explicit', quote: kept }, { field: 'deadline', basis: 'explicit', quote: removed }],
  } }] }).entities[0]!;
  repo.writeInternal({ operationId: 'user-edit', journal: true, changes: [{ entity: 'candidate', id: candidate.id,
    expectedVersion: candidate.version, values: { title: 'User-edited title', action: 'Keep this action' } }] });
  const resolve = createLocalEvidenceResolver(repo);
  return { directory, path, db, repo, store, target, survivor, candidate, resolve };
}

describe('capture evidence erasure', () => {
  it('rolls back a failed cleanup, then removes only the selected original across receipts, undo and sync history', () => {
    const f = fixture(), cursor = f.repo.cursor(), scope = { accountId, groupId: 'first' };
    const legacyInput = JSON.stringify(f.target.request);
    expect(f.repo.read().operations.find(row => row.id === f.target.request.operationId)?.fingerprint).toBe(privateOperationFingerprint(legacyInput));
    f.repo.transact(state => {
      state.operations.find(row => row.id === f.target.request.operationId)!.fingerprint = legacyInput;
      state.operations.push({ id: 'old-applied-only', fingerprint: legacyInput,
        result: { status: 'applied', message: '已保存', changes: [], conflicts: [], transactionId: 'synthetic-transaction' } });
    });
    f.db.exec("CREATE TRIGGER fail_test_erase BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    expect(() => f.store.cleanup(scope)).toThrow('synthetic failure');
    expect(f.store.message(f.target.messageId)?.deleted).toBe(false);
    expect(f.resolve({ sourceId: f.target.id }).sources[0]?.text).toBe(removed);
    f.db.exec('DROP TRIGGER fail_test_erase');
    expect(f.store.cleanup(scope).messages).toBe(1);
    expect(f.resolve({ sourceId: f.target.id }).sources[0]).toMatchObject({ text: CLEARED_CAPTURE_TEXT, captureRef: { cleared: true } });
    expect(f.resolve({ sourceId: f.survivor.id }).sources[0]?.text).toBe(kept);
    expect(f.repo.snapshot().candidates[0]).toMatchObject({ id: f.candidate.id, title: 'User-edited title', action: 'Keep this action',
      deadline: { date: '2026-02-01' }, sourceQuote: '', sourceIds: [f.target.id, f.survivor.id], temporalEvidence: [{ quote: kept }] });
    expect(JSON.stringify(f.repo.read())).not.toContain(removed);
    expect(f.repo.read().operations.find(row => row.id === 'old-applied-only')?.fingerprint).toBe(privateOperationFingerprint(legacyInput));
    expect(f.repo.changes(cursor)).toEqual({ status: 'reset' });
    expect(f.db.prepare('SELECT 1 FROM planner_sync_log').get()).toBeUndefined();
    expect(f.repo.writeInternal(f.target.request).entities[0]).toMatchObject({ id: f.target.id, text: CLEARED_CAPTURE_TEXT });
    const after = f.repo.cursor();
    expect(f.store.cleanup(scope).messages).toBe(0);
    expect(f.repo.cursor()).toEqual(after);
    expect(f.store.ingest([{ accountId, groupId: 'first', messageId: 'm', sentAt: at, text: removed }]).duplicates).toBe(1);
    expect(f.store.message(f.target.messageId)?.text).toBe('');
  });

  it('repairs earlier message tombstones on startup and when a historical full backup is restored', () => {
    const f = fixture();
    f.db.prepare("UPDATE capture_messages SET deleted=1,payload=json_set(payload,'$.deleted',json('true'),'$.text','') WHERE id=?").run(f.target.messageId);
    f.db.exec("DELETE FROM capture_meta WHERE id='plannerEvidenceCleanupV1'");
    const backup = join(f.directory, 'synthetic-old.sqlite');
    createBackup(f.repo, backup);
    const restarted = createCaptureStore(f.path); close.push(() => restarted.close());
    expect(JSON.stringify(f.repo.read())).not.toContain(removed);
    const opened = openBackupFile(backup);
    try { restoreOpenedBackup(f.repo, opened, f.store); } finally { opened.close(); }
    expect(f.resolve({ sourceId: f.target.id }).sources[0]?.captureRef?.cleared).toBe(true);
    expect(JSON.stringify(f.repo.read())).not.toContain(removed);
    expect(f.repo.snapshot().candidates[0]?.title).toBe('User-edited title');
  });

  it('erases retired attachment evidence without erasing the message body or another source with intact evidence', () => {
    const f = fixture(), groupId = 'document-group', body = 'keep this cover message', attachmentText = 'synthetic extracted contents';
    f.store.saveConfig({ ...f.store.config(), groupIds: [groupId] });
    const messageId = f.store.ingest([{ accountId, groupId, messageId: 'with-file', text: body, sentAt: at, importedAt: at,
      attachments: [{ kind: 'file', name: 'synthetic.txt' }] }]).ids[0]!;
    const attachment = f.store.attachments(messageId)[0]!;
    f.store.putAttachment(attachment.id, Buffer.from(attachmentText));
    f.store.saveExtraction(attachment.id, { extractorVersion: 'fixture', chunks: [{ ordinal: 0, location: '1', text: attachmentText, imageDataUrl: null, error: null, status: 'ready' }] });
    f.store.sealBatches({ force: true, now: at });
    const batch = f.store.claimBatch(at)!;
    f.store.saveResult(batch.id, { final: true }, at); f.store.markApplied(batch.id, at);
    const sources = f.repo.writeInternal({ operationId: 'document-evidence', journal: true, changes: [null, attachment.id].map(attachmentId => ({
      entity: 'source' as const, values: { kind: 'text', importedAt: at, text: attachmentId ? attachmentText : body,
        captureRef: { messageId, accountId, groupId, attachmentId, locator: '合成资料', transcribed: false } },
    })) }).entities;
    f.store.cleanAttachments({ retentionDays: 1, maxBytes: 1024 ** 3, now: '2026-03-01T12:00:00+08:00' });
    expect(f.store.message(messageId)).toMatchObject({ deleted: false, text: body });
    expect(f.resolve({ sourceId: sources[0]!.id }).sources[0]?.text).toBe(body);
    expect(f.resolve({ sourceId: sources[1]!.id }).sources[0]).toMatchObject({ text: CLEARED_CAPTURE_TEXT, captureRef: { attachmentId: attachment.id, cleared: true } });
    expect(JSON.stringify(f.repo.read())).not.toContain(attachmentText);
  });
});
