import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { apiResultSchema, MutationRequestSchema, MutationResultSchema, type MutationRequestInput, type MutationResult } from '../shared/contracts';
import { PLAN_FILE_EXAMPLE, type PlanFileInput } from '../shared/plan-import';
import { createPlanImportService } from './service';
import { createWriteJournal } from '../remote/write-journal';
import type { NodeRemoteClient } from '../remote/node-client';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.restoreAllMocks(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'plan-import-unit-'));
  cleanup.push(() => { const delta = relative(tmpdir(), directory); if (!delta || delta.startsWith('..') || isAbsolute(delta)) throw Error('Unsafe synthetic cleanup'); rmSync(directory, { recursive: true, force: true }); });
  const repository = createRepository(join(directory, 'synthetic.sqlite'), { automaticBackup: () => {} }); cleanup.push(() => repository.close());
  const planner = createPlanner(repository, { automaticBackup: () => {} });
  const mutate = vi.fn(async (input: MutationRequestInput): Promise<MutationResult> => planner.mutate(MutationRequestSchema.parse(input)));
  const scope = vi.fn(async () => 'synthetic:origin:device:generation-1');
  const options = { directory, snapshot: async () => planner.snapshot(), mutate, scope };
  return { directory, repository, planner, mutate, scope, options, service: createPlanImportService(options), plan: structuredClone(PLAN_FILE_EXAMPLE) };
}
async function run(f: ReturnType<typeof fixture>, plan: PlanFileInput = f.plan, allowConflicts = false) {
  const preview = await f.service.preview(plan); return f.service.confirm({ token: preview.token, allowConflicts });
}
function insert(f: ReturnType<typeof fixture>, mutations: MutationRequestInput['mutations']) {
  const result = f.planner.mutate(MutationRequestSchema.parse({ operationId: crypto.randomUUID(), origin: 'manual', mutations }));
  if (result.status !== 'applied') throw Error(result.message); return result;
}

