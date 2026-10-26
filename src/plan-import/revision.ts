import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BlockSchema, GoalSchema, TaskSchema, MutationRequestSchema, type Entity, type MutationRequest, type MutationResult, type Snapshot } from '../shared/contracts';
import type { PlanFile, PlanImportRow, PlanUpdate, PlanDeletion } from '../shared/plan-import';

export type RevisionKind = 'goal' | 'task' | 'block';
const kind = z.enum(['goal', 'task', 'block']);
const revisionEntity = z.union([GoalSchema, TaskSchema, BlockSchema]);
export const RevisionReceiptSchema = z.strictObject({
  before: z.array(z.strictObject({ kind, record: revisionEntity })).max(500),
  after: z.array(z.strictObject({ kind, id: z.string(), deleted: z.boolean(), fingerprint: z.string().nullable() })).max(500),
  transactionId: z.string().optional(),
});
export type RevisionReceipt = z.infer<typeof RevisionReceiptSchema>;
export const REVISION_KEY = 'revision:group';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const revisionHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
export const revisionOperationId = (plan: PlanFile) => `plan-revision:${revisionHash(plan.planId)}`;
export const hasRevisions = (plan: PlanFile) => plan.version === 3 && Boolean(plan.updates?.length || plan.deletions?.length);
export const revisionItems = (plan: PlanFile) => [
  ...(plan.updates ?? []).map(item => ({ ...item, action: 'update' as const })),
  ...(plan.deletions ?? []).map(item => ({ ...item, action: 'delete' as const })),
];
export function revisionEntityAt(snapshot: Snapshot, type: RevisionKind, id: string): Entity | undefined {
  return (type === 'goal' ? snapshot.goals : type === 'task' ? snapshot.tasks : snapshot.blocks).find(record => record.id === id);
}
function put(snapshot: Snapshot, type: RevisionKind, id: string, value: Entity | null) {
  if (type === 'goal') snapshot.goals = [...snapshot.goals.filter(row => row.id !== id), ...(value ? [GoalSchema.parse(value)] : [])];
  if (type === 'task') snapshot.tasks = [...snapshot.tasks.filter(row => row.id !== id), ...(value ? [TaskSchema.parse(value)] : [])];
  if (type === 'block') snapshot.blocks = [...snapshot.blocks.filter(row => row.id !== id), ...(value ? [BlockSchema.parse(value)] : [])];
}
export function restoreRevisionBefore(snapshot: Snapshot, receipt: RevisionReceipt): Snapshot {
  const baseline = structuredClone(snapshot);
  for (const before of receipt.before) put(baseline, before.kind, before.record.id, before.record);
  return baseline;
}
export function revisionPatch(plan: PlanFile, item: PlanUpdate): Record<string, unknown> {
  const { resourceRefs, ...fields } = item.values;
  return { ...fields, ...(resourceRefs !== undefined ? { resources: resourceRefs.map(id => plan.resources.find(resource => resource.id === id)!) } : {}) };
}
const labels: Record<string, string> = { title: '名称', description: '说明', priority: '优先级', targetDate: '目标日期', status: '状态', color: '颜色', deadline: '截止时间', start: '开始时间', end: '结束时间', location: '地点', reminders: '提醒', resources: '资料引用' };
function display(value: unknown): string { return value == null ? '未设置' : typeof value === 'string' ? value || '空' : JSON.stringify(value); }
function intervalInRange(plan: PlanFile, record: Entity): boolean {
  if (!('start' in record)) return false;
  const lower = Date.parse(`${plan.basis!.fromDate}T00:00:00+08:00`), upper = Date.parse(`${plan.basis!.toDate}T00:00:00+08:00`) + 86_400_000;
  // Calendar's ordinary event fallback duration is thirty minutes.
  const end = record.end ? Date.parse(record.end) : Date.parse(record.start) + 30 * 60_000;
  return Date.parse(record.start) >= lower && end <= upper;
}
export function prepareRevision(plan: PlanFile, snapshot: Snapshot) {
  const rows: PlanImportRow[] = [], before: RevisionReceipt['before'] = [], projected = structuredClone(snapshot);
  const goalId = plan.basis!.goalId, tasks = snapshot.tasks.filter(task => task.goalId === goalId), taskIds = new Set(tasks.map(task => task.id));
  const deletingBlocks = new Set((plan.deletions ?? []).filter(item => item.kind === 'block').map(item => item.targetId));
  for (const item of revisionItems(plan)) {
    const record = revisionEntityAt(snapshot, item.kind, item.targetId);
    let error = !record ? '原记录已不存在，请重新导出上下文' : record.version !== item.expectedVersion ? '原记录版本已变化，请重新导出上下文' : '';
    if (!error && record) {
      const inScope = item.kind === 'goal' ? item.targetId === goalId : item.kind === 'task' ? taskIds.has(item.targetId) : snapshot.blocks.some(block => block.id === item.targetId && block.taskId && taskIds.has(block.taskId));
      if (!inScope) error = '修订对象不属于导出的目标';
      else if (item.kind === 'block' && 'recurrence' in record) {
        if (record.recurrence || record.completed || record.cancelled) error = '重复、已完成或已取消的时段请在日历中明确处理，不能通过计划修订';
        else if (!intervalInRange(plan, record)) error = '原时段超出导出日期范围，请重新导出更大的范围';
      } else if (item.kind === 'task' && item.action === 'delete') {
        const task = snapshot.tasks.find(value => value.id === item.targetId)!;
        if (task.status === 'done') error = '已完成任务不能通过计划修订删除';
        else if (task.candidateId || snapshot.candidates.some(candidate => candidate.taskId === task.id)) error = '该任务关联通知，删除可能改变通知记录，请在应用中处理';
        else if (snapshot.blocks.some(block => block.taskId === task.id && !deletingBlocks.has(block.id))) error = '删除任务前必须在删除清单中明确列出它的全部关联时段';
      }
    }
    let next: Entity | null = record ?? null;
    const patch = item.action === 'update' ? revisionPatch(plan, item) : null;
    if (!error && record && patch) {
      const schema = item.kind === 'goal' ? GoalSchema : item.kind === 'task' ? TaskSchema : BlockSchema;
      const checked = schema.safeParse({ ...record, ...patch, version: record.version + 1 });
      if (!checked.success) error = `修改后的记录无效：${checked.error.issues[0]?.message ?? '请核对字段'}`;
      else { next = checked.data; if (item.kind === 'block' && !intervalInRange(plan, next)) error = '修改后的时段超出导出日期范围'; }
    }
    if (!error && record) {
      before.push({ kind: item.kind, record: revisionEntity.parse(record) });
      put(projected, item.kind, item.targetId, item.action === 'delete' ? null : next);
    }
    const changes = patch ? Object.entries(patch).map(([field, after]) => ({ field: labels[field] ?? field, before: display(record && (record as unknown as Record<string, unknown>)[field]), after: display(after) }))
      : [{ field: '删除记录', before: record && 'title' in record ? record.title : item.targetId, after: '删除；未列出的记录保留' }];
    rows.push({ kind: item.kind, localId: item.id, existingId: item.targetId, action: item.action, title: record && 'title' in record ? record.title : item.targetId,
      state: error ? 'blocked' : item.action, detail: error || (item.action === 'update' ? '按真实编号修改；未提供的字段、完成状态及关联保留' : '明确删除此记录'), changes,
      ...(record && 'start' in record ? { start: record.start, ...(record.end ? { end: record.end } : {}) } : {}) });
  }
  return { rows, before, projected };
}
export function revisionRequest(plan: PlanFile): MutationRequest {
  const deletions = [...(plan.deletions ?? [])].sort((a, b) => Number(a.kind === 'task') - Number(b.kind === 'task'));
  return MutationRequestSchema.parse({ operationId: revisionOperationId(plan), origin: 'manual', mutations: [
    ...deletions.map(item => ({ type: 'delete', entity: item.kind, id: item.targetId, expectedVersion: item.expectedVersion })),
    ...(plan.updates ?? []).map(item => ({ type: 'update', entity: item.kind, id: item.targetId, expectedVersion: item.expectedVersion, values: revisionPatch(plan, item) })),
  ] });
}
export function revisionChangesMatch(plan: PlanFile, changes: MutationResult['changes']): boolean {
  const expected = revisionItems(plan);
  return changes.length === expected.length && expected.every(item => changes.filter(change => change.entity === item.kind && change.id === item.targetId && change.action === item.action
    && change.beforeVersion === item.expectedVersion && change.afterVersion === (item.action === 'delete' ? null : item.expectedVersion + 1)).length === 1);
}
export function revisionAfterMatches(plan: PlanFile, item: PlanUpdate | PlanDeletion, before: Entity, after: Entity | undefined | null): boolean {
  if (!('values' in item)) return !after;
  if (!after) return false;
  const expected = { ...before, ...revisionPatch(plan, item), version: before.version + 1, updatedAt: after.updatedAt };
  return revisionHash(after) === revisionHash(expected);
}
export function safeRevisionPreview(plan: PlanFile, receipt: RevisionReceipt, result: Extract<MutationResult, { status: 'preview' }>, request: MutationRequest): boolean {
  if (revisionHash({ operationId: request.operationId, mutations: request.mutations }) !== revisionHash({ operationId: result.proposedRequest.operationId, mutations: result.proposedRequest.mutations }) || !revisionChangesMatch(plan, result.changes)) return false;
  const items = revisionItems(plan);
  return result.details.length === items.length && items.every(item => {
    const detail = result.details.find(value => value.entity === item.kind && value.id === item.targetId), before = receipt.before.find(value => value.kind === item.kind && value.record.id === item.targetId)?.record;
    return before && detail && revisionHash(detail.before) === revisionHash(before) && revisionAfterMatches(plan, item, before, detail.after);
  });
}
export function recordRevisionAfter(plan: PlanFile, receipt: RevisionReceipt, snapshot: Snapshot, transactionId: string): RevisionReceipt {
  return { ...receipt, transactionId, after: revisionItems(plan).map(item => {
    const record = revisionEntityAt(snapshot, item.kind, item.targetId), before = receipt.before.find(value => value.kind === item.kind && value.record.id === item.targetId)!.record;
    return { kind: item.kind, id: item.targetId, deleted: item.action === 'delete', fingerprint: revisionAfterMatches(plan, item, before, record) && record ? revisionHash(record) : null };
  }) };
}
export function revisionReceiptValid(plan: PlanFile, receipt: RevisionReceipt, snapshot: Snapshot): boolean {
  const items = revisionItems(plan);
  if (!receipt.transactionId || receipt.after.length !== items.length || receipt.before.length !== items.length) return false;
  const journal = snapshot.journal.find(row => row.operationId === revisionOperationId(plan));
  if (journal && (journal.id !== receipt.transactionId || journal.undoneAt || !revisionChangesMatch(plan, journal.changes))) return false;
  return items.every(item => {
    const after = receipt.after.find(value => value.kind === item.kind && value.id === item.targetId), current = revisionEntityAt(snapshot, item.kind, item.targetId);
    return after && after.deleted === (item.action === 'delete') && (after.deleted ? !current : Boolean(current && after.fingerprint && revisionHash(current) === after.fingerprint));
  });
}
