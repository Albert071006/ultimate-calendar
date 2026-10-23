import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository, type Repository } from '../storage/repository';
import { createBackup, inspectBackupBundle } from '../storage/backups';
import { createRestoreManager } from '../electron/restore';
import { createCaptureStore, type CaptureStore } from '../capture/store';
import { openDatabase } from '../storage/database';
import { LedgerEntryDraftSchema } from '../shared/ledger';
import { LedgerService } from './service';

const directories: string[] = [], repositories: Repository[] = [], ledgers: LedgerService[] = [], captures: CaptureStore[] = [];
const now = () => new Date('2026-10-23T12:00:00Z');
function directory() { const dir = mkdtempSync(join(tmpdir(), 'calendar-ledger-backup-')); directories.push(dir); return dir; }
function setup(path: string) {
  const repository = createRepository(path); repositories.push(repository);
  const ledger = new LedgerService(path, { now }); ledgers.push(ledger);
  return { repository, ledger };
}
function entry(ledger: LedgerService, id: string, cents = 2000) {
  ledger.mutate({ operationId: id, expectedRevision: ledger.snapshot().revision, changes: [{ type: 'putEntry', expectedVersion: null, confirmDuplicate: false, note: '', entry: LedgerEntryDraftSchema.parse({ id, date: '2026-10-23', month: '2026-10', title: id, category: '餐饮', kind: 'expense', amountCents: cents, personalCents: cents, cashflows: [{ accountId: 'alipay', deltaCents: -cents }] }) }] });
}
function task(repository: Repository, title: string) { repository.writeInternal({ operationId: title, changes: [{ entity: 'task', values: { title } }] }); }
afterEach(() => {
  for (const capture of captures.splice(0)) capture.close();
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const repository of repositories.splice(0)) repository.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('full app backup including local ledger', () => {
  it('restores planner and full ledger together and preserves a safety backup of newer ledger writes', async () => {
    const dir = directory(), { repository, ledger } = setup(join(dir, 'live.sqlite'));
    task(repository, '备份内任务'); entry(ledger, '备份内午饭');
    ledger.mutate({ operationId: 'balance', expectedRevision: 1, changes: [{ type: 'setBalance', snapshot: { id: 'baseline', accountId: 'alipay', balanceCents: 12345, date: '2026-10-23', asOf: now().toISOString(), coveredEntryIds: ['备份内午饭'], note: '核对余额', sourceId: null } }] });
    const chosen = join(dir, 'chosen.sqlite'); createBackup(repository, chosen);
    entry(ledger, '备份后晚饭', 3000); task(repository, '备份后任务');
    const manager = createRestoreManager(repository), preview = await manager.preview(chosen);
    expect(preview.message).toContain('1 笔账目');
    const result = await manager.confirm(preview.confirmationToken);
    expect(repository.snapshot().tasks.map(item => item.title)).toEqual(['备份内任务']);
    expect(ledger.snapshot().entries.map(item => item.title)).toEqual(['备份内午饭']);
    expect(ledger.snapshot().summary.personalCents).toBe(2000);
    expect(ledger.snapshot().summary.accounts[0]!.balanceCents).toBe(12345);
    expect(ledger.snapshot().audit.some(item => item.action === '核对余额')).toBe(true);
    const safety = inspectBackupBundle(result.safetyBackupPath);
    expect(safety.ledger.entries).toHaveLength(2); expect(safety.planner.entities.task).toHaveLength(2);
    expect(() => ledger.undo({ operationId: 'old-undo', expectedRevision: ledger.snapshot().revision })).toThrow(/没有可撤销/);
  });
  it('rejects a stale restore preview after a ledger-only change', async () => {
    const dir = directory(), { repository, ledger } = setup(join(dir, 'live.sqlite'));
    entry(ledger, '午饭'); const chosen = join(dir, 'chosen.sqlite'); createBackup(repository, chosen);
    const manager = createRestoreManager(repository), preview = await manager.preview(chosen);
    entry(ledger, '晚饭');
    await expect(manager.confirm(preview.confirmationToken)).rejects.toThrow(/已改变/);
    expect(ledger.snapshot().entries).toHaveLength(2);
  });
  it('restores a pre-ledger backup to an empty ledger with the previous ledger in its safety backup', async () => {
    const dir = directory(), path = join(dir, 'live.sqlite');
    const repository = createRepository(path); repositories.push(repository); task(repository, '旧版任务');
    const chosen = join(dir, 'legacy.sqlite'); createBackup(repository, chosen);
    const ledger = new LedgerService(path, { now }); ledgers.push(ledger); entry(ledger, '新版午饭');
    const manager = createRestoreManager(repository), preview = await manager.preview(chosen);
    expect(preview.message).toContain('0 笔账目');
    const result = await manager.confirm(preview.confirmationToken);
    expect(ledger.snapshot().entries).toEqual([]); expect(repository.snapshot().tasks).toHaveLength(1);
    expect(inspectBackupBundle(result.safetyBackupPath).ledger.entries.map(item => item.title)).toEqual(['新版午饭']);
  });
  it('rolls planner, capture and ledger back when the ledger replacement fails inside the shared transaction', async () => {
    const dir = directory(), source = setup(join(dir, 'source.sqlite')), live = setup(join(dir, 'live.sqlite'));
    const sourceCapture = createCaptureStore(source.repository.path), liveCapture = createCaptureStore(live.repository.path); captures.push(sourceCapture, liveCapture);
    const ingest = (store: CaptureStore, messageId: string) => store.ingest([{ accountId: 'synthetic-account', groupId: 'synthetic-group', messageId, text: messageId, sentAt: '2026-10-23T12:00:00+08:00', importedAt: '2026-10-23T12:00:00+08:00', attachments: [] }]);
    task(source.repository, '待恢复任务'); entry(source.ledger, '待恢复午饭'); ingest(sourceCapture, 'backup-message');
    task(live.repository, '现有任务'); entry(live.ledger, '现有晚饭'); ingest(liveCapture, 'live-message');
    const chosen = join(dir, 'chosen.sqlite'); createBackup(source.repository, chosen);
    const db = openDatabase(live.repository.path);
    db.exec("CREATE TRIGGER fail_ledger_restore BEFORE UPDATE ON ledger_state BEGIN SELECT RAISE(ABORT, 'synthetic ledger restore failure'); END"); db.close();
    const manager = createRestoreManager(live.repository, () => true, liveCapture), preview = await manager.preview(chosen);
    const before = liveCapture.fingerprint();
    await expect(manager.confirm(preview.confirmationToken)).rejects.toThrow('synthetic ledger restore failure');
    expect(live.repository.snapshot().tasks.map(item => item.title)).toEqual(['现有任务']);
    expect(live.ledger.snapshot().entries.map(item => item.title)).toEqual(['现有晚饭']);
    expect(liveCapture.fingerprint()).toBe(before);
  });
  it('rejects partial tables, missing singleton and invalid money records before any restore mutation', async () => {
    const dir = directory(), { repository, ledger } = setup(join(dir, 'live.sqlite'));
    entry(ledger, '安全午饭');
    for (const variant of ['partial', 'missing', 'invalid'] as const) {
      const chosen = join(dir, `${variant}.sqlite`); createBackup(repository, chosen);
      const db = openDatabase(chosen);
      if (variant === 'partial') db.exec('DROP TABLE ledger_operations');
      if (variant === 'missing') db.exec('DELETE FROM ledger_state');
      if (variant === 'invalid') {
        const payload = JSON.parse(String(db.prepare('SELECT payload FROM ledger_state').get()!['payload']));
        payload.entries[0].personalCents = 999999;
        db.prepare('UPDATE ledger_state SET payload=?').run(JSON.stringify(payload));
      }
      db.close();
      await expect(createRestoreManager(repository).preview(chosen)).rejects.toThrow();
    }
    expect(ledger.snapshot().summary.personalCents).toBe(2000);
  });
});
