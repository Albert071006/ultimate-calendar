import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { EntitySchemas, EntityKindSchema, EntitySchema, PreviewDetailSchema, JournalSummarySchema, MutationResultSchema, SnapshotSchema, SettingsSchema, TokenUsageSchema, ReminderSchema, InstantSchema, IdSchema, type EntityKind, type Entity, type EntityMap, type Snapshot, type PreviewDetail, type SettingsInput, type TokenUsage, type Reminder } from '../shared/contracts';
import { WorkflowReceiptSchema } from '../shared/contracts';
import { openDatabase, initializeDatabase } from './database';
import { nowInstant } from '../domain/time';
import { validateRelationships } from '../domain/validation';
import { automaticBackup } from './backups';
import { normalizeLegacyRecurringSeries } from './legacy-recurring-series';
import { describeJournal } from '../domain/journal-description';
import { assignMissingColors } from '../domain/palette';

const CancellationUndoBaselineSchema = z.array(z.strictObject({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  witnesses: z.array(z.strictObject({ entity: z.enum(['block', 'course']), id: IdSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })).length(2),
}));
const JournalSchema = JournalSummarySchema.extend({ details: z.array(PreviewDetailSchema), undoExpected: z.array(PreviewDetailSchema).optional(), cancellationUndoBaseline: CancellationUndoBaselineSchema.optional() });
const OperationResultSchema = z.union([MutationResultSchema, z.strictObject({ entities: z.array(EntitySchema) }), WorkflowReceiptSchema]);
const StateSchema = z.strictObject({ schemaVersion: z.literal(1), entities: z.record(EntityKindSchema, z.array(EntitySchema)), settings: SettingsSchema,
  journal: z.array(JournalSchema), operations: z.array(z.strictObject({ id: IdSchema, fingerprint: z.string(), result: OperationResultSchema })),
  usage: z.array(TokenUsageSchema), receipts: z.array(z.string()), lastBackupAt: InstantSchema.nullable() });
