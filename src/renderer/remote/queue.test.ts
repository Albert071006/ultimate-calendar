import { describe, expect, it } from 'vitest';
import { BlockSchema, MutationRequestSchema, TaskSchema, type Snapshot } from '../../shared/contracts';
import { DEFAULT_LEDGER_RULES, LedgerMutationRequestSchema, LedgerSnapshotSchema } from '../../shared/ledger';
import { emptyState, stateSnapshot } from '../../storage/repository';
import { emptyPartition } from './storage';
import { allowsOffline, captureBase, localId, projectSnapshot, rebaseWrite, references, resolveAliases } from './queue';
import type { OfflinePartition, PendingWrite } from './types';

const at = '2030-01-01T10:00:00+08:00';
function snapshot(): Snapshot {
  const value = stateSnapshot(emptyState());
  value.tasks.push(TaskSchema.parse({ id: 'task', version: 1, title: '合成待办', createdAt: at, updatedAt: at }));
  value.blocks.push(BlockSchema.parse({ id: 'block', version: 1, title: '合成活动', kind: 'event', start: '2030-01-02T10:00:00+08:00', end: null, createdAt: at, updatedAt: at }));
  return value;
}
function partition(): OfflinePartition {
  const value = emptyPartition({ paired: true, identity: { protocolVersion: 1, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 }, device: { id: '22222222-2222-4222-8222-222222222222', name: '合成手机' }, csrfToken: 'not-a-real-token', aiConfigured: false });
  value.snapshot = snapshot(); return value;
}
const request = (mutations: unknown[], extra: Record<string, unknown> = {}) => ({ operationId: 'synthetic-op', origin: 'manual', mutations, ...extra });
function pending(input: unknown, id = 'queue-one'): PendingWrite {
  return { id, requestId: `request-${id}`, method: 'mutate', input, identity: partition().session.identity, createdAt: at, status: 'queued', label: '合成修改', message: '', dependencies: [], targets: [], base: [] };
}
const event = { title: '合成单次活动', kind: 'event', start: '2030-01-02T11:00:00+08:00', end: null };
function expense(extraEntry: Record<string, unknown> = {}, extraChange: Record<string, unknown> = {}) {
  return { operationId: 'expense-op', expectedRevision: 3, month: '2030-02', changes: [{ type: 'putEntry', expectedVersion: null, entry: { id: 'entry-new', kind: 'expense', date: '2030-02-01', month: '2030-02', title: '合成支出', category: '其他', amountCents: 100, personalCents: 100, cashflows: [{ accountId: 'wechat', deltaCents: -100 }], ...extraEntry }, ...extraChange }] };
}
function ledger(revision: number, month: string) {
  return LedgerSnapshotSchema.parse({ revision, entries: [], balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [], summary: { month, from: null, to: null, actualPaidCents: 0, personalCents: 0, incomeCents: 0, assetSaleCents: 0, familyUsageCents: 0, pendingPersonalCount: 0, pendingAccountCount: 0, uncertainDateCents: 0, unallocatedAdjustmentCents: 0, cashBalanceCents: null, storedBalanceCents: null, accounts: [], categories: [], days: [] } });
}

