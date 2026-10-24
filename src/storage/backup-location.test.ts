import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { createRepository, type Repository } from './repository';
import { automaticBackup, createBackup, restoreBackup } from './backups';
import { initializeBackupDirectory, readSpaceState, resolveBackupDirectory, saveSpacePolicy, writeSpaceState } from './space-policy';
import { planBackupRetention, pruneManagedBackups } from './backup-retention';
import { createRestoreManager } from '../electron/restore';

const directories: string[] = [], repositories: Repository[] = [];
afterEach(() => {
  repositories.splice(0).forEach(repository => repository.close());
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'calendar-backup-location-')); directories.push(root);
  const data = join(root, 'profile'), documents = join(root, 'documents'); mkdirSync(data); mkdirSync(documents);
  return { root, data, documents };
}
function repository(data: string) {
  const repo = createRepository(join(data, 'planner.sqlite')); repositories.push(repo); return repo;
}

describe('central backup directory', () => {
  it('defaults production to the dedicated Documents folder and preserves policy on initialization', () => {
    const x = fixture();
    const original = readSpaceState(x.data);
    writeSpaceState(x.data, { ...original, policy: { ...original.policy, autoBackupKeep: 4 }, lastResult: '已有清理结果' });
    const folder = initializeBackupDirectory(x.data, x.documents);
    expect(folder).toBe(join(x.documents, '终极日历', '备份')); expect(existsSync(folder)).toBe(true);
    expect(resolveBackupDirectory(x.data)).toBe(folder);
    expect(readSpaceState(x.data)).toMatchObject({ policy: { autoBackupKeep: 4 }, lastResult: '已有清理结果' });
    saveSpacePolicy(x.data, { ...original.policy, autoBackupKeep: 6 });
    expect(resolveBackupDirectory(x.data)).toBe(folder);
  });
  it('keeps isolated profiles in their own directory even after a production configuration is copied in', () => {
    const x = fixture(), shared = initializeBackupDirectory(x.data, x.documents);
    const isolated = join(x.root, 'isolated'); mkdirSync(isolated);
    writeSpaceState(isolated, readSpaceState(x.data));
    const folder = initializeBackupDirectory(isolated, x.documents, true);
    expect(folder).toBe(join(isolated, 'backups')); expect(resolveBackupDirectory(isolated)).toBe(folder);
    expect(resolveBackupDirectory(x.data)).toBe(shared);
    expect(readdirSync(shared)).toEqual([]);
  });
  it('uses the central folder for automatic backup, rotation and direct restore safety backups', () => {
    const x = fixture(), folder = initializeBackupDirectory(x.data, x.documents), repo = repository(x.data);
    automaticBackup(repo);
    expect(readdirSync(folder).filter(name => name.startsWith('auto-'))).toHaveLength(1);
    expect(existsSync(join(x.data, 'backups'))).toBe(false);
    const before = join(folder, 'manual.sqlite'); createBackup(repo, before);
    const restored = restoreBackup(repo, before);
    expect(restored.safetyBackupPath.startsWith(folder)).toBe(true);
    expect(planBackupRetention(x.data, readSpaceState(x.data).policy).count).toBe(2);
    expect(pruneManagedBackups(x.data).deletedCount).toBe(0);
  });
  it('writes confirmation restore safety backups centrally and does not touch the legacy directory', async () => {
    const x = fixture(), folder = initializeBackupDirectory(x.data, x.documents), repo = repository(x.data);
    const old = join(x.data, 'backups'); mkdirSync(old); writeFileSync(join(old, 'legacy.sqlite'), 'do not migrate or delete');
    const backup = join(folder, 'chosen.sqlite'); createBackup(repo, backup);
    const manager = createRestoreManager(repo);
    try {
      const preview = await manager.preview(backup), result = await manager.confirm(preview.confirmationToken);
      expect(result.safetyBackupPath.startsWith(folder)).toBe(true);
      expect(readdirSync(old)).toEqual(['legacy.sqlite']);
    } finally { manager.dispose(); }
  });
  it('rejects root, relative and live-data-parent destinations before creating or deleting backup files', () => {
    const x = fixture();
    for (const backupDirectory of [parse(x.root).root, 'relative-folder']) {
      expect(() => writeSpaceState(x.data, { ...readSpaceState(x.data), backupDirectory })).toThrow();
    }
    writeSpaceState(x.data, { ...readSpaceState(x.data), backupDirectory: x.root });
    expect(() => resolveBackupDirectory(x.data)).toThrow('上级目录');
  });
});
