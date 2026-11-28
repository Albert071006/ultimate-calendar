import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPlanner } from '../domain/planner';
import { MutationRequestSchema, type FocusSessionInput, type MutationInput, type MutationResult } from '../shared/contracts';
import { createBackup, inspectBackup, restoreBackup } from './backups';
import { createRepository, type Repository } from './repository';

const repositories: Repository[] = [], directories: string[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const values: FocusSessionInput = {
  title: '练习节奏', mode: 'manual', start: '2026-11-07T10:00:00+08:00',
  end: '2026-11-07T10:10:00+08:00', durationSeconds: 420, note: '中途休息',
};
function open(path = ':memory:') {
  const repository = createRepository(path, { automaticBackup: () => {} });
  repositories.push(repository);
  const planner = createPlanner(repository, { automaticBackup: () => {} });
  const mutate = (...mutations: MutationInput[]) => planner.mutate(MutationRequestSchema.parse({
    operationId: randomUUID(), origin: 'manual', mutations,
  }));
  const confirm = (result: MutationResult) => {
    if (result.status !== 'preview') throw Error(result.message);
    return planner.mutate({ ...result.proposedRequest, confirmed: true, confirmationToken: result.confirmationToken });
  };
  return { repository, planner, mutate, confirm };
}
function linkedFixture() {
  const f = open();
  f.mutate({ type: 'create', entity: 'course', values: { title: '节奏课', weekday: 1, termStart: '2026-11-02', firstWeek: 1, lastWeek: 4, startTime: '15:00', endTime: '16:00' } });
  f.mutate({ type: 'create', entity: 'goal', values: { title: '完成练习册' } });
  const course = f.planner.snapshot().courses[0]!, goal = f.planner.snapshot().goals[0]!;
  f.mutate({ type: 'create', entity: 'task', values: { title: '练习', courseId: course.id, goalId: goal.id } });
  const task = f.planner.snapshot().tasks[0]!;
  f.mutate({ type: 'create', entity: 'block', values: { title: '练习时段', kind: 'work', start: values.start, end: values.end, taskId: task.id } });
  const block = f.planner.snapshot().blocks[0]!;
  return { ...f, task, block, links: { taskId: task.id, blockId: block.id, courseId: course.id, goalId: goal.id } };
}

it('previews, commits, replays and undoes a mixed focus/task/block transaction as a unit', () => {
  const f = linkedFixture();
  const request = MutationRequestSchema.parse({ operationId: 'focus-mixed', origin: 'manual', mutations: [
    { type: 'createFocusSession', values: { ...values, ...f.links } },
    { type: 'update', entity: 'task', id: f.task.id, expectedVersion: 1, values: { description: '完成练习' } },
    { type: 'update', entity: 'block', id: f.block.id, expectedVersion: 1, values: { completed: true } },
  ] });
  const baseline = f.planner.snapshot();
  const preview = f.planner.mutate(request);
  expect(preview.status).toBe('preview');
  expect(f.planner.snapshot()).toEqual(baseline);
  const applied = f.confirm(preview);
  expect(applied.status).toBe('applied');
  expect(f.planner.mutate(request)).toEqual(applied);
  const latest = f.planner.snapshot();
  expect(latest.focusSessions).toHaveLength(1);
  expect(latest.focusSessions[0]).toMatchObject({ ...values, ...f.links, version: 1 });
  expect(latest.tasks[0]).toMatchObject({ status: 'done', description: '完成练习' });
  expect(latest.blocks[0]!.completed).toBe(true);
  expect(latest.journal[0]!.changes.map(change => change.entity).sort()).toEqual(['block', 'focusSession', 'task']);
  expect(f.planner.undo().status).toBe('applied');
  const undone = f.planner.snapshot();
  expect(undone.focusSessions).toEqual([]);
  expect(undone.tasks[0]).toMatchObject({ status: f.task.status, description: f.task.description });
  expect(undone.blocks[0]!.completed).toBe(f.block.completed);
  const beforeFailure = f.planner.snapshot();
  const stale = f.planner.mutate({ ...request, operationId: 'focus-stale' });
  expect(stale).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'version', entity: 'task' }] });
  expect(f.planner.snapshot()).toEqual(beforeFailure);
});