describe('offline mutation scope', () => {
  it('allows ordinary tasks, ordinary single blocks and explicit completion changes', () => {
    const value = snapshot();
    for (const mutation of [
      { type: 'create', entity: 'task', values: { title: '合成新待办' } },
      { type: 'create', entity: 'block', values: event },
      { type: 'create', entity: 'block', values: { ...event, taskId: 'task' } },
      { type: 'update', entity: 'task', id: 'task', expectedVersion: 1, values: { title: '合成修改', deadline: { date: '2030-02-01', time: null } } },
      { type: 'finishTask', id: 'task', expectedVersion: 1, completed: true },
      { type: 'finishBlock', id: 'block', expectedVersion: 1, completed: false },
    ]) expect(allowsOffline('mutate', request([mutation]), value)).toBe(true);
  });

  it.each(['candidateId', 'goalId', 'courseId'])('rejects a new task with a hidden %s association and changes to existing associations', key => {
    const value = snapshot();
    expect(allowsOffline('mutate', request([{ type: 'create', entity: 'task', values: { title: '合成待办', [key]: 'advanced-target' } }]), value)).toBe(false);
    expect(allowsOffline('mutate', request([{ type: 'update', entity: 'task', id: 'task', expectedVersion: 1, values: { [key]: 'advanced-target' } }]), value)).toBe(false);
    const task = value.tasks[0]!; Reflect.set(task, key, 'existing-target');
    expect(allowsOffline('mutate', request([{ type: 'update', entity: 'task', id: 'task', expectedVersion: 1, values: { title: '只改标题', [key]: 'existing-target' } }]), value)).toBe(true);
    expect(allowsOffline('mutate', request([{ type: 'update', entity: 'task', id: 'task', expectedVersion: 1, values: { [key]: null } }]), value)).toBe(false);
  });

  it('cannot create recurrence, inject repeat metadata, or relink a block offline', () => {
    const value = snapshot();
    for (const injected of [{ recurrence: { seriesId: 'series', occurrenceStart: event.start } }, { cancelled: true }, { candidateId: 'candidate' }, { repeat: 'weekly' }]) {
      expect(allowsOffline('mutate', request([{ type: 'create', entity: 'block', values: { ...event, ...injected } }]), value)).toBe(false);
      expect(allowsOffline('mutate', request([{ type: 'update', entity: 'block', id: 'block', expectedVersion: 1, values: injected }]), value)).toBe(false);
    }
    expect(allowsOffline('mutate', request([{ type: 'update', entity: 'block', id: 'block', expectedVersion: 1, values: { taskId: 'task' } }]), value)).toBe(false);
    for (const target of ['missing', 'advanced']) {
      value.tasks.push(TaskSchema.parse({ ...value.tasks[0], id: 'advanced', candidateId: 'candidate' }));
      expect(allowsOffline('mutate', request([{ type: 'create', entity: 'block', values: { ...event, taskId: target } }]), value)).toBe(false);
    }
  });

  it('requires current versions, rejects recurring/cancelled edits and rejects invalid merged intervals', () => {
    const value = snapshot();
    expect(allowsOffline('mutate', request([{ type: 'finishTask', id: 'task', expectedVersion: 2 }]), value)).toBe(false);
    expect(allowsOffline('mutate', request([{ type: 'update', entity: 'block', id: 'block', expectedVersion: 1, values: { kind: 'work' } }]), value)).toBe(false);
    value.blocks[0]!.recurrence = { seriesId: 'series', occurrenceStart: event.start };
    expect(allowsOffline('mutate', request([{ type: 'finishBlock', id: 'block', expectedVersion: 1 }]), value)).toBe(false);
    value.blocks[0]!.recurrence = null; value.blocks[0]!.cancelled = true;
    expect(allowsOffline('mutate', request([{ type: 'update', entity: 'block', id: 'block', expectedVersion: 1, values: { title: '不能改' } }]), value)).toBe(false);
  });

  it('rejects advanced methods, AI requests, preview tokens and a mixed supported/unsupported batch', () => {
    const value = snapshot(); const basic = { type: 'create', entity: 'task', values: { title: '普通待办' } };
    for (const method of ['command', 'undo', 'ledgerUndo', 'importSource', 'analyzeSource'] as const) expect(allowsOffline(method, {}, value)).toBe(false);
    for (const extra of [{ origin: 'ai' }, { confirmationToken: 'preview-token' }, { confirmed: true, confirmationToken: 'preview-token' }]) expect(allowsOffline('mutate', request([basic], extra), value)).toBe(false);
    expect(allowsOffline('mutate', request([basic, { type: 'create', entity: 'goal', values: { title: '高级目标' } }]), value)).toBe(false);
    expect(allowsOffline('mutate', request([basic]), null)).toBe(false);
  });

  it('permits only simple new full-personal expenses, not balance anchors, income, duplicate confirmation or provenance', () => {
    expect(allowsOffline('ledgerMutate', expense(), null)).toBe(true);
    for (const extra of [{ incomeCents: 1 }, { assetSaleCents: 1 }, { personalCents: 50 }, { kind: 'income' }, { sourceId: 'source' }, { sourceKey: 'source-key' }, { ruleKey: 'rule' }, { relatedEntryIds: ['entry'] }, { snapshotPositions: [{ snapshotId: 'balance', position: 'after' }] }, { adjustments: [{ targetEntryIds: ['entry'], amountCents: 100 }] }, { cashflows: [{ accountId: 'wechat', deltaCents: 100 }] }]) expect(allowsOffline('ledgerMutate', expense(extra), null)).toBe(false);
    expect(allowsOffline('ledgerMutate', expense({}, { confirmDuplicate: true }), null)).toBe(false);
    expect(allowsOffline('ledgerMutate', expense({}, { expectedVersion: 1 }), null)).toBe(false);
  });
});

