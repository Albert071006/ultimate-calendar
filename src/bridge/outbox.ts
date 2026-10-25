import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DistilledRequestSchema, type DistilledRequest } from '../shared/distilled';
import { RemoteIdentitySchema, type RemoteIdentity } from '../shared/remote';
import { BridgeFault, type BridgeIssue } from './config';
import { distilledHash, projectDistilledFields, type SafeDistillation } from './projection';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export interface ClaimedDistillation { request: DistilledRequest; hash: string; attempts: number; leaseToken: string }
export interface OutboxStats { pending: number; sending: number; accepted: number; blocked: number }
export interface BridgeOutbox {
  bind(fingerprint: string): void;
  cursor(): number;
  enqueue(items: SafeDistillation[], identity: RemoteIdentity, now: number, cursor: number): { inserted: number; duplicates: number };
  claim(now: number, leaseMs?: number): ClaimedDistillation | null;
  accepted(item: ClaimedDistillation, now: number): boolean;
  retry(item: ClaimedDistillation, nextAttempt: number, reason: BridgeIssue): boolean;
  block(item: ClaimedDistillation, reason: BridgeIssue): boolean;
  stats(): OutboxStats;
  close(): void;
}
const allowedTables = ['bridge_meta', 'bridge_outbox'];
const validMs = (value: number) => Number.isSafeInteger(value) && value >= 0;
function protect(path: string) {
  if (process.platform !== 'win32') for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
}
/** Dedicated database. Refuse an existing planner/auth/other database before making any write. */
export function createBridgeOutbox(path: string): BridgeOutbox {
  if (path !== ':memory:' && !isAbsolute(path)) throw new BridgeFault('configuration');
  let db: DatabaseSync | undefined;
  try {
    if (path !== ':memory:') {
      if (existsSync(path) && statSync(path).size > 0) {
        const probe = new DatabaseSync(path, { readOnly: true });
        try {
          const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name));
          const version = Number(probe.prepare('PRAGMA user_version').get()!['user_version']);
          if (!(tables.length === 0 && version === 0) && !(tables.length === 2 && version === 1 && tables.every(table => allowedTables.includes(table)))) throw new BridgeFault('configuration');
        } finally { probe.close(); }
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try { closeSync(openSync(path, 'ax', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      protect(path);
    }
    db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS bridge_meta (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bridge_outbox (content_hash TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER,
        created_at INTEGER NOT NULL, accepted_at INTEGER, reason TEXT);
      CREATE INDEX IF NOT EXISTS bridge_outbox_due ON bridge_outbox(status,next_attempt);
      PRAGMA user_version=1; COMMIT;`);
    if (path !== ':memory:') protect(path);
  } catch (error) { db?.close(); throw error instanceof BridgeFault ? error : new BridgeFault('storage'); }
  const database = db;
  let closed = false;
  function safe<T>(work: () => T): T { try { return work(); } catch (error) { throw error instanceof BridgeFault ? error : new BridgeFault('storage'); } }
  function transaction<T>(work: () => T): T {
    return safe(() => {
      database.exec('BEGIN IMMEDIATE');
      try { const result = work(); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; }
    });
  }
  function settle(item: ClaimedDistillation, status: string, next: number, reason: string | null, now: number | null = null): boolean {
    return safe(() => database.prepare(`UPDATE bridge_outbox SET status=?,next_attempt=?,reason=?,accepted_at=?,lease_token=NULL,lease_until=NULL
      WHERE content_hash=? AND lease_token=? AND status='sending'`).run(status, next, reason, now, item.hash, item.leaseToken).changes > 0);
  }
  return {
    bind(fingerprint) {
      if (!hashSchema.safeParse(fingerprint).success) throw new BridgeFault('configuration');
      transaction(() => {
        const old = database.prepare("SELECT payload FROM bridge_meta WHERE id='binding'").get();
        if (old && old.payload !== fingerprint) throw new BridgeFault('identity');
        database.prepare("INSERT OR IGNORE INTO bridge_meta(id,payload) VALUES('binding',?)").run(fingerprint);
      });
    },
    cursor() { return safe(() => { const row = database.prepare("SELECT payload FROM bridge_meta WHERE id='cursor'").get(); const value = row ? Number(row.payload) : 0; if (!validMs(value)) throw Error(); return value; }); },
    enqueue(values, identity, now, cursor) {
      if (!validMs(now) || !validMs(cursor)) throw new BridgeFault('configuration');
      const parsedIdentity = RemoteIdentitySchema.safeParse(identity); if (!parsedIdentity.success) throw new BridgeFault('identity');
      const items = values.map(value => {
        const { distilledId, ...fields } = value.item; const projected = projectDistilledFields(fields);
        if (!projected.ok || projected.value.hash !== value.hash || projected.value.item.distilledId !== distilledId) throw new BridgeFault('validation');
        return projected.value;
      });
      return transaction(() => {
        if (!database.prepare("SELECT 1 FROM bridge_meta WHERE id='binding'").get()) throw new BridgeFault('identity');
        let inserted = 0; let duplicates = 0;
        for (const value of items) {
          const request = DistilledRequestSchema.parse({ requestId: `qqb_${distilledHash({ identity: parsedIdentity.data, hash: value.hash })}`, identity: parsedIdentity.data, items: [value.item] });
          const result = database.prepare("INSERT OR IGNORE INTO bridge_outbox(content_hash,request_id,payload,status,next_attempt,created_at) VALUES(?,?,?,'pending',?,?)").run(value.hash, request.requestId, JSON.stringify(request), now, now);
          if (result.changes) inserted++; else duplicates++;
        }
        database.prepare("INSERT INTO bridge_meta(id,payload) VALUES('cursor',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(String(cursor));
        return { inserted, duplicates };
      });
    },
    claim(now, leaseMs = 120_000) {
      if (!validMs(now) || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 600_000) throw new BridgeFault('configuration');
      return transaction(() => {
        const row = database.prepare(`SELECT * FROM bridge_outbox WHERE next_attempt<=?
          AND (status='pending' OR (status='sending' AND lease_until<=?)) ORDER BY created_at,content_hash LIMIT 1`).get(now, now);
        if (!row) return null;
        const request = DistilledRequestSchema.parse(JSON.parse(String(row.payload))); const hash = hashSchema.parse(row.content_hash);
        if (request.items.length !== 1) throw new BridgeFault('storage');
        const { distilledId, ...fields } = request.items[0]!; const projected = projectDistilledFields(fields);
        if (!projected.ok || projected.value.hash !== hash || projected.value.item.distilledId !== distilledId) throw new BridgeFault('storage');
        const leaseToken = randomUUID(); database.prepare("UPDATE bridge_outbox SET status='sending',attempts=attempts+1,lease_token=?,lease_until=? WHERE content_hash=?").run(leaseToken, now + leaseMs, hash);
        return { request, hash, attempts: Number(row.attempts) + 1, leaseToken };
      });
    },
    accepted(item, now) { if (!validMs(now)) throw new BridgeFault('configuration'); return settle(item, 'accepted', 0, null, now); },
    retry(item, nextAttempt, reason) { if (!validMs(nextAttempt)) throw new BridgeFault('configuration'); return settle(item, 'pending', nextAttempt, reason); },
    block(item, reason) { return settle(item, 'blocked', 0, reason); },
    stats() {
      return safe(() => {
        const rows = database.prepare('SELECT status,count(*) AS n FROM bridge_outbox GROUP BY status').all();
        const stats: OutboxStats = { pending: 0, sending: 0, accepted: 0, blocked: 0 };
        for (const row of rows) { if (!Object.hasOwn(stats, String(row.status))) throw Error(); stats[row.status as keyof OutboxStats] = Number(row.n); }
        return stats;
      });
    },
    close() { if (!closed) { closed = true; database.close(); } },
  };
}
