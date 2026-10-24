import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { InstantSchema } from '../shared/contracts';
import { nowInstant } from '../domain/time';

export interface AttachmentRetentionPolicy { retentionDays: number; maxBytes: number; now?: string }
export interface AttachmentRetentionSummary {
  totalBytes: number;
  eligibleBytes: number;
  protectedBytes: number;
  reclaimableBytes: number;
  remainingBytes: number;
  selectedAttachments: number;
  protectedAttachments: number;
  overBudgetBytes: number;
}
type JsonObject = Record<string, unknown>;
type Attachment = { id: string; hash: string | null; chunks: number; payload: string };
type BatchGroup = {
  id: string; at: number; protected: boolean; attachments: Attachment[];
  savedPayload: string | null; checkpointBytes: number;
};
export interface AttachmentRetentionPlan {
  summary: AttachmentRetentionSummary;
  groups: BatchGroup[];
}
const policySchema = z.strictObject({
  retentionDays: z.number().int().min(1).max(3650),
  maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  now: InstantSchema.optional(),
});
const object = (value: unknown): JsonObject | null => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

/** Only duplicate input material is discarded; completed AI output and evidence remain intact. */
function withoutAttachmentInput(payload: string): string {
  const batch = JSON.parse(payload) as JsonObject;
  const result = object(batch.result);
  if (!result) return payload;
  const next: JsonObject = { ...result, attachmentsCleared: true };
  if (Array.isArray(result.context)) next.context = [];
  if (Array.isArray(result.units)) next.units = result.units.map(unit => {
    const value = object(unit); if (!value) return unit;
    const { text: _text, imageDataUrl: _image, ...metadata } = value;
    return metadata;
  });
  return JSON.stringify({ ...batch, result: next });
}

