import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepository, newEntity } from '../storage/repository';
import { createLedgerService } from '../ledger/service';
import { LedgerEntryDraftSchema } from '../shared/ledger';
import { createSafeBackup } from './backup';
import { RemoteState } from './state';
import { createCloudRestore } from './cloud-restore';
import { createRemoteService } from './service';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function folder() {
  const root = mkdtempSync(join(tmpdir(), 'calendar-cloud-restore-'));
  cleanup.push(() => { const delta = relative(resolve(tmpdir()), resolve(root)); if (!delta || delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }); }); return root;
}
function setup() {
  const root = folder(), repository = createRepository(join(root, 'data', 'planner.sqlite'), { automaticBackup: () => {} }), ledger = createLedgerService(repository.path), state = new RemoteState(join(root, 'data', 'remote-state.sqlite'));
  cleanup.push(() => { ledger.close(); repository.close(); state.close(); });
  repository.transact(value => { newEntity(value, 'task', { title: '虚构备份任务' }); });
  const entry = LedgerEntryDraftSchema.parse({ id: 'synthetic-entry', kind: 'expense', date: '2026-10-24', month: '2026-10', title: '虚构账目', category: '餐饮', amountCents: 100, personalCents: 100, cashflows: [{ accountId: 'alipay', deltaCents: -100 }], originalText: 'SYNTHETIC-RAW-INPUT' });
  ledger.mutate({ operationId: 'old-ledger-op', expectedRevision: 0, changes: [{ type: 'putEntry', entry, expectedVersion: null, confirmDuplicate: false, note: '' }] });
  const backup = () => createSafeBackup({ repository, ledger, directory: join(root, 'backups') });
  const content = readFileSync(backup(), 'utf8');
  repository.transact(value => { newEntity(value, 'task', { title: '虚构当前新任务' }); });
  let clock = Date.parse('2026-10-25T10:00:00Z'), busy = false, backupFails = false;
  const restore = createCloudRestore({ repository, ledger, state, backup: () => backupFails ? undefined : backup(), hasPendingWrites: () => busy, now: () => clock });
  return { root, repository, ledger, state, content, restore, setBusy: (value: boolean) => { busy = value; }, setBackupFails: () => { backupFails = true; }, expire: () => { clock += 11 * 60_000; } };
}

