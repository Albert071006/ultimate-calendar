import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRepository } from './repository';
import { createBackup, openBackupFile, restoreBackup } from './backups';
import { newLocalResources, readLocalResources, writeLocalResources, mergeLocalResources, writeLocalResourcesCompanion, readLocalResourcesCompanion } from './local-resources';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { const rel = relative(tmpdir(), root); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); } });
function fixture() { const directory = mkdtempSync(join(tmpdir(), 'calendar-resource-backup-')); roots.push(directory); return directory; }
it('includes only reference locations in the standalone backup and restores missing same-device references', () => {
  const directory = fixture(), path = join(directory, 'answers.txt'); writeFileSync(path, 'synthetic original');
  const resource = { id: randomUUID(), kind: 'file' as const, path, updatedAt: new Date().toISOString() };
  const registry = { ...newLocalResources(), locations: [resource] }; writeLocalResources(directory, registry);
  const repo = createRepository(join(directory, 'planner.sqlite'), { automaticBackup() {} });
  try {
    const backupPath = join(directory, 'saved.sqlite'); createBackup(repo, backupPath);
    expect(existsSync(`${backupPath}-wal`)).toBe(false);
    const backup = openBackupFile(backupPath); try { expect(backup.localResources).toEqual(registry); } finally { backup.close(); }
    writeLocalResources(directory, { ...registry, locations: [] }); restoreBackup(repo, backupPath);
    expect(readLocalResources(directory)?.locations).toEqual([resource]); expect(existsSync(path)).toBe(true);
  } finally { repo.close(); }
});
it('preserves newer relocations and never adopts the identity or locations of another computer', () => {
  const directory = fixture(), registry = newLocalResources(), id = randomUUID();
  const current = { ...registry, locations: [{ id, kind: 'file' as const, path: 'C:\\new.txt', updatedAt: new Date().toISOString() }] };
  writeLocalResources(directory, current);
  mergeLocalResources(directory, { ...registry, locations: [{ ...current.locations[0]!, path: 'C:\\old.txt' }] });
  expect(readLocalResources(directory)).toEqual(current);
  mergeLocalResources(directory, { ...current, deviceId: randomUUID() }); expect(readLocalResources(directory)).toEqual(current);
  const newComputer = fixture(); mergeLocalResources(newComputer, current); expect(readLocalResources(newComputer)).toBeNull();
});
it('keeps a remote backup companion separate from the JSON payload sent to the shared service', () => {
  const directory = fixture(), registry = newLocalResources(); writeLocalResources(directory, registry);
  const sharedBackup = join(directory, 'shared.json'); writeFileSync(sharedBackup, '{"synthetic":"shared data"}');
  writeLocalResourcesCompanion(directory, sharedBackup);
  expect(readLocalResourcesCompanion(sharedBackup)).toEqual(registry);
  expect(readLocalResourcesCompanion(join(directory, 'older.json'))).toBeNull();
});
