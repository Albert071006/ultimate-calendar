import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { createCollectorControlClient } from './collector-control';
import type { createUpdateService } from './update-service';
import { SnapshotSchema } from '../shared/contracts';
import { BackupExportManifestSchema, CLOUD_BACKUP_CHUNK_BYTES, MAX_CLOUD_EXPORT_BYTES } from '../shared/cloud-management';
import type { RemoteMethod } from '../shared/remote';
import { applyPlannerPatch } from '../shared/planner-sync';
import { createRepository, emptyState, newEntity } from '../storage/repository';
import { readLocalResourcesCompanion, writeLocalResources } from '../storage/local-resources';
import { createRemoteHttpServer } from '../server/http';
import { createRemoteService } from '../server/service';
import { createNodeRemoteClient } from '../remote/node-client';
import { DEFAULT_LEDGER_RULES } from '../shared/ledger';
import { createRemoteDesktopShell } from './remote-desktop-shell';
import { app, powerMonitor } from 'electron';

type UpdateOptions = Parameters<typeof createUpdateService>[0];
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), updateOptions: [] as UpdateOptions[], updates: [] as ReturnType<typeof createUpdateService>[],
  trays: [] as Array<EventEmitter & { destroy: ReturnType<typeof vi.fn>; menu?: Array<{ label?: string; click?: () => void }> }>,
  notifications: [] as Array<EventEmitter & { close: ReturnType<typeof vi.fn> }>,
  autoShow: false, supported: true,
  schedulers: [] as Array<{ initialize: ReturnType<typeof vi.fn>; updateSnapshot: ReturnType<typeof vi.fn>; check: ReturnType<typeof vi.fn>; acknowledge: ReturnType<typeof vi.fn> }>,
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('electron-updater', () => ({ NsisUpdater: class { constructor() { throw Error('A real installer must never be initialized in shell unit tests'); } } }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '0.4.7', setLoginItemSettings: vi.fn(), quit: vi.fn() }),
    powerMonitor: new EventEmitter(), dialog: { showErrorBox: vi.fn() }, Menu: { buildFromTemplate: (value: unknown) => value }, nativeImage: { createFromPath: vi.fn(() => ({})) },
    Tray: class extends EventEmitter {
      menu?: Array<{ label?: string; click?: () => void }>;
      destroy = vi.fn(); setToolTip = vi.fn();
      setContextMenu(value: typeof this.menu) { this.menu = value; }
      constructor() { super(); mocks.trays.push(this); }
    },
    Notification: class extends EventEmitter {
      static isSupported() { return mocks.supported; }
      show() { if (mocks.autoShow) this.emit('show'); }
      close = vi.fn();
      constructor() { super(); mocks.notifications.push(this); }
    },
  };
});
vi.mock('./remote-reminders', () => ({ createRemoteReminderScheduler: vi.fn(() => {
  const value = { initialize: vi.fn(async () => {}), updateSnapshot: vi.fn(), check: vi.fn(async () => []), acknowledge: vi.fn(async () => {}) };
  mocks.schedulers.push(value); return value;
}) }));
vi.mock('./update-service', () => ({ createUpdateService: vi.fn((options: UpdateOptions) => {
  mocks.updateOptions.push(options);
  const value = { snapshot: vi.fn(() => ({ status: 'idle' })), checkForUpdates: vi.fn(async () => ({ ok: true, data: {} })), downloadUpdate: vi.fn(async () => ({ ok: true, data: {} })),
    installUpdate: vi.fn(async () => ({ ok: true, data: {} })), isInstalling: vi.fn(() => false), start: vi.fn(), stop: vi.fn() } as unknown as ReturnType<typeof createUpdateService>;
  mocks.updates.push(value); return value;
}) }));

const originalPlatform = process.platform, roots: string[] = [], shells: ReturnType<typeof createRemoteDesktopShell>[] = [];
const identity = { protocolVersion: 1 as const, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 };
const snapshot = () => SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: { closeToTray: false, autoLaunch: true }, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
const backup = () => JSON.stringify({ format: 'ultimate-calendar-safe-backup', formatVersion: 1, createdAt: new Date().toISOString(), planner: emptyState(),
  ledger: { format: 'ultimate-calendar-ledger', formatVersion: 1, entries: [], balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [] } });
