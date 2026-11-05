import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as workerModule from '../storage/backup-worker-client';
import { createSafeBackupFromDatabase } from './backup';
import { createRemoteService, type RemoteService } from './service';

vi.mock('../storage/backup-worker-client', { spy: true });
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'uc-background-backup-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let blocked = false, release: () => void = () => {};
  const run = vi.fn(async (job: workerModule.BackupJob) => {
    if (blocked) await new Promise<void>(done => { release = done; });
    if (job.kind !== 'safe') throw Error('Expected safe export');
    return createSafeBackupFromDatabase(job);
  });
  vi.spyOn(workerModule, 'createBackupWorker').mockReturnValue({ run, close: async () => {} });
  const service = createRemoteService({ dataDirectory: join(root, 'data'), backupDirectory: join(root, 'backups'), scheduleMonthlyAllowance: false, getApiKey: async () => null });
  cleanup.push(async () => { release(); await service.close(); });
  return { service, run, block: () => { blocked = true; }, release: () => { blocked = false; release(); } };
}
async function exportedPreview(service: RemoteService) {
  const identity = service.state.identity();
  const exported = await service.rpc('backupExportData', { requestId: 'export', identity }, 'device') as { ok: true; data: { content: string } };
  const preview = await service.rpc('restorePreview', { requestId: 'preview', identity, input: exported.data }, 'device') as { ok: true; data: { token: string; digest: string } };
  return { requestId: 'confirm', identity, input: { token: preview.data.token, digest: preview.data.digest } };
}
describe('background service backup integration', () => {
  it('returns a durable write receipt before exporting, and a later write does not postpone the deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    const f = fixture(), settings = f.service.snapshot().settings;
    const saved = await f.service.rpc('saveSettings', { requestId: 'first-save', identity: f.service.state.identity(), input: { expectedSettings: settings, settings: { ...settings, campus: '虚构校区' } } }, 'device');
    expect(saved).toMatchObject({ ok: true }); expect(f.service.state.operation('first-save', 'device')).toMatchObject({ status: 'completed' });
    expect(f.run).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(59_000);
    const current = f.service.snapshot().settings;
    await f.service.rpc('saveSettings', { requestId: 'second-save', identity: f.service.state.identity(), input: { expectedSettings: current, settings: { ...current, campus: '虚构第二校区' } } }, 'device');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.run).toHaveBeenCalledOnce(); expect(f.service.status().backup).toMatchObject({ pending: false, status: 'ok' });
  });
  it('fences new writes while waiting for the restore safety backup', async () => {
    const f = fixture(), request = await exportedPreview(f.service); f.block();
    const restoring = f.service.rpc('restoreConfirm', request, 'device');
    const settings = f.service.snapshot().settings;
    await expect(f.service.rpc('saveSettings', { requestId: 'racing-write', identity: request.identity, input: { expectedSettings: settings, settings } }, 'device')).rejects.toMatchObject({ status: 409 });
    expect(f.service.state.operation('racing-write', 'device')).toEqual({ status: 'unknown' });
    f.release(); expect(await restoring).toMatchObject({ ok: true, data: { identity: { generation: 2 } } });
  });
  it('rechecks the generation after an asynchronous restore backup without overwriting data', async () => {
    const f = fixture(), request = await exportedPreview(f.service); f.block();
    const restoring = f.service.rpc('restoreConfirm', request, 'device');
    f.service.state.advanceGeneration();
    f.release(); expect(await restoring).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.service.state.identity().generation).toBe(2); expect(f.service.status().restore.status).toBe('never');
  });
});
