import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { IdSchema } from '../shared/contracts';
import { privatePath } from '../remote/private-file';
import { BridgeFault } from './config';

const DistilledId = z.string().regex(/^qq[de]_[a-f0-9]{64}$/);
export const LocalEvidenceLinkSchema = z.strictObject({ distilledId: DistilledId, eventId: z.string().regex(/^qqe_[a-f0-9]{64}$/).optional(), ancestorIds: z.array(IdSchema).max(100).optional(), candidateId: IdSchema, sourceIds: z.array(IdSchema).min(1).max(1000) });
export type LocalEvidenceLink = z.infer<typeof LocalEvidenceLinkSchema>;
export const evidenceIndexPath = (sourceDatabase: string) => join(dirname(sourceDatabase), 'credentials', 'qq-evidence-index.sqlite');
export const distilledSourceId = (distilledId: string) => `distilled-source:${createHash('sha256').update(JSON.stringify(DistilledId.parse(distilledId))).digest('hex')}`;
function verify(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  const version = db.prepare('PRAGMA user_version').get()!.user_version;
  if (!(version === 1 && tables.length === 1 && tables.includes('qq_evidence_links')) && !(version === 2 && tables.length === 2 && tables.includes('qq_evidence_links') && tables.includes('qq_event_generations'))) throw new BridgeFault('storage');
}
function protect(path: string) { if (process.platform !== 'win32') for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600); }
/** Private local identifiers only. Never put this index or these links in a distilled request. */
export function createEvidenceIndex(path: string) {
  privatePath(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const stat = lstatSync(path); if (!stat.isFile() || stat.nlink !== 1) throw new BridgeFault('storage');
    const probe = new DatabaseSync(path, { readOnly: true }); try { verify(probe); } finally { probe.close(); }
  }
  const db = new DatabaseSync(path); let closed = false;
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS qq_evidence_links (cloud_source_id TEXT NOT NULL, distilled_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(cloud_source_id,candidate_id,source_id));
      CREATE TABLE IF NOT EXISTS qq_event_generations (event_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
        generation INTEGER NOT NULL, PRIMARY KEY(event_id,candidate_id), UNIQUE(event_id,generation));
      PRAGMA user_version=2; COMMIT;`); verify(db); protect(path);
  } catch { db.close(); throw new BridgeFault('storage'); }
  return {
    generation(eventId: string, ancestorIds: string[]): number {
      if (!/^qqe_[a-f0-9]{64}$/.test(eventId) || !ancestorIds.length || ancestorIds.length > 100) throw new BridgeFault('storage');
      const ids = ancestorIds.map(id => IdSchema.parse(id));
      db.exec('BEGIN IMMEDIATE');
      try {
        // Allocate the root before its descendants, and keep these ranks through DB vacuum/restores.
        let next = Number(db.prepare('SELECT COALESCE(MAX(generation),0) AS n FROM qq_event_generations WHERE event_id=?').get(eventId)!.n);
        for (const id of [...ids].reverse()) if (!db.prepare('SELECT 1 FROM qq_event_generations WHERE event_id=? AND candidate_id=?').get(eventId, id)) {
          next++; if (!Number.isSafeInteger(next)) throw Error('Invalid event generation');
          db.prepare('INSERT INTO qq_event_generations(event_id,candidate_id,generation) VALUES(?,?,?)').run(eventId, id, next);
        }
        const generation = Number(db.prepare('SELECT generation FROM qq_event_generations WHERE event_id=? AND candidate_id=?').get(eventId, ids[0]!)!.generation);
        db.exec('COMMIT'); protect(path); return generation;
      } catch { db.exec('ROLLBACK'); throw new BridgeFault('storage'); }
    },
    legacyIds(candidateIds: string[]): string[] {
      const ids = new Set<string>();
      for (const id of candidateIds) for (const row of db.prepare("SELECT DISTINCT distilled_id FROM qq_evidence_links WHERE candidate_id=? AND distilled_id LIKE 'qqd_%' ORDER BY rowid DESC LIMIT 100").all(IdSchema.parse(id))) ids.add(DistilledId.parse(row.distilled_id));
      return [...ids].slice(0, 99);
    },
    remember(input: LocalEvidenceLink[]) {
      const links = input.map(value => LocalEvidenceLinkSchema.parse(value));
      db.exec('BEGIN IMMEDIATE');
      try {
        const insert = db.prepare('INSERT OR IGNORE INTO qq_evidence_links(cloud_source_id,distilled_id,candidate_id,source_id) VALUES(?,?,?,?)');
        for (const link of links) for (const distilledId of new Set([link.distilledId, ...(link.eventId ? [link.eventId] : [])])) for (const id of new Set(link.sourceIds)) insert.run(distilledSourceId(distilledId), distilledId, link.candidateId, id);
        db.exec('COMMIT'); protect(path);
      } catch { db.exec('ROLLBACK'); throw new BridgeFault('storage'); }
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
/** Missing mapping remains missing. No title matching, no cloud request, and no source DB write. */
export function readEvidenceSourceIds(path: string, sourceId: string): string[] {
  if (!/^distilled-source:[a-f0-9]{64}$/.test(sourceId)) return [];
  privatePath(path); if (!existsSync(path)) return [];
  const stat = lstatSync(path); if (!stat.isFile() || stat.nlink !== 1) throw new BridgeFault('storage');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000'); verify(db);
    const rows = db.prepare('SELECT DISTINCT distilled_id,source_id FROM qq_evidence_links WHERE cloud_source_id=? ORDER BY source_id LIMIT 101').all(sourceId);
    const ids = new Set<string>();
    for (const row of rows) {
      if (distilledSourceId(String(row.distilled_id)) !== sourceId) throw new BridgeFault('storage');
      ids.add(IdSchema.parse(row.source_id));
    }
    if (ids.size > 100) throw new BridgeFault('storage');
    return [...ids];
  } finally { db.close(); }
}
