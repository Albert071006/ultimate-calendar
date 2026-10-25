import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BridgeFault } from './config';
import { distilledHash, legacyCandidateKey, projectDistilledFields, type SafeDistillation } from './projection';
import { LocalEvidenceLinkSchema, type LocalEvidenceLink } from './evidence-index';

export interface CandidatePage { items: SafeDistillation[]; localLinks: LocalEvidenceLink[]; cursor: number; done: boolean; examined: number; privacyRejected: number; schemaRejected: number }
export interface CandidateReader { readonly fingerprint: string; scan(cursor?: number, limit?: number): CandidatePage; close(): void }

/** No defaults and no discovery. This connection never initializes, migrates or recovers the desktop database. */
export function createCandidateReader(sourceDatabase: string): CandidateReader {
  let db: DatabaseSync | undefined;
  let fingerprint: string;
  try {
    if (!isAbsolute(sourceDatabase) || !statSync(sourceDatabase).isFile()) throw Error();
    const real = realpathSync(sourceDatabase); fingerprint = distilledHash(process.platform === 'win32' ? real.toLowerCase() : real);
    db = new DatabaseSync(real, { readOnly: true }); db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
    if (Number(db.prepare('PRAGMA user_version').get()!['user_version']) !== 1) throw Error();
    db.prepare('SELECT kind,id,payload FROM records LIMIT 0').all();
  } catch { db?.close(); throw new BridgeFault('source'); }
  const database = db;
  let closed = false;
  const lineage = database.prepare("SELECT id,json_extract(payload,'$.revisionOfId') AS revision_of,json_extract(payload,'$.duplicateOfId') AS duplicate_of FROM records WHERE kind='candidate' AND id=?");
  const query = database.prepare(`SELECT c.rowid AS position,c.id AS local_candidate_id,json_extract(c.payload,'$.version') AS local_version,json_extract(c.payload,'$.sourceIds') AS local_source_ids,
    json_object('title',json_extract(c.payload,'$.title'),'action',json_extract(c.payload,'$.action'),
      'benefit',json_extract(c.payload,'$.benefit'),'benefitKind',json_extract(c.payload,'$.benefitKind'),
      'potentialBenefit',json_extract(c.payload,'$.potentialBenefit'),'conditions',json_extract(c.payload,'$.conditions'),
      'uncertainties',json_extract(c.payload,'$.uncertainties'),'deadline',json_extract(c.payload,'$.deadline'),
      'eventStart',json_extract(c.payload,'$.eventStart'),'eventEnd',json_extract(c.payload,'$.eventEnd'),
      'location',json_extract(c.payload,'$.location')) AS distilled,
    (SELECT json_group_array(json_object('account',json_extract(s.payload,'$.captureRef.accountId'),'group',json_extract(s.payload,'$.captureRef.groupId')))
      FROM json_each(c.payload,'$.sourceIds') refs JOIN records s ON s.kind='source' AND s.id=refs.value
      WHERE json_type(s.payload,'$.captureRef.accountId')='text' AND json_type(s.payload,'$.captureRef.groupId')='text') AS private_tokens
    FROM records c WHERE c.kind='candidate' AND c.rowid>? AND json_extract(c.payload,'$.status')='pending'
      AND EXISTS (SELECT 1 FROM json_each(c.payload,'$.sourceIds') refs JOIN records s ON s.kind='source' AND s.id=refs.value
        WHERE json_type(s.payload,'$.captureRef.accountId')='text' AND json_type(s.payload,'$.captureRef.groupId')='text')
    ORDER BY c.rowid LIMIT ?`);
  return {
    fingerprint,
    scan(cursor = 0, limit = 200) {
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new BridgeFault('configuration');
      try {
        const rows = query.all(cursor, limit); const page: CandidatePage = { items: [], localLinks: [], cursor, done: rows.length < limit, examined: rows.length, privacyRejected: 0, schemaRejected: 0 };
        for (const row of rows) {
          page.cursor = Number(row.position);
          const tokens = (JSON.parse(String(row.private_tokens)) as { account: string; group: string }[]).flatMap(value => [value.account, value.group]);
          const ancestorIds: string[] = []; let id = String(row.local_candidate_id);
          while (id && !ancestorIds.includes(id) && ancestorIds.length < 100) {
            ancestorIds.push(id); const ancestor = lineage.get(id); if (!ancestor) break;
            const parent = ancestor.revision_of ?? ancestor.duplicate_of; if (!parent) break; id = String(parent);
          }
          const eventId = `qqe_${distilledHash({ origin: fingerprint, root: ancestorIds.at(-1) })}`;
          // The service replaces this provisional lineage depth with its durable private generation.
          const projected = projectDistilledFields(JSON.parse(String(row.distilled)), tokens, { eventId, eventRevision: [ancestorIds.length, Number(row.local_version)], legacyCandidateKey: legacyCandidateKey(ancestorIds.at(-1)!) });
          if (projected.ok) {
            page.items.push(projected.value);
            page.localLinks.push(LocalEvidenceLinkSchema.parse({ distilledId: projected.value.item.distilledId, eventId, ancestorIds, candidateId: row.local_candidate_id, sourceIds: JSON.parse(String(row.local_source_ids)) }));
          }
          else if (projected.reason === 'privacy') page.privacyRejected++; else page.schemaRejected++;
        }
        return page;
      } catch { throw new BridgeFault('source'); }
    },
    close() { if (!closed) { closed = true; database.close(); } },
  };
}
