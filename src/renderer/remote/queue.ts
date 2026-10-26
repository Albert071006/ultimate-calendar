import { BlockSchema, InstantSchema, MutationRequestSchema, TaskSchema, type MutationRequestInput, type Snapshot, type Task } from '../../shared/contracts';
import { LedgerMutationRequestSchema, type LedgerMutationRequest } from '../../shared/ledger';
import type { RemoteMethod } from '../../shared/remote';
import type { OfflinePartition, PendingWrite } from './types';

export const localId = (item: Pick<PendingWrite, 'id'>, index: number) => 'local:' + item.id + ':' + index;
export const instant = (at = Date.now()) => new Date(at + 8 * 3600000).toISOString().replace('Z', '+08:00');

const plainTask = (task: Task) => task.candidateId === null && task.goalId === null && task.courseId === null;
const sameAssociation = (values: object, record: object, keys: string[]) => keys.every(key =>
  !Object.hasOwn(values, key) || Reflect.get(values, key) === Reflect.get(record, key));

/** Evaluate the whole batch before using any projection. A stale or unsupported member rejects the batch. */
function applyOfflineMutations(input: unknown, baseline: Snapshot, idFor: (index: number) => string, at: string): Snapshot | null {
  const parsed = MutationRequestSchema.safeParse(input);
  if (!parsed.success || parsed.data.confirmed || parsed.data.confirmationToken !== undefined || parsed.data.origin !== 'manual' || !InstantSchema.safeParse(at).success) return null;
  const snapshot = structuredClone(baseline);
  for (const [index, change] of parsed.data.mutations.entries()) {
    if (change.type === 'create' && change.entity === 'task') {
      if (change.values.candidateId || change.values.goalId || change.values.courseId) return null;
      const task = TaskSchema.safeParse({ ...change.values, id: idFor(index), version: 1, createdAt: at, updatedAt: at });
      if (!task.success || snapshot.tasks.some(value => value.id === task.data.id)) return null;
      snapshot.tasks.push(task.data);
    } else if (change.type === 'create' && change.entity === 'block') {
      // A basic block may refer to a cached/local ordinary task, never candidate or series provenance.
      if (change.values.taskId && !snapshot.tasks.some(task => task.id === change.values.taskId && plainTask(task) && task.status === 'open')) return null;
      const block = BlockSchema.safeParse({ ...change.values, id: idFor(index), version: 1, createdAt: at, updatedAt: at });
      if (!block.success || block.data.recurrence || block.data.cancelled || snapshot.blocks.some(value => value.id === block.data.id)) return null;
      snapshot.blocks.push(block.data);
    } else if ((change.type === 'update' && change.entity === 'task') || change.type === 'finishTask') {
      const index = snapshot.tasks.findIndex(task => task.id === change.id); const old = snapshot.tasks[index];
      if (!old || old.version !== change.expectedVersion) return null;
      if (change.type === 'update' && !sameAssociation(change.values, old, ['candidateId', 'goalId', 'courseId'])) return null;
      const task = TaskSchema.safeParse({ ...old, ...(change.type === 'update' ? change.values : { status: change.completed ? 'done' : 'open' }), version: old.version + 1, updatedAt: at });
      if (!task.success) return null; snapshot.tasks[index] = task.data;
    } else if ((change.type === 'update' && change.entity === 'block') || change.type === 'finishBlock') {
      const index = snapshot.blocks.findIndex(block => block.id === change.id); const old = snapshot.blocks[index];
      if (!old || old.recurrence || old.cancelled || old.version !== change.expectedVersion) return null;
      if (change.type === 'update' && !sameAssociation(change.values, old, ['taskId'])) return null;
      const block = BlockSchema.safeParse({ ...old, ...(change.type === 'update' ? change.values : { completed: change.completed }), version: old.version + 1, updatedAt: at });
      if (!block.success) return null; snapshot.blocks[index] = block.data;
    } else return null;
  }
  return snapshot;
}

/** Offline permissions are deliberately narrower than the online RPC whitelist. */
export function allowsOffline(method: RemoteMethod, input: unknown, snapshot: Snapshot | null): boolean {
  if (method === 'ledgerMutate') {
    const parsed = LedgerMutationRequestSchema.safeParse(input);
    return parsed.success && parsed.data.changes.every(change => change.type === 'putEntry' && change.expectedVersion === null &&
      change.entry.kind === 'expense' && change.entry.personalCents === change.entry.amountCents && change.entry.cashflows.length <= 1 &&
      change.entry.cashflows.every(flow => flow.deltaCents === -change.entry.amountCents) && change.entry.adjustments.length === 0 &&
      change.entry.incomeCents === 0 && change.entry.assetSaleCents === 0 && change.entry.snapshotPositions.length === 0 && !change.confirmDuplicate &&
      change.entry.relatedEntryIds.length === 0 && !change.entry.sourceId && !change.entry.sourceKey && !change.entry.ruleKey);
  }
  if (method !== 'mutate' || !snapshot) return false;
  return applyOfflineMutations(input, snapshot, index => `offline-validation:${index}`, instant()) !== null;
}

export function references(input: unknown): string[] {
  const values = new Set<string>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    for (const [key, value] of Object.entries(item)) {
      if ((key === 'id' || key.endsWith('Id')) && !['operationId', 'requestId', 'dataInstanceId'].includes(key) && typeof value === 'string') values.add(value);
      else if (typeof value === 'object') visit(value);
    }
  };
  visit(input); return [...values];
}

