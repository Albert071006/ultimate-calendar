import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { RemoteIdentitySchema, type RemoteDevice, type RemoteIdentity, type RemoteMethod, type RemoteOperation } from '../shared/remote';
import { remoteOutputs } from './protocol';
import { z } from 'zod';

export const BackupStatusSchema = z.strictObject({
  status: z.enum(['never', 'ok', 'failed']), lastAttemptAt: z.string().datetime().nullable(), lastSuccessAt: z.string().datetime().nullable(),
  consecutiveFailures: z.number().int().nonnegative(), failureCode: z.enum(['BACKUP_FAILED', 'STATUS_UNREADABLE']).nullable(),
});
export type BackupStatus = z.infer<typeof BackupStatusSchema>;
export const EMPTY_BACKUP_STATUS: BackupStatus = { status: 'never', lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, failureCode: null };

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
type SessionRow = { hash: string; id: string; name: string; csrf: string; expires: number };
type OpRow = { id: string; device: string; method: RemoteMethod; fingerprint: string; status: string; result: string | null; generation: number };
export class RemoteFault extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Separate private database: authentication material never enters planner snapshots/backups. */
export class RemoteState {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly now: () => number = Date.now, recoverPending = true) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') { chmodSync(dirname(path), 0o700); chmodSync(path, 0o600); }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL,name TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY,device TEXT NOT NULL,method TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,result TEXT,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operational (key TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
    if (!this.db.prepare('SELECT 1 FROM metadata').get()) this.db.prepare('INSERT INTO metadata VALUES(1,?)').run(JSON.stringify({ protocolVersion: 1, dataInstanceId: randomUUID(), generation: 1 }));
    if (recoverPending) this.db.exec("UPDATE operations SET status='interrupted' WHERE status='processing'");
    this.db.exec("DELETE FROM operations WHERE method IN ('snapshot','ledgerSnapshot')");
    if (process.platform !== 'win32') for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) chmodSync(`${path}${suffix}`, 0o600);
  }
  identity(): RemoteIdentity { return RemoteIdentitySchema.parse(JSON.parse(String(this.db.prepare('SELECT identity FROM metadata WHERE id=1').get()!.identity))); }
  backupStatus(): BackupStatus {
    const row = this.db.prepare("SELECT payload FROM operational WHERE key='backup'").get();
    if (!row) return { ...EMPTY_BACKUP_STATUS };
    try { return BackupStatusSchema.parse(JSON.parse(String(row.payload))); }
    catch { return { ...EMPTY_BACKUP_STATUS, status: 'failed', consecutiveFailures: 1, failureCode: 'STATUS_UNREADABLE' }; }
  }
  saveBackupStatus(status: BackupStatus): void { this.db.prepare("INSERT OR REPLACE INTO operational(key,payload) VALUES('backup',?)").run(JSON.stringify(BackupStatusSchema.parse(status))); }
  /** Call after a controlled restore/replacement before accepting any old queued writes. */
  advanceGeneration(): RemoteIdentity {
    const next = { ...this.identity(), generation: this.identity().generation + 1 };
    this.db.prepare('UPDATE metadata SET identity=? WHERE id=1').run(JSON.stringify(next)); return next;
  }
  createPairingCode(): string {
    const code = secret();
    this.db.prepare('INSERT OR REPLACE INTO pairing(id,hash,expires,attempts) VALUES(1,?,?,0)').run(digest(code), this.now() + 10 * 60_000);
    return code;
  }
  pair(code: string, name: string): { token: string; csrfToken: string; device: RemoteDevice } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT hash,expires,attempts FROM pairing WHERE id=1').get() as { hash: string; expires: number; attempts: number } | undefined;
      if (!row || row.expires <= this.now() || row.attempts >= 10) throw new RemoteFault(429, '配对码已失效或尝试过多，请在服务端重新生成');
      this.db.prepare('UPDATE pairing SET attempts=attempts+1 WHERE id=1').run();
      if (!timingSafeEqual(Buffer.from(row.hash, 'hex'), Buffer.from(digest(code), 'hex'))) {
        this.db.exec('COMMIT'); throw new RemoteFault(403, '配对码不正确');
      }
      const token = secret(), csrfToken = secret(), device = { id: randomUUID(), name };
      this.db.prepare('INSERT INTO sessions(hash,id,name,csrf,expires) VALUES(?,?,?,?,?)').run(digest(token), device.id, name, csrfToken, this.now() + 30 * 86400_000);
      this.db.exec('DELETE FROM pairing'); this.db.exec('COMMIT'); return { token, csrfToken, device };
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* bad-code attempt already persisted */ } throw error; }
  }
  session(token: string | undefined): { device: RemoteDevice; csrfToken: string } | null {
    if (!token || token.length > 200) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(digest(token), this.now()) as SessionRow | undefined;
    return row ? { device: { id: row.id, name: row.name }, csrfToken: row.csrf } : null;
  }
  devices(): RemoteDevice[] { return this.db.prepare('SELECT id,name FROM sessions WHERE expires>?').all(this.now()) as RemoteDevice[]; }
  revoke(id: string): void { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
  operation(id: string, device: string): RemoteOperation {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=? AND device=? AND generation=?').get(id, device, this.identity().generation) as OpRow | undefined;
    if (!row) return { status: 'unknown' };
    if (row.status === 'completed') return { status: 'completed', requestId: id, method: row.method, result: remoteOutputs[row.method].parse(JSON.parse(row.result!)) };
    return { status: row.status as 'processing' | 'interrupted', requestId: id, method: row.method };
  }
  begin(id: string, device: string, method: RemoteMethod, fingerprint: string): RemoteOperation | null {
    const prior = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as OpRow | undefined;
    if (prior) {
      if (prior.device !== device || prior.method !== method || prior.fingerprint !== fingerprint || prior.generation !== this.identity().generation) throw new RemoteFault(409, '请求编号已用于不同操作，请核对原操作');
      return this.operation(id, device);
    }
    this.db.prepare("INSERT INTO operations(id,device,method,fingerprint,status,generation) VALUES(?,?,?,?,'processing',?)").run(id, device, method, fingerprint, this.identity().generation);
    return null;
  }
  complete(id: string, result: unknown): void { this.db.prepare("UPDATE operations SET status='completed',result=? WHERE id=?").run(JSON.stringify(result), id); }
  interrupt(id: string): void { this.db.prepare("UPDATE operations SET status='interrupted' WHERE id=?").run(id); }
  close(): void { this.db.close(); }
}
