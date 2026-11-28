import { EntitySchemas, FOCUS_SETTING_KEYS, PlannerPatchSchema, type EntityKind, type JournalSummary, type MutationResult, type PlannerPatch, type Settings, type Snapshot } from './contracts';

export const PLANNER_SYNC_HEADER = 'X-Calendar-Sync';
export const PLANNER_SYNC_VERSION = '2';
export const plannerCollectionFields = {
  source: 'sources', candidate: 'candidates', task: 'tasks', block: 'blocks', focusSession: 'focusSessions',
  goal: 'goals', course: 'courses', courseException: 'courseExceptions', preference: 'preferences', feedback: 'feedback',
} as const satisfies Record<EntityKind, keyof Snapshot>;

/** null means a missing revision/changed stream, never permission to guess the missing data. */
export function applyPlannerPatch(snapshot: Snapshot, value: PlannerPatch): Snapshot | null {
  const patch = PlannerPatchSchema.parse(value), cursor = snapshot.cursor;
  if (!cursor || cursor.streamId !== patch.from.streamId || patch.to.streamId !== patch.from.streamId || patch.to.revision < patch.from.revision) return null;
  // Exact receipt replays and late notifications cannot roll a newer canonical state back.
  if (cursor.revision > patch.to.revision || cursor.revision === patch.to.revision && patch.from.revision !== patch.to.revision) return snapshot;
  if (cursor.revision === patch.to.revision && !patch.entities.length && !patch.settings && !patch.journal && !patch.usage) return snapshot;
  if (cursor.revision !== patch.from.revision) return null;
  const next = { ...snapshot, cursor: patch.to };
  for (const kind of Object.keys(plannerCollectionFields) as EntityKind[]) {
    const changes = patch.entities.filter(change => change.entity === kind);
    if (!changes.length) continue;
    const field = plannerCollectionFields[kind], records = new Map(snapshot[field].map(record => [record.id, record]));
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

export function omitFocusSettings(settings: Settings) {
  const result: Partial<Settings> = { ...settings };
  for (const key of FOCUS_SETTING_KEYS) delete result[key];
  return result;
}

const supportsEntry = (entry: JournalSummary) => entry.changes.every(change => change.entity !== 'focusSession');
function legacyPatch(patch: PlannerPatch) {
  return { ...patch, entities: patch.entities.filter(change => change.entity !== 'focusSession'),
    ...(patch.settings && { settings: omitFocusSettings(patch.settings) }),
    ...(patch.journal && { journal: patch.journal.filter(supportsEntry) }) };
}
function legacyMutation(result: MutationResult) {
  if (result.status === 'preview' && result.details.some(detail => detail.entity === 'focusSession')) {
    const message = '此操作涉及专注记录，请更新客户端后查看完整预览。';
    return { status: 'clarification', message, questions: [message], changes: [], conflicts: [] };
  }
  return { ...result, changes: result.changes.filter(change => change.entity !== 'focusSession'),
    conflicts: result.conflicts.filter(conflict => conflict.entity !== 'focusSession') };
}

/** Project only the wire response. Keep canonical backups, receipts and cursor revisions intact. */
export function legacyPlannerSyncResult(method: string, value: unknown, incremental = false): unknown {
  if (!value || typeof value !== 'object') return value;
  const { sync, ...result } = value as Record<string, unknown>;
  if (!result.ok || !result.data || typeof result.data !== 'object') return result;
  if (incremental && sync) result.sync = legacyPatch(sync as PlannerPatch);
  if (method === 'snapshot') {
    const { focusSessions: _focus, cursor, settings, journal, ...data } = result.data as Snapshot;
    result.data = { ...data, ...(incremental && { cursor }), settings: omitFocusSettings(settings), journal: journal.filter(supportsEntry) };
  } else if (method === 'changes' && 'patch' in result.data) {
    result.data = { ...result.data, patch: legacyPatch(result.data.patch as PlannerPatch) };
  } else if (method === 'saveSettings') {
    result.data = omitFocusSettings(result.data as Settings);
  } else if (method === 'mutate' || method === 'undo') {
    result.data = legacyMutation(result.data as MutationResult);
  } else if (method === 'command' && 'mutationResult' in result.data && result.data.mutationResult) {
    result.data = { ...result.data, mutationResult: legacyMutation(result.data.mutationResult as MutationResult) };
  }
  return result;
}