export function resolveAliases<T>(input: T, aliases: Record<string, string>): T {
  const visit = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string' && (key === 'id' || key.endsWith('Id')) && !['operationId', 'requestId', 'dataInstanceId'].includes(key)) return Object.hasOwn(aliases, value) && typeof aliases[value] === 'string' ? aliases[value] : value;
    if (Array.isArray(value)) return value.map(item => visit(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]));
    return value;
  };
  return visit(input) as T;
}

export function writeLabel(method: RemoteMethod, input: unknown): string {
  if (method === 'mutate') {
    const parsed = MutationRequestSchema.safeParse(input);
    if (parsed.success) return parsed.data.mutations.map(change => {
      const title = 'values' in change && 'title' in change.values ? change.values.title : '';
      return (change.type === 'create' ? '新增' : change.type === 'finishTask' || change.type === 'finishBlock' ? '更改完成状态' : '修改') + (title ? ' · ' + title : '安排');
    }).join('、');
  }
  const labels: Partial<Record<RemoteMethod, string>> = { ledgerMutate: '保存账目', command: '生活助手请求', importSource: '导入内容', analyzeSource: '分析内容', undo: '撤销日历修改', ledgerUndo: '撤销账目' };
  return labels[method] ?? '提交修改';
}

export function projectSnapshot(partition: OfflinePartition): Snapshot | null {
  if (!partition.snapshot) return null;
  let snapshot = structuredClone(partition.snapshot);
  const identity = partition.session.identity;
  const committed = new Set(partition.snapshot.journal.map(entry => entry.operationId));
  for (const item of partition.queue) {
    if (!['queued', 'sending', 'uncertain'].includes(item.status) || item.method !== 'mutate') continue;
    if (item.identity.dataInstanceId !== identity.dataInstanceId || item.identity.generation !== identity.generation || item.identity.protocolVersion !== identity.protocolVersion) continue;
    const parsed = MutationRequestSchema.safeParse(resolveAliases(item.input, partition.aliases));
    if (!parsed.success) continue;
    // The canonical refresh can arrive before the acknowledgement. Never render an already-applied write twice.
    if (committed.has(parsed.data.operationId)) continue;
    const projected = applyOfflineMutations(parsed.data, snapshot, index => {
      const local = localId(item, index); return Object.hasOwn(partition.aliases, local) ? partition.aliases[local]! : local;
    }, item.createdAt);
    if (projected) snapshot = projected;
  }
  return snapshot;
}

export function captureBase(method: RemoteMethod, input: unknown, partition: OfflinePartition): unknown {
  if (method === 'ledgerMutate') {
    const request = LedgerMutationRequestSchema.safeParse(input);
    const month = request.success ? request.data.month ?? request.data.changes.find(change => change.type === 'putEntry')?.entry.month : undefined;
    return { revision: (month ? partition.ledgers[month] : Object.values(partition.ledgers)[0])?.revision ?? 0 };
  }
  const ids = references(input);
  const snapshot = projectSnapshot(partition);
  return snapshot ? [...snapshot.tasks, ...snapshot.blocks].filter(item => ids.includes(item.id)) : [];
}

/** Called only after the user chooses their version in the conflict panel. */
export function rebaseWrite(item: PendingWrite, partition: OfflinePartition): unknown {
  if (item.status === 'sending' || item.status === 'uncertain') throw Error('请先核对原请求结果，不能将结果未知的操作作为新操作重放');
  const input = resolveAliases(item.input, partition.aliases);
  if (item.method === 'mutate') {
    const request = MutationRequestSchema.parse(input);
    const snapshot = partition.snapshot;
    if (!snapshot) throw Error('请先取得服务端最新安排');
    const versions = new Map<string, number>();
    const rebased = { ...request, operationId: crypto.randomUUID(), confirmed: false, confirmationToken: undefined,
      mutations: request.mutations.map(change => {
        if (!('expectedVersion' in change) || !('id' in change)) return change;
        const kind = change.type === 'finishTask' || ('entity' in change && change.entity === 'task') ? 'task' : change.type === 'finishBlock' || ('entity' in change && change.entity === 'block') ? 'block' : null;
        const record = (kind === 'task' ? snapshot.tasks : kind === 'block' ? snapshot.blocks : []).find(value => value.id === change.id);
        if (!record) throw Error('该事项已在服务端移除，请重新新建或放弃本机修改');
        const key = `${kind}:${record.id}`; const next = versions.get(key) ?? record.version; versions.set(key, next + 1);
        return { ...change, expectedVersion: next };
      }) } satisfies MutationRequestInput;
    if (!allowsOffline('mutate', rebased, snapshot)) throw Error('这项更改超出离线基础操作范围，请回到原页面重新确认');
    return rebased;
  }
  if (item.method === 'ledgerMutate') {
    const request = LedgerMutationRequestSchema.parse(input);
    const snapshot = partition.ledgers[request.month ?? Object.keys(partition.ledgers)[0] ?? ''];
    if (!snapshot) throw Error('请先取得服务端最新账本');
    if (!allowsOffline('ledgerMutate', request, partition.snapshot)) throw Error('这项账目需要回到原页面重新确认');
    return { ...request, operationId: crypto.randomUUID(), expectedRevision: snapshot.revision } satisfies LedgerMutationRequest;
  }
  throw Error('这项操作需要回到原页面重新确认');
}
