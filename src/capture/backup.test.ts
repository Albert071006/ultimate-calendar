import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository, type Repository } from '../storage/repository';
import { createBackup, inspectBackupBundle } from '../storage/backups';
import { createRestoreManager } from '../electron/restore';
import { createCaptureStore, type CaptureStore } from './store';
import { openDatabase } from '../storage/database';

const directories: string[] = [], repositories: Repository[] = [], captures: CaptureStore[] = [];
const account = 'synthetic-account', group = 'synthetic-group', at = '2026-10-23T12:00:00+08:00', later = '2026-10-23T12:02:00+08:00';
function directory() { const dir = mkdtempSync(join(tmpdir(), 'calendar-capture-backup-')); directories.push(dir); return dir; }
function setup(path: string) {
  const repository = createRepository(path), capture = createCaptureStore(path); repositories.push(repository); captures.push(capture);
  capture.saveConfig({ ...capture.config(), enabled: true, accountId: account, groupIds: [group] });
  return { repository, capture };
}
function ingest(capture: CaptureStore, messageId: string, withFile = false) {
  const result = capture.ingest([{ accountId: account, groupId: group, messageId, sentAt: at, importedAt: at, text: '合成文件通知', attachments: withFile ? [{ kind: 'file', name: '合成.txt' }] : [] }]);
  const id = result.ids[0]!;
  if (withFile) capture.putAttachment(capture.attachments(id)[0]!.id, Buffer.from('synthetic attachment bytes'));
  return id;
}
function task(repository: Repository, title: string) { repository.writeInternal({ operationId: title, changes: [{ entity: 'task', values: { title } }] }); }
afterEach(() => {
  vi.restoreAllMocks();
  for (const capture of captures.splice(0)) capture.close();
  for (const repository of repositories.splice(0)) repository.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('planner and QQ backup restoration', () => {
  it('backs up actual attachment BLOBs and atomically restores data with interrupted requests paused', async () => {
    const dir = directory(), { repository, capture } = setup(join(dir, 'live.sqlite'));
    task(repository, '备份内任务'); const sourceId = ingest(capture, 'backup-message', true);
    capture.sealBatches({ now: later }); const batch = capture.claimBatch(later)!; capture.startAttempt(batch.id, 'synthetic-input', later);
    const chosen = join(dir, 'chosen.sqlite'); createBackup(repository, chosen);
    expect(inspectBackupBundle(chosen).capture?.batches[0]?.status).toBe('requesting');
    task(repository, '备份后任务'); ingest(capture, 'later-message');
    const manager = createRestoreManager(repository, () => true, capture), preview = await manager.preview(chosen);
    expect(preview.message).toContain('1 条 QQ 消息');
    const result = await manager.confirm(preview.confirmationToken);
    expect(repository.snapshot().tasks.map(item => item.title)).toEqual(['备份内任务']);
    expect(capture.listMessages().items.map(item => item.messageId)).toEqual(['backup-message']);
    expect(capture.config()).toMatchObject({ enabled: false, analysisEnabled: false });
    expect(capture.batch(batch.id)).toMatchObject({ status: 'uncertain', attempts: [{ status: 'uncertain' }] });
    expect(capture.readAttachmentBytes(capture.attachments(sourceId)[0]!.id)).toEqual(Buffer.from('synthetic attachment bytes'));
    const safety = inspectBackupBundle(result.safetyBackupPath);
    expect(safety.planner.entities.task).toHaveLength(2); expect(safety.capture?.messages).toHaveLength(2);
    expect(safety.capture?.blobs).toHaveLength(1);
  });

  it('rejects confirmation after new QQ data without exporting attachment bytes for the fingerprint', async () => {
    const dir = directory(), { repository, capture } = setup(join(dir, 'live.sqlite'));
    ingest(capture, 'first', true); const chosen = join(dir, 'chosen.sqlite'); createBackup(repository, chosen);
    vi.spyOn(capture, 'exportState').mockImplementation(() => { throw new Error('Must not export BLOBs for conflict checks'); });
    const manager = createRestoreManager(repository, () => true, capture), preview = await manager.preview(chosen);
    const revision = capture.fingerprint(); ingest(capture, 'second'); expect(capture.fingerprint()).not.toBe(revision);
    await expect(manager.confirm(preview.confirmationToken)).rejects.toThrow('QQ 采集数据已改变');
    expect(capture.listMessages().items).toHaveLength(2);
  });

  it('restores legacy calendar-only backups to empty paused capture state with a full safety backup', async () => {
    const dir = directory(), path = join(dir, 'live.sqlite'), repository = createRepository(path); repositories.push(repository);
    task(repository, '旧版任务'); const chosen = join(dir, 'legacy.sqlite'); createBackup(repository, chosen);
    const capture = createCaptureStore(path); captures.push(capture);
    capture.saveConfig({ ...capture.config(), enabled: true, accountId: account, groupIds: [group] }); ingest(capture, 'new-qq-message', true);
    const manager = createRestoreManager(repository, () => true, capture), preview = await manager.preview(chosen);
    expect(preview.message).toContain('旧备份');
    const result = await manager.confirm(preview.confirmationToken);
    expect(capture.listMessages().items).toEqual([]); expect(capture.stats().attachmentBytes).toBe(0);
    expect(capture.config()).toMatchObject({ enabled: false, analysisEnabled: false, accountId: null });
    expect(inspectBackupBundle(result.safetyBackupPath).capture?.messages).toHaveLength(1);
  });

  it('rolls capture changes back if a planner write fails in the same transaction', async () => {
    const dir = directory(), source = setup(join(dir, 'source.sqlite')), live = setup(join(dir, 'live.sqlite'));
    task(source.repository, '待恢复任务'); ingest(source.capture, 'from-backup', true);
    task(live.repository, '现有任务'); ingest(live.capture, 'live-message', true);
    const chosen = join(dir, 'chosen.sqlite'); createBackup(source.repository, chosen);
    const db = openDatabase(live.repository.path);
    db.exec("CREATE TRIGGER fail_restore_core BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT, 'synthetic restore failure'); END"); db.close();
    const manager = createRestoreManager(live.repository, () => true, live.capture), preview = await manager.preview(chosen);
    const before = live.capture.fingerprint();
    await expect(manager.confirm(preview.confirmationToken)).rejects.toThrow('synthetic restore failure');
    expect(live.repository.snapshot().tasks.map(item => item.title)).toEqual(['现有任务']);
    expect(live.capture.listMessages().items.map(item => item.messageId)).toEqual(['live-message']);
    expect(live.capture.fingerprint()).toBe(before); expect(live.capture.config().enabled).toBe(true);
  });

  it('rejects corrupt attachments and partial/future capture schemas in preview', async () => {
    const dir = directory(), { repository, capture } = setup(join(dir, 'live.sqlite'));
    ingest(capture, 'first', true);
    for (const variant of ['blob', 'partial', 'future'] as const) {
      const chosen = join(dir, `${variant}.sqlite`); createBackup(repository, chosen);
      const db = openDatabase(chosen);
      if (variant === 'blob') db.prepare('UPDATE capture_blobs SET bytes=?').run(Buffer.from('corrupt synthetic bytes'));
      if (variant === 'partial') db.exec('DROP TABLE capture_coverage');
      if (variant === 'future') db.exec("UPDATE capture_meta SET payload='99' WHERE id='schemaVersion'");
      db.close();
      await expect(createRestoreManager(repository, () => true, capture).preview(chosen)).rejects.toThrow();
    }
    expect(capture.listMessages().items).toHaveLength(1);
  });

  it('does not restore QQ-containing backups through a legacy planner-only manager', async () => {
    const dir = directory(), { repository, capture } = setup(join(dir, 'live.sqlite'));
    ingest(capture, 'first'); const chosen = join(dir, 'chosen.sqlite'); createBackup(repository, chosen);
    await expect(createRestoreManager(repository).preview(chosen)).rejects.toThrow('QQ 采集资料');
  });
  it('rejects a backup estimated above the restore ceiling before writing a file', () => {
    const dir = directory(), { repository } = setup(join(dir, 'live.sqlite'));
    vi.spyOn(repository, 'estimatedBackupBytes').mockReturnValue(513 * 1024 * 1024);
    const vacuum = vi.spyOn(repository, 'vacuumInto');
    expect(() => createBackup(repository, join(dir, 'too-large.sqlite'))).toThrow('512 MB'); expect(vacuum).not.toHaveBeenCalled();
  });
});
