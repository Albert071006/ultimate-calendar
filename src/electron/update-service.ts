import type { AppUpdater } from 'electron-updater';
import type { ApiError, ApiResult } from '../shared/contracts';
import { UpdateStateSchema, type UpdateState } from '../shared/update';
import { updateError, updateFailure } from './update-errors';

export const OFFICIAL_UPDATE_SOURCE = Object.freeze({ provider: 'github' as const, owner: 'Albert071006', repo: 'ultimate-calendar', private: false, channel: 'latest' });
export type UpdateDriver = Pick<AppUpdater, 'autoDownload' | 'autoInstallOnAppQuit' | 'autoRunAppAfterInstall' | 'allowDowngrade' | 'allowPrerelease' | 'disableWebInstaller' | 'forceDevUpdateConfig' | 'netSession' | 'setFeedURL' | 'checkForUpdates' | 'downloadUpdate' | 'on' | 'removeListener'> & {
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};
interface UpdateOptions {
  currentVersion: string;
  packaged: boolean;
  platform: string;
  isolatedProfile: boolean;
  getUpdater(): UpdateDriver;
  isBusy(): boolean;
  /** Suspend background writes and finish a verified SQLite backup before returning. */
  prepareInstall(): void | Promise<void>;
  resumeAfterFailedInstall(): void | Promise<void>;
  setQuitting(value: boolean): void;
  onChanged?(state: UpdateState): void;
  now?(): Date;
}

function stableVersion(value: string): number[] | null {
  if (!/^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(value)) return null;
  return value.split('.').map(Number);
}
function newerStable(version: string, current: string) {
  const next = stableVersion(version), previous = stableVersion(current);
  if (!next || !previous) return false;
  for (let i = 0; i < 3; i++) if (next[i] !== previous[i]) return next[i]! > previous[i]!;
  return false;
}
function notes(value: unknown): string {
  const content = typeof value === 'string' ? value : Array.isArray(value)
    ? value.map(entry => entry && typeof entry === 'object' && 'note' in entry && typeof entry.note === 'string' ? entry.note : '').filter(Boolean).join('\n\n') : '';
  // Display release text only: never pass provider HTML to the renderer as markup.
  return content.replace(/<[^>]*>/g, '').replace(/\u0000/g, '').slice(0, 20_000);
}

