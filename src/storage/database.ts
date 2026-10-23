import * as sqlite from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** Node 24 exposes DatabaseSync; Electron 45 may expose the preferred Database name. No warning suppression. */
export function openDatabase(path: string, readOnly = false): sqlite.DatabaseSync {
  if (path !== ':memory:' && !readOnly) mkdirSync(dirname(path), { recursive: true });
  const runtime = sqlite as unknown as { Database?: typeof sqlite.DatabaseSync; DatabaseSync: typeof sqlite.DatabaseSync };
  const db = new (runtime.Database ?? runtime.DatabaseSync)(path, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (!readOnly) {
      const v = db.prepare('PRAGMA user_version').get()!['user_version']; if (v !== 0 && v !== 1) throw Error('不支持的数据库版本');
      db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
    }
    return db;
  } catch (error) { db.close(); throw error; }
}
/** SQLite DDL and user_version participate in this same transaction as default data. */
export function initializeDatabase(db: sqlite.DatabaseSync, initializeDefaults: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const v = db.prepare('PRAGMA user_version').get()!['user_version']; if (v !== 0 && v !== 1) throw Error('不支持的数据库版本');
    db.exec(`CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
    initializeDefaults();
    db.exec('PRAGMA user_version=1; COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