it('validates the merged session, protects optimistic versions, and restores deletes and edits', () => {
  const f = open();
  f.mutate({ type: 'createFocusSession', values });
  const first = f.planner.snapshot().focusSessions[0]!;
  const target = { id: first.id, expectedVersion: 1 };
  expect(f.mutate({ type: 'updateFocusSession', ...target, values: { end: values.start } }).status).toBe('clarification');
  expect(f.mutate({ type: 'updateFocusSession', ...target, values: { durationSeconds: 601 } }).status).toBe('clarification');
  for (const key of ['taskId', 'blockId', 'courseId', 'goalId']) {
    expect(f.mutate({ type: 'updateFocusSession', ...target, values: { [key]: 'unknown' } }).status).toBe('clarification');
  }
  expect(f.planner.snapshot().focusSessions).toEqual([first]);
  f.mutate({ type: 'updateFocusSession', ...target, values: { title: '更正练习', durationSeconds: 480 } });
  expect(f.planner.snapshot().focusSessions[0]).toMatchObject({ ...values, title: '更正练习', durationSeconds: 480, version: 2 });
  for (const result of [
    f.mutate({ type: 'deleteFocusSession', ...target }),
    f.mutate({ type: 'updateFocusSession', ...target, values: { note: '' } }),
  ]) expect(result).toMatchObject({ status: 'clarification', conflicts: [{ kind: 'version', entity: 'focusSession' }] });
  f.mutate({ type: 'deleteFocusSession', ...target, expectedVersion: 2 });
  expect(f.planner.snapshot().focusSessions).toEqual([]);
  expect(f.planner.undo().status).toBe('applied');
  expect(f.planner.snapshot().focusSessions[0]).toMatchObject({ id: first.id, title: '更正练习', version: 3 });
  expect(f.planner.undo().status).toBe('applied');
  expect(f.planner.snapshot().focusSessions[0]).toMatchObject({ ...values, id: first.id, version: 4 });
});

it.each(['task', 'block', 'goal', 'course', 'removeTask'] as const)('detaches only the removed %s links and restores them with its undo', kind => {
  const f = linkedFixture();
  f.mutate({ type: 'createFocusSession', values: { ...values, ...f.links } });
  const before = f.planner.snapshot().focusSessions[0]!;
  const target = kind === 'removeTask' ? 'task' : kind;
  const id = f.links[`${target}Id`];
  const result = kind === 'removeTask' ? f.mutate({ type: 'removeTask', id, expectedVersion: 1, includeLinkedBlocks: true })
    : kind === 'course' ? f.mutate({ type: 'delete', entity: 'course', id, expectedVersion: 1, scope: 'all' })
      : f.mutate({ type: 'delete', entity: kind, id, expectedVersion: 1 });
  expect(f.confirm(result).status).toBe('applied');
  const detached = { ...f.links, [`${target}Id`]: null, ...(kind === 'removeTask' ? { blockId: null } : {}) };
  expect(f.planner.snapshot().focusSessions).toMatchObject([{ ...values, ...detached, id: before.id }]);
  expect(f.planner.undo().status).toBe('applied');
  expect(f.planner.snapshot().focusSessions).toMatchObject([{ ...values, ...f.links, id: before.id }]);
});

it('moves direct course links along with task links when a course is replaced from its first week', () => {
  const f = linkedFixture();
  f.mutate({ type: 'createFocusSession', values: { ...values, ...f.links } });
  const result = f.mutate({ type: 'update', entity: 'course', id: f.links.courseId, expectedVersion: 1,
    values: { title: '节奏二班' }, scope: 'this-and-following', occurrenceDate: '2026-11-02' });
  expect(f.confirm(result).status).toBe('applied');
  const updated = f.planner.snapshot();
  expect(updated.courses).toHaveLength(1);
  expect(updated.courses[0]!.id).not.toBe(f.links.courseId);
  expect(updated.tasks[0]!.courseId).toBe(updated.courses[0]!.id);
  expect(updated.focusSessions[0]!.courseId).toBe(updated.courses[0]!.id);
  expect(f.planner.undo().status).toBe('applied');
  expect(f.planner.snapshot().focusSessions[0]!.courseId).toBe(f.links.courseId);
});

it('preserves focus history when a revised notice removes its event, and reattaches it on undo', () => {
  const f = open();
  const source = f.repository.writeInternal({ operationId: 'source', changes: [
    { entity: 'source', values: { kind: 'text', text: '合成练习通知', importedAt: values.start } },
  ] }).entities[0]!;
  const candidate = (operationId: string, timing: { eventStart: string } | { revisionOfId: string }) =>
    f.repository.writeInternal({ operationId, changes: [{ entity: 'candidate', values: { title: '自主练习', sourceIds: [source.id], ...timing } }] }).entities[0]!;
  const initial = candidate('first-notice', { eventStart: values.start });
  expect(f.mutate({ type: 'acceptCandidate', id: initial.id, expectedVersion: 1 }).status).toBe('applied');
  const task = f.planner.snapshot().tasks[0]!, block = f.planner.snapshot().blocks[0]!;
  f.mutate({ type: 'createFocusSession', values: { ...values, taskId: task.id, blockId: block.id } });
  const revision = candidate('revised-notice', { revisionOfId: initial.id });
  expect(f.confirm(f.mutate({ type: 'acceptCandidate', id: revision.id, expectedVersion: 1 })).status).toBe('applied');
  expect(f.planner.snapshot().blocks).toEqual([]);
  expect(f.planner.snapshot().focusSessions).toMatchObject([{ ...values, blockId: null, taskId: task.id }]);
  expect(f.planner.undo().status).toBe('applied');
  expect(f.planner.snapshot().focusSessions).toMatchObject([{ ...values, blockId: block.id, taskId: task.id }]);
});

