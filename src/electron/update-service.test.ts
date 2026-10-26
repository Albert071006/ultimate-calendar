import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdateService, OFFICIAL_UPDATE_SOURCE, type UpdateDriver } from './update-service';
import { UpdateStateSchema, type UpdateState } from '../shared/update';

const release = { version: '0.3.4', releaseNotes: '新增测试功能' };
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowDowngrade = true;
  allowPrerelease = true;
  disableWebInstaller = false;
  forceDevUpdateConfig = true;
  netSession = { closeAllConnections: vi.fn(async () => {}), setProxy: vi.fn(async () => {}), forceReloadProxyConfig: vi.fn(async () => {}) };
  cancellationToken = { cancel: vi.fn() };
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn<() => Promise<unknown>>(async () => { this.emit('update-available', release); return { cancellationToken: this.cancellationToken }; });
  downloadUpdate = vi.fn(async () => { this.emit('download-progress', { percent: 42 }); this.emit('update-downloaded', release); return ['synthetic-installer.exe']; });
  quitAndInstall = vi.fn();
}
const services: ReturnType<typeof createUpdateService>[] = [];
function fixture(overrides: Partial<Parameters<typeof createUpdateService>[0]> = {}) {
  const driver = new FakeUpdater(), changes: UpdateState[] = [];
  const getUpdater = vi.fn(() => driver as unknown as UpdateDriver);
  const isBusy = vi.fn(() => false), prepareInstall = vi.fn(async () => {}), resumeAfterFailedInstall = vi.fn(async () => {}), setQuitting = vi.fn();
  const service = createUpdateService({ currentVersion: '0.3.3', packaged: true, platform: 'win32', isolatedProfile: false,
    getUpdater, isBusy, prepareInstall, resumeAfterFailedInstall, setQuitting, now: () => new Date('2026-10-23T13:00:00Z'),
    onChanged: state => changes.push(UpdateStateSchema.parse(state)), ...overrides });
  services.push(service);
  return { service, driver, changes, getUpdater, isBusy, prepareInstall, resumeAfterFailedInstall, setQuitting };
}
async function ready(f: ReturnType<typeof fixture>) { await f.service.checkForUpdates(); await f.service.downloadUpdate(); }
afterEach(() => { for (const service of services.splice(0)) service.stop(); vi.useRealTimers(); });

