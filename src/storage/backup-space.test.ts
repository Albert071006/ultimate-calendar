import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository, type Repository } from './repository';
import { createBackup, restoreBackup } from './backups';
import { createRestoreManager } from '../electron/restore';
import { nowInstant } from '../domain/time';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});
const dirs: string[] = [], repositories: Repository[] = [], managers: ReturnType<typeof createRestoreManager>[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(statfsSync).mockReset().mockImplementation(actual.statfsSync);
});
afterEach(() => {
  vi.restoreAllMocks();
  managers.splice(0).forEach(manager => manager.dispose());
  repositories.splice(0).forEach(repository => repository.close());
  dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-backup-space-')); dirs.push(dir);
  const repository = createRepository(join(dir, 'live.sqlite')); repositories.push(repository);
  repository.transact(state => { state.lastBackupAt = nowInstant(); });
  repository.writeInternal({ operationId: 'synthetic-backup', changes: [{ entity: 'task', values: { title: '备份里的任务' } }] });
  const backup = join(dir, 'chosen.sqlite'); createBackup(repository, backup);
  repository.writeInternal({ operationId: 'synthetic-current', changes: [{ entity: 'task', values: { title: '当前任务' } }] });
  const manager = createRestoreManager(repository); managers.push(manager);
  return { dir, repository, backup, manager };
}
function available(dir: string, bytes: number) {
  const base = statfsSync(dir);
  vi.mocked(statfsSync).mockReturnValueOnce({ ...base, bavail: Math.floor(bytes / Number(base.bsize)) } as ReturnType<typeof statfsSync>);
}

describe('backup and restore disk reservations', () => {
  it('rejects a backup before writing when the destination cannot fit it', () => {
    const { dir, repository } = fixture(); const destination = join(dir, 'no-space.sqlite');
    const before = repository.read(); available(dir, 0);
    expect(() => createBackup(repository, destination)).toThrow('保存完整备份');
    expect(existsSync(destination)).toBe(false); expect(repository.read()).toEqual(before);
  });
  it('rejects restore staging before copying and leaves source and current data untouched', async () => {
    const { dir, repository, backup, manager } = fixture(); const before = repository.read();
    available(dir, 0);
    await expect(manager.preview(backup)).rejects.toThrow('暂存副本');
    expect(readdirSync(join(dir, 'restore-staging'))).toEqual([]);
    expect(existsSync(backup)).toBe(true); expect(repository.read()).toEqual(before);
  });
  it('requires room for restore writes in addition to the safety backup, before creating that backup', async () => {
    const { dir, repository, backup, manager } = fixture(); const before = repository.read();
    const preview = await manager.preview(backup);
    // This could fit the small safety backup and its 16 MiB margin, but not the restore reservation.
    available(dir, 32 * 1024 * 1024);
    await expect(manager.confirm(preview.confirmationToken)).rejects.toThrow('安全备份与恢复写入');
    expect(existsSync(join(dir, 'backups'))).toBe(false); expect(repository.read()).toEqual(before);
    // A failed capacity check does not consume the preview; after space is available, confirmation works.
    expect((await manager.confirm(preview.confirmationToken)).status).toBe('restored');
    expect(repository.snapshot().tasks.map(item => item.title)).toEqual(['备份里的任务']);
  });
  it('applies the same combined reservation to direct restoration', () => {
    const { dir, repository, backup } = fixture(); const before = repository.read();
    available(dir, 32 * 1024 * 1024);
    expect(() => restoreBackup(repository, backup)).toThrow('安全备份与恢复写入');
    expect(existsSync(join(dir, 'backups'))).toBe(false); expect(repository.read()).toEqual(before);
  });
});
