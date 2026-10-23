import { existsSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './database';
import { readDatabaseState, type Repository } from './repository';
import { nowInstant } from '../domain/time';
import { inspectCaptureBackup, replacePlannerAndCapture } from '../capture/backup';
import type { CaptureStore } from '../capture/store';
import { WorkflowError } from '../ai/deepseek';
import { readLedgerDatabase, replaceLedgerDatabase } from '../ledger/service';
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
export function createBackup(repository: Repository, path: string): { path: string; includesSources: true } {
  if (path === repository.path || existsSync(path)) throw Error('备份目标已存在');
  if (repository.estimatedBackupBytes() > MAX_BACKUP_BYTES) throw new WorkflowError('STORAGE', '当前数据预计超过 512 MB 的备份恢复上限，未创建新备份；可先按群或日期清理不再需要的采集附件。原有数据和备份均保留。');
  mkdirSync(dirname(path), { recursive: true }); repository.vacuumInto(path);
  if (statSync(path).size > MAX_BACKUP_BYTES) throw new WorkflowError('STORAGE', `已生成的备份超过 512 MB，文件保留在 ${path}，但当前版本无法恢复；需要后续流式恢复支持。`);
  return { path, includesSources: true };
}
export function inspectBackupBundle(path: string) {
  if (!existsSync(path)) throw Error('备份文件不存在');
  if (statSync(path).size > MAX_BACKUP_BYTES) throw new WorkflowError('VALIDATION', '当前版本只能恢复不超过 512 MB 的备份；该文件已保留，请勿删除。');
  const db = openDatabase(path, true);
  try { if (db.prepare('PRAGMA integrity_check').get()!['integrity_check'] !== 'ok') throw Error('备份完整性校验失败');
    if (db.prepare('PRAGMA user_version').get()!['user_version'] !== 1) throw Error('备份版本不支持');
    return { planner: readDatabaseState(db), capture: inspectCaptureBackup(db), ledger: readLedgerDatabase(db) };
  } finally { db.close(); }
}
export function inspectBackup(path: string) { return inspectBackupBundle(path).planner; }
export function restoreBackup(repository: Repository, path: string, captureStore?: CaptureStore): { safetyBackupPath: string } {
  const state = inspectBackupBundle(path); const safetyBackupPath = join(dirname(repository.path), 'backups', `before-restore-${randomUUID()}.sqlite`);
  createBackup(repository, safetyBackupPath); replacePlannerAndCapture(repository, state.planner, state.capture, captureStore, db => replaceLedgerDatabase(db, state.ledger)); return { safetyBackupPath };
}
/** Runs only after durable commit. Failure cannot turn an already-applied operation into an apparent failure. */
export function automaticBackup(repository: Repository): void {
  if (repository.path === ':memory:') return;
  const state = repository.read(); const now = nowInstant(); if (state.lastBackupAt && Date.parse(now) - Date.parse(state.lastBackupAt) < 86400_000) return;
  try {
    const directory = join(dirname(repository.path), 'backups'); const name = `auto-${now.replace(/[:+.]/g, '-')}-${randomUUID()}.sqlite`;
    createBackup(repository, join(directory, name)); repository.transact(live => { live.lastBackupAt = now; });
    const backups = readdirSync(directory).filter(f => /^auto-.*\.sqlite$/.test(f)).sort();
    for (const file of backups.slice(0, Math.max(0, backups.length - 7))) rmSync(join(directory, file));
  } catch { /* Current data remains durable; manual backup exposes storage errors directly. */ }
}
