import { EntitySchemas, PlannerPatchSchema, type PlannerPatch, type Snapshot } from './contracts';

export const PLANNER_SYNC_HEADER = 'X-Calendar-Sync';
export const PLANNER_SYNC_VERSION = '1';
const fields = { source: 'sources', candidate: 'candidates', task: 'tasks', block: 'blocks', goal: 'goals', course: 'courses', courseException: 'courseExceptions', preference: 'preferences', feedback: 'feedback' } as const;

/** null means a missing revision/changed stream, never permission to guess the missing data. */
export function applyPlannerPatch(snapshot: Snapshot, value: PlannerPatch): Snapshot | null {
  const patch = PlannerPatchSchema.parse(value), cursor = snapshot.cursor;
  if (!cursor || cursor.streamId !== patch.from.streamId || patch.to.streamId !== patch.from.streamId || patch.to.revision < patch.from.revision) return null;
  // Exact receipt replays and late notifications cannot roll a newer canonical state back.
  if (cursor.revision > patch.to.revision || cursor.revision === patch.to.revision && patch.from.revision !== patch.to.revision) return snapshot;
  if (cursor.revision === patch.to.revision && !patch.entities.length && !patch.settings && !patch.journal && !patch.usage) return snapshot;
  if (cursor.revision !== patch.from.revision) return null;
  const next = { ...snapshot, cursor: patch.to };
  for (const kind of Object.keys(fields) as (keyof typeof fields)[]) {
    const changes = patch.entities.filter(change => change.entity === kind);
    if (!changes.length) continue;
    const field = fields[kind], records = new Map(snapshot[field].map(record => [record.id, record]));
    for (const change of changes) {
      if (change.value === null) records.delete(change.id);
      else {
        const record = EntitySchemas[kind].parse(change.value);
        if (record.id !== change.id) throw Error('增量记录身份不一致');
        records.set(change.id, record);
      }
    }
    Object.assign(next, { [field]: [...records.values()] });
  }
  if (patch.settings) next.settings = patch.settings;
  if (patch.journal) next.journal = patch.journal;
  if (patch.usage) {
    const usage = new Map(snapshot.tokenUsage.map(record => [record.id, record]));
    for (const id of patch.usage.deletedIds) usage.delete(id);
    for (const record of patch.usage.upserts) usage.set(record.id, record);
    next.tokenUsage = [...usage.values()];
  }
  return next;
}

/** Old strict clients retain their original response shapes during staged upgrades. */
export function legacyPlannerSyncResult(method: string, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const { sync: _sync, ...result } = value as Record<string, unknown>;
  if (method === 'snapshot' && result.ok && result.data && typeof result.data === 'object') {
    const { cursor: _cursor, ...data } = result.data as Record<string, unknown>;
    result.data = data;
  }
  return result;
}