it('keeps a newer session intact when the user tries to undo creation of its parent', () => {
  const f = open();
  const creation = f.mutate({ type: 'create', entity: 'goal', values: { title: '练习目标' } });
  if (creation.status !== 'applied') throw Error(creation.message);
  f.mutate({ type: 'createFocusSession', values: { ...values, goalId: f.planner.snapshot().goals[0]!.id } });
  const before = f.planner.snapshot();
  expect(f.planner.undo(creation.transactionId).status).toBe('clarification');
  expect(f.planner.snapshot()).toEqual(before);
});

it('reads an old SQLite backup before migration, restores it, migrates idempotently, and round-trips a current backup', () => {
  const dir = mkdtempSync(join(process.cwd(), '.focus-storage-test-'));
  directories.push(dir);
  const oldPath = join(dir, 'legacy.sqlite'), backupPath = join(dir, 'new.sqlite');
  const legacy = open(oldPath);
  legacy.mutate({ type: 'create', entity: 'task', values: { title: '旧练习' } });
  legacy.repository.saveSettings({ campus: '合成校区' });
  const oldTask = legacy.planner.snapshot().tasks[0]!;
  legacy.repository.close();
  const db = new DatabaseSync(oldPath);
  try {
    db.exec(`DROP TABLE focus_sessions;
      UPDATE settings SET payload=json_remove(payload,'$.focusMinutes','$.shortBreakMinutes','$.longBreakMinutes','$.pomodorosBeforeLongBreak','$.focusSoundEnabled')`);
  } finally { db.close(); }
  const destination = open(join(dir, 'destination.sqlite'));
  destination.mutate({ type: 'createFocusSession', values });
  expect(inspectBackup(oldPath).entities.focusSession).toEqual([]);
  restoreBackup(destination.repository, oldPath);
  expect(destination.planner.snapshot()).toMatchObject({ tasks: [oldTask], focusSessions: [], settings: { campus: '合成校区', focusMinutes: 25 } });
  expect(destination.planner.undo().status).toBe('applied');
  const migrated = open(oldPath);
  expect(migrated.planner.snapshot().tasks).toEqual([oldTask]);
  migrated.repository.saveSettings({ ...migrated.planner.snapshot().settings, focusMinutes: 35, focusSoundEnabled: false });
  migrated.mutate({ type: 'createFocusSession', values: { ...values, taskId: oldTask.id } });
  const session = migrated.planner.snapshot().focusSessions[0]!;
  migrated.repository.close();
  const reopened = open(oldPath);
  expect(reopened.planner.snapshot().focusSessions).toEqual([session]);
  createBackup(reopened.repository, backupPath);
  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  try {
    expect(backupDb.prepare('SELECT id FROM focus_sessions').all()).toEqual([{ id: session.id }]);
    expect(backupDb.prepare("SELECT id FROM records WHERE kind='focusSession'").all()).toEqual([]);
  } finally { backupDb.close(); }
  restoreBackup(destination.repository, backupPath);
  expect(destination.planner.snapshot()).toMatchObject({ tasks: [oldTask], focusSessions: [session], settings: { campus: '合成校区', focusMinutes: 35, focusSoundEnabled: false } });
  expect(destination.planner.undo().status).toBe('applied');
  expect(destination.planner.snapshot().focusSessions).toEqual([]);
});

it('rejects a focus session misfiled in the generic records table', () => {
  const dir = mkdtempSync(join(process.cwd(), '.focus-storage-test-'));
  directories.push(dir);
  const path = join(dir, 'misfiled.sqlite'), f = open(path);
  f.mutate({ type: 'createFocusSession', values });
  f.repository.close();
  const db = new DatabaseSync(path);
  try {
    db.exec("INSERT INTO records(kind,id,payload) SELECT 'focusSession',id,payload FROM focus_sessions; DELETE FROM focus_sessions");
  } finally { db.close(); }
  expect(() => inspectBackup(path)).toThrow('focus_sessions');
  expect(() => open(path)).toThrow('focus_sessions');
});
