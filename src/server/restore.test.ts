import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepository, newEntity } from '../storage/repository';
import * as storage from '../storage/repository';
import { openDatabase } from '../storage/database';
import { CourseSchema } from '../shared/contracts';
import { createLedgerService } from '../ledger/service';
import { LedgerEntryDraftSchema } from '../shared/ledger';
import { createSafeBackup } from './backup';
import { restoreSafeBackup } from './restore';
import { RemoteState } from './state';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'calendar-restore-test-')), data = join(root, 'original');
  const repository = createRepository(join(data, 'planner.sqlite'), { automaticBackup: () => {} });
  const ledger = createLedgerService(repository.path, { now: () => new Date('2020-01-03T12:00:00Z') });
  repository.transact(state => {
    const source = newEntity(state, 'source', { kind: 'text', text: 'SYNTHETIC-PRIVATE-ORIGINAL', importedAt: '2020-01-01T10:00:00+08:00', status: 'succeeded' });
    const candidate = newEntity(state, 'candidate', { title: '虚构提炼结果', sourceIds: [source.id], sourceQuote: 'SYNTHETIC-PRIVATE-ORIGINAL' });
    const goal = newEntity(state, 'goal', { title: '虚构学习目标' });
    const task = newEntity(state, 'task', { title: '虚构待办', goalId: goal.id, candidateId: candidate.id });
    newEntity(state, 'block', { title: '虚构执行时段', kind: 'work', taskId: task.id, start: '2027-01-02T10:00:00+08:00', end: '2027-01-02T10:45:00+08:00' });
  });
  const entry = LedgerEntryDraftSchema.parse({ id: 'fixture-expense', kind: 'expense', date: '2020-01-02', month: '2020-01', title: '虚构午餐', category: '餐饮', amountCents: 1000, personalCents: 500, cashflows: [{ accountId: 'alipay', deltaCents: -1000 }] });
  ledger.mutate({ operationId: 'fixture-entry', expectedRevision: 0, changes: [{ type: 'putEntry', expectedVersion: null, entry, confirmDuplicate: false, note: '' }] });
  ledger.mutate({ operationId: 'fixture-balance', expectedRevision: 1, changes: [{ type: 'setBalance', snapshot: { id: 'fixture-balance', accountId: 'alipay', balanceCents: 9000, date: '2020-01-02', asOf: null, coveredEntryIds: [entry.id], note: '虚构历史余额', sourceId: null } }] });
  const state = new RemoteState(join(data, 'remote-state.sqlite')); const oldIdentity = state.identity(), oldToken = state.pair(state.createPairingCode(), '旧虚构设备').token; state.close();
  writeFileSync(join(data, 'notifications.sqlite'), 'SYNTHETIC-VAPID-NOT-A-BACKUP');
  const file = createSafeBackup({ repository, ledger, directory: join(root, 'exports') });
  const originalState = repository.read(), originalLedger = ledger.exportJson();
  ledger.close(); repository.close();
  return { root, data, file, originalState, originalLedger, oldIdentity, oldToken };
}
describe('safe backup restore into a new authority', () => {
  it('restores task/goal/candidate/block relationships and complete ledger balances without restoring sessions or secrets', () => {
    const value = fixture();
    try {
      const originalBytes = readFileSync(value.file), target = join(value.root, 'restored');
      const restored = restoreSafeBackup({ backupFile: value.file, dataDirectory: target });
      expect(restored).toMatchObject({ taskCount: 1, ledgerEntryCount: 1 }); expect(restored.identity.dataInstanceId).not.toBe(value.oldIdentity.dataInstanceId); expect(restored.identity.generation).toBe(1);
      const repository = createRepository(join(target, 'planner.sqlite'), { automaticBackup: () => {} }), ledger = createLedgerService(repository.path), state = new RemoteState(join(target, 'remote-state.sqlite'));
      try {
        const snapshot = repository.snapshot();
        expect(snapshot.tasks).toEqual(value.originalState.entities.task); expect(snapshot.goals).toEqual(value.originalState.entities.goal); expect(snapshot.blocks).toEqual(value.originalState.entities.block);
        expect(snapshot.tasks[0]!.goalId).toBe(snapshot.goals[0]!.id); expect(snapshot.tasks[0]!.candidateId).toBe(snapshot.candidates[0]!.id); expect(snapshot.blocks[0]!.taskId).toBe(snapshot.tasks[0]!.id); expect(snapshot.candidates[0]!.sourceIds).toEqual([snapshot.sources[0]!.id]);
        expect(JSON.stringify(snapshot)).not.toContain('SYNTHETIC-PRIVATE-ORIGINAL'); expect(ledger.exportJson()).toEqual(value.originalLedger); expect(ledger.snapshot('2020-01').balanceSnapshots[0]!.balanceCents).toBe(9000);
        expect(state.devices()).toEqual([]); expect(state.session(value.oldToken)).toBeNull(); expect(existsSync(join(target, 'notifications.sqlite'))).toBe(false); expect(readdirSync(target).some(name => /credentials|key|secret/.test(name))).toBe(false);
      } finally { state.close(); ledger.close(); repository.close(); }
      expect(readFileSync(value.file)).toEqual(originalBytes); expect(existsSync(join(value.data, 'planner.sqlite'))).toBe(true);
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('accepts an existing empty target but rejects a nonempty store without changing either original', () => {
    const value = fixture();
    try {
      const empty = join(value.root, 'empty'); mkdirSync(empty); restoreSafeBackup({ backupFile: value.file, dataDirectory: empty }); expect(existsSync(join(empty, 'planner.sqlite'))).toBe(true);
      const old = readFileSync(join(value.data, 'planner.sqlite'));
      expect(() => restoreSafeBackup({ backupFile: value.file, dataDirectory: value.data })).toThrow(/不会覆盖/); expect(readFileSync(join(value.data, 'planner.sqlite'))).toEqual(old);
      expect(() => restoreSafeBackup({ backupFile: 'relative.json', dataDirectory: join(value.root, 'other') })).toThrow(/绝对/);
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('rejects unsupported, malformed planner and invalid ledger relationships before leaving a target or staging directory', () => {
    const value = fixture();
    try {
      const input = JSON.parse(readFileSync(value.file, 'utf8')), target = join(value.root, 'must-stay-absent'), invalid = join(value.root, 'invalid.json');
      const variants = [
        { ...input, formatVersion: 999 },
        { ...input, sessions: [{ token: 'forbidden' }] },
        { ...input, planner: { ...input.planner, schemaVersion: 999 } },
        { ...input, planner: { ...input.planner, entities: { ...input.planner.entities, task: input.planner.entities.task.map((task: object) => ({ ...task, goalId: 'missing-goal' })) } } },
        { ...input, ledger: { ...input.ledger, balanceSnapshots: input.ledger.balanceSnapshots.map((snapshot: object) => ({ ...snapshot, coveredEntryIds: ['missing-entry'] })) } },
      ];
      for (const item of variants) {
        writeFileSync(invalid, JSON.stringify(item)); expect(() => restoreSafeBackup({ backupFile: invalid, dataDirectory: target })).toThrow(); expect(existsSync(target)).toBe(false); expect(readdirSync(value.root).some(name => name.startsWith('.calendar-restore-'))).toBe(false);
      }
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('restores legacy null course and goal colors with matching undo images and preserves the backup', () => {
    const value = fixture();
    try {
      const input = JSON.parse(readFileSync(value.file, 'utf8'));
      const goal = input.planner.entities.goal[0];
      goal.color = null;
      const course = CourseSchema.parse({ id: 'synthetic-course', version: 2, createdAt: goal.createdAt, updatedAt: goal.updatedAt,
        title: '合成课程', weekday: 1, startTime: '09:00', endTime: '10:00', firstWeek: 1, lastWeek: 16, termStart: '2026-09-07', color: null });
      input.planner.entities.course.push(course);
      const details = [{ entity: 'goal', id: goal.id, before: null, after: goal }, { entity: 'course', id: course.id, before: null, after: course }];
      input.planner.journal.push({ id: 'old-journal', operationId: 'old-operation', createdAt: goal.createdAt, origin: 'manual', message: '',
        changes: [], undoneAt: null, undoable: true, details, undoExpected: details });
      const file = join(value.root, 'legacy-colors.json'), target = join(value.root, 'restored');
      writeFileSync(file, JSON.stringify(input));
      const bytes = readFileSync(file);
      restoreSafeBackup({ backupFile: file, dataDirectory: target });
      const repository = createRepository(join(target, 'planner.sqlite'), { automaticBackup() {} });
      try {
        const { goals, courses } = repository.snapshot();
        const restoredGoal = goals[0]!, restoredCourse = courses[0]!;
        expect(restoredGoal).toEqual({ ...goal, color: expect.any(String) });
        expect(restoredCourse).toEqual({ ...course, color: expect.any(String) });
        const journal = repository.read().journal.find(record => record.id === 'old-journal')!;
        for (const images of [journal.details, journal.undoExpected!]) {
          expect(images.map(detail => detail.after)).toEqual([restoredGoal, restoredCourse]);
        }
      } finally { repository.close(); }
      expect(readFileSync(file)).toEqual(bytes);
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('rejects changed persisted business data and cleans only its newly created staging directory', () => {
    const value = fixture();
    const open = storage.createRepository;
    const inject = vi.spyOn(storage, 'createRepository').mockImplementationOnce((path, options) => {
      const repo = open(path, options);
      const db = openDatabase(path);
      try {
        db.exec(`CREATE TRIGGER damage_restored_goal AFTER INSERT ON records WHEN NEW.kind='goal'
          BEGIN UPDATE records SET payload=json_set(payload,'$.title','corrupted goal') WHERE kind=NEW.kind AND id=NEW.id; END;`);
      } finally { db.close(); }
      return repo;
    });
    try {
      const file = value.file;
      const bytes = readFileSync(file), target = join(value.root, 'failed-target');
      expect(() => restoreSafeBackup({ backupFile: file, dataDirectory: target })).toThrow(/核对不一致/);
      expect(existsSync(target)).toBe(false); expect(readdirSync(value.root).some(name => name.startsWith('.calendar-restore-'))).toBe(false); expect(readFileSync(file)).toEqual(bytes); expect(existsSync(join(value.data, 'planner.sqlite'))).toBe(true);
    } finally { inject.mockRestore(); rmSync(value.root, { recursive: true, force: true }); }
  });
});
