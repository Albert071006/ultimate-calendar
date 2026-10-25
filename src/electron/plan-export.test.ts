import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { emptyState, newEntity, stateSnapshot } from '../storage/repository';
import { PlanContextSchema, type PlanSource } from '../shared/plan-context';
const mocks = vi.hoisted(() => ({ save: vi.fn(), write: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => 'C:/synthetic-documents' }, dialog: { showSaveDialog: mocks.save } }));
vi.mock('node:fs/promises', () => ({ writeFile: mocks.write }));
import { createNativePlanExport, localPlanSource } from './plan-export';
import { dispatchRequest } from './ipc';
beforeEach(() => vi.resetAllMocks());
const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) { const part = relative(tmpdir(), directory); if (!part || part.startsWith('..') || isAbsolute(part)) throw Error('Unsafe synthetic cleanup'); rmSync(directory, { recursive: true, force: true }); } });
function fixture() {
  const state = emptyState(), goal = newEntity(state, 'goal', { title: '合成英语目标', description: '合成说明' });
  newEntity(state, 'task', { title: '合成阅读', goalId: goal.id });
  const source: PlanSource = { kind: 'cloud', dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 };
  const getSource = vi.fn(async () => source);
  const host = createNativePlanExport({ window: () => ({} as BrowserWindow), snapshot: async () => stateSnapshot(state), source: getSource });
  const request = { goalId: goal.id, fromDate: '2030-04-15', toDate: '2030-04-21', instructions: '补充学习时段' };
  return { state, host, request, getSource, source };
}

describe('native goal context export', () => {
  it('previews counts without saving or mutating and writes a valid context only after save', async () => {
    const f = fixture(), before = JSON.stringify(f.state), preview = await f.host.planExportPreview(f.request);
    if (!preview.ok) throw Error('preview failed');
    expect(preview.data.counts).toMatchObject({ tasks: 1, blocks: 0 }); expect(mocks.write).not.toHaveBeenCalled();
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/synthetic-context.json' });
    expect(await f.host.planExportSave({ token: preview.data.token })).toMatchObject({ ok: true, data: { saved: true, filename: 'synthetic-context.json' } });
    const context = PlanContextSchema.parse(JSON.parse(mocks.write.mock.calls[0]![1]));
    expect(context.goal.id).toBe(f.request.goalId); expect(context.request).toBe('补充学习时段'); expect(context.basis.source).toEqual(f.source);
    expect(JSON.stringify(f.state)).toBe(before);
    await expect(f.host.planExportSave({ token: preview.data.token })).rejects.toThrow(/失效/);
  });
  it('cancelled native save retains the preview and writes nothing', async () => {
    const f = fixture(), preview = await f.host.planExportPreview(f.request); if (!preview.ok) throw Error('preview failed');
    mocks.save.mockResolvedValue({ canceled: true });
    expect(await f.host.planExportSave({ token: preview.data.token })).toEqual({ ok: true, data: { saved: false } }); expect(mocks.write).not.toHaveBeenCalled();
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/synthetic-context.json' });
    expect((await f.host.planExportSave({ token: preview.data.token })).ok).toBe(true);
  });
  it('rechecks after the native file dialog and never writes a stale plan', async () => {
    const f = fixture(), preview = await f.host.planExportPreview(f.request); if (!preview.ok) throw Error('preview failed');
    mocks.save.mockImplementation(async () => { newEntity(f.state, 'task', { title: '合成并发任务', goalId: f.request.goalId }); return { canceled: false, filePath: 'C:/synthetic-context.json' }; });
    await expect(f.host.planExportSave({ token: preview.data.token })).rejects.toThrow(/变化/); expect(mocks.write).not.toHaveBeenCalled();
  });
  it('rejects a changed source or failed connection instead of exporting an empty plan', async () => {
    const f = fixture(), preview = await f.host.planExportPreview(f.request); if (!preview.ok) throw Error('preview failed');
    f.getSource.mockResolvedValue({ ...f.source, generation: 2 });
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/synthetic-context.json' });
    await expect(f.host.planExportSave({ token: preview.data.token })).rejects.toThrow(/变化/); expect(mocks.write).not.toHaveBeenCalled();
    f.getSource.mockRejectedValue(Error('synthetic offline')); await expect(f.host.planExportPreview(f.request)).rejects.toThrow(/offline/);
  });
  it('persists a local source ID without exporting its profile path', () => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-export-id-')); roots.push(root);
    const first = localPlanSource(root); expect(first.kind).toBe('local'); expect(localPlanSource(root)).toEqual(first); expect(JSON.stringify(first)).not.toContain(root);
  });
  it('rejects untrusted callers and invalid range before any host work', async () => {
    const caller = { senderId: 1, frameId: 2, url: 'app://synthetic' }, handle = vi.fn();
    expect((await dispatchRequest('planExportPreview', { goalId: 'x', fromDate: '2030-04-21', toDate: '2030-04-15' }, caller, caller, { planExportPreview: handle })).ok).toBe(false);
    expect((await dispatchRequest('planExportSave', { token: 'x' }, { ...caller, senderId: 9 }, caller, { planExportSave: handle })).ok).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });
});
