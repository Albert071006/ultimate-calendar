import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRepository } from '../storage/repository';
import { createLedgerService, replaceLedgerDatabase } from '../ledger/service';
import { importDistilled } from './distilled';
import { DistilledRequestSchema } from '../shared/distilled';
import { createSafeBackup, validateSafeBackup, SOURCE_PLACEHOLDER } from './backup';

const identity = { protocolVersion: 1 as const, dataInstanceId: 'e7028f3d-072b-4ab2-bfd2-b915956318d3', generation: 1 };
function request(requestId = 'batch-one', title = '提交虚构报告') { return DistilledRequestSchema.parse({ requestId, identity, items: [{ distilledId: 'synthetic-stable-id-001', title, deadline: { date: '2027-01-02', time: '20:10' } }] }); }
function eventRequest(revision: number, title = '提交虚构报告', event = 'a') {
  return DistilledRequestSchema.parse({ requestId: `event-${event}-${revision}`, identity, items: [{ distilledId: 'qqd_' + 'b'.repeat(64), eventId: 'qqe_' + event.repeat(64), eventRevision: [10, revision], title, deadline: { date: '2027-01-02', time: '20:10' } }] });
}
const migrationKey = (id: string) => 'qqm_' + createHash('sha256').update(JSON.stringify({ legacyCandidateId: id })).digest('hex');
describe('strict distilled imports', () => {
  it('retains actionable fields with placeholder provenance and deduplicates across batches', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const first = importDistilled(repository, request()); expect(first.created).toBe(1);
      expect(importDistilled(repository, request())).toEqual(first);
      expect(importDistilled(repository, request('other-batch')).created).toBe(0);
      const snapshot = repository.snapshot(); expect(snapshot.candidates).toHaveLength(1); expect(snapshot.sources).toHaveLength(1);
      expect(snapshot.candidates[0]).toMatchObject({ title: '提交虚构报告', deadline: { date: '2027-01-02', time: '20:10' }, sourceQuote: '', temporalEvidence: [] });
      expect(snapshot.sources[0]).toMatchObject({ kind: 'text', imageDataUrl: null, label: '采集电脑提炼' });
      expect(JSON.stringify(snapshot)).not.toContain('captureRef');
      expect(() => importDistilled(repository, request('changed', '编号相同但内容不同'))).toThrow(/内容不同/);
      expect(repository.snapshot().candidates).toHaveLength(1);
    } finally { repository.close(); }
  });
  it('rejects raw evidence, group identifiers, paths and attachments instead of silently dropping them', () => {
    const base = request();
    for (const field of ['sourceQuote', 'captureRef', 'groupId', 'path', 'imageDataUrl', 'text', 'attachments']) {
      expect(() => DistilledRequestSchema.parse({ ...base, items: [{ ...base.items[0], [field]: 'synthetic-private-value' }] })).toThrow();
    }
  });
  it('rolls the whole batch back on a later conflicting extraction', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      importDistilled(repository, request());
      const batch = request('conflicting-batch');
      batch.items.unshift({ ...batch.items[0]!, distilledId: 'synthetic-second-id-002' }); batch.items[1]!.title = 'changed';
      expect(() => importDistilled(repository, batch)).toThrow(); expect(repository.snapshot().candidates).toHaveLength(1);
    } finally { repository.close(); }
  });
  it('updates pending events in place while preserving snooze, edited fields, and old receipts', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const first = importDistilled(repository, eventRequest(1)); const id = first.candidateIds[0]!;
      repository.writeInternal({ operationId: 'user-edit', changes: [{ entity: 'candidate', id, expectedVersion: 1, values: { title: '我修改的标题', snoozedUntil: '2027-01-01T00:00:00+08:00' } }] });
      const next = eventRequest(2, '采集端的新标题'); next.items[0]!.action = '新增报名步骤';
      expect(importDistilled(repository, next)).toEqual({ candidateIds: [id], created: 0 });
      expect(repository.snapshot().candidates).toMatchObject([{ id, title: '我修改的标题', action: '新增报名步骤', snoozedUntil: '2027-01-01T00:00:00+08:00' }]);
      expect(importDistilled(repository, eventRequest(1))).toEqual(first);
      const replay = { ...eventRequest(1), requestId: 'stale-new-batch' }; expect(importDistilled(repository, replay).created).toBe(0);
      expect(repository.snapshot().candidates[0]!.action).toBe('新增报名步骤');
      const conflict = { ...next, requestId: 'changed-same-revision', items: [{ ...next.items[0]!, action: '不一致' }] };
      expect(() => importDistilled(repository, conflict)).toThrow(/修订内容不同/);
    } finally { repository.close(); }
  });
  it('binds an already changed legacy card using a prior opaque content ID without breaking its receipt', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const legacy = request(); legacy.items[0]!.distilledId = 'qqd_' + 'a'.repeat(64);
      const first = importDistilled(repository, legacy);
      const changed = eventRequest(2, '已补充时间的通知'); changed.items[0]!.legacyDistilledIds = [legacy.items[0]!.distilledId];
      expect(importDistilled(repository, changed)).toEqual({ candidateIds: first.candidateIds, created: 0 });
      expect(repository.snapshot().candidates).toHaveLength(1); expect(repository.snapshot().candidates[0]!.title).toBe('已补充时间的通知');
      expect(importDistilled(repository, { ...legacy, requestId: 'old-client-retry' }).candidateIds).toEqual(first.candidateIds);
      expect(repository.snapshot().candidates[0]!.title).toBe('已补充时间的通知');
      const independent = eventRequest(2, '已补充时间的通知', 'c'); independent.items[0]!.legacyDistilledIds = changed.items[0]!.legacyDistilledIds;
      expect(importDistilled(repository, independent).created).toBe(1); expect(repository.snapshot().candidates).toHaveLength(2);
    } finally { repository.close(); }
  });
  it('binds identical legacy content on first contact and keeps independent equal-text events distinct', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const event = eventRequest(1), legacy = request(); legacy.items = [{ ...legacy.items[0]!, distilledId: event.items[0]!.distilledId }];
      const original = importDistilled(repository, legacy);
      expect(importDistilled(repository, event)).toEqual({ candidateIds: original.candidateIds, created: 0 });
      expect(importDistilled(repository, eventRequest(1, '提交虚构报告', 'c')).created).toBe(1);
      expect(repository.snapshot().candidates).toHaveLength(2);
    } finally { repository.close(); }
  });
  it('keeps accepted work intact and maintains just one pending review across successive supplements', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const id = importDistilled(repository, eventRequest(1)).candidateIds[0]!;
      const task = repository.writeInternal({ operationId: 'accepted-task', changes: [{ entity: 'task', values: { title: '用户的已接受任务', candidateId: id } }] }).entities[0]!;
      repository.writeInternal({ operationId: 'accept-original', changes: [{ entity: 'candidate', id, expectedVersion: 1, values: { status: 'accepted', taskId: task.id } }] });
      const accepted = repository.snapshot().candidates[0]!;
      const review = importDistilled(repository, eventRequest(2, '新增报名条件'));
      expect(review.created).toBe(1); expect(importDistilled(repository, eventRequest(3, '报名条件再补充'))).toEqual({ candidateIds: review.candidateIds, created: 0 });
      const current = repository.snapshot(); expect(current.candidates).toHaveLength(2); expect(current.candidates[0]).toEqual(accepted); expect(current.tasks).toEqual([task]);
      expect(current.candidates[1]).toMatchObject({ status: 'pending', revisionOfId: id, title: '报名条件再补充' });
      expect(importDistilled(repository, { ...eventRequest(2, '新增报名条件'), requestId: 'retry-review' }).created).toBe(0);
    } finally { repository.close(); }
  });
  it('does not resurrect ignored events or replay unseen stale revisions', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const id = importDistilled(repository, eventRequest(3, '最新通知')).candidateIds[0]!;
      expect(importDistilled(repository, eventRequest(1, '陈旧通知')).created).toBe(0); expect(repository.snapshot().candidates[0]!.title).toBe('最新通知');
      repository.writeInternal({ operationId: 'ignore-event', changes: [{ entity: 'candidate', id, expectedVersion: 1, values: { status: 'ignored' } }] });
      const ignored = repository.snapshot().candidates[0]!;
      expect(importDistilled(repository, eventRequest(4, '忽略后补充')).created).toBe(0); expect(repository.snapshot().candidates).toEqual([ignored]);
    } finally { repository.close(); }
  });
  it('allows only opaque identity metadata together with the existing summary whitelist', () => {
    const event = eventRequest(1);
    for (const extra of [{ eventId: 'PRIVATE_QQ_GROUP' }, { legacyDistilledIds: ['C:\\private\\source'] }, { eventRevision: [1] }, { revisionOfId: 'local-candidate-id' }, { sourceIds: ['local-source'] }]) expect(() => DistilledRequestSchema.parse({ ...event, items: [{ ...event.items[0], ...extra }] })).toThrow();
    expect(() => DistilledRequestSchema.parse({ ...event, items: [{ ...event.items[0], eventRevision: undefined }] })).toThrow();
  });
  it('continues event updates and preserves user edits after a sanitized safe backup and restore', () => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-distilled-restore-'));
    const repository = createRepository(join(root, 'data', 'planner.sqlite'), { automaticBackup: () => {} });
    const ledger = createLedgerService(repository.path), restored = createRepository(join(root, 'restored', 'planner.sqlite'), { automaticBackup: () => {} });
    try {
      const first = importDistilled(repository, eventRequest(1));
      repository.writeInternal({ operationId: 'synthetic-user-edit', changes: [{ entity: 'candidate', id: first.candidateIds[0], expectedVersion: 1, values: { title: '用户更正的标题' } }] });
      const file = createSafeBackup({ repository, ledger, directory: join(root, 'exports') });
      const backup = validateSafeBackup(JSON.parse(readFileSync(file, 'utf8')));
      expect(backup.planner.operations.find(operation => operation.id === 'synthetic-user-edit')!.fingerprint).toMatch(/^redacted:[a-f0-9]{64}$/);
      expect(backup.planner.operations.find(operation => operation.id.startsWith('distilled-event:'))!.fingerprint).toMatch(/^event-head-v1:10:1:[a-f0-9]{64}$/);
      restored.replaceState(backup.planner, db => replaceLedgerDatabase(db, backup.ledger));
      const changed = eventRequest(2, '采集端更新标题'); changed.items[0]!.action = '恢复后补充的报名步骤';
      expect(importDistilled(restored, changed)).toEqual({ candidateIds: first.candidateIds, created: 0 });
      expect(restored.snapshot().candidates).toMatchObject([{ id: first.candidateIds[0], title: '用户更正的标题', action: '恢复后补充的报名步骤' }]);
      expect(restored.snapshot().candidates).toHaveLength(1);
      expect(importDistilled(restored, eventRequest(1))).toEqual(first);
      expect(importDistilled(restored, { ...eventRequest(1), requestId: 'restored-stale-retry' }).created).toBe(0);
      expect(restored.snapshot().candidates[0]!.action).toBe('恢复后补充的报名步骤');
    } finally { ledger.close(); repository.close(); restored.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('validates event head metadata and upgrades the earlier JSON encoding on its next revision', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      importDistilled(repository, eventRequest(1));
      repository.transact(state => {
        const head = state.operations.find(operation => operation.id.startsWith('distilled-event:'))!;
        head.fingerprint = JSON.stringify({ revision: [10, 1], fingerprint: head.fingerprint.split(':').at(-1) });
      });
      expect(importDistilled(repository, eventRequest(2)).created).toBe(0);
      expect(repository.read().operations.find(operation => operation.id.startsWith('distilled-event:'))!.fingerprint).toMatch(/^event-head-v1:10:2:/);
      repository.transact(state => { state.operations.find(operation => operation.id.startsWith('distilled-event:'))!.fingerprint = 'event-head-v1:9007199254740992:2:' + 'a'.repeat(64); });
      expect(() => importDistilled(repository, eventRequest(3))).toThrow('事件同步状态损坏');
      expect(repository.snapshot().candidates).toHaveLength(1);
    } finally { repository.close(); }
  });
  it('binds migrated UUIDs without old distilled receipts, preserving decisions and edits across safe restore', () => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-migrated-event-'));
    const repository = createRepository(join(root, 'data', 'planner.sqlite'), { automaticBackup: () => {} }), ledger = createLedgerService(repository.path);
    const restored = createRepository(join(root, 'restored', 'planner.sqlite'), { automaticBackup: () => {} }), restoredLedger = createLedgerService(restored.path);
    try {
      const source = repository.writeInternal({ operationId: 'migration-source', changes: [{ entity: 'source', values: { kind: 'text', text: SOURCE_PLACEHOLDER, label: '采集电脑提炼', importedAt: '2020-01-01T00:00:00+08:00' } }] }).entities[0]!;
      const pending = repository.writeInternal({ operationId: 'migration-pending', changes: [{ entity: 'candidate', values: { title: '云端人工更正标题', action: '原报名步骤', sourceIds: [source.id], snoozedUntil: '2027-01-01T00:00:00+08:00' } }] }).entities[0]!;
      const ignored = repository.writeInternal({ operationId: 'migration-ignored', changes: [{ entity: 'candidate', values: { title: '云端人工更正标题', action: '原报名步骤', sourceIds: [source.id], status: 'ignored' } }] }).entities[0]!;
      const accepted = repository.writeInternal({ operationId: 'migration-accepted', changes: [{ entity: 'candidate', values: { title: '已接受旧通知', sourceIds: [source.id], status: 'accepted' } }] }).entities[0]!;
      const initial = validateSafeBackup(JSON.parse(readFileSync(createSafeBackup({ repository, ledger, directory: join(root, 'exports') }), 'utf8')));
      restored.replaceState(initial.planner, db => replaceLedgerDatabase(db, initial.ledger));
      expect(restored.read().operations.some(operation => operation.id.startsWith('distilled-item:'))).toBe(false);
      const upload = eventRequest(1, '本机未修改的旧标题'); upload.items[0]!.legacyCandidateKey = migrationKey(pending.id); upload.items[0]!.action = '原报名步骤';
      const ignoredUpload = eventRequest(1, '本机仍pending的旧通知', 'c'); ignoredUpload.items[0]!.legacyCandidateKey = migrationKey(ignored.id);
      const acceptedUpload = eventRequest(1, '本机不同的旧内容', 'd'); acceptedUpload.items[0]!.legacyCandidateKey = migrationKey(accepted.id);
      expect(JSON.stringify(upload)).not.toContain(pending.id);
      expect(importDistilled(restored, upload)).toEqual({ candidateIds: [pending.id], created: 0 });
      expect(importDistilled(restored, ignoredUpload)).toEqual({ candidateIds: [ignored.id], created: 0 });
      expect(importDistilled(restored, acceptedUpload)).toEqual({ candidateIds: [accepted.id], created: 0 });
      expect(restored.snapshot().candidates).toEqual([pending, ignored, accepted]);
      const linked = validateSafeBackup(JSON.parse(readFileSync(createSafeBackup({ repository: restored, ledger: restoredLedger, directory: join(root, 'linked-exports') }), 'utf8')));
      restored.replaceState(linked.planner, db => replaceLedgerDatabase(db, linked.ledger));
      const next = eventRequest(2, '本机未修改的旧标题'); next.items[0]!.legacyCandidateKey = migrationKey(pending.id); next.items[0]!.action = '真正的新补充';
      expect(importDistilled(restored, next)).toEqual({ candidateIds: [pending.id], created: 0 });
      expect(restored.snapshot().candidates[0]).toMatchObject({ id: pending.id, title: '云端人工更正标题', action: '真正的新补充', snoozedUntil: '2027-01-01T00:00:00+08:00' });
      const ignoredNext = eventRequest(2, '忽略后的补充', 'c'); ignoredNext.items[0]!.legacyCandidateKey = migrationKey(ignored.id);
      expect(importDistilled(restored, ignoredNext)).toEqual({ candidateIds: [ignored.id], created: 0 });
      expect(restored.snapshot().candidates.find(value => value.id === ignored.id)).toEqual(ignored);
      expect(restored.snapshot().candidates).toHaveLength(3);
    } finally { ledger.close(); restoredLedger.close(); repository.close(); restored.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('does not bind arbitrary UUIDs without the exact sanitized migration source marker', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const source = repository.writeInternal({ operationId: 'ordinary-source', changes: [{ entity: 'source', values: { kind: 'text', text: '普通云端来源', label: '普通来源', importedAt: '2020-01-01T00:00:00+08:00' } }] }).entities[0]!;
      const candidate = repository.writeInternal({ operationId: 'ordinary-candidate', changes: [{ entity: 'candidate', values: { title: '提交虚构报告', sourceIds: [source.id] } }] }).entities[0]!;
      const upload = eventRequest(1); upload.items[0]!.legacyCandidateKey = migrationKey(candidate.id);
      expect(importDistilled(repository, upload).created).toBe(1); expect(repository.snapshot().candidates[0]).toEqual(candidate);
      expect(() => DistilledRequestSchema.parse({ ...upload, items: [{ ...upload.items[0], legacyCandidateKey: candidate.id }] })).toThrow();
    } finally { repository.close(); }
  });
  it('allows the optional migration hint on an already used event revision without changing receipts or content', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const original = eventRequest(1), first = importDistilled(repository, original), upgraded = eventRequest(1);
      upgraded.items[0]!.legacyCandidateKey = migrationKey('11111111-2222-4333-8444-555555555555');
      expect(importDistilled(repository, upgraded)).toEqual(first);
      expect(importDistilled(repository, { ...upgraded, requestId: 'upgraded-client-retry' })).toEqual({ candidateIds: first.candidateIds, created: 0 });
      expect(repository.snapshot().candidates).toHaveLength(1);
      expect(() => importDistilled(repository, { ...upgraded, items: [{ ...upgraded.items[0]!, title: '不能借新增提示改变内容' }] })).toThrow(/不同内容/);
    } finally { repository.close(); }
  });
});
