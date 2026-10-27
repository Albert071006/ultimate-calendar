import { app, dialog, Menu, nativeImage, Notification, powerMonitor, Tray, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { NsisUpdater } from 'electron-updater';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { SnapshotSchema, apiResultSchema, type ApiResult, type Settings, type Snapshot } from '../shared/contracts';
import { RemoteIdentitySchema, type RemoteIdentity, type RemoteMethod } from '../shared/remote';
import { BackupExportDataSchema, MAX_CLOUD_EXPORT_BYTES } from '../shared/cloud-management';
import { nowInstant } from '../domain/time';
import { WorkflowError } from '../ai/deepseek';
import { validateSafeBackup } from '../server/backup';
import { writeLocalResourcesCompanion } from '../storage/local-resources';
import { readPrivate, writePrivate } from '../remote/private-file';
import type { NativeRemoteConfig } from './remote-config';
import type { createCollectorControlClient } from './collector-control';
import { createRemoteReminderScheduler } from './remote-reminders';
import { createUpdateService } from './update-service';
import { CaptureSnapshotSchema } from '../shared/capture';
import { COLLECTOR_TRAY_RENEW_MS } from './collector-tray';

const DeviceSettings = z.strictObject({ version: z.literal(1), closeToTray: z.boolean(), autoLaunch: z.boolean() });
const successfulSnapshot = apiResultSchema(SnapshotSchema), successfulBackup = apiResultSchema(BackupExportDataSchema);
const wait = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));
interface Options {
  window: BrowserWindow;
  directory: string;
  config: NativeRemoteConfig;
  rpc(method: RemoteMethod, input?: unknown): Promise<unknown>;
  getIdentity(): Promise<RemoteIdentity>;
  collector: ReturnType<typeof createCollectorControlClient> | null;
  changed(): void;
  /** Other native/cloud writes must finish before installation can begin. */
  isBusy?(): boolean;
}

