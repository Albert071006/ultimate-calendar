import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backup, type DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../storage/database';
import { emptyState, readDatabaseState } from '../storage/repository';
import { inspectBackupFile } from '../storage/backups';
import { readLedgerDatabase } from '../ledger/service';

const databaseName = 'planner.sqlite';
const companionFiles = ['credentials/deepseek.bin', 'credentials/qq-bridge.bin', 'Local State', 'reminder-cursor.json', 'space-management.json', 'tray-notice-seen'];

/** AppData can be virtualized by the launching MSIX application; Documents is shared across hosts. */
export function resolveDataDirectory(documentsDirectory: string, profile: string | null): string {
  return profile ?? join(documentsDirectory, '终极日历', '数据');
}

function existingFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw Error('资料路径不是普通文件，已停止迁移。');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function legacyDirectories(legacyDirectory: string, packagesDirectory?: string): string[] {
  const directories = [legacyDirectory];
  if (packagesDirectory && existsSync(packagesDirectory)) {
    // Inspect only this application's exact legacy subdirectory, never other applications' files.
    for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(packagesDirectory, entry.name, 'LocalCache', 'Roaming', '终极日历');
      if (existsSync(directory)) directories.push(directory);
    }
  }
  const seen = new Set<string>();
  return directories.filter(directory => {
    if (!existsSync(directory)) return false;
    const physical = realpathSync.native(directory).toLocaleLowerCase();
    if (seen.has(physical)) return false;
    seen.add(physical); return true;
  });
}

function hasUserData(db: DatabaseSync, directory: string): boolean {
  const state = readDatabaseState(db);
  if (Object.values(state.entities).some(records => records.length) || state.journal.length || state.operations.length || state.usage.length || state.receipts.length) return true;
  if (JSON.stringify(state.settings) !== JSON.stringify(emptyState().settings)) return true;
  const ledger = readLedgerDatabase(db);
  if (ledger.revision || ledger.entries.length || ledger.balanceSnapshots.length || ledger.audit.length || ledger.sources.length) return true;
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row['name'])));
  for (const table of ['capture_messages', 'capture_attachments', 'capture_blobs', 'ledger_operations']) {
    if (tables.has(table) && Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!['count']) > 0) return true;
  }
  return companionFiles.filter(file => file.startsWith('credentials/')).some(file => existingFile(join(directory, file)));
}

function copyCompanionFiles(source: string, destination: string): void {
  for (const file of companionFiles) {
    const from = join(source, file), to = join(destination, file);
    if (!existingFile(from)) continue;
    if (existingFile(to)) {
      if (!readFileSync(from).equals(readFileSync(to))) throw Error('新旧资料目录存在不同的凭据或配置，已停止迁移；原文件均保留。');
      continue;
    }
    if (file.startsWith('credentials/')) mkdirSync(join(destination, 'credentials'), { recursive: true });
    copyFileSync(from, to, constants.COPYFILE_EXCL);
  }
}

export interface DataDirectoryOptions {
  directory: string;
  legacyDirectory: string;
  profile: string | null;
  packagesDirectory?: string;
}

/** Run after taking the single-instance lock, before opening any writable database connection. */
export async function prepareDataDirectory(options: DataDirectoryOptions): Promise<'existing' | 'new' | 'migrated' | 'isolated'> {
  const { directory, legacyDirectory, profile } = options;
  if (profile) { mkdirSync(directory, { recursive: true }); return 'isolated'; }
  const destination = join(directory, databaseName);
  if (existingFile(destination)) return 'existing';
  if (existsSync(`${destination}-wal`) || existsSync(`${destination}-shm`)) throw Error('新资料目录存在未恢复的 SQLite 日志，已停止启动，避免创建空库。');
  const packagesDirectory = options.packagesDirectory ?? (process.platform === 'win32' ? join(homedir(), 'AppData', 'Local', 'Packages') : undefined);
  const candidates: { directory: string; hasData: boolean }[] = [];
  const seenDatabaseFiles = new Set<string>();
  for (const oldDirectory of legacyDirectories(legacyDirectory, packagesDirectory)) {
    if (resolve(oldDirectory) === resolve(directory)) continue;
    const source = join(oldDirectory, databaseName);
    if (!existingFile(source)) {
      if (existsSync(`${source}-wal`) || existsSync(`${source}-shm`) || companionFiles.filter(file => file !== 'Local State' && file !== 'tray-notice-seen').some(file => existingFile(join(oldDirectory, file)))) {
        throw Error('旧资料目录缺少主数据库但仍有凭据、配置或日志，已停止迁移；请先恢复原有资料。');
      }
      continue;
    }
    // MSIX redirection can preserve the logical path even in realpath.native().
    // File IDs identify the same database reached through that alias and its package path.
    // Use bigint because Windows file IDs may exceed Number's integer precision.
    const file = statSync(source, { bigint: true });
    if (file.ino !== 0n) {
      const identity = `${file.dev}:${file.ino}`;
      if (seenDatabaseFiles.has(identity)) continue;
      seenDatabaseFiles.add(identity);
    }
    const db = openDatabase(source, true);
    try { candidates.push({ directory: oldDirectory, hasData: hasUserData(db, oldDirectory) }); }
    finally { db.close(); }
  }
  const populated = candidates.filter(candidate => candidate.hasData);
  if (populated.length > 1 || (!populated.length && candidates.length > 1)) {
    throw Error('发现多个旧资料库，无法安全判断应迁移哪一份。已停止启动，原资料均保留；请先选择并恢复正确的备份。');
  }
  const chosen = populated[0] ?? candidates[0];
  mkdirSync(directory, { recursive: true });
  if (!chosen) return 'new';
  // Publish encryption metadata synchronously, before Electron can initialize Chromium/OSCrypt.
  // On failure no destination database exists; matching files permit a safe retry.
  copyCompanionFiles(chosen.directory, directory);
  const temporary = join(directory, `.data-migration-${randomUUID()}.sqlite`);
  const source = openDatabase(join(chosen.directory, databaseName), true);
  try {
    // SQLite's online backup includes committed WAL pages; never copy a running database file.
    await backup(source, temporary);
    const standalone = openDatabase(temporary);
    try { standalone.exec('PRAGMA journal_mode=DELETE'); }
    finally { standalone.close(); }
    inspectBackupFile(temporary);
    // A same-volume hard link publishes the complete, closed backup atomically without overwriting.
    linkSync(temporary, destination);
    return 'migrated';
  } finally {
    source.close();
    try { rmSync(temporary, { force: true }); } catch { /* Keep an inaccessible staging file; never delete either database. */ }
  }
}
