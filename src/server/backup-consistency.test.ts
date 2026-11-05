import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as storage from '../storage/repository';
import { createLedgerService } from '../ledger/service';
import { LedgerEntryDraftSchema } from '../shared/ledger';
import { createSafeBackupFromDatabase, validateSafeBackup } from './backup';
import { openDatabase } from '../storage/database';

vi.mock('../storage/repository', { spy: true });
describe('consistent safe backup snapshots', () => {
  it('keeps ledger and planner at the same read snapshot while another connection commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-consistent-backup-'));
    const repository = storage.createRepository(join(root, 'data', 'planner.sqlite'), { automaticBackup() {} }), ledger = createLedgerService(repository.path);
    const { readDatabaseState: read } = await vi.importActual<typeof storage>('../storage/repository');
    const spy = vi.spyOn(storage, 'readDatabaseState').mockImplementation(db => {
      const captured = read(db); spy.mockRestore();
      repository.transact(state => { storage.newEntity(state, 'task', { title: '虚构快照之后创建的任务' }); });
      ledger.mutate({ operationId: 'synthetic-after-snapshot', expectedRevision: 0, changes: [{ type: 'putEntry', expectedVersion: null, confirmDuplicate: false, note: '', entry: LedgerEntryDraftSchema.parse({ id: 'synthetic-entry', kind: 'expense', date: '2020-01-01', month: '2020-01', title: '虚构支出', category: '其他', amountCents: 100, personalCents: 100, cashflows: [{ accountId: 'alipay', deltaCents: -100 }] }) }] });
      return captured;
    });
    try {
      const path = createSafeBackupFromDatabase({ databasePath: repository.path, directory: join(root, 'exports') });
      const saved = validateSafeBackup(JSON.parse(readFileSync(path, 'utf8')));
      expect(saved.planner.entities.task).toHaveLength(0); expect(saved.ledger.entries).toHaveLength(0);
      expect(repository.snapshot().tasks).toHaveLength(1); expect(ledger.exportJson().entries).toHaveLength(1);
      const db = openDatabase(repository.path);
      try { expect(db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2); } finally { db.close(); }
    } finally { spy.mockRestore(); ledger.close(); repository.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