/** All URLs and installer paths stay inside the trusted updater, never in IPC input. */
export function createUpdateService(options: UpdateOptions) {
  const enabled = options.packaged && options.platform === 'win32' && !options.isolatedProfile;
  let state: UpdateState = UpdateStateSchema.parse({ currentVersion: options.currentVersion, status: enabled ? 'idle' : 'unavailable',
    latestVersion: null, releaseNotes: '', progressPercent: null, checkedAt: null,
    message: enabled ? '从 GitHub 正式发行版检查更新，下载和安装由你决定。' : '开发模式、独立测试资料或非 Windows 环境不启用更新。' });
  let updater: UpdateDriver | null = null;
  let operation: 'check' | 'download' | 'install' | null = null;
  let downloaded = false, stopped = false, started = false, preparing = false;
  let firstCheck: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
  let installWatchdog: ReturnType<typeof setTimeout> | undefined;
  let recovering: Promise<void> | null = null;
  let driverGeneration = 0;
  let abortNetwork: (() => void) | null = null, downloadAdvanced: (() => void) | null = null;
  let abortBackoff: (() => void) | null = null;
  let connectionReset: Promise<void> = Promise.resolve();
  let readyVersion: string | null = null, recheckedVersion: string | null = null;
  let recheckingDriver: UpdateDriver | null = null;
  let downloadToken: Parameters<UpdateDriver['downloadUpdate']>[0];
  const now = options.now ?? (() => new Date());
  const snapshot = (): UpdateState => ({ ...state });
  const success = (): ApiResult<UpdateState> => ({ ok: true, data: snapshot() });
  const failure = (code: ApiError['code'], message: string): ApiResult<UpdateState> => ({ ok: false, error: { code, message, retryable: code !== 'VALIDATION' } });
  function update(patch: Partial<UpdateState>) {
    if (stopped) return;
    state = UpdateStateSchema.parse({ ...state, ...patch }); options.onChanged?.(snapshot());
  }
  function discardNetworkDriver() {
    driverGeneration++;
    const previous = updater; updater = null;
    readyVersion = null;
    const token = downloadToken; downloadToken = undefined;
    token?.cancel();
    // This is electron-updater's dedicated session, not the app/AI/QQ network session.
    // Wait for the reset before starting another request on this shared partition.
    if (previous) connectionReset = connectionReset.then(() => previous.netSession.closeAllConnections()).catch(() => {});
  }
  function boundedNetwork<T>(work: (active: () => boolean) => Promise<T>, idleMilliseconds: number, isDownload = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let idle: ReturnType<typeof setTimeout>, total: ReturnType<typeof setTimeout> | undefined, ended = false;
      const cleanup = () => { clearTimeout(idle); if (total) clearTimeout(total); abortNetwork = null; downloadAdvanced = null; };
      const abort = () => {
        if (ended) return; ended = true; cleanup(); discardNetworkDriver();
        downloaded = false;
        reject(updateError(stopped ? 'UPDATE_CANCELLED' : 'UPDATE_NETWORK_TIMEOUT'));
      };
      const resetIdle = () => { clearTimeout(idle); idle = setTimeout(abort, idleMilliseconds); };
      resetIdle(); abortNetwork = abort;
      if (isDownload) { downloadAdvanced = resetIdle; total = setTimeout(abort, 2 * 60 * 60 * 1000); }
      Promise.resolve().then(() => work(() => !ended && !stopped)).then(value => {
        if (ended) return; ended = true; cleanup(); resolve(value);
      }, error => { if (ended) return; ended = true; cleanup(); reject(error); });
    });
  }
  async function prepareNetwork(driver: UpdateDriver, active: () => boolean) {
    await connectionReset;
    if (!active()) throw updateError('UPDATE_CANCELLED');
    // Refresh only the updater's system-proxy settings, including changes since launch.
    await driver.netSession.setProxy({ mode: 'system' });
    if (!active()) throw updateError('UPDATE_CANCELLED');
    await driver.netSession.forceReloadProxyConfig();
    if (!active()) throw updateError('UPDATE_CANCELLED');
  }
  function backoff(milliseconds: number) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { abortBackoff = null; resolve(); }, milliseconds);
      abortBackoff = () => { clearTimeout(timer); abortBackoff = null; reject(updateError('UPDATE_CANCELLED')); };
      if (stopped) abortBackoff();
    });
  }
  async function retryNetwork(work: () => Promise<void>, downloading: boolean) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (stopped) throw updateError('UPDATE_CANCELLED');
      try { await work(); return; }
      catch (error) {
        // Detach the failed generation before any late result can make it installable.
        if (updater) discardNetworkDriver();
        downloaded = false;
        const problem = updateFailure(error);
        if (stopped || !problem.retryable || attempt === 3) throw error;
        update({ status: downloading ? 'downloading' : 'checking', progressPercent: downloading ? 0 : null,
          message: `${problem.message.replace(/，请.*$/, '')}，正在自动重试（${attempt + 1}/3）…` });
        await backoff(attempt * 1000);
      }
    }
  }
  function recoverInstall(message: string): Promise<void> {
    if (recovering) return recovering;
    if (installWatchdog) clearTimeout(installWatchdog);
    options.setQuitting(false);
    update({ status: downloaded ? 'downloaded' : 'error', message });
    // Keep the operation lock until the suspended collection service has resumed.
    recovering = Promise.resolve().then(() => options.resumeAfterFailedInstall()).catch(() => {
      update({ message: `${message} QQ 采集连接恢复失败，可在 QQ 采集页重新连接。` });
    }).finally(() => { recovering = null; operation = null; });
    return recovering;
  }
  function ensureUpdater(): UpdateDriver {
    if (updater) return updater;
    const driver = options.getUpdater();
    const generation = ++driverGeneration;
    const current = () => !stopped && generation === driverGeneration;
    driver.autoDownload = false;
    driver.autoInstallOnAppQuit = false;
    driver.autoRunAppAfterInstall = true;
    driver.allowPrerelease = false;
    driver.allowDowngrade = false;
    driver.forceDevUpdateConfig = false;
    driver.disableWebInstaller = true;
    driver.setFeedURL(OFFICIAL_UPDATE_SOURCE);
    driver.on('update-available', info => {
      if (!current()) return;
      if (operation === 'download' && recheckingDriver === driver) { recheckedVersion = info.version; return; }
      if (operation !== 'check') return;
      if (!newerStable(info.version, options.currentVersion)) {
        update({ status: 'idle', latestVersion: null, releaseNotes: '', progressPercent: null, checkedAt: now().toISOString(), message: '当前已是最新正式版本。' }); return;
      }
      downloaded = false;
      readyVersion = info.version;
      update({ status: 'available', latestVersion: info.version, releaseNotes: notes(info.releaseNotes), progressPercent: null, checkedAt: now().toISOString(), message: `发现新版本 ${info.version}，可以下载更新。` });
    });
    driver.on('update-not-available', info => {
      if (!current()) return;
      if (operation === 'download' && recheckingDriver === driver) { recheckedVersion = info.version; return; }
      if (operation !== 'check') return;
      downloaded = false;
      update({ status: 'idle', latestVersion: null, releaseNotes: '', progressPercent: null, checkedAt: now().toISOString(), message: '当前已是最新正式版本。' });
    });
    driver.on('download-progress', info => {
      if (!current() || operation !== 'download' || recheckingDriver === driver || !Number.isFinite(info.percent)) return;
      if (info.percent > (state.progressPercent ?? 0)) downloadAdvanced?.();
      update({ status: 'downloading', progressPercent: Math.min(100, Math.max(0, info.percent)), message: '正在下载更新，可以继续使用日历。' });
    });
    driver.on('update-downloaded', info => {
      if (!current() || operation !== 'download' || recheckingDriver === driver || readyVersion !== info.version || info.version !== state.latestVersion || !newerStable(info.version, options.currentVersion)) return;
      // electron-updater emits this only after download and checksum/signature checks finish.
      downloaded = true;
      update({ status: 'downloaded', progressPercent: 100, message: '更新已下载并通过校验。点击“重启安装”前会先备份本地数据。' });
    });
    driver.on('error', () => {
      if (!current()) return;
      if (operation === 'install' && !preparing) {
        void recoverInstall('安装程序未能启动，应用保持运行，请重试。');
      }
      // Network errors are handled by the rejected operation promise, including retries.
    });
    updater = driver; return driver;
  }
  async function checkForUpdates(): Promise<ApiResult<UpdateState>> {
    if (!enabled || stopped) return success();
    if (operation || downloaded) return success();
    operation = 'check';
    update({ status: 'checking', latestVersion: null, releaseNotes: '', progressPercent: null, message: '正在检查 GitHub 正式发行版…' });
    try {
      await retryNetwork(async () => {
        update({ status: 'checking', latestVersion: null, releaseNotes: '' });
        await boundedNetwork(async active => {
          const driver = ensureUpdater(); await prepareNetwork(driver, active);
          const result = await driver.checkForUpdates();
          if (active()) downloadToken = result?.cancellationToken;
          if (active() && state.status === 'checking') throw updateError('UPDATE_INCOMPLETE');
        }, 30_000);
      }, false);
    } catch (error) { update({ status: 'error', latestVersion: null, releaseNotes: '', checkedAt: now().toISOString(), message: updateFailure(error).message }); }
    finally { operation = null; }
    return success();
  }
  async function downloadUpdate(): Promise<ApiResult<UpdateState>> {
    if (!enabled || stopped) return failure('VALIDATION', state.message);
    if (operation || downloaded) return success();
    if (!state.latestVersion || !newerStable(state.latestVersion, options.currentVersion)) return failure('VALIDATION', '请先检查是否有可用的新版本。');
    const expectedVersion = state.latestVersion;
    operation = 'download';
    update({ status: 'downloading', progressPercent: 0, message: '正在下载更新，可以继续使用日历。' });
    try {
      await retryNetwork(async () => {
        await boundedNetwork(async active => {
          const driver = ensureUpdater(); await prepareNetwork(driver, active);
          if (readyVersion !== expectedVersion) {
            recheckedVersion = null; recheckingDriver = driver;
            try {
              const result = await driver.checkForUpdates();
              if (active()) downloadToken = result?.cancellationToken;
            } finally { if (recheckingDriver === driver) recheckingDriver = null; }
            if (!active()) throw updateError('UPDATE_CANCELLED');
            if (recheckedVersion !== expectedVersion) {
              update({ latestVersion: null, releaseNotes: '' });
              throw updateError(recheckedVersion === null ? 'UPDATE_INCOMPLETE' : 'UPDATE_RELEASE_CHANGED');
            }
            readyVersion = expectedVersion;
          }
          if (!active()) throw updateError('UPDATE_CANCELLED');
          await driver.downloadUpdate(downloadToken);
          if (active() && !downloaded) throw updateError('UPDATE_INCOMPLETE');
        }, 120_000, true);
      }, true);
    } catch (error) { downloaded = false; update({ status: 'error', progressPercent: null, message: updateFailure(error).message }); }
    finally { recheckingDriver = null; operation = null; }
    return success();
  }
  async function installUpdate(): Promise<ApiResult<UpdateState>> {
    if (!enabled || stopped) return failure('VALIDATION', state.message);
    if (operation) return failure('CONFLICT', '更新操作正在进行，请稍候。');
    if (!downloaded) return failure('VALIDATION', '请先下载并校验更新。');
    if (options.isBusy()) {
      const message = '当前操作或 QQ 消息处理尚未完成，请稍后再重启安装。';
      update({ message }); return failure('CONFLICT', message);
    }
    operation = 'install'; preparing = true;
    update({ status: 'installing', message: '正在备份本地日历、账本和消息数据…' });
    try { await options.prepareInstall(); }
    catch {
      preparing = false;
      const message = '更新前备份未完成，应用未退出。请检查数据目录空间和写入权限后重试。';
      await recoverInstall(message); return failure('STORAGE', state.message);
    }
    preparing = false;
    if (stopped) return failure('CANCELLED', '应用正在退出，已取消本次安装。');
    update({ message: '备份已完成，正在重启并安装更新…' });
    // Close-to-tray must not intercept the updater's subsequent app.quit().
    options.setQuitting(true);
    try {
      installWatchdog = setTimeout(() => {
        if (!stopped && operation === 'install') void recoverInstall('安装程序未能完成启动，应用保持运行，请重试。');
      }, 15_000);
      ensureUpdater().quitAndInstall(true, true);
      if (recovering) { await recovering; return failure('INTERNAL', state.message); }
    } catch { await recoverInstall('安装程序未能启动，应用保持运行，请重试。'); return failure('INTERNAL', state.message); }
    return success();
  }
  return {
    snapshot, checkForUpdates, downloadUpdate, installUpdate,
    isInstalling: () => operation === 'install',
    start() {
      if (!enabled || stopped || started) return;
      started = true;
      firstCheck = setTimeout(() => { void checkForUpdates(); }, 15_000);
      poll = setInterval(() => { if (state.status !== 'available' && state.status !== 'downloaded') void checkForUpdates(); }, 4 * 60 * 60 * 1000);
    },
    stop() {
      stopped = true;
      if (firstCheck) clearTimeout(firstCheck);
      if (poll) clearInterval(poll);
      if (installWatchdog) clearTimeout(installWatchdog);
      abortNetwork?.();
      abortBackoff?.();
      // Keep the guarded error listener: a late request failure must not become an unhandled EventEmitter error during shutdown.
    },
  };
}
