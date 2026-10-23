import type { DatabaseSync } from 'node:sqlite';
import type { Repository, StoredState } from '../storage/repository';
import { emptyCaptureState, readCaptureDatabaseState, replaceCaptureDatabaseState, type CaptureExportState, type CaptureStore } from './store';

const TABLES = ['capture_meta', 'capture_selections', 'capture_messages', 'capture_blobs', 'capture_attachments', 'capture_chunks', 'capture_batches', 'capture_batch_messages', 'capture_coverage'];

/** A missing capture schema denotes a legacy planner backup; partial/future schemas are rejected. */
export function inspectCaptureBackup(db: DatabaseSync): CaptureExportState | null {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'capture_*'").all().map(row => String(row['name']));
  if (!tables.length) return null;
  if (tables.length !== TABLES.length || TABLES.some(table => !tables.includes(table))) throw new Error('QQ 采集备份表不完整或版本不支持');
  if (db.prepare("SELECT payload FROM capture_meta WHERE id='schemaVersion'").get()?.['payload'] !== '1') throw new Error('QQ 采集备份版本不支持');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('QQ 采集备份关联校验失败');
  const state = readCaptureDatabaseState(db);
  const expected = state.batches.flatMap(batch => batch.messageIds.map((messageId, ordinal) => JSON.stringify([batch.id, messageId, ordinal]))).sort();
  const actual = db.prepare('SELECT batch_id,message_id,ordinal FROM capture_batch_messages').all().map(row => JSON.stringify([row['batch_id'], row['message_id'], row['ordinal']])).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('QQ 批次与消息成员关系不一致');
  return state;
}

/** Both subsystems are replaced on the repository connection inside a single SQLite transaction. */
export function replacePlannerAndCapture(repository: Repository, planner: StoredState, capture: CaptureExportState | null, store?: CaptureStore, additional?: (db: DatabaseSync) => void): void {
  if (store && (store.path !== repository.path || store.path === ':memory:')) throw new Error('QQ 采集与日历必须使用同一个 SQLite 数据文件才能同时恢复');
  if (capture && !store) throw new Error('该备份含有 QQ 采集资料，需要同时初始化采集存储后恢复');
  repository.replaceState(planner, db => { if (store) replaceCaptureDatabaseState(db, capture ?? emptyCaptureState(), { recover: true }); additional?.(db); });
}
