import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepository } from './repository';
import { automaticBackup, automaticBackupStatus, flushAutomaticBackups, inspectBackupFile } from './backups';
import { resolveBackupDirectory } from './space-policy';

afterEach(() => vi.useRealTimers());
describe('daily complete desktop backups', () => {
  it('keeps a verified backup successful when only its daily cadence hint cannot be saved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-backup-hint-')), repository = createRepository(join(root, 'planner.sqlite'));
    try {
      repository.saveSettings({ campus: '合成校区' });
      const hint = vi.spyOn(repository, 'transact').mockImplementation(() => { throw Error('synthetic metadata write failed'); });
      await expect(flushAutomaticBackups(repository)).resolves.toBeUndefined();
      hint.mockRestore();
      const directory = resolveBackupDirectory(root), backups = readdirSync(directory).filter(name => name.startsWith('auto-'));
      expect(backups).toHaveLength(1);
      expect(inspectBackupFile(join(directory, backups[0]!)).planner.settings.campus).toBe('合成校区');
      expect(repository.read().lastBackupAt).toBeNull();
    } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('coalesces the first due writes without rereading the whole state on every button and drains on exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-daily-backup-')), repository = createRepository(join(root, 'planner.sqlite'));
    try {
      const read = vi.spyOn(repository, 'read');
      for (let index = 0; index < 5; index++) repository.saveSettings({ campus: `虚构校区${index}` });
      expect(read).toHaveBeenCalledOnce(); expect(automaticBackupStatus(repository)).toMatchObject({ pending: true, running: false, status: 'never' });
      await flushAutomaticBackups(repository);
      const directory = resolveBackupDirectory(root), backups = readdirSync(directory).filter(name => name.startsWith('auto-'));
      expect(backups).toHaveLength(1); expect(inspectBackupFile(join(directory, backups[0]!)).planner.settings.campus).toBe('虚构校区4');
      repository.saveSettings({ campus: '虚构同日后续修改' });
      expect(automaticBackupStatus(repository)).toMatchObject({ pending: false, status: 'ok' });
      await flushAutomaticBackups(repository); expect(readdirSync(directory).filter(name => name.startsWith('auto-'))).toHaveLength(1);
      read.mockRestore();
    } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('attempts another complete backup after the daily interval rather than copying the capture DB every minute', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    const root = mkdtempSync(join(tmpdir(), 'uc-daily-interval-')), repository = createRepository(join(root, 'planner.sqlite'));
    try {
      automaticBackup(repository); await flushAutomaticBackups(repository);
      vi.setSystemTime(new Date('2027-01-01T23:59:00Z')); automaticBackup(repository);
      expect(automaticBackupStatus(repository).pending).toBe(false);
      vi.setSystemTime(new Date('2027-01-02T00:00:01Z')); automaticBackup(repository);
      expect(automaticBackupStatus(repository).pending).toBe(true);
      await flushAutomaticBackups(repository);
      expect(readdirSync(resolveBackupDirectory(root)).filter(name => name.startsWith('auto-'))).toHaveLength(2);
    } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