/** Pure plan: neither SQLite pages nor source/ledger/task records are modified. */
export function planAttachmentRetention(db: DatabaseSync, input: AttachmentRetentionPolicy): AttachmentRetentionPlan {
  const policy = policySchema.parse(input);
  const now = Date.parse(policy.now ?? nowInstant());
  const protectedMessages = new Set<string>();
  const hasPlanner = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='records'").get();
  if (hasPlanner) {
    // Keep originals while someone still needs to judge or act on them. A shared batch is
    // protected as a whole because its checkpoint cannot safely be split after the fact.
    for (const row of db.prepare(`
      SELECT DISTINCT json_extract(s.payload,'$.captureRef.messageId') AS id
      FROM records s
      WHERE s.kind='source' AND json_extract(s.payload,'$.captureRef.messageId') IS NOT NULL
        AND (json_extract(s.payload,'$.status')='processing' OR EXISTS (
          SELECT 1 FROM records c, json_each(c.payload,'$.sourceIds') source
          WHERE c.kind='candidate' AND source.value=s.id AND (
            json_extract(c.payload,'$.status')='pending'
            OR EXISTS (SELECT 1 FROM records t WHERE t.kind='task'
              AND json_extract(t.payload,'$.status')='open'
              AND (json_extract(t.payload,'$.candidateId')=c.id OR json_extract(c.payload,'$.taskId')=t.id))
            OR EXISTS (SELECT 1 FROM records e WHERE e.kind='block'
              AND json_extract(e.payload,'$.candidateId')=c.id
              AND coalesce(json_extract(e.payload,'$.completed'),0)=0
              AND julianday(coalesce(json_extract(e.payload,'$.end'),json_extract(e.payload,'$.start')))>=julianday(?))
          )
        ))`).iterate(new Date(now).toISOString())) protectedMessages.add(String(row['id']));
  }

  const blobBytes = new Map<string, number>();
  for (const row of db.prepare('SELECT hash,length(bytes) AS size FROM capture_blobs').iterate()) blobBytes.set(String(row['hash']), Number(row['size']));
  const references = new Map<string, number>();
  for (const row of db.prepare('SELECT hash,count(*) AS n FROM capture_attachments WHERE hash IS NOT NULL GROUP BY hash').iterate()) references.set(String(row['hash']), Number(row['n']));
  const groups = new Map<string, BatchGroup>();
  const protectedBatches = new Set<string>();
  for (const row of db.prepare('SELECT batch_id,message_id FROM capture_batch_messages').iterate()) {
    if (protectedMessages.has(String(row['message_id']))) protectedBatches.add(String(row['batch_id']));
  }
  let chunksTotal = 0;
  for (const row of db.prepare(`
    SELECT a.id,a.hash,a.payload,m.id AS message_id,m.imported_at,bm.batch_id,b.status,
      coalesce((SELECT sum(length(CAST(c.payload AS BLOB))) FROM capture_chunks c WHERE c.attachment_id=a.id),0) AS chunks
    FROM capture_attachments a JOIN capture_messages m ON m.id=a.message_id
    LEFT JOIN capture_batch_messages bm ON bm.message_id=m.id
    LEFT JOIN capture_batches b ON b.id=bm.batch_id
    ORDER BY m.imported_at,a.id`).iterate()) {
    const value = JSON.parse(String(row['payload'])) as JsonObject;
    const id = row['batch_id'] ? String(row['batch_id']) : `unbatched:${String(row['message_id'])}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, at: 0, protected: row['status'] !== 'applied' || protectedBatches.has(id), attachments: [], savedPayload: null, checkpointBytes: 0 };
      groups.set(id, group);
    }
    group.at = Math.max(group.at, Date.parse(String(row['imported_at'])));
    group.protected ||= protectedMessages.has(String(row['message_id'])) || !['ready', 'deleted', 'unsupported'].includes(String(value.status));
    const chunkSize = Number(row['chunks']); chunksTotal += chunkSize;
    if (row['hash'] || chunkSize > 0) group.attachments.push({ id: String(row['id']), hash: row['hash'] ? String(row['hash']) : null, chunks: chunkSize, payload: String(row['payload']) });
  }
  for (const group of groups.values()) {
    if (!group.attachments.length || group.id.startsWith('unbatched:')) continue;
    const row = db.prepare('SELECT payload FROM capture_batches WHERE id=?').get(group.id);
    if (!row) { group.protected = true; continue; }
    const payload = String(row['payload']);
    const value = JSON.parse(payload) as JsonObject;
    group.at = Math.max(group.at, Date.parse(String(value.updatedAt)));
    group.savedPayload = withoutAttachmentInput(payload);
    group.checkpointBytes = Math.max(0, bytes(payload) - bytes(group.savedPayload));
    if (!Number.isFinite(group.at)) group.protected = true;
  }
  const totalBytes = [...blobBytes.values()].reduce((sum, n) => sum + n, chunksTotal)
    + [...groups.values()].reduce((sum, group) => sum + group.checkpointBytes, 0);
  const eligible = [...groups.values()].filter(group => !group.protected && group.attachments.length).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  function release(group: BatchGroup, selectedRefs: Map<string, number>) {
    let released = 0;
    released += group.checkpointBytes;
    for (const a of group.attachments) {
      released += a.chunks;
      if (a.hash) {
        const n = (selectedRefs.get(a.hash) ?? 0) + 1; selectedRefs.set(a.hash, n);
        if (n === references.get(a.hash)) released += blobBytes.get(a.hash) ?? 0;
      }
    }
    return released;
  }
  const selected: BatchGroup[] = [];
  const selectedRefs = new Map<string, number>(), eligibleRefs = new Map<string, number>();
  let reclaimableBytes = 0, eligibleBytes = 0;
  const cutoff = now - policy.retentionDays * 86400_000;
  for (const group of eligible) {
    eligibleBytes += release(group, eligibleRefs);
    if (group.at < cutoff || totalBytes - reclaimableBytes > policy.maxBytes) {
      selected.push(group); reclaimableBytes += release(group, selectedRefs);
    }
  }
  return {
    groups: selected,
    summary: {
      totalBytes, eligibleBytes, protectedBytes: totalBytes - eligibleBytes, reclaimableBytes,
      remainingBytes: totalBytes - reclaimableBytes,
      selectedAttachments: selected.reduce((n, g) => n + g.attachments.length, 0),
      protectedAttachments: [...groups.values()].filter(g => g.protected).reduce((n, g) => n + g.attachments.length, 0),
      overBudgetBytes: Math.max(0, totalBytes - reclaimableBytes - policy.maxBytes),
    },
  };
}

/** Caller must hold an IMMEDIATE transaction so references and review status cannot change. */
export function applyAttachmentRetention(db: DatabaseSync, plan: AttachmentRetentionPlan): AttachmentRetentionSummary {
  const changedHashes = new Set<string>();
  for (const group of plan.groups) {
    for (const a of group.attachments) {
      const value = { ...JSON.parse(a.payload) as JsonObject, hash: null, locator: null, status: 'deleted', error: '附件缓存已按空间管理规则清理；消息正文与已有事项保留' };
      db.prepare('DELETE FROM capture_chunks WHERE attachment_id=?').run(a.id);
      db.prepare('UPDATE capture_attachments SET hash=NULL,payload=? WHERE id=?').run(JSON.stringify(value), a.id);
      if (a.hash) changedHashes.add(a.hash);
    }
    if (group.savedPayload) db.prepare('UPDATE capture_batches SET payload=? WHERE id=?').run(group.savedPayload, group.id);
  }
  for (const hash of changedHashes) db.prepare('DELETE FROM capture_blobs WHERE hash=? AND NOT EXISTS (SELECT 1 FROM capture_attachments WHERE hash=?)').run(hash, hash);
  return plan.summary;
}
