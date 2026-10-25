import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { createCollectorControlClient } from './collector-control';
import type { createUpdateService } from './update-service';
import { SnapshotSchema } from '../shared/contracts';
import { emptyState } from '../storage/repository';
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
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function fixture(production = true) {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-shell-unit-')); roots.push(directory);
  const window = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), isMinimized: vi.fn(() => false), restore: vi.fn(), show: vi.fn(), hide: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } });
  const collector = { invoke: vi.fn(async () => ({ ok: true, data: {} })), setTrayOwner: vi.fn(async (_owner: string, _active: boolean) => ({ ok: true, data: { accepted: true } })), processState: vi.fn(async (): Promise<'running' | 'stopped' | 'unknown'> => 'running'), shutdownAndWait: vi.fn(async () => ({ ok: true, data: { stopped: true } })), close: vi.fn() };
  const rpc = vi.fn(async (method: string) => method === 'snapshot' ? { ok: true, data: snapshot() } : { ok: true, data: { content: backup() } });
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
    expect(mocks.trays[0]!.menu!.some(item => item.label === '启动 QQ 采集')).toBe(true);
    expect(mocks.trays[0]!.menu!.some(item => item.label === '退出日历')).toBe(true);
  });

  it('stops and restarts collection from the same cloud tray while preserving cloud actions', async () => {
    const f = fixture(); await flush();
    f.shell.setTrayItems([{ label: '合成云端操作' }]);
    mocks.trays[0]!.menu!.find(item => item.label?.startsWith('停止 QQ 采集'))!.click!(); await flush();
    expect(f.collector.shutdownAndWait).toHaveBeenCalledOnce(); expect(mocks.trays).toHaveLength(1);
    expect(mocks.trays[0]!.menu!.some(item => item.label === '退出日历')).toBe(true);
    const claims = f.collector.setTrayOwner.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000); expect(f.collector.setTrayOwner).toHaveBeenCalledTimes(claims);
    f.collector.invoke.mockResolvedValueOnce({ ok: false } as never).mockResolvedValue({ ok: true, data: {} });
    f.collector.processState.mockResolvedValue('stopped');
    mocks.trays[0]!.menu!.find(item => item.label === '启动 QQ 采集')!.click!(); await flush();
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

  it('does not stop collectors when the backup fails validation or changes data identity', async () => {
    const f = fixture(); await flush();
    f.rpc.mockImplementation(async method => method === 'snapshot' ? { ok: true, data: snapshot() } : { ok: true, data: { content: '{}' } });
    await expect(f.hooks.prepareInstall()).rejects.toThrow(); expect(f.collector.shutdownAndWait).not.toHaveBeenCalled();
    f.rpc.mockImplementation(async method => method === 'snapshot' ? { ok: true, data: snapshot() } : { ok: true, data: { content: backup() } });
    f.getIdentity.mockResolvedValueOnce(identity).mockResolvedValueOnce({ ...identity, generation: 2 });
    await expect(f.hooks.prepareInstall()).rejects.toThrow(/身份改变/); expect(f.collector.shutdownAndWait).not.toHaveBeenCalled();
  });

  it('preserves an intentionally stopped collector when installation fails', async () => {
    const f = fixture(); await flush();
    mocks.trays[0]!.menu!.find(item => item.label?.startsWith('停止 QQ 采集'))!.click!(); await flush();
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
