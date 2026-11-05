import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PlannerCursorSchema, PlannerPatchSchema, type PlannerChanges, type PlannerCursor, type PlannerPatch } from '../shared/contracts';

const RETAIN = 256, MAX_BYTES = 4 * 1024 * 1024;
export function createPlannerChangeLog(db: DatabaseSync, sanitize: (patch: PlannerPatch) => PlannerPatch = value => value) {
  db.exec(`CREATE TABLE IF NOT EXISTS planner_sync_meta (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS planner_sync_log (revision INTEGER PRIMARY KEY, payload TEXT NOT NULL, bytes INTEGER NOT NULL)`);
  db.prepare('INSERT OR IGNORE INTO planner_sync_meta VALUES(1,?)').run(JSON.stringify({ streamId: randomUUID(), revision: 0 }));
  const cursor = () => PlannerCursorSchema.parse(JSON.parse(String(db.prepare('SELECT payload FROM planner_sync_meta WHERE id=1').get()!.payload)));
  return {
    cursor,
    reset() {
      db.prepare('UPDATE planner_sync_meta SET payload=? WHERE id=1').run(JSON.stringify({ streamId: randomUUID(), revision: 0 }));
      db.exec('DELETE FROM planner_sync_log');
    },
    /** Caller owns the same SQLite transaction as the business entities. */
    append(change: Omit<PlannerPatch, 'from' | 'to'>) {
      if (!change.entities.length && !change.settings && !change.journal && !change.usage) return;
      const from = cursor(), to = { ...from, revision: from.revision + 1 };
      const patch = PlannerPatchSchema.parse(sanitize({ ...change, from, to })), payload = JSON.stringify(patch), bytes = Buffer.byteLength(payload);
      db.prepare('UPDATE planner_sync_meta SET payload=? WHERE id=1').run(JSON.stringify(to));
      // A large import remains valid; its clients deliberately take a fresh snapshot.
      if (bytes > MAX_BYTES) { db.exec('DELETE FROM planner_sync_log'); return; }
      db.prepare('INSERT INTO planner_sync_log VALUES(?,?,?)').run(to.revision, payload, bytes);
      db.prepare('DELETE FROM planner_sync_log WHERE revision<=?').run(to.revision - RETAIN);
      let total = Number(db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM planner_sync_log').get()!.bytes);
      while (total > MAX_BYTES) {
        const oldest = db.prepare('SELECT revision,bytes FROM planner_sync_log ORDER BY revision LIMIT 1').get()!;
        db.prepare('DELETE FROM planner_sync_log WHERE revision=?').run(oldest.revision!); total -= Number(oldest.bytes);
      }
    },
    changes(from: PlannerCursor): PlannerChanges {
      const to = cursor();
      if (from.streamId !== to.streamId || from.revision > to.revision) return { status: 'reset' };
      const patch: PlannerPatch = { from, to, entities: [] };
      if (from.revision === to.revision) return { status: 'patch', patch };
      const rows = db.prepare('SELECT revision,payload FROM planner_sync_log WHERE revision>? ORDER BY revision').all(from.revision);
      if (rows.length !== to.revision - from.revision || Number(rows[0]?.revision) !== from.revision + 1) return { status: 'reset' };
      const entities = new Map<string, PlannerPatch['entities'][number]>(), usage = new Map<string, NonNullable<PlannerPatch['usage']>['upserts'][number]>(), deleted = new Set<string>();
      for (const row of rows) {
        const item = PlannerPatchSchema.parse(JSON.parse(String(row.payload)));
        if (item.from.streamId !== to.streamId || item.to.streamId !== to.streamId || item.from.revision !== Number(row.revision) - 1 || item.to.revision !== Number(row.revision)) return { status: 'reset' };
        for (const entity of item.entities) entities.set(`${entity.entity}:${entity.id}`, entity);
        if (item.settings) patch.settings = item.settings;
        if (item.journal) patch.journal = item.journal;
        if (item.usage) {
          for (const id of item.usage.deletedIds) { usage.delete(id); deleted.add(id); }
          for (const value of item.usage.upserts) { usage.set(value.id, value); deleted.delete(value.id); }
        }
      }
      patch.entities = [...entities.values()];
      if (usage.size || deleted.size) patch.usage = { upserts: [...usage.values()], deletedIds: [...deleted] };
      return { status: 'patch', patch };
    },
  };
}