function backupRpc(content = backup(), damage?: 'changed' | 'short') {
  const bytes = Buffer.from(content), downloadId = randomUUID(), sha256 = createHash('sha256').update(bytes).digest('hex');
  return async (method: RemoteMethod, input?: unknown) => {
    if (method === 'snapshot') return { ok: true, data: snapshot() };
    if (method === 'backupExportStart') return { ok: true, data: { downloadId, sha256, totalBytes: bytes.length, chunkBytes: CLOUD_BACKUP_CHUNK_BYTES } };
    if (method === 'backupExportFinish') { expect(input).toEqual({ downloadId }); return { ok: true, data: { released: true } }; }
    if (method !== 'backupExportChunk') throw Error('Unexpected RPC: ' + method);
    const request = input as { downloadId: string; offset: number };
    expect(request.downloadId).toBe(downloadId);
    let chunk = Buffer.from(bytes.subarray(request.offset, request.offset + CLOUD_BACKUP_CHUNK_BYTES));
    if (damage === 'short') chunk = chunk.subarray(0, -1);
    // Swap a timestamp digit, leaving a valid safe backup with the same byte count.
    if (damage === 'changed') chunk[chunk.indexOf('"createdAt":"') + '"createdAt":"'.length] = '1'.charCodeAt(0);
    return { ok: true, data: { downloadId, offset: request.offset, data: chunk.toString('base64') } };
  };
}
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function fixture(production = true) {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-shell-unit-')); roots.push(directory);
  const window = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(), hide: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } });
  const collector = { invoke: vi.fn(async () => ({ ok: true, data: {} })), setTrayOwner: vi.fn(async (_owner: string, _active: boolean) => ({ ok: true, data: { accepted: true } })), processState: vi.fn(async (): Promise<'running' | 'stopped' | 'unknown'> => 'running'), shutdownAndWait: vi.fn(async () => ({ ok: true, data: { stopped: true } })), close: vi.fn() };
  const rpc = vi.fn<(method: RemoteMethod, input?: unknown) => Promise<unknown>>(backupRpc());
  const changed = vi.fn(), isBusy = vi.fn(() => false), getIdentity = vi.fn(async () => identity);
  const config = { origin: 'https://synthetic.invalid', deviceName: '合成电脑', ...(production ? { localDataDirectory: join(directory, 'capture-only-source') } : {}) };
  const shell = createRemoteDesktopShell({ window: window as unknown as BrowserWindow, directory, config, rpc, changed, isBusy, getIdentity,
    collector: collector as unknown as ReturnType<typeof createCollectorControlClient> });
  shells.push(shell);
  return { shell, directory, window, collector, rpc, changed, getIdentity, config, isBusy, updates: mocks.updates.at(-1)!, hooks: mocks.updateOptions.at(-1)! };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T03:00:00Z'));
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  mocks.spawn.mockReset(); mocks.updateOptions.length = 0; mocks.updates.length = 0; mocks.trays.length = 0; mocks.notifications.length = 0; mocks.schedulers.length = 0;
  mocks.autoShow = false; mocks.supported = true; vi.mocked(app.setLoginItemSettings).mockClear(); vi.mocked(app.quit).mockClear();
  mocks.spawn.mockImplementation(() => { const child = Object.assign(new EventEmitter(), { unref: vi.fn() }); Promise.resolve().then(() => child.emit('spawn')); return child; });
});
afterEach(() => {
  for (const shell of shells.splice(0)) shell.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  app.removeAllListeners(); powerMonitor.removeAllListeners();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }); vi.useRealTimers();
});

