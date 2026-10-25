import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { InstantSchema, ReminderSchema, type Instant, type Reminder } from '../shared/contracts';
import { PushPreferencesSchema, PushSubscriptionInputSchema, type PushPreferences, type PushSubscriptionInput, type PushSubscriptionSummary } from '../shared/push';
import { nowInstant } from '../domain/time';

const DeviceIdSchema = z.string().trim().min(1).max(200);
const VapidKeysSchema = z.strictObject({ publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/), privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export type VapidKeys = z.infer<typeof VapidKeysSchema>;
export interface StoredPushSubscription extends PushSubscriptionSummary { subscription: PushSubscriptionInput }
export interface PushDelivery {
  id: string; reminder: Reminder; target: StoredPushSubscription; attempts: number; leaseToken: string; expiresAt: Instant;
}
export type DeliveryOutcome = { kind: 'accepted' } | { kind: 'retry'; nextAttemptAt: Instant; reason: string } | { kind: 'failed' | 'cancelled' | 'expired'; reason?: string };
export interface PushStore {
  upsertSubscription(deviceId: string, input: PushSubscriptionInput, preferences?: Partial<PushPreferences>, now?: Instant): PushSubscriptionSummary;
  listSubscriptions(deviceId: string): PushSubscriptionSummary[];
  getSubscription(deviceId: string, subscriptionId: string): StoredPushSubscription | null;
  removeSubscription(deviceId: string, subscriptionId: string): boolean;
  revokeDevice(deviceId: string): void;
  getPublicVapidKey(): string | null;
  getOrCreateVapidKeys(generate: () => VapidKeys): VapidKeys;
  /** Atomically replaces the current eligible set, retaining completed per-device delivery receipts. */
  reconcile(reminders: Reminder[], now: Instant, catchUpMs: number): void;
  claimDue(now: Instant, limit?: number, leaseMs?: number): PushDelivery[];
  currentDelivery(id: string, leaseToken: string, now: Instant): PushDelivery | null;
  settle(id: string, leaseToken: string, outcome: DeliveryOutcome): boolean;
  cancelJob(reminderId: string): void;
  disableSubscription(subscriptionId: string): void;
  close(): void;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class PushSubscriptionConflict extends Error {}
function summary(row: Record<string, unknown>): PushSubscriptionSummary {
  return { id: String(row.id), deviceId: String(row.device_id), showDetails: row.show_details === 1, active: row.active === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
const ms = (instant: string) => Date.parse(InstantSchema.parse(instant));

/** This is cloud delivery state, deliberately separate from desktop reminder receipts and planner backups. */
export function createPushStore(path: string): PushStore {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(path, 'ax', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (process.platform !== 'win32') for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) chmodSync(`${path}${suffix}`, 0o600);
  }
  const db = new DatabaseSync(path);
  let closed = false;
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
    const version = Number(db.prepare('PRAGMA user_version').get()!['user_version']);
    if (version !== 0 && version !== 1) throw Error('不支持的推送数据库版本');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS push_metadata (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, show_details INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, scheduled_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_deliveries (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES push_jobs(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        lease_token TEXT, lease_until INTEGER, reason TEXT, UNIQUE(job_id,subscription_id));
      CREATE INDEX IF NOT EXISTS push_delivery_due ON push_deliveries(status,next_attempt_at);
      CREATE INDEX IF NOT EXISTS push_subscription_device ON push_subscriptions(device_id);
      PRAGMA user_version=1; COMMIT;`);
    if (path !== ':memory:' && process.platform !== 'win32') for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) chmodSync(`${path}${suffix}`, 0o600);
  } catch (error) { db.close(); throw error; }
  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function delivery(row: Record<string, unknown>): PushDelivery {
    return { id: String(row.delivery_id), reminder: ReminderSchema.parse(JSON.parse(String(row.reminder))),
      target: { ...summary(row), subscription: PushSubscriptionInputSchema.parse(JSON.parse(String(row.subscription))) },
      attempts: Number(row.attempts), leaseToken: String(row.lease_token), expiresAt: new Date(Number(row.expires_at) + 8 * 3600_000).toISOString().replace('Z', '+08:00') };
  }
  const joined = `SELECT d.id AS delivery_id,d.attempts,d.lease_token,j.payload AS reminder,j.expires_at,
    s.id,s.device_id,s.show_details,s.active,s.created_at,s.updated_at,s.payload AS subscription
    FROM push_deliveries d JOIN push_jobs j ON j.id=d.job_id JOIN push_subscriptions s ON s.id=d.subscription_id`;
  const store: PushStore = {
    upsertSubscription(deviceId, value, preferences = {}, now = nowInstant()) {
      DeviceIdSchema.parse(deviceId); const input = PushSubscriptionInputSchema.parse(value); const settings = PushPreferencesSchema.parse(preferences); const at = ms(now);
      if (input.expirationTime !== undefined && input.expirationTime !== null && input.expirationTime <= at) throw Error('浏览器推送订阅已过期');
      const id = hash(input.endpoint);
      return transaction(() => {
        const existing = db.prepare('SELECT * FROM push_subscriptions WHERE id=?').get(id);
        if (existing && existing['device_id'] !== deviceId) throw new PushSubscriptionConflict('推送订阅属于另一台设备，请重新订阅');
        if (!existing && Number(db.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE device_id=?').get(deviceId)!['n']) >= 10) throw new PushSubscriptionConflict('该设备推送订阅过多，请先删除旧订阅');
        db.prepare(`INSERT INTO push_subscriptions(id,device_id,endpoint,payload,show_details,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,show_details=excluded.show_details,active=1,updated_at=excluded.updated_at`).run(id, deviceId, input.endpoint, JSON.stringify(input), Number(settings.showDetails), now, now);
        return summary(db.prepare('SELECT * FROM push_subscriptions WHERE id=?').get(id)!);
      });
    },
    listSubscriptions(deviceId) { DeviceIdSchema.parse(deviceId); return db.prepare('SELECT * FROM push_subscriptions WHERE device_id=? ORDER BY created_at,id').all(deviceId).map(summary); },
    getSubscription(deviceId, id) {
      DeviceIdSchema.parse(deviceId); const row = db.prepare('SELECT * FROM push_subscriptions WHERE id=? AND device_id=?').get(id, deviceId);
      return row ? { ...summary(row), subscription: PushSubscriptionInputSchema.parse(JSON.parse(String(row.payload))) } : null;
    },
    removeSubscription(deviceId, id) { DeviceIdSchema.parse(deviceId); return db.prepare('DELETE FROM push_subscriptions WHERE id=? AND device_id=?').run(id, deviceId).changes > 0; },
    revokeDevice(deviceId) { DeviceIdSchema.parse(deviceId); db.prepare('DELETE FROM push_subscriptions WHERE device_id=?').run(deviceId); },
    getPublicVapidKey() { const row = db.prepare("SELECT payload FROM push_metadata WHERE id='vapid'").get(); return row ? VapidKeysSchema.parse(JSON.parse(String(row.payload))).publicKey : null; },
    getOrCreateVapidKeys(generate) {
      return transaction(() => {
        const row = db.prepare("SELECT payload FROM push_metadata WHERE id='vapid'").get();
        if (row) return VapidKeysSchema.parse(JSON.parse(String(row.payload)));
        const keys = VapidKeysSchema.parse(generate()); db.prepare("INSERT INTO push_metadata(id,payload) VALUES('vapid',?)").run(JSON.stringify(keys)); return keys;
      });
    },
    reconcile(values, now, catchUpMs) {
      const at = ms(now); if (!Number.isInteger(catchUpMs) || catchUpMs <= 0 || catchUpMs > 86_400_000) throw Error('推送补发范围必须在24小时内');
      const reminders = values.map(value => ReminderSchema.parse(value));
      transaction(() => {
        db.prepare("UPDATE push_jobs SET state='cancelled' WHERE state='active'").run();
        for (const reminder of reminders) {
          const scheduled = ms(reminder.scheduledAt); const expires = scheduled + catchUpMs;
          if (scheduled > at || expires <= at) continue;
          db.prepare(`INSERT INTO push_jobs(id,payload,scheduled_at,expires_at,state) VALUES(?,?,?,?,'active')
            ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at,state='active'`).run(reminder.id, JSON.stringify(reminder), scheduled, expires);
          for (const row of db.prepare('SELECT * FROM push_subscriptions WHERE active=1').all()) {
            const subscription = PushSubscriptionInputSchema.parse(JSON.parse(String(row.payload)));
            // A freshly enabled device does not replay reminders from before it subscribed.
            if (ms(String(row.created_at)) > scheduled || (subscription.expirationTime != null && subscription.expirationTime <= at)) continue;
            db.prepare('INSERT OR IGNORE INTO push_deliveries(id,job_id,subscription_id,next_attempt_at) VALUES(?,?,?,?)').run(hash(`${reminder.id}\0${row.id}`), reminder.id, String(row.id), scheduled);
          }
        }
        db.prepare("UPDATE push_jobs SET state='expired' WHERE expires_at<=?").run(at);
        db.prepare("UPDATE push_deliveries SET status='expired',lease_token=NULL,lease_until=NULL WHERE status IN ('pending','retry','leased') AND job_id IN (SELECT id FROM push_jobs WHERE state='expired')").run();
        db.prepare("INSERT INTO push_metadata(id,payload) VALUES('lastCheck',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(now));
      });
    },
    claimDue(now, limit = 20, leaseMs = 60_000) {
      const at = ms(now); if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) throw Error('推送领取参数无效');
      return transaction(() => {
        const rows = db.prepare(`${joined} WHERE j.state='active' AND j.expires_at>? AND s.active=1 AND d.next_attempt_at<=?
          AND (d.status IN ('pending','retry') OR (d.status='leased' AND d.lease_until<=?)) ORDER BY j.scheduled_at,d.id LIMIT ?`).all(at, at, at, limit);
        return rows.map(row => {
          const token = randomUUID(); db.prepare("UPDATE push_deliveries SET status='leased',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?").run(token, at + leaseMs, String(row.delivery_id));
          return delivery({ ...row, attempts: Number(row.attempts) + 1, lease_token: token });
        });
      });
    },
    currentDelivery(id, token, now) {
      const at = ms(now); const row = db.prepare(`${joined} WHERE d.id=? AND d.lease_token=? AND d.status='leased' AND d.lease_until>?
        AND j.state='active' AND j.expires_at>? AND s.active=1`).get(id, token, at, at);
      return row ? delivery(row) : null;
    },
    settle(id, token, outcome) {
      const next = outcome.kind === 'retry' ? ms(outcome.nextAttemptAt) : 0;
      return db.prepare(`UPDATE push_deliveries SET status=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,reason=?
        WHERE id=? AND lease_token=? AND status='leased'`).run(outcome.kind, next, 'reason' in outcome ? (outcome.reason ?? '').slice(0, 100) : '', id, token).changes > 0;
    },
    cancelJob(id) { db.prepare("UPDATE push_jobs SET state='cancelled' WHERE id=?").run(id); },
    disableSubscription(id) {
      transaction(() => {
        db.prepare('UPDATE push_subscriptions SET active=0 WHERE id=?').run(id);
        db.prepare("UPDATE push_deliveries SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE subscription_id=? AND status IN ('pending','retry','leased')").run(id);
      });
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
  return store;
}
