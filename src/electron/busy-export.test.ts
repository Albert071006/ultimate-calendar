import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { emptyState, newEntity, stateSnapshot } from '../storage/repository';
import { BusyContextSchema } from '../shared/busy-context';
import type { PlanSource } from '../shared/plan-context';
const mocks = vi.hoisted(() => ({ save: vi.fn(), write: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => 'C:/synthetic-documents' }, dialog: { showSaveDialog: mocks.save } }));
vi.mock('node:fs/promises', () => ({ writeFile: mocks.write }));
import { createNativeBusyExport } from './busy-export';
import { dispatchRequest } from './ipc';
beforeEach(() => vi.resetAllMocks());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  const state = emptyState();
  const source: PlanSource = { kind: 'cloud', dataInstanceId: '55555555-5555-4555-8555-555555555555', generation: 1 };
  const getSource = vi.fn(async (): Promise<PlanSource> => source), snapshot = vi.fn(async () => stateSnapshot(state));
  const host = createNativeBusyExport({ window: () => ({} as BrowserWindow), snapshot, source: getSource });
  const request = { fromDate: '2026-11-02', toDate: '2026-11-08', instructions: '为一个新学习目标安排整周学习时段' };
  return { state, source, getSource, snapshot, host, request };
}

describe('native standalone busy time export', () => {
  it('previews zero busy time without a goal and saves valid UTF-8 JSON without changing data', async () => {
    const f = fixture(), before = JSON.stringify(f.state), preview = await f.host.busyExportPreview(f.request); if (!preview.ok) throw Error('preview failed');
    expect(preview.data.counts).toEqual({ intervals: 0, courses: 0, work: 0, events: 0 }); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/synthetic-busy.json' });
    expect(await f.host.busyExportSave({ token: preview.data.token })).toEqual({ ok: true, data: { saved: true, filename: 'synthetic-busy.json' } });
    const context = BusyContextSchema.parse(JSON.parse(mocks.write.mock.calls[0]![1])); expect(context.request).toBe(f.request.instructions); expect(context.source).toEqual(f.source); expect(context.busyIntervals).toEqual([]);
    expect(mocks.write.mock.calls[0]![2]).toBe('utf8'); expect(JSON.stringify(f.state)).toBe(before);
    await expect(f.host.busyExportSave({ token: preview.data.token })).rejects.toThrow(/失效/);
  });

  it('counts categories correctly and retains the preview when save is cancelled', async () => {
    const f = fixture();
    newEntity(f.state, 'course', { title: '合成课表', weekday: 1, startTime: '09:00', endTime: '10:00', firstWeek: 1, lastWeek: 1, termStart: '2026-11-02' });
    newEntity(f.state, 'block', { title: '合成学习', kind: 'work', start: '2026-11-02T19:00:00+08:00', end: '2026-11-02T20:00:00+08:00' });
    newEntity(f.state, 'block', { title: '合成活动', kind: 'event', start: '2026-11-03T19:00:00+08:00', end: null });
    const preview = await f.host.busyExportPreview(f.request); if (!preview.ok) throw Error('preview failed');
    expect(preview.data.counts).toEqual({ intervals: 3, courses: 1, work: 1, events: 1 });
    mocks.save.mockResolvedValueOnce({ canceled: true });
    expect(await f.host.busyExportSave({ token: preview.data.token })).toEqual({ ok: true, data: { saved: false } }); expect(mocks.write).not.toHaveBeenCalled();
    mocks.save.mockResolvedValueOnce({ canceled: false, filePath: 'C:/synthetic-busy.json' });
    expect((await f.host.busyExportSave({ token: preview.data.token })).ok).toBe(true);
    expect(BusyContextSchema.parse(JSON.parse(mocks.write.mock.calls[0]![1])).busyIntervals.every(value => value.title === undefined)).toBe(true);
  });

  it('rechecks occupancy after the native dialog and refuses stale content', async () => {
    const f = fixture(), preview = await f.host.busyExportPreview(f.request); if (!preview.ok) throw Error('preview failed');
    mocks.save.mockImplementation(async () => { newEntity(f.state, 'block', { title: '合成并发日程', kind: 'event', start: '2026-11-02T19:00:00+08:00', end: null }); return { canceled: false, filePath: 'C:/synthetic-busy.json' }; });
    await expect(f.host.busyExportSave({ token: preview.data.token })).rejects.toThrow(/变化/); expect(mocks.write).not.toHaveBeenCalled();
  });

  it('rejects source changes during snapshot reads or before saving, rather than exporting an empty fallback', async () => {
    const f = fixture(); f.getSource.mockResolvedValueOnce(f.source).mockResolvedValueOnce({ kind: 'cloud', dataInstanceId: f.source.dataInstanceId, generation: 2 });
    await expect(f.host.busyExportPreview(f.request)).rejects.toThrow(/连接已改变/);
    f.getSource.mockResolvedValue(f.source); const preview = await f.host.busyExportPreview(f.request); if (!preview.ok) throw Error('preview failed');
    f.getSource.mockResolvedValue({ kind: 'cloud', dataInstanceId: f.source.dataInstanceId, generation: 2 }); mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/synthetic-busy.json' });
    await expect(f.host.busyExportSave({ token: preview.data.token })).rejects.toThrow(/变化/); expect(mocks.write).not.toHaveBeenCalled();
    f.snapshot.mockRejectedValue(Error('synthetic offline')); await expect(f.host.busyExportPreview(f.request)).rejects.toThrow(/offline/);
  });

  it('expires previews after ten minutes and rejects untrusted callers and invalid ranges', async () => {
    const f = fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    const preview = await f.host.busyExportPreview(f.request); if (!preview.ok) throw Error('preview failed');
    vi.setSystemTime(new Date('2026-11-01T00:10:01Z'));
    await expect(f.host.busyExportSave({ token: preview.data.token })).rejects.toThrow(/失效/); expect(mocks.save).not.toHaveBeenCalled();
    const caller = { senderId: 1, frameId: 2, url: 'app://synthetic' }, handle = vi.fn();
    expect((await dispatchRequest('busyExportPreview', { fromDate: '2026-11-08', toDate: '2026-11-02' }, caller, caller, { busyExportPreview: handle })).ok).toBe(false);
    expect((await dispatchRequest('busyExportSave', { token: 'x' }, { ...caller, senderId: 9 }, caller, { busyExportSave: handle })).ok).toBe(false); expect(handle).not.toHaveBeenCalled();
  });
});
