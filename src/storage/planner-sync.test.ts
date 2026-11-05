import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createRepository, type Repository } from './repository';
import { createPlanner } from '../domain/planner';
import { applyPlannerPatch, legacyPlannerSyncResult } from '../shared/planner-sync';
import type { PlannerCursor, Snapshot } from '../shared/contracts';

const roots: string[] = [], repositories: Repository[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) { const part = relative(tmpdir(), root); if (!part || part.startsWith('..') || isAbsolute(part)) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planner-incremental-')); roots.push(root);
  const path = join(root, 'planner.sqlite');
  const open = () => { const repository = createRepository(path, { automaticBackup: () => {} }); repositories.push(repository); return repository; };
  const repository = open(), planner = createPlanner(repository, { automaticBackup: () => {} });
  return { repository, planner, open };
}
function patch(repository: Repository, cursor: PlannerCursor) {
  const result = repository.changes(cursor); if (result.status !== 'patch') throw Error('Expected continuous patch'); return result.patch;
}

describe('durable planner incremental state', () => {
  it('reads snapshot records and cursor consistently while another connection commits', () => {
    const f = fixture(), writer = f.open(), before = f.repository.snapshot();
    const prepare = DatabaseSync.prototype.prepare;
    let injected = false;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql === 'SELECT kind,id,payload FROM records ORDER BY rowid' && !injected) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          const rows = all(...args); injected = true;
          writer.saveSettings({ ...before.settings, campus: 'Committed by another connection' });
          return rows;
        });
      }
      return statement;
    });
    expect(f.repository.snapshot()).toEqual(before);
    expect(injected).toBe(true);
    expect(f.repository.snapshot().settings.campus).toBe('Committed by another connection');
    expect(f.repository.cursor().revision).toBe(before.cursor!.revision + 1);
    // These reads are also valid from inside a business transaction.
    expect(() => f.repository.transact(() => { f.repository.snapshot(); f.repository.changes(before.cursor!); })).not.toThrow();
  });

  it('reads the change cursor and retained log from one snapshot across another commit', () => {
    const f = fixture(), writer = f.open(), before = f.repository.snapshot();
    f.repository.saveSettings({ ...before.settings, campus: 'First revision' });
    const first = f.repository.snapshot(), prepare = DatabaseSync.prototype.prepare;
    let injected = false;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql === 'SELECT payload FROM planner_sync_meta WHERE id=1' && !injected) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, 'get').mockImplementation((...args) => {
          const row = get(...args); injected = true;
          writer.saveSettings({ ...before.settings, campus: 'Second revision' });
          return row;
        });
      }
      return statement;
    });
    const firstPatch = patch(f.repository, before.cursor!);
    expect(firstPatch.to).toEqual(first.cursor);
    expect(applyPlannerPatch(before, firstPatch)).toEqual(first);
    const final = f.repository.snapshot();
    expect(applyPlannerPatch(first, patch(f.repository, first.cursor!))).toEqual(final);
  });

  it('includes every linked record when accepting a candidate and when undoing that acceptance', () => {
    const { repository, planner } = fixture();
    const source = repository.writeInternal({ operationId: 'source', changes: [{ entity: 'source', values: { kind: 'text', text: 'Synthetic meeting', importedAt: '2030-01-01T10:00:00+08:00' } }] }).entities[0]!;
    const candidate = repository.writeInternal({ operationId: 'candidate', changes: [{ entity: 'candidate', values: { title: 'Synthetic meeting', sourceIds: [source.id], eventStart: '2030-01-02T10:00:00+08:00' } }] }).entities[0]!;
    const before = repository.snapshot();
    const request = { operationId: 'accept', origin: 'manual' as const, confirmed: false, mutations: [{ type: 'acceptCandidate' as const, id: candidate.id, expectedVersion: candidate.version }] };
    const applied = planner.mutate(request); expect(applied.status).toBe('applied');
    const delta = patch(repository, before.cursor!);
    expect(delta.entities.map(value => value.entity)).toEqual(expect.arrayContaining(['candidate', 'task', 'block', 'feedback']));
    expect(applyPlannerPatch(before, delta)).toEqual(repository.snapshot());
    const revision = repository.cursor(); planner.mutate(request); expect(repository.cursor()).toEqual(revision);
    const accepted = repository.snapshot();
    if (applied.status !== 'applied') throw Error('Expected applied');
    planner.undo(applied.transactionId);
    const undo = patch(repository, accepted.cursor!);
    expect(undo.entities.some(value => value.value === null && value.entity === 'task')).toBe(true);
    expect(applyPlannerPatch(accepted, undo)).toEqual(repository.snapshot());
  });

  it('keeps revisions and changes across restart, including settings, while no-ops and rollbacks do not advance them', () => {
    const f = fixture(), initial = f.repository.snapshot();
    f.repository.transact(() => {}); expect(f.repository.cursor()).toEqual(initial.cursor);
    expect(() => f.repository.transact(state => { state.settings.campus = 'rolled back'; throw Error('abort'); })).toThrow('abort');
    expect(f.repository.cursor()).toEqual(initial.cursor);
    f.repository.saveSettings({ ...initial.settings, campus: 'Synthetic campus' });
    const saved = f.repository.snapshot(); f.repository.close();
    const reopened = f.open(); expect(reopened.cursor()).toEqual(saved.cursor);
    expect(applyPlannerPatch(initial, patch(reopened, initial.cursor!))).toEqual(saved);
  });

  it('rejects missing history and old restored streams instead of silently skipping revisions', () => {
    const { repository } = fixture(), initial = repository.snapshot();
    for (let index = 0; index < 258; index += 1) repository.saveSettings({ ...initial.settings, campus: `Synthetic ${index}` });
    expect(repository.changes(initial.cursor!)).toEqual({ status: 'reset' });
    const beforeRestore = repository.cursor(); repository.replaceState(repository.read());
    expect(repository.cursor().streamId).not.toBe(beforeRestore.streamId);
    expect(repository.changes(beforeRestore)).toEqual({ status: 'reset' });
  });

  it('ignores duplicate or late patches and detects a skipped revision', () => {
    const { repository } = fixture(), before = repository.snapshot();
    repository.saveSettings({ ...before.settings, campus: 'First' }); const first = patch(repository, before.cursor!);
    const middle = applyPlannerPatch(before, first)!;
    repository.saveSettings({ ...before.settings, campus: 'Second' }); const second = patch(repository, middle.cursor!);
    expect(applyPlannerPatch(before, second)).toBeNull();
    const latest = applyPlannerPatch(middle, second)!;
    expect(applyPlannerPatch(latest, first)).toBe(latest);
    expect(applyPlannerPatch(latest, second)).toBe(latest);
  });

  it('keeps the old strict HTTP response shape for clients without incremental support', () => {
    const { repository } = fixture(), data = repository.snapshot();
    const value = legacyPlannerSyncResult('snapshot', { ok: true, data, sync: patch(repository, data.cursor!) }) as { data: Snapshot; sync?: unknown };
    expect(value.data.cursor).toBeUndefined(); expect(value.sync).toBeUndefined();
    expect(data.cursor).toBeDefined();
  });

  it('returns a small committed response for a synthetic large calendar instead of its full history', () => {
    const { repository, planner } = fixture();
    repository.writeInternal({ operationId: 'synthetic-bulk', changes: Array.from({ length: 800 }, (_, index) => ({ entity: 'task' as const, values: { title: `Synthetic task ${index}`, description: 'Synthetic background information. '.repeat(20) } })) });
    repository.transact(state => {
      for (let index = 0; index < 1000; index += 1) state.usage.push({ id: `usage-${index}`, operationId: `synthetic-call-${index}`, createdAt: '2030-01-01T10:00:00+08:00', model: 'synthetic', purpose: 'source', inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, totalTokens: 110, estimatedCost: null, currency: null });
    });
    const before = repository.snapshot(), task = before.tasks[0]!;
    const result = planner.mutate({ operationId: 'synthetic-completion', origin: 'manual', confirmed: false, mutations: [{ type: 'finishTask', id: task.id, expectedVersion: task.version, completed: true }] });
    const sync = patch(repository, before.cursor!);
    const fullBytes = Buffer.byteLength(JSON.stringify({ ok: true, data: repository.snapshot() }));
    const committedBytes = Buffer.byteLength(JSON.stringify({ ok: true, data: result, sync }));
    expect(committedBytes / fullBytes).toBeLessThan(0.02);
    expect(applyPlannerPatch(before, sync)).toEqual(repository.snapshot());
    console.info(JSON.stringify({ benchmark: 'synthetic-calendar-sync', tasks: 800, usageRows: 1000, fullSnapshotBytes: fullBytes, committedResponseBytes: committedBytes, reductionPercent: Number((100 * (1 - committedBytes / fullBytes)).toFixed(2)) }));
  });
});