describe('cloud desktop device shell', () => {
  it('applies device-only settings without requiring a new cloud revision', async () => {
    const f = fixture(); await flush();
    const cursor = { streamId: '11111111-1111-4111-8111-111111111111', revision: 2 };
    const before = f.shell.snapshot({ ...snapshot(), cursor });
    f.shell.saveDeviceSettings({ closeToTray: false, autoLaunch: true });
    const delta = f.shell.patch({ from: cursor, to: cursor, entities: [], settings: { ...before.settings, closeToTray: true, autoLaunch: false } });
    const after = applyPlannerPatch(before, delta)!;
    expect(after.cursor).toEqual(cursor);
    expect(after.settings).toMatchObject({ closeToTray: false, autoLaunch: true });
    expect(f.changed).toHaveBeenCalledOnce();
  });

  it('renews the shared tray and completes its release before allowing normal quit', async () => {
    const f = fixture(); await flush();
    const owner = f.collector.setTrayOwner.mock.calls[0]![0];
    expect(f.collector.setTrayOwner).toHaveBeenCalledWith(owner, true);
    await vi.advanceTimersByTimeAsync(5000); expect(f.collector.setTrayOwner).toHaveBeenCalledTimes(2);
    let release: (() => void) | undefined;
    f.collector.setTrayOwner.mockImplementationOnce(async () => { await new Promise<void>(done => { release = done; }); return { ok: true, data: { accepted: true } }; });
    const event = { preventDefault: vi.fn() }; app.emit('before-quit', event); await flush();
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(mocks.trays[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.collector.setTrayOwner).toHaveBeenLastCalledWith(owner, false); expect(app.quit).not.toHaveBeenCalled();
    release?.(); await flush(); expect(app.quit).toHaveBeenCalledOnce();
    const calls = f.collector.setTrayOwner.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000); expect(f.collector.setTrayOwner).toHaveBeenCalledTimes(calls);
  });

  it('leaves one collector fallback on a control outage and regains one cloud tray on recovery', async () => {
    const f = fixture(); await flush();
    f.collector.setTrayOwner.mockResolvedValue({ ok: false } as never);
    f.collector.processState.mockResolvedValue('running');
    f.collector.invoke.mockResolvedValue({ ok: false } as never);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.trays).toHaveLength(1); expect(mocks.trays[0]!.destroy).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
    f.collector.setTrayOwner.mockResolvedValue({ ok: true, data: { accepted: true } });
    await vi.advanceTimersByTimeAsync(5000); expect(mocks.trays).toHaveLength(2); expect(mocks.trays[1]!.destroy).not.toHaveBeenCalled();
  });

  it('keeps the cloud entry point when the collector is confirmed gone', async () => {
    const f = fixture(); await flush();
    f.collector.setTrayOwner.mockResolvedValue({ ok: false } as never); f.collector.processState.mockResolvedValue('stopped');
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.trays).toHaveLength(1); expect(mocks.trays[0]!.destroy).not.toHaveBeenCalled();
    expect(mocks.trays[0]!.menu!.some(item => item.label === '启动本机采集')).toBe(true);
    expect(mocks.trays[0]!.menu!.some(item => item.label === '退出日历')).toBe(true);
  });

  it('stops and restarts collection from the same cloud tray while preserving cloud actions', async () => {
    const f = fixture(); await flush();
    f.shell.setTrayItems([{ label: '合成云端操作' }]);
    mocks.trays[0]!.menu!.find(item => item.label?.startsWith('停止本机采集'))!.click!(); await flush();
    expect(f.collector.shutdownAndWait).toHaveBeenCalledOnce(); expect(mocks.trays).toHaveLength(1);
    expect(mocks.trays[0]!.menu!.some(item => item.label === '退出日历')).toBe(true);
    const claims = f.collector.setTrayOwner.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); expect(f.collector.setTrayOwner).toHaveBeenCalledTimes(claims);
    f.collector.invoke.mockResolvedValueOnce({ ok: false } as never).mockResolvedValue({ ok: true, data: {} });
    f.collector.processState.mockResolvedValue('stopped');
    mocks.trays[0]!.menu!.find(item => item.label === '启动本机采集')!.click!(); await flush();
    expect(mocks.spawn).toHaveBeenCalledOnce(); expect(mocks.trays).toHaveLength(1);
    expect(mocks.trays[0]!.menu!.some(item => item.label === '合成云端操作')).toBe(true);
    expect(f.collector.setTrayOwner).toHaveBeenLastCalledWith(expect.any(String), true);
  });

  it('keeps isolated smoke profiles free of OS startup, updater timers, collectors and notifications', async () => {
    const f = fixture(false); await flush();
    expect(f.hooks.isolatedProfile).toBe(true); expect(f.updates.start).not.toHaveBeenCalled();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.trays).toHaveLength(0); expect(f.rpc).not.toHaveBeenCalled(); expect(f.collector.invoke).not.toHaveBeenCalled();
    expect(f.collector.setTrayOwner).not.toHaveBeenCalled();
    expect(await f.shell.handle('snapshot')).toBeNull();
    expect(await f.shell.handle('updateSnapshot')).toEqual({ ok: true, data: { status: 'idle' } });
    await f.shell.handle('checkForUpdates'); await f.shell.handle('downloadUpdate'); await f.shell.handle('installUpdate');
    expect(f.updates.checkForUpdates).toHaveBeenCalledOnce(); expect(f.updates.downloadUpdate).toHaveBeenCalledOnce(); expect(f.updates.installUpdate).toHaveBeenCalledOnce();
  });

  it('overlays only device switches and persists them without a second formal database', async () => {
    const f = fixture(); await flush();
    expect(f.shell.snapshot(snapshot()).settings).toMatchObject({ closeToTray: true, autoLaunch: false, model: 'deepseek-flash' });
    f.shell.saveDeviceSettings({ closeToTray: false, autoLaunch: true });
    expect(JSON.parse(readFileSync(join(f.directory, 'device-settings.json'), 'utf8'))).toEqual({ version: 1, closeToTray: false, autoLaunch: true });
    expect(f.shell.snapshot(snapshot()).settings).toMatchObject({ closeToTray: false, autoLaunch: true });
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true, path: process.execPath, args: [] });
    expect(f.changed).toHaveBeenCalledOnce(); expect(readdirSync(f.directory)).not.toContain('planner.sqlite');
    f.shell.close();
    writeFileSync(join(f.directory, 'device-settings.json'), '{invalid', { mode: 0o600 });
    expect(() => createRemoteDesktopShell({ window: f.window as unknown as BrowserWindow, directory: f.directory, config: f.config, rpc: f.rpc, changed: f.changed, getIdentity: f.getIdentity, collector: null })).toThrow();
  });

  it('honors close-to-tray but lets app quit and a disabled preference close normally', async () => {
    const f = fixture(); await flush(); const event = { preventDefault: vi.fn() };
    f.window.emit('close', event); expect(event.preventDefault).toHaveBeenCalledOnce(); expect(f.window.hide).toHaveBeenCalledOnce();
    f.shell.saveDeviceSettings({ closeToTray: false, autoLaunch: false });
    f.window.emit('close', event); expect(event.preventDefault).toHaveBeenCalledTimes(2); expect(app.quit).toHaveBeenCalledOnce();
    f.shell.saveDeviceSettings({ closeToTray: true, autoLaunch: false });
    const beforeQuit = { preventDefault: vi.fn() }; app.emit('before-quit', beforeQuit);
    f.window.emit('close', event); expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(beforeQuit.preventDefault).toHaveBeenCalledOnce();
    await flush(); expect(app.quit).toHaveBeenCalledTimes(2);
    expect(f.collector.setTrayOwner).toHaveBeenLastCalledWith(expect.any(String), false);
  });

  it('polls in the background and never advances reminders after an unsuccessful cloud read', async () => {
    const f = fixture(); await flush(); const scheduler = mocks.schedulers[0]!;
    expect(scheduler.check).toHaveBeenCalledOnce();
    f.rpc.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK' } } as never);
    await vi.advanceTimersByTimeAsync(30_000); expect(scheduler.check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); expect(scheduler.check).toHaveBeenCalledTimes(2);
    f.getIdentity.mockResolvedValue({ ...identity, generation: 2 });
    powerMonitor.emit('resume'); await flush(); expect(mocks.schedulers).toHaveLength(2);
    expect(mocks.schedulers[1]!.check).toHaveBeenCalledOnce();
  });

  it('acknowledges only a displayed OS notification and navigates to its cloud record', async () => {
    const f = fixture(); await flush(); const scheduler = mocks.schedulers[0]!;
    const reminder = { id: 'synthetic-reminder', refKind: 'task', refId: 'synthetic-task', title: '合成提醒', message: '合成提醒内容', dueAt: '2030-01-01T11:00:00+08:00', scheduledAt: '2030-01-01T11:00:00+08:00', dateOnly: false };
    scheduler.check.mockResolvedValue([reminder]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.notifications).toHaveLength(1); expect(scheduler.acknowledge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); expect(mocks.notifications).toHaveLength(1);
    const notification = mocks.notifications[0]!; notification.emit('show'); await flush();
    expect(scheduler.acknowledge).toHaveBeenCalledExactlyOnceWith(['synthetic-reminder']);
    notification.emit('click'); expect(f.window.show).toHaveBeenCalled();
    expect(f.window.webContents.send).toHaveBeenCalledWith('planner:navigate', { entity: 'task', id: 'synthetic-task' });
  });

  it('keeps failed OS deliveries pending and removes all lifecycle hooks on close', async () => {
    const f = fixture(); await flush(); const scheduler = mocks.schedulers[0]!;
    scheduler.check.mockResolvedValue([{ id: 'failed-reminder', refKind: 'task', refId: 'synthetic-task', title: '合成提醒', message: '合成内容' }]);
    await vi.advanceTimersByTimeAsync(30_000); mocks.notifications[0]!.emit('failed');
    expect(scheduler.acknowledge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); expect(mocks.notifications).toHaveLength(2);
    f.shell.close(); const calls = f.rpc.mock.calls.length;
    powerMonitor.emit('resume'); f.window.emit('focus'); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.rpc).toHaveBeenCalledTimes(calls); expect(f.updates.stop).toHaveBeenCalledOnce(); expect(mocks.trays[0]!.destroy).toHaveBeenCalledOnce();
    expect(mocks.notifications[1]!.close).toHaveBeenCalledOnce();
  });

  it('durably validates a cloud backup before requesting collector shutdown and restarts only after failed installation', async () => {
    const f = fixture(); await flush();
    f.collector.shutdownAndWait.mockImplementation(async () => {
      const files = readdirSync(join(f.directory, 'backups')); expect(files).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(f.directory, 'backups', files[0]!), 'utf8')).format).toBe('ultimate-calendar-safe-backup');
      return { ok: true, data: { stopped: true } };
    });
    await f.hooks.prepareInstall(); expect(f.collector.shutdownAndWait).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
    f.collector.invoke.mockResolvedValueOnce({ ok: false } as never).mockResolvedValue({ ok: true, data: {} });
    f.collector.processState.mockResolvedValue('stopped');
    await f.hooks.resumeAfterFailedInstall();
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, ['--planner-capture-only', `--planner-profile=${f.config.localDataDirectory}`], { windowsHide: true, detached: true, stdio: 'ignore' });
    expect(f.hooks.isBusy()).toBe(false); f.isBusy.mockReturnValue(true); expect(f.hooks.isBusy()).toBe(true);
  });

  it('reads a multi-chunk cloud export through the paired HTTP client and verifies the installed backup before collector shutdown', async () => {
    vi.useRealTimers();
    const f = fixture(); await flush();
    const dataDirectory = join(f.directory, 'synthetic-server'), origin = 'http://localhost:3210';
    mkdirSync(dataDirectory);
    const repo = createRepository(join(dataDirectory, 'planner.sqlite'), { automaticBackup: () => {} });
    const description = '合成资料'.repeat(24_000), taskCount = 32;
    try {
      repo.transact(state => {
        for (let i = 0; i < taskCount; i++) newEntity(state, 'task', { title: '合成任务 ' + i, description });
      });
    } finally { repo.close(); }
    const registry = { format: 1 as const, deviceId: randomUUID(), deviceName: '合成本机资源', locations: [] };
    writeLocalResources(f.config.localDataDirectory!, registry);
    const service = createRemoteService({ dataDirectory, backupDirectory: join(f.directory, 'server-backups'), getApiKey: async () => null,
      controller: { fetch: async () => { throw Error('Unexpected AI call'); } }, startupBackup: false, scheduleMonthlyAllowance: false });
    const http = createRemoteHttpServer({ service, origin });
    let client: ReturnType<typeof createNodeRemoteClient> | undefined;
    try {
      const port = await http.listen(0);
      // Route this fixed synthetic Host and Origin to this test's ephemeral listener.
      const transport: typeof fetch = async (url, init = {}) => {
        const target = new URL(String(url));
        if (target.origin !== origin) throw Error('Unexpected external destination');
        return new Promise((resolve, reject) => {
          const request = httpRequest({ hostname: '127.0.0.1', port, path: target.pathname, method: init.method,
            headers: { ...Object.fromEntries(new Headers(init.headers)), Host: target.host }, signal: init.signal ?? undefined }, response => {
            const bytes: Buffer[] = []; response.on('data', part => bytes.push(Buffer.from(part)));
            response.once('error', reject); response.on('end', () => {
              const headers = new Headers();
              for (const [name, value] of Object.entries(response.headers)) {
                if (Array.isArray(value)) value.forEach(part => headers.append(name, part));
                else if (value !== undefined) headers.set(name, value);
              }
              resolve(new Response(Buffer.concat(bytes), { status: response.statusCode, headers }));
            });
          });
          request.once('error', reject); request.end(init.body);
        });
      };
      const remote = createNodeRemoteClient({ origin, fetch: transport, credentials: { read: () => null, write: () => {} } });
      client = remote;
      await remote.pair(service.state.createPairingCode(), '合成更新测试设备');
      f.getIdentity.mockImplementation(async () => (await remote.getSession()).identity);
      const offsets: number[] = [];
      let manifest: ReturnType<typeof BackupExportManifestSchema.parse> | undefined;
      f.rpc.mockImplementation(async (method, input) => {
        const result = await remote.rpc(method, input);
        if (result.ok && method === 'backupExportStart') manifest = BackupExportManifestSchema.parse(result.data);
        if (method === 'backupExportChunk') offsets.push((input as { offset: number }).offset);
        return result;
      });
      f.collector.shutdownAndWait.mockImplementation(async () => {
        const folder = join(f.directory, 'backups');
        const files = readdirSync(folder), filename = files.find(name => /^before-update-.*\.json$/.test(name) && !name.endsWith('.local-resources.json'))!;
        expect(files.sort()).toEqual([filename, filename + '.local-resources.json'].sort());
        const bytes = readFileSync(join(folder, filename));
        expect(bytes.length).toBeGreaterThan(MAX_CLOUD_EXPORT_BYTES);
        expect(manifest).toMatchObject({ totalBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        expect(offsets).toEqual(Array.from({ length: Math.ceil(bytes.length / manifest!.chunkBytes) }, (_, i) => i * manifest!.chunkBytes));
        const tasks = JSON.parse(bytes.toString('utf8')).planner.entities.task;
        expect(tasks).toHaveLength(taskCount); expect(tasks.at(-1).description).toBe(description);
        expect(bytes.includes(Buffer.from(registry.deviceName))).toBe(false);
        expect(readLocalResourcesCompanion(join(folder, filename))).toEqual(registry);
        return { ok: true, data: { stopped: true } };
      });
      await f.hooks.prepareInstall();
      expect(f.collector.shutdownAndWait).toHaveBeenCalledOnce(); expect(mocks.spawn).not.toHaveBeenCalled();
      expect(f.rpc.mock.calls.filter(([method]) => method === 'backupExportFinish')).toEqual([['backupExportFinish', { downloadId: manifest!.downloadId }]]);
    } finally { client?.close(); await http.close(); await service.close(); }
  }, 30_000);

  it.each(['changed', 'short'] as const)('rejects a %s chunk before publishing the backup, copying local paths or stopping the collector', async damage => {
    const f = fixture(); await flush();
    writeLocalResources(f.config.localDataDirectory!, { format: 1, deviceId: randomUUID(), deviceName: '合成本机资源', locations: [] });
    f.rpc.mockImplementation(backupRpc(backup(), damage));
    await expect(f.hooks.prepareInstall()).rejects.toThrow();
    const folder = join(f.directory, 'backups');
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
    expect(f.collector.shutdownAndWait).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
    const request = f.rpc.mock.calls.find(([method]) => method === 'backupExportChunk')![1] as { downloadId: string };
    expect(f.rpc.mock.calls.filter(([method]) => method === 'backupExportFinish')).toEqual([['backupExportFinish', { downloadId: request.downloadId }]]);
  });

  it('detects a disk byte change even when every chunk delivered by the server is intact', async () => {
    const f = fixture(); await flush();
    const planner = emptyState();
    for (let i = 0; i < 4; i++) newEntity(planner, 'task', { title: '磁盘校验 ' + i, description: '合'.repeat(99_000) });
    const content = JSON.stringify({ ...JSON.parse(backup()), planner });
    const changeAt = Buffer.from(content).indexOf('"createdAt":"') + '"createdAt":"'.length;
    const serve = backupRpc(content), folder = join(f.directory, 'backups');
    writeLocalResources(f.config.localDataDirectory!, { format: 1, deviceId: randomUUID(), deviceName: '合成本机资源', locations: [] });
    let changedOnDisk = false;
    f.rpc.mockImplementation(async (method, input) => {
      if (method === 'backupExportChunk' && (input as { offset: number }).offset === CLOUD_BACKUP_CHUNK_BYTES) {
        const [staged] = readdirSync(folder);
        const fd = openSync(join(folder, staged!), 'r+');
        try { writeSync(fd, Buffer.from('1'), 0, 1, changeAt); changedOnDisk = true; } finally { closeSync(fd); }
      }
      return serve(method, input);
    });
    await expect(f.hooks.prepareInstall()).rejects.toThrow();
    expect(changedOnDisk).toBe(true); expect(readdirSync(folder)).toEqual([]);
    expect(f.collector.shutdownAndWait).not.toHaveBeenCalled();
  });

  it('does not stop collectors when the backup fails validation or changes data identity', async () => {
    const f = fixture(); await flush();
    f.rpc.mockImplementation(backupRpc('{}'));
    await expect(f.hooks.prepareInstall()).rejects.toThrow(); expect(f.collector.shutdownAndWait).not.toHaveBeenCalled();
    f.rpc.mockImplementation(backupRpc());
    f.getIdentity.mockResolvedValueOnce(identity).mockResolvedValueOnce({ ...identity, generation: 2 });
    await expect(f.hooks.prepareInstall()).rejects.toThrow(/身份改变/); expect(f.collector.shutdownAndWait).not.toHaveBeenCalled();
  });

  it('preserves an intentionally stopped collector when installation fails', async () => {
    const f = fixture(); await flush();
    mocks.trays[0]!.menu!.find(item => item.label?.startsWith('停止本机采集'))!.click!(); await flush();
    f.collector.processState.mockResolvedValue('stopped');
    await f.hooks.prepareInstall(); await f.hooks.resumeAfterFailedInstall();
    expect(f.collector.shutdownAndWait).toHaveBeenCalledTimes(2); expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('blocks installation when the collector has not fully stopped and never force kills it', async () => {
    const f = fixture(); await flush();
    f.collector.shutdownAndWait.mockResolvedValue({ ok: false, error: { code: 'CONFLICT', message: 'still draining' } } as never);
    await expect(f.hooks.prepareInstall()).rejects.toThrow(/尚未正常退出/);
    await f.hooks.resumeAfterFailedInstall(); expect(mocks.spawn).not.toHaveBeenCalled();
    expect(f.collector.close).not.toHaveBeenCalled();
  });
});