describe('optimistic queue projection', () => {
  it('keeps single-slot completion, restoration and linked versions aligned', () => {
    const value = partition(); value.snapshot!.blocks[0]!.taskId = 'task';
    value.queue.push(pending(request([{ type: 'finishBlock', id: 'block', expectedVersion: 1, completed: true },
      { type: 'update', entity: 'task', id: 'task', expectedVersion: 2, values: { title: '已完成的合成任务' } }])));
    const done = projectSnapshot(value)!;
    expect(done.tasks[0]).toMatchObject({ status: 'done', version: 3 });
    expect(done.blocks[0]).toMatchObject({ completed: true, version: 2 });
    expect(value.snapshot!.tasks[0]).toMatchObject({ status: 'open', version: 1 });
    value.snapshot = done; value.queue = [pending(request([{ type: 'finishTask', id: 'task', expectedVersion: 3, completed: false }], { operationId: 'restore' }))];
    expect(projectSnapshot(value)!.tasks[0]).toMatchObject({ status: 'open', version: 4 });
    expect(projectSnapshot(value)!.blocks[0]).toMatchObject({ completed: false, version: 3 });
  });

  it('requires an explicit multiple-slot choice before adding a second slot and preserves per-slot completion', () => {
    const value = partition(); value.snapshot!.blocks[0]!.taskId = 'task';
    const second = { type: 'create', entity: 'block', values: { ...event, taskId: 'task' } };
    expect(allowsOffline('mutate', request([second]), value.snapshot)).toBe(false);
    const enable = { type: 'update', entity: 'task', id: 'task', expectedVersion: 1, values: { scheduleMode: 'multiple' } };
    expect(allowsOffline('mutate', request([enable, second]), value.snapshot)).toBe(true);
    value.queue.push(pending(request([enable, second, { type: 'finishBlock', id: 'block', expectedVersion: 1, completed: true }])));
    const result = projectSnapshot(value)!;
    expect(result.tasks[0]).toMatchObject({ scheduleMode: 'multiple', status: 'open', version: 2 });
    expect(result.blocks).toHaveLength(2); expect(result.blocks[0]!.completed).toBe(true);
  });

  it('captures implicit completion and slot-limit dependencies for conflict review', () => {
    const value = partition(); value.snapshot!.blocks[0]!.taskId = 'task';
    expect(captureBase('mutate', request([{ type: 'finishBlock', id: 'block', expectedVersion: 1 }]), value)).toEqual([...value.snapshot!.tasks, ...value.snapshot!.blocks]);
    expect(captureBase('mutate', request([{ type: 'finishTask', id: 'task', expectedVersion: 1 }]), value)).toEqual([...value.snapshot!.tasks, ...value.snapshot!.blocks]);
  });

  it('does not change historical completion when a full editor patch only changes its title', () => {
    const value = partition(); value.snapshot!.blocks[0]!.taskId = 'task'; value.snapshot!.blocks[0]!.completed = true;
    value.queue.push(pending(request([{ type: 'update', entity: 'task', id: 'task', expectedVersion: 1, values: { title: '修改名称', status: 'open' } }])));
    expect(projectSnapshot(value)!.blocks[0]).toMatchObject({ completed: true, version: 1 });
    value.queue = [pending(request([{ type: 'update', entity: 'block', id: 'block', expectedVersion: 1, values: { title: '修改时段名称', completed: true } }]))];
    expect(projectSnapshot(value)!.tasks[0]).toMatchObject({ status: 'open', version: 1 });
  });
  it('uses completed, supports restore, and applies sequential version checks without mutating canonical state', () => {
    const value = partition();
    value.queue.push(pending(request([{ type: 'finishTask', id: 'task', expectedVersion: 1, completed: true }, { type: 'finishTask', id: 'task', expectedVersion: 2, completed: false }])));
    const projected = projectSnapshot(value)!; expect(projected.tasks[0]).toMatchObject({ status: 'open', version: 3 }); expect(value.snapshot!.tasks[0]).toMatchObject({ status: 'open', version: 1 });
    value.queue[0]!.input = request([{ type: 'finishTask', id: 'task', expectedVersion: 1, completed: true }]);
    expect(projectSnapshot(value)!.tasks[0]!.status).toBe('done');
  });

  it('never partly projects a rejected batch or a malformed cached write', () => {
    const value = partition();
    value.queue.push(pending(request([{ type: 'create', entity: 'task', values: { title: '不应出现' } }, { type: 'create', entity: 'goal', values: { title: '高级目标' } }])));
    expect(projectSnapshot(value)).toEqual(value.snapshot);
    value.queue[0]!.input = request([{ type: 'update', entity: 'task', id: 'task', expectedVersion: 1, values: { title: '不应出现' } }, { type: 'finishTask', id: 'task', expectedVersion: 1 }]);
    expect(projectSnapshot(value)).toEqual(value.snapshot);
    value.queue[0]!.input = { nonsense: true }; expect(projectSnapshot(value)).toEqual(value.snapshot);
  });

  it('skips old data identities, failed/review writes and canonical journal operations after a lost acknowledgement', () => {
    const value = partition(); const item = pending(request([{ type: 'create', entity: 'task', values: { title: '不能重复' } }])); value.queue.push(item);
    item.identity = { ...item.identity, generation: 0 }; expect(projectSnapshot(value)).toEqual(value.snapshot);
    item.identity = value.session.identity;
    for (const status of ['failed', 'conflict', 'review', 'blocked'] as const) { item.status = status; expect(projectSnapshot(value)).toEqual(value.snapshot); }
    item.status = 'uncertain'; value.snapshot!.journal.push({ id: 'journal', operationId: 'synthetic-op', createdAt: at, origin: 'manual', message: '已保存', changes: [], undoneAt: null, undoable: true });
    expect(projectSnapshot(value)).toEqual(value.snapshot);
  });

  it('projects dependent local tasks, then follows acknowledged aliases without duplicate creates', () => {
    const value = partition(); const create = pending(request([{ type: 'create', entity: 'task', values: { title: '本地新增' } }]), 'create'); const id = localId(create, 0);
    const update = pending(request([{ type: 'update', entity: 'task', id, expectedVersion: 1, values: { title: '本地再改' } }], { operationId: 'update-op' }), 'update');
    value.queue.push(create, update); expect(projectSnapshot(value)!.tasks.find(task => task.id === id)).toMatchObject({ title: '本地再改', version: 2 });
    value.aliases[id] = 'server-new'; value.snapshot!.tasks.push(TaskSchema.parse({ id: 'server-new', version: 1, title: '本地新增', createdAt: at, updatedAt: at }));
    value.snapshot!.journal.push({ id: 'journal', operationId: 'synthetic-op', createdAt: at, origin: 'manual', message: '已保存', changes: [], undoneAt: null, undoable: true });
    const projected = projectSnapshot(value)!; expect(projected.tasks).toHaveLength(2); expect(projected.tasks.find(task => task.id === 'server-new')).toMatchObject({ title: '本地再改', version: 2 });
  });

  it('resolves only entity aliases, preserving durable operation IDs and ignoring prototype properties', () => {
    const input = { operationId: 'local:one', mutations: [{ id: 'local:one', values: { taskId: 'local:two', title: 'local:one' } }] };
    expect(resolveAliases(input, { 'local:one': 'real-one', 'local:two': 'real-two' })).toEqual({ operationId: 'local:one', mutations: [{ id: 'real-one', values: { taskId: 'real-two', title: 'local:one' } }] });
    expect(resolveAliases({ id: 'constructor' }, {})).toEqual({ id: 'constructor' });
    expect(references(input)).toEqual(['local:one', 'local:two']);
  });
});