export type StoredState = z.infer<typeof StateSchema>;
export const kinds = Object.keys(EntitySchemas) as EntityKind[];
export function emptyState(): StoredState { return { schemaVersion: 1, entities: Object.fromEntries(kinds.map(k => [k, []])) as unknown as StoredState['entities'], settings: SettingsSchema.parse({}), journal: [], operations: [], usage: [], receipts: [], lastBackupAt: null }; }
export function parseState(value: unknown): StoredState {
  const state = StateSchema.parse(value);
  for (const kind of kinds) {
    state.entities[kind] = state.entities[kind].map(record => EntitySchemas[kind].parse(record));
    if (new Set(state.entities[kind].map(e => e.id)).size !== state.entities[kind].length) throw Error('重复记录 ID');
  }
  normalizeLegacyRecurringSeries(state);
  for (const journal of state.journal) for (const detail of [...journal.details, ...(journal.undoExpected ?? [])]) {
    for (const value of [detail.before, detail.after]) if (value) { EntitySchemas[detail.entity].parse(value); if (value.id !== detail.id) throw Error('撤销记录 ID 不匹配'); }
  }
  for (const list of [state.journal, state.operations, state.usage]) if (new Set(list.map(item => item.id)).size !== list.length) throw Error('内部记录 ID 重复');
  validateRelationships(state, false); return state;
}
export function records<K extends EntityKind>(state: StoredState, kind: K): EntityMap[K][] { return state.entities[kind] as EntityMap[K][]; }
export function findEntity<K extends EntityKind>(state: StoredState, kind: K, id: string): EntityMap[K] | undefined { return records(state, kind).find(e => e.id === id); }
export function putEntity(state: StoredState, kind: EntityKind, record: Entity) { const list = state.entities[kind]; const i = list.findIndex(e => e.id === record.id); if (i < 0) list.push(record); else list[i] = record; }
export function deleteEntity(state: StoredState, kind: EntityKind, id: string) { state.entities[kind] = state.entities[kind].filter(e => e.id !== id); }
export function newEntity(state: StoredState, kind: EntityKind, values: unknown): Entity {
  const at = nowInstant(); const record = EntitySchemas[kind].parse({ ...(values as object), id: randomUUID(), version: 1, createdAt: at, updatedAt: at }); putEntity(state, kind, record); return record;
}
export function updateEntity(state: StoredState, kind: EntityKind, id: string, values: unknown): Entity {
  const old = findEntity(state, kind, id); if (!old) throw Error(`记录不存在：${kind}/${id}`);
  const next = EntitySchemas[kind].parse({ ...old, ...(values as object), id, version: old.version + 1, createdAt: old.createdAt, updatedAt: nowInstant() }); putEntity(state, kind, next); return next;
}
export function stateSnapshot(state: StoredState): Snapshot {
  return SnapshotSchema.parse({ schemaVersion: 1, sources: state.entities.source, candidates: state.entities.candidate, tasks: state.entities.task, blocks: state.entities.block, goals: state.entities.goal, courses: state.entities.course, courseExceptions: state.entities.courseException, preferences: state.entities.preference, feedback: state.entities.feedback, settings: state.settings, journal: state.journal.slice().reverse().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 100).map(({ details, undoExpected: _expected, cancellationUndoBaseline: _cancelBaseline, ...summary }) => ({ ...summary, ...describeJournal({ ...summary, details }) })), tokenUsage: state.usage, keyStatus: { configured: false, sessionOnly: false } });
}
export function diffStates(before: StoredState, after: StoredState): PreviewDetail[] {
  return kinds.flatMap(entity => [...new Set([...before.entities[entity], ...after.entities[entity]].map(e => e.id))].flatMap(id => {
    const old = findEntity(before, entity, id) ?? null; const next = findEntity(after, entity, id) ?? null;
    return JSON.stringify(old) === JSON.stringify(next) ? [] : [{ entity, id, before: old, after: next }];
  }));
}
export function summarize(details: PreviewDetail[]) { return details.map(d => { const record = d.after ?? d.before; return { entity: d.entity, id: d.id, action: d.before === null ? 'create' as const : d.after === null ? 'delete' as const : 'update' as const, beforeVersion: d.before?.version ?? null, afterVersion: d.after?.version ?? null, title: record && 'title' in record ? record.title : '' }; }); }

