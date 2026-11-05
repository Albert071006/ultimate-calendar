import { existsSync, mkdirSync, statSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './database';
import { readDatabaseState, type Repository } from './repository';
import { nowInstant } from '../domain/time';
import { inspectCaptureBackup } from '../capture/backup';
import type { CaptureStore } from '../capture/store';
import { WorkflowError } from '../ai/deepseek';
import { readLedgerDatabase, replaceLedgerDatabase } from '../ledger/service';
import { copyCaptureBackupFile, inspectCaptureBackupFile } from '../capture/backup-file';
import { emptyCaptureState, replaceCaptureDatabaseState } from '../capture/store';
import { resolveBackupDirectory } from './space-policy';
import { includeLocalResourcesInBackup, readLocalResourcesFromBackup, mergeLocalResources } from './local-resources';
import { createBackupScheduler } from './backup-scheduler';
import { createBackupWorker } from './backup-worker-client';

const MiB = 1024 * 1024;
function requireDiskSpace(directory: string, bytes: number, purpose: string): void {
  const space = statfsSync(directory);
  if (space.bavail * space.bsize < bytes) throw new WorkflowError('STORAGE', `磁盘可用空间不足，${purpose}需要至少约 ${Math.ceil(bytes / MiB)} MB 可用空间；原有数据和备份均保留。`);
}
export function requireRestoreStagingSpace(directory: string, bytes: number): void {
  requireDiskSpace(directory, bytes + 16 * MiB, '恢复预览的暂存副本');
}
export function createBackup(repository: Pick<Repository, 'path' | 'estimatedBackupBytes' | 'vacuumInto'>, path: string): { path: string; includesSources: true } {
  if (path === repository.path || existsSync(path)) throw Error('备份目标已存在');
  mkdirSync(dirname(path), { recursive: true });
  requireDiskSpace(dirname(path), repository.estimatedBackupBytes() + 16 * MiB, '保存完整备份');
  repository.vacuumInto(path);
  const db = openDatabase(path);
  try { includeLocalResourcesInBackup(db, dirname(repository.path)); db.exec('PRAGMA journal_mode=DELETE'); }
  finally { db.close(); }
  return { path, includesSources: true };
}
/** SQLite VACUUM INTO reads a consistent snapshot; never copy a live DB/WAL file. */
export function createBackupFromDatabase(databasePath: string, target: string) {
  const db = openDatabase(databasePath, true);
  try {
    return createBackup({ path: databasePath, vacuumInto: path => { db.prepare('VACUUM INTO ?').run(path); }, estimatedBackupBytes: () => {
      const pages = Number(db.prepare('PRAGMA page_count').get()!['page_count']), free = Number(db.prepare('PRAGMA freelist_count').get()!['freelist_count']);
      return Math.max(0, pages - free) * Number(db.prepare('PRAGMA page_size').get()!['page_size']);
    } }, target);
  } finally { db.close(); }
}
/** Small-data inspection compatibility helper. Desktop restore/update use inspectBackupFile instead. */
export function inspectBackupBundle(path: string) {
  if (!existsSync(path)) throw Error('备份文件不存在');
  const db = openDatabase(path, true);
  try { if (db.prepare('PRAGMA integrity_check').get()!['integrity_check'] !== 'ok') throw Error('备份完整性校验失败');
    if (db.prepare('PRAGMA user_version').get()!['user_version'] !== 1) throw Error('备份版本不支持');
    return { planner: readDatabaseState(db), capture: inspectCaptureBackup(db), ledger: readLedgerDatabase(db) };
  } finally { db.close(); }
}
export function inspectBackup(path: string) { return inspectBackupFile(path).planner; }

/** Keep a read transaction open so preview and confirmation refer to the same validated snapshot. */
export function openBackupFile(path: string) {
  if (!statSync(path).isFile()) throw Error('请选择日历 SQLite 备份文件');
  const db = openDatabase(path, true);
  try {
    db.exec('BEGIN');
    if (db.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok') throw Error('备份完整性校验失败');
    if (db.prepare('PRAGMA user_version').get()?.['user_version'] !== 1) throw Error('备份版本不支持');
    const planner = readDatabaseState(db), capture = inspectCaptureBackupFile(db), ledger = readLedgerDatabase(db), localResources = readLocalResourcesFromBackup(db);
    const allocated = Number(db.prepare('PRAGMA page_count').get()!['page_count']);
    const free = Number(db.prepare('PRAGMA freelist_count').get()!['freelist_count']);
    const pageSize = Number(db.prepare('PRAGMA page_size').get()!['page_size']);
    const estimatedBytes = Math.max(0, allocated - free) * pageSize;
    let closed = false;
    return { db, planner, capture, ledger, localResources, estimatedBytes, close() { if (!closed) { closed = true; db.close(); } } };
  } catch (error) { db.close(); throw error; }
}
export type OpenBackupFile = ReturnType<typeof openBackupFile>;
export function inspectBackupFile(path: string) {
  const file = openBackupFile(path);
  try { return { planner: file.planner, capture: file.capture, ledger: file.ledger }; }
  finally { file.close(); }
}
export function requireRestoreSpace(repository: Repository, file: OpenBackupFile, includeSafetyBackup = true): void {
  const current = repository.estimatedBackupBytes();
  // Reserve for changed old pages, incoming pages, WAL frames/checkpoint growth and a safety margin.
  // The staging copy already exists and is reflected in available disk space at this point.
  const writes = 2 * (current + file.estimatedBytes) + 64 * MiB;
  const dataDirectory = dirname(repository.path);
  let sameDiskSafetyBytes = 0;
  if (includeSafetyBackup) {
    let backupParent = resolveBackupDirectory(dataDirectory);
    while (!existsSync(backupParent)) backupParent = dirname(backupParent);
    if (statSync(backupParent).dev === statSync(dataDirectory).dev) sameDiskSafetyBytes = current;
    else requireDiskSpace(backupParent, current + 16 * MiB, '恢复前安全备份');
  }
  requireDiskSpace(dataDirectory, writes + sameDiskSafetyBytes, includeSafetyBackup ? '恢复前安全备份与恢复写入' : '恢复写入及临时日志');
}
export function restoreOpenedBackup(repository: Repository, file: OpenBackupFile, captureStore?: CaptureStore): void {
  if (captureStore && (captureStore.path !== repository.path || captureStore.path === ':memory:')) throw Error('QQ 采集与日历必须使用同一个 SQLite 数据文件才能同时恢复');
  if (file.capture && !captureStore) throw Error('该备份含有 QQ 采集资料，需要同时初始化采集存储后恢复');
  requireRestoreSpace(repository, file, false);
  // Add missing private references before the transaction; no existing location is overwritten.
  // Even if the planner restore fails, this only preserves additional recoverable references.
  mergeLocalResources(dirname(repository.path), file.localResources);
  repository.replaceState(file.planner, destination => {
    if (captureStore) {
      if (file.capture) copyCaptureBackupFile(file.db, destination, file.capture);
      else replaceCaptureDatabaseState(destination, emptyCaptureState(), { recover: true });
    }
    replaceLedgerDatabase(destination, file.ledger);
  });
}
export function restoreBackup(repository: Repository, path: string, captureStore?: CaptureStore): { safetyBackupPath: string } {
  const file = openBackupFile(path);
  try {
    requireRestoreSpace(repository, file);
    const safetyBackupPath = join(resolveBackupDirectory(dirname(repository.path)), `before-restore-${randomUUID()}.sqlite`);
    createBackup(repository, safetyBackupPath); inspectBackupFile(safetyBackupPath);
    restoreOpenedBackup(repository, file, captureStore); return { safetyBackupPath };
  } finally { file.close(); }
}
const automaticBackups = new WeakMap<Repository, { dueAt: number; status: 'never' | 'ok' | 'failed'; lastSuccessAt: string | null; scheduler: ReturnType<typeof createBackupScheduler>; worker: ReturnType<typeof createBackupWorker> }>();
/** Desktop complete backups include the potentially large capture database.
 * Keep the existing daily cadence and retention policy, but do all copying and
 * validation off the UI process, 60 seconds after the first due change. */
function automaticBackupState(repository: Repository) {
    let pending = automaticBackups.get(repository);
    if (!pending) {
      const last = repository.read().lastBackupAt, worker = createBackupWorker();
      const scheduler = createBackupScheduler({
        run: signal => {
          const now = nowInstant(), directory = resolveBackupDirectory(dirname(repository.path));
          return worker.run({ kind: 'desktop', databasePath: repository.path, target: join(directory, `auto-${now.replace(/[:+.]/g, '-')}-${randomUUID()}.sqlite`) }, signal);
        },
        onSuccess: (_path, at) => {
          // This metadata is only a cadence hint, never evidence that a business
          // write was persisted. A failure here merely permits an extra backup.
          const savedAt = nowInstant();
          try { repository.transact(live => { live.lastBackupAt = savedAt; }); }
          catch { /* The verified file exists; a missing cadence hint may cause an extra backup after restart. */ }
          const current = automaticBackups.get(repository);
          if (current) { current.dueAt = Date.parse(at) + 86400_000; current.lastSuccessAt = savedAt; current.status = 'ok'; }
        },
        onFailure: () => { const current = automaticBackups.get(repository); if (current) current.status = 'failed'; },
      });
      pending = { dueAt: last ? Date.parse(last) + 86400_000 : 0, status: last ? 'ok' : 'never', lastSuccessAt: last, scheduler, worker }; automaticBackups.set(repository, pending);
    }
    return pending;
}
export function automaticBackup(repository: Repository): void {
  if (repository.path === ':memory:') return;
  try {
    const pending = automaticBackupState(repository);
    // A daily snapshot already in progress counts as today's attempt. Captured
    // data stays a consistent point in time; later edits remain in the live WAL.
    if (Date.now() >= pending.dueAt && !pending.scheduler.status().running) pending.scheduler.markDirty();
  } catch { /* Current data remains durable; manual backup exposes storage errors directly. */ }
}
export function automaticBackupStatus(repository: Repository) {
  const pending = automaticBackupState(repository);
  return { status: pending.status, lastSuccessAt: pending.lastSuccessAt, ...pending.scheduler.status() };
}
/** Call after writers stop and before closing the repository on normal exit. */
export async function flushAutomaticBackups(repository: Repository, timeoutMs = 25_000): Promise<void> {
  const pending = automaticBackups.get(repository); if (!pending) return;
  try { await pending.scheduler.close(timeoutMs); }
  finally { await pending.worker.close(); automaticBackups.delete(repository); }
}
/** Emergency/non-application close must not leave a timer using a closed DB. */
export function cancelAutomaticBackups(repository: Repository): void {
  const pending = automaticBackups.get(repository); if (!pending) return;
  pending.scheduler.cancel(); void pending.worker.close(); automaticBackups.delete(repository);
}