describe('controlled cloud restore', () => {
  it('previews without writing and requires the same device, digest and unexpired token', () => {
    const f = setup(), before = f.repository.read(), identity = f.state.identity();
    const preview = f.restore.preview({ content: f.content }, 'device-a');
    expect(preview).toMatchObject({ taskCount: 1, ledgerEntryCount: 1 }); expect(f.repository.read()).toEqual(before); expect(f.state.identity()).toEqual(identity);
    expect(() => f.restore.confirm({ token: preview.token, digest: 'f'.repeat(64) }, 'device-a')).toThrow(/失效/);
    expect(() => f.restore.confirm(preview, 'device-b')).toThrow();
    const confirmation = { token: preview.token, digest: preview.digest };
    expect(() => f.restore.confirm(confirmation, 'device-b')).toThrow(/当前设备/);
    f.expire(); expect(() => f.restore.confirm(confirmation, 'device-a')).toThrow(/失效/);
    for (const content of ['not-json', JSON.stringify({ format: 'desktop-full-backup' }), JSON.stringify({ ...JSON.parse(f.content), formatVersion: 999 })]) expect(() => f.restore.preview({ content }, 'device-a')).toThrow(/安全备份/);
  });

  it('rejects changes after preview, pending writes and backup failure before advancing generation', () => {
    const f = setup(), identity = f.state.identity();
    let preview = f.restore.preview({ content: f.content }, 'device');
    f.repository.saveSettings({ ...f.repository.snapshot().settings, campus: '虚构修改校区' });
    expect(() => f.restore.confirm({ token: preview.token, digest: preview.digest }, 'device')).toThrow(/资料已变化/);
    preview = f.restore.preview({ content: f.content }, 'device'); f.setBusy(true);
    expect(() => f.restore.confirm({ token: preview.token, digest: preview.digest }, 'device')).toThrow(/进行中的修改/);
    f.setBusy(false); f.setBackupFails();
    expect(() => f.restore.confirm({ token: preview.token, digest: preview.digest }, 'device')).toThrow(/安全备份未完成/);
    expect(f.state.identity()).toEqual(identity); expect(f.repository.snapshot().tasks).toHaveLength(2); expect(f.state.restoreStatus().status).toBe('never');
  });

  it('backs up current data, replaces planner and ledger, fences old writes and preserves pairing', () => {
    const f = setup(), identity = f.state.identity(), paired = f.state.pair(f.state.createPairingCode(), '虚构设备');
    f.state.begin('old-write', paired.device.id, 'saveSettings', 'synthetic-fingerprint');
    const preview = f.restore.preview({ content: f.content }, paired.device.id), confirmation = { token: preview.token, digest: preview.digest };
    const restored = f.restore.confirm(confirmation, paired.device.id);
    expect(restored).toMatchObject({ identity: { ...identity, generation: identity.generation + 1 }, taskCount: 1, ledgerEntryCount: 1, backupCreated: true });
    expect(f.repository.snapshot().tasks).toHaveLength(1); expect(f.repository.read().operations).toEqual([]); expect(f.repository.read().receipts).toEqual([]);
    expect(f.ledger.exportJson().entries[0]?.originalText).toBe('');
    expect(f.state.operation('old-write', paired.device.id)).toEqual({ status: 'unknown' }); expect(f.state.session(paired.token)?.device.id).toBe(paired.device.id);
    expect(f.state.restoreStatus()).toMatchObject({ status: 'completed', generation: restored.identity.generation });
    const backupPayloads = readdirSync(join(f.root, 'backups')).map(name => JSON.parse(readFileSync(join(f.root, 'backups', name), 'utf8')));
    expect(backupPayloads.some(value => value.planner.entities.task.length === 2)).toBe(true);
    expect(() => f.restore.confirm(confirmation, paired.device.id)).toThrow(/失效/);
  });

  it('rolls back both business stores on transactional failure but retains the generation fence and interrupted marker', () => {
    const f = setup(), beforePlanner = f.repository.read(), beforeLedger = f.ledger.exportJson(), identity = f.state.identity();
    const preview = f.restore.preview({ content: f.content }, 'device'), replace = f.repository.replaceState.bind(f.repository);
    vi.spyOn(f.repository, 'replaceState').mockImplementation((value, callback) => replace(value, db => { callback?.(db); throw Error('synthetic transaction failure'); }));
    expect(() => f.restore.confirm({ token: preview.token, digest: preview.digest }, 'device')).toThrow(/结果需要核对/);
    expect(f.repository.read()).toEqual(beforePlanner); expect(f.ledger.exportJson()).toEqual(beforeLedger);
    expect(f.state.identity().generation).toBe(identity.generation + 1); expect(f.state.restoreStatus().status).toBe('interrupted');
  });

  it('identifies a process interruption on the next service-state startup without claiming success', () => {
    const root = folder(), path = join(root, 'remote-state.sqlite'); let state = new RemoteState(path);
    state.saveRestoreStatus({ status: 'processing', at: '2026-10-25T10:00:00Z', generation: 2 }); state.advanceGeneration(true); state.close();
    state = new RemoteState(path);
    try { expect(state.restoreStatus()).toMatchObject({ status: 'interrupted', generation: 2 }); expect(state.identity().generation).toBe(2); } finally { state.close(); }
  });

  it('handles restore as an authenticated-identity special operation without replaying or archiving the uploaded backup', async () => {
    const root = folder(), service = createRemoteService({ dataDirectory: join(root, 'data'), backupDirectory: join(root, 'backups'), getApiKey: async () => null });
    cleanup.push(() => service.close()); const identity = service.state.identity();
    const exported = await service.rpc('backupExportData', { requestId: 'export', identity }, 'device') as { ok: true; data: { content: string } };
    const preview = await service.rpc('restorePreview', { requestId: 'preview', identity, input: exported.data }, 'device') as { ok: true; data: { token: string; digest: string } };
    expect(preview.ok).toBe(true); expect(service.state.operation('preview', 'device')).toEqual({ status: 'unknown' });
    const request = { requestId: 'confirm', identity, input: { token: preview.data.token, digest: preview.data.digest } };
    expect(await service.rpc('restoreConfirm', request, 'device')).toMatchObject({ ok: true, data: { identity: { generation: 2 } } });
    expect(service.state.operation('confirm', 'device')).toEqual({ status: 'unknown' });
    await expect(service.rpc('restoreConfirm', request, 'device')).rejects.toMatchObject({ status: 409 });
    await expect(service.rpc('saveSettings', { requestId: 'old-offline-write', identity, input: { expectedSettings: service.snapshot().settings, settings: service.snapshot().settings } }, 'device')).rejects.toMatchObject({ status: 409 });
    expect(service.status().restore.status).toBe('completed');
  });

  it('discards an old snapshot whose asynchronous key-status lookup finishes after a restore', async () => {
    const root = folder(); let release: () => void = () => {}, started: () => void = () => {};
    const entered = new Promise<void>(done => { started = done; }), hold = new Promise<void>(done => { release = done; });
    const service = createRemoteService({ dataDirectory: join(root, 'data'), backupDirectory: join(root, 'backups'), getApiKey: async () => { started(); await hold; return null; } });
    cleanup.push(() => service.close()); const identity = service.state.identity();
    const exported = await service.rpc('backupExportData', { requestId: 'export', identity }, 'device') as { ok: true; data: { content: string } };
    const preview = await service.rpc('restorePreview', { requestId: 'preview', identity, input: exported.data }, 'device') as { ok: true; data: { token: string; digest: string } };
    const snapshot = service.rpc('snapshot', { requestId: 'old-snapshot', identity }, 'device'); await entered;
    expect(await service.rpc('restoreConfirm', { requestId: 'confirm', identity, input: { token: preview.data.token, digest: preview.data.digest } }, 'device')).toMatchObject({ ok: true });
    release(); await expect(snapshot).rejects.toMatchObject({ status: 409 });
  });
});