/** Table names are fixed internal constants; all external values use prepared parameters. */
const tables = ['settings', 'journal', 'operations', 'usage', 'receipts', 'metadata'] as const;
function tableEntries(state: StoredState, table: typeof tables[number]): [string, unknown][] {
  switch (table) {
    case 'settings': return [['settings', state.settings]];
    case 'journal': return state.journal.map(j => [j.id, j]);
    case 'operations': return state.operations.map(o => [o.id, o]);
    case 'usage': return state.usage.map(u => [u.id, u]);
    case 'receipts': return state.receipts.map(id => [id, true]);
    case 'metadata': return [['schemaVersion', state.schemaVersion], ['lastBackupAt', state.lastBackupAt]];
  }
}
export function readDatabaseState(db: DatabaseSync): StoredState {
  const state = emptyState();
  for (const row of db.prepare('SELECT kind,id,payload FROM records ORDER BY rowid').all()) { const kind = EntityKindSchema.parse(row['kind']); const record = EntitySchemas[kind].parse(JSON.parse(row['payload'] as string)); if (record.id !== row['id']) throw Error('存储记录 ID 不匹配'); state.entities[kind].push(record); }
  const data = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT id,payload FROM ${table} ORDER BY rowid`).all().map(row => [row['id'] as string, JSON.parse(row['payload'] as string)] as [string, unknown])])) as Record<typeof tables[number], [string, unknown][]>;
  if (data.settings.length !== 1 || data.settings[0]![0] !== 'settings' || data.metadata.length !== 2 || data.metadata.some(([id]) => !['schemaVersion', 'lastBackupAt'].includes(id))) throw Error('存储配置或元数据无效');
  for (const table of ['journal', 'operations', 'usage'] as const) for (const [id, value] of data[table]) if (!value || typeof value !== 'object' || !('id' in value) || value.id !== id) throw Error('内部记录 ID 不匹配');
  if (data.receipts.some(([, value]) => value !== true)) throw Error('提醒记录无效');
  state.settings = SettingsSchema.parse(data.settings.find(([id]) => id === 'settings')?.[1]);
  state.journal = data.journal.map(([, value]) => JournalSchema.parse(value)); state.operations = data.operations.map(([, value]) => StateSchema.shape.operations.element.parse(value));
  state.usage = data.usage.map(([, value]) => TokenUsageSchema.parse(value)); state.receipts = data.receipts.map(([id]) => id);
  state.schemaVersion = z.literal(1).parse(data.metadata.find(([id]) => id === 'schemaVersion')?.[1]);
  state.lastBackupAt = InstantSchema.nullable().parse(data.metadata.find(([id]) => id === 'lastBackupAt')?.[1]); return parseState(state);
}
function persistDiff(db: DatabaseSync, before: StoredState, after: StoredState) {
  for (const d of diffStates(before, after)) {
    if (d.after) db.prepare('INSERT INTO records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(d.entity, d.id, JSON.stringify(d.after));
    else db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(d.entity, d.id);
  }
  for (const table of tables) {
    const old = new Map(tableEntries(before, table).map(([id, value]) => [id, JSON.stringify(value)])); const next = new Map(tableEntries(after, table).map(([id, value]) => [id, JSON.stringify(value)]));
    for (const [id, payload] of next) if (old.get(id) !== payload) db.prepare(`INSERT INTO ${table}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(id, payload);
    for (const id of old.keys()) if (!next.has(id)) db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  }
}

