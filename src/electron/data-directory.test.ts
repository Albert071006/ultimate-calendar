import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../storage/database';
import { createRepository, newEntity, type Repository } from '../storage/repository';
import { createLedgerService } from '../ledger/service';
import { prepareDataDirectory, resolveDataDirectory } from './data-directory';

const roots: string[] = [], repositories: Repository[] = [];
afterEach(() => {
  repositories.splice(0).forEach(repository => repository.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'calendar-data-directory-')); roots.push(root);
  const directory = join(root, 'documents', '终极日历', '数据');
  const legacyDirectory = join(root, 'legacy'), packagesDirectory = join(root, 'packages');
  return { root, directory, legacyDirectory, packagesDirectory, profile: null };
}
function repository(directory: string, populated = false) {
  const repo = createRepository(join(directory, 'planner.sqlite')); repositories.push(repo);
  if (populated) repo.transact(state => { newEntity(state, 'task', { title: '测试任务' }); });
  return repo;
}
function counts(path: string) {
  const db = openDatabase(path, true);
  try { return Number(db.prepare('SELECT count(*) AS n FROM records').get()!['n']); }
  finally { db.close(); }
}

describe('shared production data directory', () => {
  it('uses Documents across launchers and preserves an explicit isolated profile', () => {
    expect(resolveDataDirectory('documents', null)).toBe(join('documents', '终极日历', '数据'));
    expect(resolveDataDirectory('documents', 'isolated')).toBe('isolated');
  });

  it('starts a new profile only when no legacy database or orphaned files exist', async () => {
    const x = fixture();
    mkdirSync(x.legacyDirectory);
    writeFileSync(join(x.legacyDirectory, 'Local State'), '{}');
    expect(await prepareDataDirectory(x)).toBe('new');
    expect(existsSync(join(x.directory, 'planner.sqlite'))).toBe(false);
    writeFileSync(join(x.legacyDirectory, 'planner.sqlite-wal'), 'orphan');
    await expect(prepareDataDirectory(x)).rejects.toThrow('缺少主数据库');
  });

  it('never inspects or replaces legacy data once the canonical database exists', async () => {
    const x = fixture();
    const repo = repository(x.directory, true); repo.close();
    const before = readFileSync(repo.path);
    mkdirSync(x.legacyDirectory); writeFileSync(join(x.legacyDirectory, 'planner.sqlite'), 'broken old data');
    expect(await prepareDataDirectory(x)).toBe('existing');
    expect(readFileSync(repo.path).equals(before)).toBe(true);
  });

  it('backs up committed WAL data and preserves credentials/configuration without copying cache or backups', async () => {
    const x = fixture(), repo = repository(x.legacyDirectory, true);
    const writer = openDatabase(repo.path);
    writer.exec('CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES(\'from WAL\')');
    mkdirSync(join(x.legacyDirectory, 'credentials'));
    const ciphertext = Buffer.from([0, 1, 2, 255]);
    writeFileSync(join(x.legacyDirectory, 'credentials', 'deepseek.bin'), ciphertext);
    writeFileSync(join(x.legacyDirectory, 'Local State'), '{"os_crypt":{"encrypted_key":"synthetic"}}');
    writeFileSync(join(x.legacyDirectory, 'space-management.json'), '{"kept":true}');
    mkdirSync(join(x.legacyDirectory, 'cache')); writeFileSync(join(x.legacyDirectory, 'cache', 'cache.json'), 'cache');
    mkdirSync(join(x.legacyDirectory, 'backups')); writeFileSync(join(x.legacyDirectory, 'backups', 'old.sqlite'), 'backup');
    try {
      expect(existsSync(`${repo.path}-wal`)).toBe(true);
      expect(await prepareDataDirectory(x)).toBe('migrated');
      const destination = join(x.directory, 'planner.sqlite'), db = openDatabase(destination, true);
      try { expect(db.prepare('SELECT count(*) AS n FROM migration_probe').get()!['n']).toBe(1); }
      finally { db.close(); }
      expect(counts(destination)).toBe(1); expect(counts(repo.path)).toBe(1);
      expect(existsSync(`${destination}-wal`)).toBe(false);
      expect(readFileSync(join(x.directory, 'credentials', 'deepseek.bin'))).toEqual(ciphertext);
      expect(readFileSync(join(x.directory, 'Local State'), 'utf8')).toBe('{"os_crypt":{"encrypted_key":"synthetic"}}');
      expect(readFileSync(join(x.directory, 'space-management.json'), 'utf8')).toBe('{"kept":true}');
      expect(existsSync(join(x.directory, 'cache'))).toBe(false);
      expect(existsSync(join(x.directory, 'backups'))).toBe(false);
      expect(existsSync(join(x.legacyDirectory, 'backups', 'old.sqlite'))).toBe(true);
    } finally { writer.close(); }
  });

  it('finds a populated MSIX copy instead of the empty ordinary profile, including a default ledger_state row', async () => {
    const x = fixture();
    const empty = repository(x.legacyDirectory);
    const ledger = createLedgerService(empty.path); ledger.close();
    const msix = join(x.packagesDirectory, 'Example.Application_abcd', 'LocalCache', 'Roaming', '终极日历');
    repository(msix, true);
    expect(await prepareDataDirectory(x)).toBe('migrated');
    expect(counts(join(x.directory, 'planner.sqlite'))).toBe(1);
    expect(counts(empty.path)).toBe(0);
  });

  it('blocks multiple populated legacy copies without choosing the largest or newest', async () => {
    const x = fixture(); repository(x.legacyDirectory, true);
    repository(join(x.packagesDirectory, 'Example.Application_abcd', 'LocalCache', 'Roaming', '终极日历'), true);
    await expect(prepareDataDirectory(x)).rejects.toThrow('多个旧资料库');
    expect(existsSync(join(x.directory, 'planner.sqlite'))).toBe(false);
  });

  it('recognizes one physical database exposed through both legacy and package paths', async () => {
    const x = fixture(), repo = repository(x.legacyDirectory, true); repo.close();
    const msix = join(x.packagesDirectory, 'Example.Application_abcd', 'LocalCache', 'Roaming', '终极日历');
    mkdirSync(msix, { recursive: true });
    // A hard link models two distinct path strings reaching the same Windows file ID.
    linkSync(repo.path, join(msix, 'planner.sqlite'));
    expect(await prepareDataDirectory(x)).toBe('migrated');
    expect(counts(join(x.directory, 'planner.sqlite'))).toBe(1);
    expect(counts(repo.path)).toBe(1);
    expect(counts(join(msix, 'planner.sqlite'))).toBe(1);
  });

  it('fails closed for a corrupt legacy database and conflicting credential files', async () => {
    const x = fixture(); mkdirSync(x.legacyDirectory);
    writeFileSync(join(x.legacyDirectory, 'planner.sqlite'), 'broken');
    await expect(prepareDataDirectory(x)).rejects.toThrow();
    expect(existsSync(join(x.directory, 'planner.sqlite'))).toBe(false);
    rmSync(join(x.legacyDirectory, 'planner.sqlite'));
    repository(x.legacyDirectory, true);
    for (const directory of [x.directory, x.legacyDirectory]) mkdirSync(join(directory, 'credentials'), { recursive: true });
    writeFileSync(join(x.directory, 'credentials', 'deepseek.bin'), 'new credential');
    writeFileSync(join(x.legacyDirectory, 'credentials', 'deepseek.bin'), 'old credential');
    await expect(prepareDataDirectory(x)).rejects.toThrow('不同的凭据');
    expect(existsSync(join(x.directory, 'planner.sqlite'))).toBe(false);
    expect(readFileSync(join(x.directory, 'credentials', 'deepseek.bin'), 'utf8')).toBe('new credential');
  });

  it('does not discover or migrate production data for an explicit profile', async () => {
    const x = fixture(); repository(x.legacyDirectory, true);
    expect(await prepareDataDirectory({ ...x, profile: x.directory })).toBe('isolated');
    expect(existsSync(join(x.directory, 'planner.sqlite'))).toBe(false);
  });
});