describe('explicit conflict resolution', () => {
  it('rebases following task edits against the version advanced by completing its single slot', () => {
    const value = partition(); value.snapshot!.blocks[0]!.taskId = 'task'; value.snapshot!.tasks[0]!.version = 7; value.snapshot!.blocks[0]!.version = 4;
    const item = pending(request([{ type: 'finishBlock', id: 'block', expectedVersion: 1, completed: true },
      { type: 'update', entity: 'task', id: 'task', expectedVersion: 2, values: { title: '保留本机标题' } }])); item.status = 'conflict';
    const rebased = MutationRequestSchema.parse(rebaseWrite(item, value));
    expect(rebased.mutations.map(change => 'expectedVersion' in change ? change.expectedVersion : null)).toEqual([4, 8]);
    expect(allowsOffline('mutate', rebased, value.snapshot)).toBe(true);
  });
  it('rebases versions per kind and within a batch only after the result is known', () => {
    const value = partition(); value.snapshot!.tasks[0]!.version = 7;
    const item = pending(request([{ type: 'update', entity: 'task', id: 'task', expectedVersion: 1, values: { title: '保留本机标题' } }, { type: 'finishTask', id: 'task', expectedVersion: 2, completed: true }])); item.status = 'conflict';
    const rebased = MutationRequestSchema.parse(rebaseWrite(item, value));
    expect(rebased.operationId).not.toBe('synthetic-op'); expect(rebased.mutations.map(change => 'expectedVersion' in change ? change.expectedVersion : null)).toEqual([7, 8]);
    item.status = 'uncertain'; expect(() => rebaseWrite(item, value)).toThrow('结果未知');
  });

  it('chooses the requested ledger month rather than an unrelated first cached month', () => {
    const value = partition(); value.ledgers['2030-01'] = ledger(1, '2030-01'); value.ledgers['2030-02'] = ledger(8, '2030-02');
    const input = expense(); expect(captureBase('ledgerMutate', input, value)).toEqual({ revision: 8 });
    const item = pending(input); item.method = 'ledgerMutate'; item.status = 'conflict';
    expect(LedgerMutationRequestSchema.parse(rebaseWrite(item, value)).expectedRevision).toBe(8);
  });

  it('does not take a task version when a block has the same allowed identifier', () => {
    const value = partition(); value.snapshot!.tasks[0]!.id = 'shared-id'; value.snapshot!.tasks[0]!.version = 8;
    value.snapshot!.blocks[0]!.id = 'shared-id'; value.snapshot!.blocks[0]!.version = 3;
    const item = pending(request([{ type: 'finishBlock', id: 'shared-id', expectedVersion: 1, completed: true }])); item.status = 'conflict';
    const rebased = MutationRequestSchema.parse(rebaseWrite(item, value)); expect(rebased.mutations[0]).toMatchObject({ expectedVersion: 3 });
  });
});
