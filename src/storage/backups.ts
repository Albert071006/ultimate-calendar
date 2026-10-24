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
import { pruneManagedBackups } from './backup-retention';
import { resolveBackupDirectory } from './space-policy';

const MiB = 1024 * 1024;
function requireDiskSpace(directory: string, bytes: number, purpose: string): void {
  const space = statfsSync(directory);
  if (space.bavail * space.bsize < bytes) throw new WorkflowError('STORAGE', `磁盘可用空间不足，${purpose}需要至少约 ${Math.ceil(bytes / MiB)} MB 可用空间；原有数据和备份均保留。`);
}
export function requireRestoreStagingSpace(directory: string, bytes: number): void {
  requireDiskSpace(directory, bytes + 16 * MiB, '恢复预览的暂存副本');
}
export function createBackup(repository: Repository, path: string): { path: string; includesSources: true } {
  if (path === repository.path || existsSync(path)) throw Error('备份目标已存在');
  mkdirSync(dirname(path), { recursive: true });
  requireDiskSpace(dirname(path), repository.estimatedBackupBytes() + 16 * MiB, '保存完整备份');
  repository.vacuumInto(path);
  return { path, includesSources: true };
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
    const planner = readDatabaseState(db), capture = inspectCaptureBackupFile(db), ledger = readLedgerDatabase(db);
    const allocated = Number(db.prepare('PRAGMA page_count').get()!['page_count']);
    const free = Number(db.prepare('PRAGMA freelist_count').get()!['freelist_count']);
    const pageSize = Number(db.prepare('PRAGMA page_size').get()!['page_size']);
    const estimatedBytes = Math.max(0, allocated - free) * pageSize;
    let closed = false;
    return { db, planner, capture, ledger, estimatedBytes, close() { if (!closed) { closed = true; db.close(); } } };
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
    createBackup(repository, safetyBackupPath); restoreOpenedBackup(repository, file, captureStore); return { safetyBackupPath };
  } finally { file.close(); }
}
/** Runs only after durable commit. Failure cannot turn an already-applied operation into an apparent failure. */
export function automaticBackup(repository: Repository): void {
  if (repository.path === ':memory:') return;
  const state = repository.read(); const now = nowInstant(); if (state.lastBackupAt && Date.parse(now) - Date.parse(state.lastBackupAt) < 86400_000) return;
  try {
    const directory = resolveBackupDirectory(dirname(repository.path)); const name = `auto-${now.replace(/[:+.]/g, '-')}-${randomUUID()}.sqlite`;
    createBackup(repository, join(directory, name)); repository.transact(live => { live.lastBackupAt = now; });
    pruneManagedBackups(dirname(repository.path));
  } catch { /* Current data remains durable; manual backup exposes storage errors directly. */ }
}
