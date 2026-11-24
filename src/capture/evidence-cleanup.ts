import type { DatabaseSync } from 'node:sqlite';
import type { Source } from '../shared/contracts';
import { clearedCaptureSource } from '../shared/capture-evidence';
import { privateOperationFingerprint } from '../storage/operation-fingerprint';
import { createPlannerChangeLog } from '../storage/planner-sync';
import type { StoredState } from '../storage/repository';

export interface DeletedCaptureEvidence { messages: Set<string>; attachments: Set<string> }
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasTable = (db: DatabaseSync, table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

export function deletedCaptureEvidence(db: DatabaseSync): DeletedCaptureEvidence {
  const ids = (sql: string) => new Set([...db.prepare(sql).iterate()].map(row => String(row.id)));
  return {
    messages: ids('SELECT id FROM capture_messages WHERE deleted=1'),
    attachments: ids("SELECT id FROM capture_attachments WHERE json_extract(payload,'$.status')='deleted'"),
  };
}

function visit(value: unknown, examine: (record: JsonObject) => void) {
  if (Array.isArray(value)) { for (const entry of value) visit(entry, examine); }
  else if (object(value)) {
    examine(value);
    for (const child of Object.values(value)) if (typeof child === 'object') visit(child, examine);
  }
}

/** Discover old source snapshots as well as live ones. Deleted sources may only exist in undo/receipts. */
function evidenceCleaner(deleted: DeletedCaptureEvidence, remainingText: (id: string) => string | undefined) {
  const clearedIds = new Map<string, Set<string>>();
  function selected(row: JsonObject) {
    const ref = row.captureRef;
    return object(ref) && (typeof ref.messageId === 'string' && deleted.messages.has(ref.messageId) ||
      typeof ref.attachmentId === 'string' && deleted.attachments.has(ref.attachmentId));
  }
  function discover(value: unknown) {
    visit(value, row => {
      if (typeof row.id !== 'string' || typeof row.text !== 'string' || !selected(row)) return;
      const originals = clearedIds.get(row.id) ?? new Set<string>();
      if (object(row.captureRef) && !row.captureRef.cleared) originals.add(row.text);
      clearedIds.set(row.id, originals);
    });
  }
  function referencesErasedSource(value: unknown) {
    let found = false;
    visit(value, row => {
      if (selected(row) || typeof row.sourceId === 'string' && clearedIds.has(row.sourceId) ||
          Array.isArray(row.sourceIds) && row.sourceIds.some(id => clearedIds.has(id)) ||
          row.entity === 'source' && typeof row.id === 'string' && clearedIds.has(row.id)) found = true;
    });
    return found;
  }
  function inputReferencesErasedSource(serialized: string) {
    try { return referencesErasedSource(JSON.parse(serialized)); }
    catch { return false; } // An opaque legacy fingerprint is not necessarily JSON.
  }
  function clean(value: unknown): boolean {
    let changed = false;
    visit(value, row => {
      if (object(row.captureRef) && typeof row.text === 'string' && selected(row)) {
        const next = clearedCaptureSource(row as unknown as Source);
        if (row.text !== next.text || row.kind !== next.kind || row.imageDataUrl !== null || row.error !== null ||
            row.label !== next.label || row.captureRef.locator !== next.captureRef!.locator ||
            row.captureRef.transcribed !== false || row.captureRef.cleared !== true) {
          Object.assign(row, next); changed = true;
        }
        return;
      }
      if (!Array.isArray(row.sourceIds) || !row.sourceIds.some(id => clearedIds.has(id))) return;
      const sourceIds = row.sourceIds as string[];
      const cleared = sourceIds.filter(id => clearedIds.has(id)), remaining = sourceIds.filter(id => !clearedIds.has(id));
      const eraseQuote = (quote: unknown) => typeof quote === 'string' && quote.length > 0 && (!remaining.length ||
        cleared.some(id => [...clearedIds.get(id)!].some(text => text.includes(quote))) && !remaining.some(id => remainingText(id)?.includes(quote)));
      if (eraseQuote(row.sourceQuote)) { row.sourceQuote = ''; changed = true; }
      if (Array.isArray(row.temporalEvidence)) {
        const kept = row.temporalEvidence.filter(item => !object(item) || !eraseQuote(item.quote));
        if (kept.length !== row.temporalEvidence.length) { row.temporalEvidence = kept; changed = true; }
      }
    });
    // Inspect the request separately: even an ID-only result may have a verbatim legacy input.
    if (object(value) && object(value.result) && typeof value.fingerprint === 'string' && value.fingerprint.startsWith('{')) {
      if (changed || referencesErasedSource(value.result) || inputReferencesErasedSource(value.fingerprint)) {
        value.fingerprint = privateOperationFingerprint(value.fingerprint);
        changed = true;
      }
    }
    return changed;
  }
  return { discover, clean };
}

/** A restored legacy backup is cleaned according to its own tombstones before it becomes visible. */
export function cleanRestoredEvidence(state: StoredState, deleted: DeletedCaptureEvidence) {
  if (!deleted.messages.size && !deleted.attachments.size) return;
  const sources = new Map((state.entities.source as Source[]).map(source => [source.id, source.text]));
  const cleaner = evidenceCleaner(deleted, id => sources.get(id));
  for (const row of [...state.entities.source, ...state.journal, ...state.operations]) cleaner.discover(row);
  for (const row of [...state.entities.source, ...state.entities.candidate, ...state.journal, ...state.operations]) cleaner.clean(row);
}

/** An applied batch is already committed to planner records. Its cached answer is never resumed. */
export function cleanCompletedCaptureInputs(db: DatabaseSync, deleted: DeletedCaptureEvidence) {
  if ((!deleted.messages.size && !deleted.attachments.size) || !hasTable(db, 'capture_batches')) return;
  const attachmentOwners = new Set<string>();
  const owner = db.prepare('SELECT message_id FROM capture_attachments WHERE id=?');
  for (const id of deleted.attachments) {
    const row = owner.get(id);
    if (row) attachmentOwners.add(String(row.message_id));
  }
  const update = db.prepare('UPDATE capture_batches SET payload=? WHERE id=?');
  for (const row of db.prepare("SELECT id,payload FROM capture_batches WHERE status='applied' AND instr(payload,'\"context\"')+instr(payload,'\"units\"')>0").iterate()) {
    const batch = JSON.parse(String(row.payload)) as JsonObject, result = batch.result;
    if (!object(result)) continue;
    const ownsMessage = Array.isArray(batch.messageIds) && batch.messageIds.some(id => deleted.messages.has(id));
    let changed = false;
    if (ownsMessage) {
      batch.result = { cleaned: true };
      update.run(JSON.stringify(batch), row.id!);
      continue;
    }
    const retiredUnits = new Set<string>();
    visit(result.units, unit => {
      if (typeof unit.id !== 'string' || typeof unit.attachmentId !== 'string' || !deleted.attachments.has(unit.attachmentId)) return;
      retiredUnits.add(unit.id);
      for (const key of ['text', 'imageDataUrl']) if (key in unit) { delete unit[key]; changed = true; }
    });
    if (retiredUnits.size) {
      if (result.attachmentsCleared !== true) { result.attachmentsCleared = true; changed = true; }
      visit(result.completed, entry => {
        // Extraction validates quotes and temporal evidence against the primary unit.
        if (Array.isArray(entry.sourceIds) && entry.sourceIds.length && entry.sourceIds.every(id => retiredUnits.has(id))) {
          if (entry.sourceQuote) { entry.sourceQuote = ''; changed = true; }
          if (Array.isArray(entry.temporalEvidence) && entry.temporalEvidence.length) { entry.temporalEvidence = []; changed = true; }
        }
        if (typeof entry.sourceId === 'string' && retiredUnits.has(entry.sourceId) && entry.quote) { entry.quote = ''; changed = true; }
      });
    }
    if (Array.isArray(result.context)) {
      result.context = result.context.filter(item => {
        if (!object(item) || typeof item.id !== 'string') return true;
        if (deleted.messages.has(item.id)) { changed = true; return false; }
        // Historical context identifies attachments by their owner message, not by attachment ID.
        // Retention retires the whole eligible batch, including every cached attachment of this owner.
        if (attachmentOwners.has(item.id) && item.attachments) { delete item.attachments; changed = true; }
        return true;
      });
    }
    if (changed) update.run(JSON.stringify(batch), row.id!);
  }
}

/** Capture and planner use the same DB file. Caller holds BEGIN IMMEDIATE across all erasures. */
export function cleanStoredEvidence(db: DatabaseSync, deleted: DeletedCaptureEvidence) {
  cleanCompletedCaptureInputs(db, deleted);
  if ((!deleted.messages.size && !deleted.attachments.size) || !hasTable(db, 'records')) return;
  const sourceText = db.prepare("SELECT json_extract(payload,'$.text') AS text FROM records WHERE kind='source' AND id=?");
  const cleaner = evidenceCleaner(deleted, id => sourceText.get(id)?.text as string | undefined);
  const tables = (['records', 'operations', 'journal', 'planner_sync_log'] as const).filter(table => hasTable(db, table));
  const records = (table: typeof tables[number], evidence: boolean) => {
    const where = table === 'records' ? evidence ? "kind='source'" : "kind IN ('source','candidate')" :
      evidence ? "instr(payload,'\"captureRef\"')>0" : "(instr(payload,'\"captureRef\"')>0 OR instr(payload,'\"sourceIds\"')>0)";
    const rawInputs = table === 'operations' && !evidence ? " OR substr(json_extract(payload,'$.fingerprint'),1,1)='{'" : '';
    return db.prepare(`SELECT rowid AS position,payload FROM ${table} WHERE ${where}${rawInputs}`).iterate();
  };
  for (const table of tables) for (const row of records(table, true)) cleaner.discover(JSON.parse(String(row.payload)));
  let changed = false;
  for (const table of tables) {
    const update = db.prepare(`UPDATE ${table} SET payload=? WHERE rowid=?`);
    for (const row of records(table, false)) {
      const value: unknown = JSON.parse(String(row.payload));
      if (!cleaner.clean(value)) continue;
      changed = true;
      // Old patches can contain the original even if the live source was deleted. Reset after this scan.
      if (table === 'planner_sync_log') break;
      update.run(JSON.stringify(value), row.position!);
    }
  }
  if (changed && tables.includes('planner_sync_log')) createPlannerChangeLog(db).reset();
}