export interface InternalChange { entity: EntityKind; id?: string; expectedVersion?: number; values?: unknown; delete?: boolean }
export interface Repository {
  readonly path: string;
  read(): StoredState;
  snapshot(): Snapshot;
  transact<T>(work: (state: StoredState) => T): T;
  writeInternal(request: { operationId: string; changes: InternalChange[]; usage?: TokenUsage; journal?: boolean }): { entities: Entity[] };
  saveSettings(settings: SettingsInput): Snapshot['settings'];
  addUsage(usage: TokenUsage): void;
  claimReminders(reminders: Reminder[]): Reminder[];
  close(): void;
  vacuumInto(path: string): void;
  estimatedBackupBytes(): number;
  /** Internal database callback shares the planner transaction; never exposed to renderer IPC. */
  replaceState(state: StoredState, inTransaction?: (db: DatabaseSync) => void): void;
}
export function createRepository(path: string, options: { automaticBackup?(repository: Repository): void } = {}): Repository {
  const backup = options.automaticBackup ?? automaticBackup;
  const db = openDatabase(path); let closed = false;
  try { initializeDatabase(db, () => initializeDefaults(db)); } catch (error) { db.close(); throw error; }
  const read = () => readDatabaseState(db);
  const repository: Repository = {
    path, read, snapshot: () => stateSnapshot(read()),
    transact(work) {
      db.exec('BEGIN IMMEDIATE'); let result;
      try { const state = read(); const before = structuredClone(state); result = work(state); assignMissingColors(state, nowInstant().slice(0, 10)); parseState(state); persistDiff(db, before, state); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      return result;
    },
    writeInternal(request) {
      const fingerprint = JSON.stringify(request); const result = repository.transact(state => {
        const previous = state.operations.find(o => o.id === request.operationId); if (previous) { if (previous.fingerprint !== fingerprint) throw Error('operationId 已用于不同操作'); return previous.result as { entities: Entity[] }; }
        const before = structuredClone(state); const entities: Entity[] = [];
        for (const change of request.changes) {
          if (change.id) { const old = findEntity(state, change.entity, change.id); if (!old || old.version !== change.expectedVersion) throw Error('记录不存在或版本已改变');
            if (change.delete) deleteEntity(state, change.entity, change.id); else entities.push(updateEntity(state, change.entity, change.id, change.values));
          } else entities.push(newEntity(state, change.entity, change.values));
        }
        validateRelationships(state, true, before);
        if (request.usage) state.usage.push(TokenUsageSchema.parse(request.usage));
        const details = diffStates(before, state); if (details.length && request.journal) state.journal.push({ id: randomUUID(), operationId: request.operationId, createdAt: nowInstant(), origin: 'manual', message: '保存导入数据', changes: summarize(details), details, undoneAt: null, undoable: true });
        const result = { entities }; state.operations.push({ id: request.operationId, fingerprint, result }); return result;
      }); backup(repository); return result;
    },
    saveSettings(value) { const settings = SettingsSchema.parse(value); repository.transact(state => { state.settings = settings; }); backup(repository); return settings; },
    addUsage(value) { const usage = TokenUsageSchema.parse(value); repository.transact(state => { if (!state.usage.some(u => u.operationId === usage.operationId)) state.usage.push(usage); }); backup(repository); },
    claimReminders(values) { const reminders = values.map(r => ReminderSchema.parse(r)); return repository.transact(state => { const fresh = reminders.filter(r => !state.receipts.includes(r.id)); state.receipts.push(...fresh.map(r => r.id)); return fresh; }); },
    close() { if (!closed) { db.close(); closed = true; } },
    vacuumInto(target) { db.prepare('VACUUM INTO ?').run(target); },
    estimatedBackupBytes() {
      const pages = Number(db.prepare('PRAGMA page_count').get()!['page_count']);
      const free = Number(db.prepare('PRAGMA freelist_count').get()!['freelist_count']);
      const size = Number(db.prepare('PRAGMA page_size').get()!['page_size']);
      return Math.max(0, pages - free) * size;
    },
    replaceState(value, inTransaction) { const state = parseState(value); repository.transact(live => { Object.assign(live, state); inTransaction?.(db); }); },
  };
  // Fail on corrupt/future/incompatible persisted records before returning a usable repository.
  // Records saved before belonging colors existed receive theirs once, durably, at open.
  try { read(); repository.transact(() => undefined); return repository; } catch (error) { db.close(); throw error; }
}

/** Recover old interrupted bootstrap only when no user/history data or custom settings exist. */
function initializeDefaults(db: DatabaseSync): void {
  try { readDatabaseState(db); return; } catch (originalError) {
    const plannerTables = ['records', ...tables];
    const unknownTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().some(row => !plannerTables.includes(row['name'] as typeof plannerTables[number]));
    if (unknownTables || ['records', 'journal', 'operations', 'usage', 'receipts'].some(table => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) throw originalError;
    const defaults = emptyState();
    const savedSettings = db.prepare('SELECT id,payload FROM settings').all();
    if (savedSettings.length > 1 || savedSettings.some(row => row['id'] !== 'settings' || JSON.stringify(SettingsSchema.parse(JSON.parse(row['payload'] as string))) !== JSON.stringify(defaults.settings))) throw originalError;
    const savedMetadata = db.prepare('SELECT id,payload FROM metadata').all();
    const metadata = new Map(tableEntries(defaults, 'metadata').map(([id, value]) => [id, JSON.stringify(value)]));
    if (savedMetadata.some(row => !metadata.has(row['id'] as string) || row['payload'] !== metadata.get(row['id'] as string))) throw originalError;
    // Existing recognized defaults are retained; only missing rows are filled atomically.
    for (const table of ['settings', 'metadata'] as const) {
      const existing = new Set((table === 'settings' ? savedSettings : savedMetadata).map(row => row['id']));
      for (const [id, value] of tableEntries(defaults, table)) if (!existing.has(id)) db.prepare(`INSERT INTO ${table}(id,payload) VALUES(?,?)`).run(id, JSON.stringify(value));
    }
    readDatabaseState(db);
  }
}