describe('JSON plan creation coordinator', () => {
  it('previews without writing, then creates linked goals, tasks, blocks and resource references', async () => {
    const f = fixture(), preview = await f.service.preview(f.plan);
    expect(f.mutate).not.toHaveBeenCalled(); expect(preview.rows.map(row => row.state)).toEqual(['new', 'new', 'new']);
    expect(preview.rows[0]!.detail).toContain('2026-11-08'); expect(preview.rows[1]!.detail).toContain('截止'); expect(preview.rows[2]!.detail).toContain('阅读第一章');
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ status: 'complete', applied: 3, remaining: 0 });
    const saved = f.planner.snapshot();
    expect(saved.tasks[0]!.goalId).toBe(saved.goals[0]!.id); expect(saved.blocks[0]!.taskId).toBe(saved.tasks[0]!.id);
    expect(saved.goals[0]!.resources).toEqual(f.plan.resources);
    expect((await f.service.preview(f.plan)).rows.every(row => row.state === 'existing')).toBe(true);
    expect(await run(f)).toMatchObject({ status: 'complete', applied: 0 }); expect(f.mutate).toHaveBeenCalledTimes(3);
  });

  it('retains receipts across restart, rejects changed content/scope, and does not merge by title', async () => {
    const f = fixture(); insert(f, [{ type: 'create', entity: 'goal', values: { title: f.plan.goals![0]!.title } }]);
    await run(f); expect(f.planner.snapshot().goals).toHaveLength(2);
    f.service = createPlanImportService(f.options); expect(await run(f)).toMatchObject({ applied: 0 });
    const changed = structuredClone(f.plan); changed.tasks![0]!.title = '不同内容';
    await expect(f.service.preview(changed)).rejects.toThrow(/planId.*改变/);
    f.scope.mockResolvedValue('synthetic:origin:device:generation-2');
    await expect(f.service.preview(f.plan)).rejects.toThrow(/资料代际/);
  });

  it('protects edited/deleted imported records and blocks their new dependents', async () => {
    const f = fixture(); await run(f); const saved = f.planner.snapshot();
    insert(f, [{ type: 'update', entity: 'goal', id: saved.goals[0]!.id, expectedVersion: saved.goals[0]!.version, values: { title: '用户修改后的目标' } }]);
    const deletion = f.planner.mutate(MutationRequestSchema.parse({ operationId: 'synthetic-delete', origin: 'manual', mutations: [{ type: 'delete', entity: 'block', id: saved.blocks[0]!.id, expectedVersion: 1 }] }));
    if (deletion.status === 'preview') f.planner.mutate({ ...deletion.proposedRequest, confirmed: true, confirmationToken: deletion.confirmationToken });
    const preview = await f.service.preview(f.plan); expect(preview.rows.map(row => row.state)).toEqual(['blocked', 'existing', 'blocked']);
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ status: 'partial', applied: 0, remaining: 2 });
    expect(f.planner.snapshot().goals[0]!.title).toBe('用户修改后的目标'); expect(f.planner.snapshot().blocks).toHaveLength(0);
  });

  it('validates external dependencies and rejects stale confirmation before any writes', async () => {
    const f = fixture(), plan: PlanFileInput = { ...f.plan, planId: 'external-links', goals: [], tasks: [{ id: 't', title: '引用不存在的目标', goalId: 'missing-goal' }], blocks: [] };
    expect((await f.service.preview(plan)).rows[0]!.state).toBe('blocked');
    const preview = await f.service.preview(f.plan); insert(f, [{ type: 'create', entity: 'task', values: { title: '外部新增' } }]);
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ status: 'partial', applied: 0 });
    expect(f.mutate).not.toHaveBeenCalled();
  });

  it('resumes an applied-but-lost response with the original request and never recreates it', async () => {
    const f = fixture(); let lose = true;
    f.mutate.mockImplementation(async input => { const result = f.planner.mutate(MutationRequestSchema.parse(input)); if (lose) { lose = false; throw Error('synthetic response lost'); } return result; });
    expect(await run(f)).toMatchObject({ status: 'partial' }); expect(f.planner.snapshot().goals).toHaveLength(1);
    const pending = JSON.parse(readFileSync(join(f.directory, 'plan-import-receipts.json'), 'utf8')).pending;
    f.service = createPlanImportService(f.options);
    expect(await run(f)).toMatchObject({ status: 'complete' });
    expect(f.mutate.mock.calls[1]![0]).toEqual(pending.request);
    expect(f.planner.snapshot().goals).toHaveLength(1); expect(f.planner.snapshot().tasks).toHaveLength(1); expect(f.planner.snapshot().blocks).toHaveLength(1);
  });

  it('requires explicit approval for an overlap and persists the exact confirmed request after response loss', async () => {
    const f = fixture(); insert(f, [{ type: 'create', entity: 'block', values: { title: '已有安排', kind: 'event', start: '2026-11-02T19:30:00+08:00', end: '2026-11-02T20:30:00+08:00' } }]);
    const preview = await f.service.preview(f.plan); expect(preview.conflicts).toHaveLength(1);
    expect(await f.service.confirm({ token: preview.token })).toMatchObject({ applied: 0, status: 'partial' });
    let lose = true;
    f.mutate.mockImplementation(async input => { const result = f.planner.mutate(MutationRequestSchema.parse(input)); if (input.confirmed && result.status === 'applied' && lose) { lose = false; throw Error('synthetic confirmed response lost'); } return result; });
    expect(await run(f, f.plan, true)).toMatchObject({ status: 'partial' });
    const pending = JSON.parse(readFileSync(join(f.directory, 'plan-import-receipts.json'), 'utf8')).pending;
    expect(pending.request.confirmed).toBe(true); expect(pending.request.confirmationToken).toBeTruthy();
    f.service = createPlanImportService(f.options); const count = f.mutate.mock.calls.length;
    const retry = await f.service.preview(f.plan); expect(retry.rows.at(-1)!.state).toBe('new'); expect(retry.conflicts).toEqual([]);
    expect(await f.service.confirm({ token: retry.token })).toMatchObject({ status: 'complete' });
    expect(f.mutate.mock.calls[count]![0]).toEqual(pending.request); expect(f.planner.snapshot().blocks).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(f.directory, 'plan-import-receipts.json'), 'utf8')).pending).toBeNull();
  });

  it('resumes a lost confirmed cloud response through the real write journal using the identical intent', async () => {
    const f = fixture(); insert(f, [{ type: 'create', entity: 'block', values: { title: '合成云端已有安排', kind: 'event', start: '2026-11-02T19:30:00+08:00', end: '2026-11-02T20:30:00+08:00' } }]);
    const receipts = new Map<string, { status: 'completed'; method: 'mutate'; result: { ok: true; data: MutationResult } }>();
    let lose = true;
    const client = { origin: 'https://synthetic.invalid', getSession: async () => ({ deviceId: '11111111-1111-4111-8111-111111111111', identity: { protocolVersion: 1, dataInstanceId: '22222222-2222-4222-8222-222222222222', generation: 1 } }),
      operation: vi.fn(async (id: string) => receipts.get(id) ?? { status: 'unknown' }),
      rpc: vi.fn(async (_method: string, input: MutationRequestInput, requestId: string) => {
        const result = f.planner.mutate(MutationRequestSchema.parse(input)); receipts.set(requestId, { status: 'completed', method: 'mutate', result: { ok: true, data: result } });
        if (input.confirmed && lose) { lose = false; throw Error('synthetic cloud response lost'); } return { ok: true, data: result };
      }) };
    const journal = createWriteJournal(client as unknown as NodeRemoteClient, join(f.directory, 'synthetic-write-journal.json'));
    f.service = createPlanImportService({ ...f.options, mutate: async input => { const result = apiResultSchema(MutationResultSchema).parse(await journal.rpc('mutate', input)); if (!result.ok) throw Error(result.error.message); return result.data; } });
    expect(await run(f, f.plan, true)).toMatchObject({ status: 'partial' });
    const calls = client.rpc.mock.calls.length;
    const preview = await f.service.preview(f.plan); expect(preview.rows.at(-1)!.state).toBe('new');
    const resumed = await f.service.confirm({ token: preview.token, allowConflicts: true }); expect(resumed, resumed.message).toMatchObject({ status: 'complete' });
    expect(client.rpc).toHaveBeenCalledTimes(calls); expect(client.operation).toHaveBeenCalledOnce();
    expect(f.planner.snapshot().blocks).toHaveLength(2); expect(await journal.inspect()).toEqual({ status: 'none' });
  });

  it('checks course occurrences and conflicts between proposed study blocks before confirming each backend preview', async () => {
    const f = fixture(); insert(f, [{ type: 'create', entity: 'course', values: { title: '合成周一课程', weekday: 1, startTime: '19:30', endTime: '20:30', firstWeek: 1, lastWeek: 1, parity: 'all', termStart: '2026-11-02' } }]);
    f.plan.blocks!.push({ ...f.plan.blocks![0]!, id: 'second-session', title: '第二段学习', start: '2026-11-02T19:45:00+08:00', end: '2026-11-02T20:45:00+08:00' });
    const preview = await f.service.preview(f.plan); expect(preview.conflicts).toHaveLength(3);
    expect(await f.service.confirm({ token: preview.token, allowConflicts: true })).toMatchObject({ status: 'complete', applied: 4 });
    expect(f.planner.snapshot().blocks).toHaveLength(2);
  });

  it('returns a resumable partial result even when the latest snapshot is offline', async () => {
    const f = fixture(); let offline = false;
    f.service = createPlanImportService({ ...f.options, snapshot: async () => { if (offline) throw Error('synthetic offline'); return f.planner.snapshot(); }, mutate: async input => {
      f.planner.mutate(MutationRequestSchema.parse(input)); offline = true; throw Error('synthetic disconnected');
    } });
    const result = await run(f); expect(result).toMatchObject({ status: 'partial', applied: 0, remaining: 3 }); expect(result.preview).toBeUndefined();
    expect(f.planner.snapshot().goals).toHaveLength(1); expect(JSON.parse(readFileSync(join(f.directory, 'plan-import-receipts.json'), 'utf8')).pending).not.toBeNull();
  });

  it('stops after an unexpected concurrent write while preserving successful steps', async () => {
    const f = fixture(); let first = true;
    f.mutate.mockImplementation(async input => { const result = f.planner.mutate(MutationRequestSchema.parse(input)); if (first) { first = false; insert(f, [{ type: 'create', entity: 'task', values: { title: '合成并发事项' } }]); } return result; });
    expect(await run(f)).toMatchObject({ status: 'partial', applied: 1, remaining: 2 });
    expect(f.planner.snapshot().blocks).toHaveLength(0);
    expect(await run(f)).toMatchObject({ status: 'complete', applied: 2 }); expect(f.planner.snapshot().goals).toHaveLength(1);
  });

  it('finds recent operation receipts after local receipt loss and refuses modified recovered records', async () => {
    const f = fixture(); await run(f);
    rmSync(join(f.directory, 'plan-import-receipts.json')); f.service = createPlanImportService(f.options);
    expect((await f.service.preview(f.plan)).rows.every(row => row.state === 'existing')).toBe(true);
    expect(await run(f)).toMatchObject({ status: 'complete', applied: 0 });
    expect(f.mutate).toHaveBeenCalledTimes(3);
    f.service = createPlanImportService({ ...f.options, directory: join(f.directory, 'synthetic-second-device'), scope: async () => 'synthetic:another-device' });
    expect(await run(f)).toMatchObject({ status: 'complete', applied: 0 }); expect(f.mutate).toHaveBeenCalledTimes(3);
  });

  it('requires a preview token, rejects malformed references and serializes repeated confirmation', async () => {
    const f = fixture(); await expect(f.service.confirm({ token: 'invented' })).rejects.toThrow(/预览/);
    const invalid = structuredClone(f.plan); invalid.tasks![0]!.goalRef = 'absent';
    await expect(f.service.preview(invalid)).rejects.toThrow(/goalRef/);
    const preview = await f.service.preview(f.plan);
    const results = await Promise.allSettled([f.service.confirm({ token: preview.token }), f.service.confirm({ token: preview.token })]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']); expect(f.planner.snapshot().tasks).toHaveLength(1);
  });
});
