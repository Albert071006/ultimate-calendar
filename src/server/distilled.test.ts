import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRepository, readDatabaseState, type StoredState } from '../storage/repository';
import { createLedgerService, replaceLedgerDatabase } from '../ledger/service';
import { importDistilled } from './distilled';
import { DistilledRequestSchema } from '../shared/distilled';
import { createSafeBackup, redactEvidence, validateSafeBackup, SOURCE_PLACEHOLDER } from './backup';
import { createCloudRestore } from './cloud-restore';
import { RemoteState } from './state';
import { DatabaseSync } from 'node:sqlite';

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
      expect(backup.planner.operations.some(operation => operation.id.startsWith('distilled-event:'))).toBe(false);
      expect(backup.planner.distilled).toContainEqual(expect.objectContaining({ kind: 'event', candidateId: first.candidateIds[0], version: { revision: [10, 1], fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } }));
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
  it('atomically upgrades legacy SQLite heads and rejects invalid revision numbers', () => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-distilled-legacy-')), path = join(root, 'data', 'planner.sqlite');
    let repository = createRepository(path, { automaticBackup: () => {} });
    try {
      const candidateId = importDistilled(repository, eventRequest(1)).candidateIds[0]!;
      const head = repository.read().distilled!.find(entry => entry.kind === 'event')!;
      const result = { entities: [repository.snapshot().candidates[0]!] }, legacy = { id: head.id, fingerprint: JSON.stringify(head.version), result };
      repository.close();
      const db = new DatabaseSync(path);
      try {
        db.exec('DROP TABLE distilled_state');
        db.prepare('INSERT INTO operations(id,payload) VALUES(?,?)').run(head.id, JSON.stringify(legacy));
      } finally { db.close(); }
      const oldBackup = new DatabaseSync(path, { readOnly: true });
      try {
        expect(readDatabaseState(oldBackup).distilled).toContainEqual(head);
        expect(oldBackup.prepare("SELECT 1 FROM sqlite_master WHERE name='distilled_state'").get()).toBeUndefined();
      } finally { oldBackup.close(); }
      repository = createRepository(path, { automaticBackup: () => {} });
      const inspected = new DatabaseSync(path, { readOnly: true });
      try {
        expect(inspected.prepare('SELECT 1 FROM operations WHERE id=?').get(head.id)).toBeUndefined();
        expect(inspected.prepare('SELECT 1 FROM distilled_state WHERE id=?').get(head.id)).toBeTruthy();
      } finally { inspected.close(); }
      expect(importDistilled(repository, eventRequest(2)).created).toBe(0);
      expect(repository.read().distilled).toContainEqual(expect.objectContaining({ kind: 'event', candidateId, version: { revision: [10, 2], fingerprint: expect.any(String) } }));
      const malformed = { ...legacy, fingerprint: 'event-head-v1:9007199254740992:2:' + 'a'.repeat(64) };
      expect(() => repository.replaceState({ ...repository.read(), distilled: undefined, operations: [malformed] })).toThrow('事件同步状态损坏');
    } finally { repository.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['current', 'legacy'] as const)('continues all candidate decisions across an online restore of a %s backup', async format => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-online-distilled-'));
    const repository = createRepository(join(root, 'data', 'planner.sqlite'), { automaticBackup: () => {} });
    const ledger = createLedgerService(repository.path), remote = new RemoteState(join(root, 'data', 'remote-state.sqlite'));
    const backup = () => createSafeBackup({ repository, ledger, directory: join(root, 'backups') });
    try {
      const events = ['a', 'b', 'c', 'd', 'e'];
      const ids = events.map(event => importDistilled(repository, eventRequest(1, '原通知', event)).candidateIds[0]!);
      const original = repository.snapshot().candidates;
      const task = repository.writeInternal({ operationId: 'task', changes: [{ entity: 'task', values: { title: '已确认任务', candidateId: ids[2] } }] }).entities[0]!;
      repository.writeInternal({ operationId: 'decisions', changes: [
        { entity: 'candidate', id: ids[1], expectedVersion: 1, values: { title: '人工更正', snoozedUntil: '2027-01-01T00:00:00+08:00' } },
        { entity: 'candidate', id: ids[2], expectedVersion: 1, values: { status: 'accepted', taskId: task.id } },
        { entity: 'candidate', id: ids[3], expectedVersion: 1, values: { status: 'ignored' } },
        { entity: 'candidate', id: ids[4], expectedVersion: 1, delete: true },
      ] });
      const before = repository.snapshot();
      remote.begin('old-transport', 'device', 'saveSettings', 'fixture');
      const envelope = JSON.parse(readFileSync(backup(), 'utf8')) as { planner: StoredState };
      if (format === 'legacy') {
        for (const binding of envelope.planner.distilled!) {
          if (binding.kind !== 'event' && binding.kind !== 'revision') throw Error('unexpected fixture binding');
          const candidate = original.find(entry => entry.id === binding.candidateId)!;
          const fingerprint = binding.kind === 'revision' ? binding.fingerprint : `event-head-v1:10:1:${binding.version!.fingerprint}`;
          envelope.planner.operations.push({ id: binding.id, fingerprint, result: { entities: [{ ...candidate, sourceQuote: 'SYNTHETIC_RAW_MARKER' }] } });
        }
        delete envelope.planner.distilled;
      }
      const restore = createCloudRestore({ repository, ledger, state: remote, backup, hasPendingWrites: () => false });
      const previousIdentity = remote.identity();
      const preview = restore.preview({ content: JSON.stringify(envelope) }, 'device');
      const result = await restore.confirm({ token: preview.token, digest: preview.digest }, 'device');
      expect(result.identity.generation).toBe(previousIdentity.generation + 1);
      expect(remote.operation('old-transport', 'device')).toEqual({ status: 'unknown' });
      expect(repository.read().operations).toEqual([]); expect(repository.read().receipts).toEqual([]);
      expect(JSON.stringify(repository.read().distilled)).not.toContain('SYNTHETIC_RAW_MARKER');
      const applied = events.map(event => {
        const update = eventRequest(2, '修订通知', event); update.identity = result.identity;
        update.items[0]!.action = '补充步骤';
        return importDistilled(repository, update);
      });
      const after = repository.snapshot(), card = (index: number) => after.candidates.find(candidate => candidate.id === ids[index]);
      expect(card(0)).toMatchObject({ title: '修订通知', action: '补充步骤', version: 2 });
      expect(card(1)).toMatchObject({ title: '人工更正', action: '补充步骤', snoozedUntil: '2027-01-01T00:00:00+08:00' });
      expect(card(2)).toEqual(before.candidates.find(candidate => candidate.id === ids[2]));
      expect(after.tasks).toEqual([task]);
      expect(after.candidates.find(candidate => candidate.id === applied[2]!.candidateIds[0])).toMatchObject({ status: 'pending', revisionOfId: ids[2], title: '修订通知' });
      expect(card(3)).toEqual(before.candidates.find(candidate => candidate.id === ids[3]));
      expect(card(4)).toBeUndefined(); expect(after.candidates).toHaveLength(5);
      expect(applied.map(item => item.created)).toEqual([0, 0, 1, 0, 0]);
      const stale = eventRequest(1, '原通知'); stale.identity = result.identity;
      expect(importDistilled(repository, stale)).toEqual({ created: 0, candidateIds: [ids[0]] });
      expect(repository.snapshot().candidates).toEqual(after.candidates);
    } finally { remote.close(); ledger.close(); repository.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('recovers provable event roots after an older restore already erased the complete receipt history', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const id = importDistilled(repository, eventRequest(1)).candidateIds[0]!;
      const ignored = importDistilled(repository, eventRequest(1, '旧通知', 'c')).candidateIds[0]!;
      repository.writeInternal({ operationId: 'manual-decisions', changes: [
        { entity: 'candidate', id, expectedVersion: 1, values: { title: '用户修订', snoozedUntil: '2027-01-01T00:00:00+08:00' } },
        { entity: 'candidate', id: ignored, expectedVersion: 1, values: { status: 'ignored' } },
      ] });
      const legacy = redactEvidence(repository.read());
      delete legacy.distilled; legacy.operations = []; legacy.receipts = [];
      repository.replaceState(legacy);
      const before = repository.snapshot().candidates;
      expect(importDistilled(repository, eventRequest(2, '采集端标题'))).toEqual({ candidateIds: [id], created: 0 });
      expect(importDistilled(repository, eventRequest(2, '采集端补充', 'c'))).toEqual({ candidateIds: [ignored], created: 0 });
      expect(repository.snapshot().candidates).toEqual(before);
      const next = eventRequest(3, '新版采集端标题'); next.items[0]!.action = '新增报名步骤';
      expect(importDistilled(repository, next)).toEqual({ candidateIds: [id], created: 0 });
      expect(importDistilled(repository, eventRequest(3, '已忽略的后续补充', 'c'))).toEqual({ candidateIds: [ignored], created: 0 });
      expect(repository.snapshot().candidates).toEqual([
        expect.objectContaining({ id, title: '用户修订', action: '新增报名步骤', snoozedUntil: '2027-01-01T00:00:00+08:00' }),
        before[1],
      ]);
    } finally { repository.close(); }
  });
  it.each(['source', 'owner', 'review'] as const)('declines ambiguous receiptless roots with a mismatched %s', scenario => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const id = importDistilled(repository, eventRequest(1)).candidateIds[0]!;
      if (scenario === 'review') {
        repository.writeInternal({ operationId: 'accept', changes: [{ entity: 'candidate', id, expectedVersion: 1, values: { status: 'accepted' } }] });
        expect(importDistilled(repository, eventRequest(2, '另一张待审卡')).created).toBe(1);
      }
      const legacy = redactEvidence(repository.read());
      const head = legacy.distilled!.find(entry => entry.kind === 'event')!;
      delete legacy.distilled; legacy.operations = []; legacy.receipts = [];
      if (scenario === 'owner') legacy.distilled = [{ ...head, id: 'distilled-event:' + '0'.repeat(64) }];
      if (scenario === 'source') Object.assign(legacy.entities.source[0]!, { label: '手机导入（原文已清理）' });
      repository.replaceState(legacy);
      expect(() => importDistilled(repository, eventRequest(3))).toThrow(/编号与已有资料冲突/);
      expect(repository.read()).toEqual(legacy);
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