/** Windows shell only: no authoritative SQLite or API Key is opened in the cloud profile. */
export function createRemoteDesktopShell(options: Options) {
  const { window, directory, config, collector } = options;
  const production = app.isPackaged && process.platform === 'win32' && !!config.localDataDirectory;
  const settingsFile = join(directory, 'device-settings.json');
  const saved = readPrivate(settingsFile, 16_384);
  let device = saved ? DeviceSettings.parse(JSON.parse(saved.toString('utf8'))) : DeviceSettings.parse({ version: 1, closeToTray: true, autoLaunch: false });
  let closed = false, quitting = false, ticking = false, stoppedCollector = false;
  let collectorStarting: Promise<void> | undefined;
  const trayOwner = randomUUID();
  let trayRenewing: Promise<void> | undefined, quitHandoff = false, collectorRunning = false, collectorAction = false;
  let collectorLabel = 'QQ 采集服务正在连接', extraTrayItems: MenuItemConstructorOptions[] = [];
  let ownershipTimer: ReturnType<typeof setInterval> | undefined;
  let currentIdentity = '', scheduler: ReturnType<typeof createRemoteReminderScheduler> | undefined;
  let latest: Snapshot | undefined;
  const showing = new Set<string>(), notifications = new Set<Notification>();
  let tray: Tray | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const show = () => { if (!window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } };
  const send = (channel: string, value: unknown) => { if (!closed && !window.isDestroyed()) window.webContents.send(channel, value); };

  function applyAutoLaunch() {
    // The installed app's desktop-connection.json retains the cloud authority after default startup.
    if (production) app.setLoginItemSettings({ openAtLogin: device.autoLaunch, path: process.execPath, args: [] });
  }
  function snapshot(value: Snapshot): Snapshot {
    latest = { ...value, settings: { ...value.settings, closeToTray: device.closeToTray, autoLaunch: device.autoLaunch } };
    return latest;
  }
  function saveDeviceSettings(value: Pick<Settings, 'closeToTray' | 'autoLaunch'>) {
    const next = DeviceSettings.parse({ version: 1, closeToTray: value.closeToTray, autoLaunch: value.autoLaunch });
    writePrivate(settingsFile, JSON.stringify(next)); device = next;
    if (latest) snapshot(latest);
    applyAutoLaunch(); options.changed();
  }
  function updateCollectorStatus(result: ApiResult<unknown>, processState: 'running' | 'stopped' | 'unknown' = 'unknown') {
    if (closed || quitting) return;
    collectorRunning = result.ok || processState === 'running' || processState === 'unknown' && collectorRunning;
    const parsed = result.ok ? CaptureSnapshotSchema.safeParse(result.data) : null;
    if (parsed?.success) {
      const state = parsed.data;
      collectorLabel = `QQ ${!state.config.enabled ? '采集未启用' : state.error ? '采集异常' : state.connection === 'online' ? '已连接' : '连接待恢复'} · ${state.config.analysisEnabled ? '自动提炼启用' : '自动提炼未启用'}`;
    } else collectorLabel = result.ok ? 'QQ 采集服务运行中' : collectorRunning ? 'QQ 采集服务暂不可用' : 'QQ 采集服务未运行';
    if (processState === 'stopped') createTray();
    refreshTray();
  }
  async function renewTrayOwnership() {
    if (!production || !collector || closed || quitting || !collectorRunning || updates.isInstalling()) return;
    if (trayRenewing) return trayRenewing;
    trayRenewing = (async () => {
      const result = await collector.setTrayOwner(trayOwner, true);
      if (closed || quitting) return;
      if (result.ok) createTray();
      else if (await collector.processState() === 'stopped') {
        updateCollectorStatus(result, 'stopped');
      } else { tray?.destroy(); tray = undefined; } // The collector regains its icon when this unrenewed lease expires.
    })().finally(() => { trayRenewing = undefined; });
    return trayRenewing;
  }
  async function refreshCollectorStatus() {
    if (!production || !collector || closed || quitting || collectorAction || updates.isInstalling()) return;
    const result = await collector.invoke('captureSnapshot');
    if (collectorAction || closed || quitting) return;
    updateCollectorStatus(result, result.ok ? 'running' : await collector.processState());
    await renewTrayOwnership();
  }
  async function ensureCollector() {
    if (!production || !collector || closed) return;
    if (collectorStarting) return collectorStarting;
    collectorStarting = (async () => {
      const current = await collector.invoke('captureSnapshot'), state = current.ok ? 'running' : await collector.processState(); updateCollectorStatus(current, state);
      if (current.ok || state === 'running' || closed) { await renewTrayOwnership(); return; }
      const child = spawn(process.execPath, ['--planner-capture-only', `--planner-profile=${config.localDataDirectory!}`], { windowsHide: true, detached: true, stdio: 'ignore' });
      await new Promise<void>((done, reject) => { child.once('spawn', done); child.once('error', () => reject(new WorkflowError('STORAGE', '本机采集服务未能启动，请从采集入口重试。'))); });
      child.unref();
      const deadline = Date.now() + 30_000;
      while (!closed && Date.now() < deadline) {
        const result = await collector.invoke('captureSnapshot'); updateCollectorStatus(result);
        if (result.ok) { await renewTrayOwnership(); return; }
        await wait(250);
      }
      if (!closed) throw new WorkflowError('STORAGE', '本机采集服务未恢复，未操作 QQ。请重新打开日历后核对采集状态。');
    })().finally(() => { collectorStarting = undefined; });
    return collectorStarting;
  }
  async function toggleCollector() {
    if (!collector || collectorAction || closed || quitting || updates.isInstalling()) return;
    collectorAction = true; refreshTray();
    try {
      if (collectorRunning) {
        await trayRenewing;
        const result = await collector.shutdownAndWait();
        if (!result.ok) throw new WorkflowError('CONFLICT', '采集服务尚未正常退出，请等待正在处理的消息结束后重试。');
        updateCollectorStatus({ ok: false, error: { code: 'NETWORK', message: '', retryable: false } }, 'stopped');
      } else await ensureCollector();
    } catch { dialog.showErrorBox('采集服务状态未改变', '操作未能完成，请打开日历的采集页面核对状态后重试。QQ 保持运行。'); }
    finally { collectorAction = false; refreshTray(); await renewTrayOwnership(); }
  }
  async function backupBeforeInstall() {
    const identity = JSON.stringify(RemoteIdentitySchema.parse(await options.getIdentity()));
    const result = successfulBackup.parse(await options.rpc('backupExportData'));
    if (!result.ok) throw new WorkflowError('STORAGE', '云端备份尚未完成，未安装更新。');
    validateSafeBackup(JSON.parse(result.data.content));
    if (JSON.stringify(RemoteIdentitySchema.parse(await options.getIdentity())) !== identity) throw new WorkflowError('CONFLICT', '备份期间资料身份改变，未安装更新。');
    const file = join(directory, 'backups', `before-update-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
    const bytes = Buffer.from(result.data.content);
    writePrivate(file, bytes);
    writeLocalResourcesCompanion(config.localDataDirectory ?? directory, file);
    if (!readPrivate(file, MAX_CLOUD_EXPORT_BYTES)?.equals(bytes)) throw new WorkflowError('STORAGE', '更新前备份核对失败，未安装更新。');
  }
  const updates = createUpdateService({
    currentVersion: app.getVersion(), packaged: app.isPackaged, platform: process.platform, isolatedProfile: !production,
    getUpdater: () => new NsisUpdater(),
    isBusy: () => ticking || collectorAction || !!options.isBusy?.(),
    prepareInstall: async () => {
      await backupBeforeInstall();
      await collectorStarting;
      if (collector) {
        const wasRunning = await collector.processState() !== 'stopped';
        const stopped = await collector.shutdownAndWait();
        if (!stopped.ok) throw new WorkflowError('CONFLICT', '本机采集尚未正常退出，未安装更新，也未关闭 QQ。');
        stoppedCollector = wasRunning;
      }
    },
    resumeAfterFailedInstall: async () => { if (stoppedCollector) { await ensureCollector(); stoppedCollector = false; } },
    setQuitting: value => { quitting = value; },
    onChanged: state => send('planner:update-changed', state),
  });

  async function tick() {
    if (!production || closed || ticking || updates.isInstalling()) return;
    ticking = true;
    try {
      const identity = RemoteIdentitySchema.parse(await options.getIdentity()), encoded = JSON.stringify(identity);
      // A failed read must not advance the reminder cursor using an old in-memory snapshot.
      const result = successfulSnapshot.parse(await options.rpc('snapshot'));
      if (!result.ok || closed) return;
      const value = snapshot(result.data);
      if (!scheduler || currentIdentity !== encoded) {
        const next = createRemoteReminderScheduler({ directory, identity }); await next.initialize();
        if (closed) return;
        scheduler = next; currentIdentity = encoded; showing.clear();
      }
      scheduler.updateSnapshot(value);
      if (!Notification.isSupported()) return;
      const reminders = (await scheduler.check(nowInstant())).filter(reminder => !showing.has(reminder.id));
      if (!reminders.length || closed) return;
      const ids = reminders.map(reminder => reminder.id), first = reminders[0]!, activeScheduler = scheduler;
      for (const id of ids) showing.add(id);
      const notification = new Notification({ title: reminders.length === 1 ? first.title : `终极日历 · ${reminders.length} 条提醒`,
        body: reminders.length === 1 ? first.message : `${first.title} 等 ${reminders.length} 项已到提醒时间。点击查看。`, icon: join(__dirname, '../assets/app-icon.png') });
      notifications.add(notification);
      notification.once('show', () => {
        // Acknowledgement follows actual OS presentation; a failed delivery remains pending.
        void activeScheduler.acknowledge(ids).then(() => { for (const id of ids) showing.delete(id); }).catch(() => { /* Already presented in this process; retain durable pending state for recovery. */ });
      });
      notification.once('failed', () => { for (const id of ids) showing.delete(id); notifications.delete(notification); });
      notification.once('close', () => { notifications.delete(notification); });
      notification.on('click', () => { show(); send('planner:navigate', { entity: first.refKind, id: first.refId }); });
      try { notification.show(); } catch { notifications.delete(notification); for (const id of ids) showing.delete(id); }
    } catch { /* Connection/identity/storage failure retains the cursor; the next successful poll can catch up. */ }
    finally { ticking = false; }
  }
  const beforeQuit = (event: { preventDefault(): void }) => {
    quitting = true;
    if (!production || !collector || closed || quitHandoff || updates.isInstalling()) return;
    event.preventDefault(); quitHandoff = true;
    if (ownershipTimer) clearInterval(ownershipTimer);
    tray?.destroy(); tray = undefined;
    // remote-mode closes its client synchronously with the window; return the tray before allowing that close.
    void (async () => { await trayRenewing; await collector.setTrayOwner(trayOwner, false); })().catch(() => {}).finally(() => app.quit());
  };
  const onClose = (event: { preventDefault(): void }) => {
    if (closed || quitting) return;
    if ((tray || production && collectorRunning) && device.closeToTray) { event.preventDefault(); window.hide(); }
    else if (production && collector) { event.preventDefault(); app.quit(); }
  };
  const onResume = () => { void tick(); void refreshCollectorStatus(); };
  function close() {
    if (closed) return; closed = true;
    if (timer) clearInterval(timer);
    if (ownershipTimer) clearInterval(ownershipTimer);
    updates.stop(); tray?.destroy();
    for (const notification of notifications) notification.close(); notifications.clear();
    window.removeListener('close', onClose); window.removeListener('focus', onResume); window.removeListener('closed', close);
    app.removeListener('before-quit', beforeQuit); powerMonitor.removeListener('resume', onResume);
  }
  // Isolated smoke profiles neither alter Windows startup nor create background processes or OS notifications.
  // The window has no menu bar, so cloud commands (refresh, operation review) live in the tray menu instead.
  const trayMenu = () => Menu.buildFromTemplate([{ label: '打开终极日历', click: show }, { label: '刷新提醒', click: onResume },
    ...extraTrayItems, { type: 'separator' }, { label: collectorLabel, enabled: false },
    { label: collectorAction ? '采集服务处理中…' : collectorRunning ? '停止本机采集（QQ / 微信保持运行）' : '启动本机采集', enabled: !collectorAction, click: () => { void toggleCollector(); } },
    { type: 'separator' }, { label: collectorRunning ? '退出日历（采集继续运行）' : '退出日历', click: () => app.quit() }]);
  function refreshTray() { tray?.setContextMenu(trayMenu()); tray?.setToolTip(`终极日历 · 云端资料 · ${collectorLabel}`); }
  function createTray() {
    if (tray || closed || quitting) return;
    tray = new Tray(nativeImage.createFromPath(join(__dirname, '../assets/app-icon.ico')));
    tray.on('double-click', show); refreshTray();
  }
  if (production) {
    createTray(); applyAutoLaunch();
    window.on('close', onClose); window.on('focus', onResume); app.on('before-quit', beforeQuit); powerMonitor.on('resume', onResume);
    timer = setInterval(onResume, 30_000); timer.unref(); updates.start();
    ownershipTimer = setInterval(() => { void renewTrayOwnership(); }, COLLECTOR_TRAY_RENEW_MS); ownershipTimer.unref();
    void ensureCollector().catch(() => { /* Capture controls show availability; no credentials or private errors are logged. */ });
    void tick();
  }
  window.once('closed', close);
  return {
    snapshot, saveDeviceSettings, close, isInstalling: updates.isInstalling,
    setTrayItems(items: MenuItemConstructorOptions[]) { extraTrayItems = items; refreshTray(); },
    async handle(method: string): Promise<ApiResult<unknown> | null> {
      if (method === 'updateSnapshot') return { ok: true, data: updates.snapshot() };
      if (method === 'checkForUpdates') return updates.checkForUpdates();
      if (method === 'downloadUpdate') return updates.downloadUpdate();
      if (method === 'installUpdate') return updates.installUpdate();
      return null;
    },
  };
}