describe('official update checks and downloads', () => {
  it.each([{ packaged: false }, { isolatedProfile: true }, { platform: 'darwin' }])('never initializes a real updater in a disabled environment: %o', async override => {
    vi.useFakeTimers(); const f = fixture(override); f.service.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect((await f.service.checkForUpdates()).ok).toBe(true);
    expect((await f.service.downloadUpdate()).ok).toBe(false);
    expect((await f.service.installUpdate()).ok).toBe(false);
    expect(f.service.snapshot().status).toBe('unavailable'); expect(f.getUpdater).not.toHaveBeenCalled();
  });
  it('checks quietly after 15 seconds, every four hours, and stops timers on shutdown', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.driver.checkForUpdates.mockImplementation(async () => { f.driver.emit('update-not-available', { version: '0.3.3' }); return {}; });
    f.service.start(); f.service.start(); await vi.advanceTimersByTimeAsync(14_999);
    expect(f.driver.checkForUpdates).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1);
    expect(f.driver.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 - 15_000); expect(f.driver.checkForUpdates).toHaveBeenCalledTimes(2);
    f.service.stop(); await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000); expect(f.driver.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(f.driver.downloadUpdate).not.toHaveBeenCalled(); expect(f.driver.quitAndInstall).not.toHaveBeenCalled();
  });
  it('keeps the independent local edition on its own update channel', async () => {
    const f = fixture({ channel: 'local' });
    await f.service.checkForUpdates();
    expect(f.driver.setFeedURL).toHaveBeenCalledExactlyOnceWith({ ...OFFICIAL_UPDATE_SOURCE, channel: 'local' });
    expect(f.driver.downloadUpdate).not.toHaveBeenCalled();
  });
  it('fixes the official source and requires explicit download and installation', async () => {
    const f = fixture(); const result = await f.service.checkForUpdates();
    expect(result.ok).toBe(true); expect(f.service.snapshot()).toMatchObject({ status: 'available', currentVersion: '0.3.3', latestVersion: '0.3.4', checkedAt: '2026-10-23T13:00:00.000Z' });
    expect(f.driver.setFeedURL).toHaveBeenCalledExactlyOnceWith(OFFICIAL_UPDATE_SOURCE);
    expect(f.driver).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, autoRunAppAfterInstall: true, allowDowngrade: false, allowPrerelease: false, forceDevUpdateConfig: false, disableWebInstaller: true });
    expect(f.driver.downloadUpdate).not.toHaveBeenCalled(); expect(f.driver.quitAndInstall).not.toHaveBeenCalled();
    await f.service.downloadUpdate(); expect(f.service.snapshot().status).toBe('downloaded'); expect(f.driver.quitAndInstall).not.toHaveBeenCalled();
  });
  it.each(['0.3.3', '0.3.2', '0.3.4-beta.1', '../0.3.4'])('rejects same, older or nonstable version %s', async version => {
    const f = fixture(); f.driver.checkForUpdates.mockImplementation(async () => { f.driver.emit('update-available', { version }); return {}; });
    await f.service.checkForUpdates(); expect(f.service.snapshot().status).toBe('idle'); expect(f.service.snapshot().latestVersion).toBeNull();
    expect((await f.service.downloadUpdate()).ok).toBe(false); expect(f.driver.downloadUpdate).not.toHaveBeenCalled();
  });
  it('serializes checks and downloads while preserving the available release', async () => {
    const f = fixture(); let resolve!: () => void;
    f.driver.checkForUpdates.mockImplementationOnce(async () => { await new Promise<void>(r => { resolve = r; }); f.driver.emit('update-available', release); return {}; });
    const pending = f.service.checkForUpdates(); await f.service.checkForUpdates(); await f.service.downloadUpdate();
    await vi.waitFor(() => expect(f.driver.checkForUpdates).toHaveBeenCalledTimes(1)); expect(f.driver.downloadUpdate).not.toHaveBeenCalled();
    resolve(); await pending;
    f.driver.downloadUpdate.mockImplementationOnce(async () => { await new Promise<void>(r => { resolve = r; }); f.driver.emit('update-downloaded', release); return []; });
    const downloading = f.service.downloadUpdate(); await f.service.downloadUpdate(); await f.service.checkForUpdates();
    await vi.waitFor(() => expect(f.driver.downloadUpdate).toHaveBeenCalledTimes(1)); expect(f.driver.checkForUpdates).toHaveBeenCalledTimes(1);
    resolve(); await downloading; expect(f.service.snapshot().status).toBe('downloaded');
    await f.service.checkForUpdates(); expect(f.driver.checkForUpdates).toHaveBeenCalledTimes(1);
  });
  it('bounds release text and download progress without rendering provider HTML', async () => {
    const f = fixture(); f.driver.checkForUpdates.mockImplementation(async () => { f.driver.emit('update-available', { ...release, releaseNotes: [{ note: '<b>更新</b>\u0000' + 'a'.repeat(21_000) }] }); return {}; });
    await f.service.checkForUpdates(); expect(f.service.snapshot().releaseNotes).toHaveLength(20_000); expect(f.service.snapshot().releaseNotes).not.toContain('<b>');
    f.driver.downloadUpdate.mockImplementation(async () => {
      f.driver.emit('download-progress', { percent: Number.NaN }); f.driver.emit('download-progress', { percent: 130 });
      expect(f.service.snapshot().progressPercent).toBe(100);
      f.driver.emit('download-progress', { percent: -20 }); expect(f.service.snapshot().progressPercent).toBe(0);
      f.driver.emit('update-downloaded', release); return [];
    });
    await f.service.downloadUpdate(); expect(f.service.snapshot().status).toBe('downloaded');
  });
  it('sanitizes check errors and permits a later retry', async () => {
    const f = fixture(); f.driver.checkForUpdates.mockRejectedValueOnce(Error('synthetic-secret at C:\\private'));
    await f.service.checkForUpdates(); expect(f.service.snapshot().status).toBe('error'); expect(JSON.stringify(f.changes)).not.toContain('synthetic-secret');
    await f.service.checkForUpdates(); expect(f.service.snapshot().status).toBe('available');
  });
  it('times out a stuck check after 30 seconds and retries with a fresh driver, ignoring late old results', async () => {
    vi.useFakeTimers(); const first = new FakeUpdater(), second = new FakeUpdater(); let finish!: () => void;
    first.checkForUpdates.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); first.emit('update-not-available', { version: '0.3.3' }); return {}; });
    const getUpdater = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const f = fixture({ getUpdater }); const check = f.service.checkForUpdates();
    await vi.advanceTimersByTimeAsync(29_999); expect(f.service.snapshot().status).toBe('checking');
    await vi.advanceTimersByTimeAsync(1); expect(f.service.snapshot().status).toBe('checking');
    expect(first.netSession.closeAllConnections).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); await check; expect(getUpdater).toHaveBeenCalledTimes(2); expect(f.service.snapshot().status).toBe('available');
    finish(); await vi.advanceTimersByTimeAsync(0); expect(f.service.snapshot().status).toBe('available');
    expect(f.service.snapshot().latestVersion).toBe('0.3.4');
  });
  it('resets the download idle deadline on actual progress and allows a fresh retry after timeout', async () => {
    vi.useFakeTimers(); const first = new FakeUpdater(), second = new FakeUpdater(); let finish!: () => void;
    first.downloadUpdate.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); first.emit('update-downloaded', release); return []; });
    const getUpdater = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second), f = fixture({ getUpdater });
    await f.service.checkForUpdates(); const download = f.service.downloadUpdate();
    await vi.advanceTimersByTimeAsync(110_000); first.emit('download-progress', { percent: 10 });
    await vi.advanceTimersByTimeAsync(110_000); expect(f.service.snapshot().status).toBe('downloading');
    first.emit('download-progress', { percent: 10 }); // Repeated stale progress cannot keep a stalled request alive.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.service.snapshot()).toMatchObject({ status: 'downloading', latestVersion: '0.3.4' }); expect(first.netSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(first.cancellationToken.cancel).toHaveBeenCalledOnce();
    finish(); await vi.advanceTimersByTimeAsync(0); expect(f.service.snapshot().status).toBe('downloading');
    expect((await f.service.installUpdate()).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); await download; expect(f.service.snapshot().status).toBe('downloaded');
    expect(second.checkForUpdates).toHaveBeenCalledOnce();
    expect(second.downloadUpdate).toHaveBeenCalledWith(second.cancellationToken);
    expect(getUpdater).toHaveBeenCalledTimes(2);
  });

  it('refreshes the dedicated system proxy before checks and downloads', async () => {
    const f = fixture(), order: string[] = [];
    f.driver.netSession.setProxy.mockImplementation(async () => { order.push('proxy'); });
    f.driver.netSession.forceReloadProxyConfig.mockImplementation(async () => { order.push('reload'); });
    f.driver.checkForUpdates.mockImplementation(async () => { order.push('check'); f.driver.emit('update-available', release); return {}; });
    f.driver.downloadUpdate.mockImplementation(async () => { order.push('download'); f.driver.emit('update-downloaded', release); return []; });
    await ready(f);
    expect(order).toEqual(['proxy', 'reload', 'check', 'proxy', 'reload', 'download']);
    expect(f.driver.netSession.setProxy).toHaveBeenCalledWith({ mode: 'system' });
    expect(f.driver.netSession.closeAllConnections).not.toHaveBeenCalled();
  });

  it.each(['net::ERR_CONNECTION_RESET', 'net::ERR_PROXY_CONNECTION_FAILED', 'ERR_UPDATER_INVALID_RELEASE_FEED: HttpError: 503 Service Unavailable'])('automatically retries transient %s without exposing raw diagnostics', async message => {
    vi.useFakeTimers(); const first = new FakeUpdater(), second = new FakeUpdater();
    first.checkForUpdates.mockImplementation(async () => {
      const error = Error(`${message}; https://example.invalid/?token=synthetic-secret C:\\private`);
      first.emit('error', error); throw error;
    });
    const f = fixture({ getUpdater: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) });
    const pending = f.service.checkForUpdates(); await vi.advanceTimersByTimeAsync(0);
    expect(f.service.snapshot().status).toBe('checking'); expect(f.service.snapshot().message).toContain('2/3');
    await f.service.checkForUpdates(); await f.service.downloadUpdate();
    expect(second.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(f.service.snapshot().status).toBe('available'); expect(first.netSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(second.netSession.setProxy).toHaveBeenCalledOnce(); expect(JSON.stringify(f.changes)).not.toContain('synthetic-secret');
    expect(f.changes.some(change => change.status === 'error')).toBe(false);
  });

  it('stops after three failed network attempts and permits a later manual retry', async () => {
    vi.useFakeTimers(); const drivers = Array.from({ length: 4 }, () => new FakeUpdater());
    drivers.slice(0, 3).forEach(driver => driver.checkForUpdates.mockRejectedValue(Object.assign(Error('connection reset'), { code: 'ECONNRESET' })));
    const getUpdater = vi.fn(); drivers.forEach(driver => getUpdater.mockReturnValueOnce(driver));
    const f = fixture({ getUpdater }); const pending = f.service.checkForUpdates();
    await vi.advanceTimersByTimeAsync(3000); await pending;
    expect(getUpdater).toHaveBeenCalledTimes(3); expect(f.service.snapshot()).toMatchObject({ status: 'error', latestVersion: null });
    await f.service.checkForUpdates(); expect(getUpdater).toHaveBeenCalledTimes(4); expect(f.service.snapshot().status).toBe('available');
  });

  it.each(['ERR_CERT_AUTHORITY_INVALID', 'ERR_UPDATER_INVALID_UPDATE_INFO', 'ERR_UPDATER_INVALID_SIGNATURE', 'ERR_CHECKSUM_MISMATCH'])('does not automatically retry safety/metadata failure %s', async code => {
    vi.useFakeTimers(); const f = fixture(); f.driver.checkForUpdates.mockRejectedValue(Object.assign(Error('synthetic-private'), { code }));
    await f.service.checkForUpdates(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.driver.checkForUpdates).toHaveBeenCalledOnce(); expect(f.service.snapshot().status).toBe('error');
    expect((await f.service.installUpdate()).ok).toBe(false); expect(f.prepareInstall).not.toHaveBeenCalled();
    expect(JSON.stringify(f.changes)).not.toContain('synthetic-private');
  });

  it('rechecks and pins the requested version before retrying a failed download', async () => {
    vi.useFakeTimers(); const first = new FakeUpdater(), second = new FakeUpdater();
    first.downloadUpdate.mockRejectedValue(Object.assign(Error('reset'), { code: 'ECONNRESET' }));
    second.checkForUpdates.mockImplementation(async () => { second.emit('update-available', { ...release, version: '0.3.5' }); return {}; });
    const f = fixture({ getUpdater: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) });
    await f.service.checkForUpdates(); const downloading = f.service.downloadUpdate();
    await vi.advanceTimersByTimeAsync(1000); await downloading;
    expect(second.checkForUpdates).toHaveBeenCalledOnce(); expect(second.downloadUpdate).not.toHaveBeenCalled();
    expect(f.service.snapshot()).toMatchObject({ status: 'error', latestVersion: null });
    expect(f.service.snapshot().message).toContain('正式版本已发生变化'); expect((await f.service.installUpdate()).ok).toBe(false);
  });

  it('refuses a checksum-failed download without automatic retries or installation', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.service.checkForUpdates();
    f.driver.downloadUpdate.mockRejectedValue(Object.assign(Error('sha512 checksum mismatch at C:\\private'), { code: 'ERR_CHECKSUM_MISMATCH' }));
    await f.service.downloadUpdate(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.driver.downloadUpdate).toHaveBeenCalledOnce(); expect(f.service.snapshot().message).toContain('校验失败');
    expect((await f.service.installUpdate()).ok).toBe(false); expect(f.prepareInstall).not.toHaveBeenCalled();
  });

  it('cancels retry backoff on shutdown without making further network calls', async () => {
    vi.useFakeTimers(); const first = new FakeUpdater(), second = new FakeUpdater();
    first.checkForUpdates.mockRejectedValue(Object.assign(Error('reset'), { code: 'ECONNRESET' }));
    const getUpdater = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second), f = fixture({ getUpdater });
    const pending = f.service.checkForUpdates(); await vi.advanceTimersByTimeAsync(0); const changeCount = f.changes.length;
    f.service.stop(); await pending; await vi.advanceTimersByTimeAsync(10_000);
    expect(getUpdater).toHaveBeenCalledOnce(); expect(f.changes).toHaveLength(changeCount); expect(second.checkForUpdates).not.toHaveBeenCalled();
  });

  it('does not start a delayed proxy-preparation request after shutdown', async () => {
    vi.useFakeTimers(); const f = fixture(); let releaseProxy!: () => void;
    f.driver.netSession.setProxy.mockImplementation(async () => { await new Promise<void>(resolve => { releaseProxy = resolve; }); });
    const pending = f.service.checkForUpdates(); await vi.advanceTimersByTimeAsync(0);
    f.service.stop(); await pending; releaseProxy(); await vi.advanceTimersByTimeAsync(0);
    expect(f.driver.checkForUpdates).not.toHaveBeenCalled(); expect(f.driver.netSession.closeAllConnections).toHaveBeenCalledOnce();
  });
  it('never marks unchecked or mismatched downloads installable; checksum failure can be retried', async () => {
    const f = fixture(); await f.service.checkForUpdates();
    f.driver.downloadUpdate.mockImplementationOnce(async () => { f.driver.emit('update-downloaded', { version: '99.0.0' }); return []; });
    await f.service.downloadUpdate(); expect(f.service.snapshot().status).toBe('error'); expect((await f.service.installUpdate()).ok).toBe(false);
    f.driver.downloadUpdate.mockRejectedValueOnce(Error('checksum mismatch, private path'));
    await f.service.downloadUpdate(); expect(f.service.snapshot().status).toBe('error'); expect(f.service.snapshot().latestVersion).toBe('0.3.4');
    await f.service.downloadUpdate(); expect(f.service.snapshot().status).toBe('downloaded'); expect(f.driver.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('backup and safe installation', () => {
  it('refuses installation before a verified download', async () => {
    const f = fixture(); expect((await f.service.installUpdate()).ok).toBe(false);
    await f.service.checkForUpdates(); expect((await f.service.installUpdate()).ok).toBe(false);
    expect(f.prepareInstall).not.toHaveBeenCalled(); expect(f.driver.quitAndInstall).not.toHaveBeenCalled();
  });
  it('leaves AI/QQ work running and asks for retry when the app is busy', async () => {
    const f = fixture(); await ready(f); f.isBusy.mockReturnValue(true);
    expect(await f.service.installUpdate()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.service.snapshot().status).toBe('downloaded'); expect(f.prepareInstall).not.toHaveBeenCalled(); expect(f.setQuitting).not.toHaveBeenCalled();
    f.isBusy.mockReturnValue(false); expect((await f.service.installUpdate()).ok).toBe(true); expect(f.driver.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it('cannot exit after a failed backup and restores collection so installation can be retried', async () => {
    const f = fixture(); await ready(f); f.prepareInstall.mockRejectedValueOnce(Error('disk full synthetic-private-path'));
    expect(await f.service.installUpdate()).toMatchObject({ ok: false, error: { code: 'STORAGE' } });
    expect(f.driver.quitAndInstall).not.toHaveBeenCalled(); expect(f.setQuitting).not.toHaveBeenCalledWith(true);
    expect(f.resumeAfterFailedInstall).toHaveBeenCalledOnce(); expect(f.service.isInstalling()).toBe(false);
    expect(f.service.snapshot().status).toBe('downloaded'); expect(JSON.stringify(f.changes)).not.toContain('synthetic-private-path');
    expect((await f.service.installUpdate()).ok).toBe(true); expect(f.driver.quitAndInstall).toHaveBeenCalledOnce();
  });
  it('holds the operation lock across preparation and sets quitting only after the backup completes', async () => {
    const f = fixture(); await ready(f); const order: string[] = []; let resolve!: () => void;
    f.prepareInstall.mockImplementationOnce(async () => { order.push('backup-start'); await new Promise<void>(r => { resolve = r; }); order.push('backup-finished'); });
    f.setQuitting.mockImplementation(value => { order.push(`quitting-${value}`); }); f.driver.quitAndInstall.mockImplementation(() => { order.push('installer'); });
    const pending = f.service.installUpdate(); expect(f.service.isInstalling()).toBe(true);
    expect(await f.service.installUpdate()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } }); expect(order).toEqual(['backup-start']);
    resolve(); expect((await pending).ok).toBe(true);
    expect(order).toEqual(['backup-start', 'backup-finished', 'quitting-true', 'installer']);
    expect(f.driver.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
    expect(f.service.snapshot().status).toBe('installing');
  });
  it.each(['throw', 'event'])('rolls back close-to-tray bypass if the installer fails via %s', async mode => {
    const f = fixture(); await ready(f);
    f.driver.quitAndInstall.mockImplementationOnce(() => { if (mode === 'throw') throw Error('private installer path'); f.driver.emit('error', Error('private installer path')); });
    expect(await f.service.installUpdate()).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(f.setQuitting.mock.calls.map(call => call[0])).toEqual([true, false]); expect(f.resumeAfterFailedInstall).toHaveBeenCalledOnce();
    expect(f.service.isInstalling()).toBe(false); expect(f.service.snapshot().status).toBe('downloaded');
    expect(JSON.stringify(f.changes)).not.toContain('private installer path');
  });
  it('recovers when the installer never exits the app and retains retry state', async () => {
    vi.useFakeTimers(); const f = fixture(); await ready(f); await f.service.installUpdate();
    await vi.advanceTimersByTimeAsync(15_000); expect(f.service.snapshot().status).toBe('downloaded');
    expect(f.setQuitting).toHaveBeenLastCalledWith(false); expect(f.resumeAfterFailedInstall).toHaveBeenCalledOnce(); expect(f.service.isInstalling()).toBe(false);
  });
  it('does not resume work or publish late updates after app shutdown', async () => {
    vi.useFakeTimers(); const f = fixture(); await ready(f); await f.service.installUpdate(); f.service.stop(); const changes = f.changes.length;
    f.driver.emit('error', Error('late event')); await vi.advanceTimersByTimeAsync(20_000);
    expect(f.changes).toHaveLength(changes); expect(f.resumeAfterFailedInstall).not.toHaveBeenCalled();
  });
});
