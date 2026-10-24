import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, session, Tray, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import { join, basename, extname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NsisUpdater } from 'electron-updater';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createController } from '../application/controller';
import { createBackup, automaticBackup, inspectBackupBundle } from '../storage/backups';
import { createLedgerService, type LedgerService } from '../ledger/service';
import { nowInstant } from '../domain/time';
import { reminderDigest } from '../domain/reminders';
import { ChangedEventSchema, NavigateEventSchema, MAX_IMAGE_BYTES, type ChangedEvent, type NavigateEvent, type DesktopAPI } from '../shared/contracts';
import { WorkflowError } from '../ai/deepseek';
import { createKeyStore } from './key-store';
import { boundedFile, imageFromBytes, profileFromArgs } from './files';
import { dispatchRequest, trustedCaller, type Caller } from './ipc';
import { methods } from './protocol';
import { createRestoreManager } from './restore';
import { createReminderScheduler, createReminderSummary } from './notifications';
import { createAccountService } from '../ai/account';
import { AccountStateSchema } from '../shared/account';
import { createCaptureStore } from '../capture/store';
import { createCaptureService } from '../capture/service';
import { createDocumentExtractor } from '../capture/documents/runtime';
import { CaptureSnapshotSchema } from '../shared/capture';
import { createModelRequestQueue } from '../ai/request-queue';
import { createUpdateService } from './update-service';
import { UpdateStateSchema } from '../shared/update';

app.setName('终极日历');
const APP_ID = 'local.ultimate-calendar.desktop'; app.setAppUserModelId(APP_ID);
let window: BrowserWindow | null = null; let tray: Tray | null = null; let repository: Repository | null = null;
let quitting = false; let timer: ReturnType<typeof setInterval> | undefined; let navigationReady = false;
let pendingNavigation: NavigateEvent | null = null;
let stopAccount: (() => void) | undefined;
let stopCapture: (() => void) | undefined;
let stopUpdates: (() => void) | undefined;
let ledger: LedgerService | null = null;
const missed = createReminderSummary(); let acknowledgeReminders: (ids: string[]) => Promise<void> = async () => {};
let startupNotice: { title: string; message: string } | null = null;
let profile: string | null;
try { profile = profileFromArgs(process.argv); if (profile) app.setPath('userData', profile); }
catch { dialog.showErrorBox('无法打开数据目录', '请使用 --planner-profile=本地绝对目录，并避免磁盘根目录或重复参数。'); app.exit(1); }
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { if (timer) clearInterval(timer); stopUpdates?.(); stopAccount?.(); stopCapture?.(); ledger?.close(); repository?.close(); tray?.destroy(); });
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => { if (!tray || quitting) app.quit(); });
  void app.whenReady().then(start).catch(() => {
    dialog.showErrorBox('日历启动失败', `无法打开本地数据或界面。请检查目录权限与可用空间，再重新启动。\n数据目录：${app.getPath('userData')}\n不要删除已有数据库；可从备份恢复。`); app.quit();
  });
}
function showWindow() { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
function owner(): Caller | null {
  if (!window || window.isDestroyed()) return null;
  return { senderId: window.webContents.id, frameId: window.webContents.mainFrame.routingId, url: documentUrl() };
}
function actual(event: IpcMainInvokeEvent | IpcMainEvent): Caller | null {
  const frame = event.senderFrame;
  return frame ? { senderId: event.sender.id, frameId: frame.routingId, url: frame.url } : null;
}
function documentUrl(): string {
  const url = process.env.PLANNER_DEV_URL;
  if (!app.isPackaged && url === 'http://127.0.0.1:5173/') return url;
  return pathToFileURL(join(__dirname, '../dist/index.html')).href;
}
function changed(value: ChangedEvent) { if (window && !window.isDestroyed()) window.webContents.send('planner:changed', ChangedEventSchema.parse(value)); }
function navigate(value: NavigateEvent) {
  showWindow(); pendingNavigation = NavigateEventSchema.parse(value);
  if (navigationReady && window) { window.webContents.send('planner:navigate', pendingNavigation); pendingNavigation = null; }
}
async function showRetainedSummary(explicit = false) {
  if (!navigationReady || !window) return;
  if (pendingNavigation) { window.webContents.send('planner:navigate', pendingNavigation); pendingNavigation = null; }
  if (startupNotice) { const notice = startupNotice; startupNotice = null; await dialog.showMessageBox(window, { type: 'warning', ...notice }); }
  const reminders = missed.begin(explicit); if (!reminders.length) return;
  let deferred = true; showWindow();
  try {
    const result = await dialog.showMessageBox(window, { type: 'info', title: '恢复运行后的提醒汇总', message: `共有 ${reminders.length} 条提醒在上次检查后到达`, detail: `${reminderDigest(reminders).slice(0, 4000)}\n\n应用退出、电脑关机或休眠期间不会即时提醒。`, buttons: ['查看第一项', '稍后查看'], defaultId: 0, cancelId: 1 });
    if (result.response === 0) { navigate({ entity: reminders[0]!.refKind, id: reminders[0]!.refId }); await acknowledgeReminders(reminders.map(r => r.id)); deferred = false; }
  } catch { startupNotice = { title: '提醒状态保存失败', message: '提醒已保留。请检查数据目录空间与写入权限，然后从托盘再次查看。' }; }
  finally { missed.finish(reminders.map(r => r.id), deferred); if (startupNotice || !deferred) void showRetainedSummary(); }
}
async function start() {
  const data = app.getPath('userData'); await mkdir(data, { recursive: true });
  repository = createRepository(join(data, 'planner.sqlite')); const repo = repository; const planner = createPlanner(repo);
  ledger = createLedgerService(repo.path); const localLedger = ledger;
  localLedger.ensureMonthlyAllowance();
  const keys = createKeyStore(join(data, 'credentials', 'deepseek.bin'), safeStorage, {
    onStatusChanged: () => changed({ reason: 'key' }),
  });
  // A temporary storage failure must not masquerade as a missing credential.
  // The settings page exposes recovery; account polling also retries later.
  try { await keys.initialize(); } catch { /* Keep the saved ciphertext and report keys.status().loadError. */ }
  const account = createAccountService({ getApiKey: keys.get, cachePath: join(data, 'cache', 'deepseek-prices.json'),
    isVisible: () => !!window?.isVisible() && !window.isMinimized(),
    onChanged: state => { if (window && !window.isDestroyed()) window.webContents.send('planner:account-changed', AccountStateSchema.parse(state)); },
  });
  stopAccount = account.stop;
  const modelQueue = createModelRequestQueue();
  const modelModalities = (model: string) => account.snapshot().models.data?.find(item => item.id === model)?.inputModalities ?? null;
  const controller = createController({ repository: repo, planner, ledger: localLedger, getApiKey: async () => {
    const key = await keys.get();
    if (!key && keys.status().loadError) throw new WorkflowError('STORAGE', '已保存的密钥暂未载入，请在设置中重新读取；无需重复填写');
    return key;
  }, getPriceQuote: account.quote, runModel: modelQueue.run, getModelInputModalities: modelModalities,
    afterModelRequest: () => { void account.refresh({ force: true, balanceOnly: true }); }, selectCourseFile: async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择课表 CSV/XLSX', properties: ['openFile'], filters: [{ name: '课表', extensions: ['csv', 'xlsx'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = result.filePaths[0]; const extension = extname(path).toLowerCase();
    if (!['.csv', '.xlsx'].includes(extension)) throw new WorkflowError('VALIDATION', '请选择 CSV 或 XLSX 文件');
    const bytes = await boundedFile(path, 10 * 1024 * 1024);
    if (extension === '.xlsx' && !(bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4)) throw new WorkflowError('VALIDATION', 'XLSX 文件内容无效');
    return { name: basename(path), bytes };
  } });
  let activeWorkflows = 0;
  const captureStore = createCaptureStore(join(data, 'planner.sqlite'));
  const bridgeKeys = createKeyStore(join(data, 'credentials', 'qq-bridge.bin'), safeStorage);
  try { await bridgeKeys.initialize(); } catch { /* Surface a missing connection; preserve encrypted credentials. */ }
  const documents = createDocumentExtractor();
  const capture = createCaptureService({ store: captureStore, repository: repo, credentials: bridgeKeys,
    getApiKey: keys.get, getPriceQuote: account.quote, extract: documents.extract, runModel: modelQueue.run, getModelInputModalities: modelModalities,
    afterModelRequest: () => { void account.refresh({ force: true, balanceOnly: true }); },
    onChanged: state => { if (window && !window.isDestroyed()) window.webContents.send('planner:capture-changed', CaptureSnapshotSchema.parse(state)); },
    onPlannerChanged: () => changed({ reason: 'analysis' }),
  });
  stopCapture = () => { capture.stop(); documents.dispose(); captureStore.close(); };
  const workflow = async <T>(work: () => Promise<T>): Promise<T> => { activeWorkflows++; try { return await work(); } finally { activeWorkflows--; } };
  const restore = createRestoreManager(repo, () => activeWorkflows === 0 && !capture.busy(), captureStore);
  let activeRequests = 0, captureSuspendedForUpdate = false;
  const updates = createUpdateService({
    currentVersion: app.getVersion(), packaged: app.isPackaged, platform: process.platform, isolatedProfile: !!profile,
    getUpdater: () => new NsisUpdater(),
    isBusy: () => activeRequests > 0 || activeWorkflows > 0 || capture.busy() || modelQueue.busy(),
    prepareInstall: () => {
      // Only pause this app's local capture socket. Never stop or restart the user's QQ process.
      capture.suspendForRestore(); captureSuspendedForUpdate = true;
      const backupPath = join(data, 'backups', `before-update-${randomUUID()}.sqlite`);
      createBackup(repo, backupPath); inspectBackupBundle(backupPath);
    },
    resumeAfterFailedInstall: async () => { if (captureSuspendedForUpdate) { captureSuspendedForUpdate = false; await capture.resume(); } },
    setQuitting: value => { quitting = value; },
    onChanged: state => { if (window && !window.isDestroyed()) window.webContents.send('planner:update-changed', UpdateStateSchema.parse(state)); },
  });
  stopUpdates = updates.stop;
  const api: Omit<DesktopAPI, 'onChanged' | 'onNavigate' | 'onAccountChanged' | 'onCaptureChanged' | 'onUpdateChanged'> = {
    updateSnapshot: async () => ({ ok: true, data: updates.snapshot() }),
    checkForUpdates: updates.checkForUpdates, downloadUpdate: updates.downloadUpdate, installUpdate: updates.installUpdate,
    ledgerSnapshot: async request => { const generated = localLedger.ensureMonthlyAllowance(); if (generated) { automaticBackup(repo); changed({reason:'mutation'}); } return {ok:true,data:localLedger.snapshot(request?.month)}; },
    ledgerMutate: async request => { const result = localLedger.mutate(request); automaticBackup(repo); changed({reason:'mutation'}); return {ok:true,data:result}; },
    ledgerUndo: async request => { const result = localLedger.undo(request); automaticBackup(repo); changed({reason:'undo'}); return {ok:true,data:result}; },
    ledgerExport: async request => {
      const content = request.format === 'json' ? JSON.stringify(localLedger.exportJson(),null,2) : localLedger.exportCsv(request.month);
      const result = await dialog.showSaveDialog(window!,{title:request.format === 'json' ? '导出完整账本（包含快照、关联与更正历史）' : '导出账单 CSV',defaultPath:join(app.getPath('documents'),`终极日历账单-${request.month ?? nowInstant().slice(0,10)}.${request.format}`),filters:[{name:request.format === 'json' ? '完整账本' : 'CSV 表格',extensions:[request.format]}],properties:['createDirectory','showOverwriteConfirmation']});
      if (result.canceled || !result.filePath) throw new WorkflowError('CANCELLED','已取消账单导出');
      await writeFile(result.filePath,content,'utf8'); return {ok:true,data:{path:result.filePath}};
    },
    captureSnapshot: async () => ({ ok: true, data: capture.snapshot() }),
    captureConfigure: async request => ({ ok: true, data: await capture.configure(request) }),
    captureConnect: async request => ({ ok: true, data: await capture.connect(request) }),
    captureGroups: async () => ({ ok: true, data: await capture.groups() }),
    captureMessages: async request => ({ ok: true, data: capture.messages(request) }),
    captureBatches: async request => ({ ok: true, data: capture.batches(request) }),
    captureAction: async request => ({ ok: true, data: capture.action(request) }),
    captureChunks: async request => ({ ok: true, data: capture.chunks(request) }),
    captureCleanup: async request => ({ ok: true, data: capture.cleanup(request) }),
    accountSnapshot: async () => { void account.refresh({ force: true, balanceOnly: true }); return { ok: true, data: account.snapshot() }; },
    refreshAccount: async () => { if (keys.status().loadError) await keys.retry(); return { ok: true, data: await account.refresh({ force: true }) }; },
    snapshot: async () => ({ ok: true, data: { ...planner.snapshot(), keyStatus: keys.status() } }),
    mutate: async request => { const result = planner.mutate(request as Parameters<typeof planner.mutate>[0]); if (result.status === 'applied') changed({ reason: 'mutation', transactionId: result.transactionId }); return { ok: true, data: result }; },
    undo: async id => { const result = planner.undo(id); if (result.status === 'applied') changed({ reason: 'undo', transactionId: result.transactionId }); return { ok: true, data: result }; },
    importSource: async request => { const result = await controller.importSource(request); changed({ reason: 'import' }); return result; },
    analyzeSource: async request => workflow(async () => { const pending = controller.analyzeSource(request); changed({ reason: 'analysis' }); const result = await pending; changed({ reason: 'analysis' }); return result; }),
    command: async request => workflow(async () => { const result = await controller.command(request); changed({ reason: 'mutation' }); return result; }),
    importCourses: async request => workflow(async () => { const pending = controller.importCourses(request); changed({ reason: 'import' }); const result = await pending; changed({ reason: 'import' }); return result; }),
    saveSettings: async request => { const result = await controller.saveSettings(request); if (result.ok) { applyAutoLaunch(result.data.autoLaunch); changed({ reason: 'settings' }); } return result; },
    setApiKey: async request => { const status = await keys.set(request.key); account.resetKey(); changed({ reason: 'key' }); return { ok: true, data: status }; },
    retryApiKey: async () => { const status = await keys.retry(); if (status.configured) void account.refresh({ force: true }); return { ok: true, data: status }; },
    selectImage: async () => {
      const result = await dialog.showOpenDialog(window!, { title: '选择要导入的图片', properties: ['openFile'], filters: [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }] });
      if (result.canceled || !result.filePaths[0]) return { ok: true, data: null };
      const path = result.filePaths[0]; return { ok: true, data: imageFromBytes(path, await boundedFile(path, MAX_IMAGE_BYTES)) };
    },
    backup: async () => {
      const result = await dialog.showSaveDialog(window!, { title: '备份日历（包含来源原文与截图，不包含 API 密钥）', defaultPath: join(app.getPath('documents'), `终极日历-${nowInstant().slice(0, 10)}.sqlite`), filters: [{ name: '日历备份', extensions: ['sqlite'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (result.canceled || !result.filePath) throw new WorkflowError('CANCELLED', '已取消备份');
      // VACUUM refuses an existing file. Do not silently overwrite a prior backup.
      try { return { ok: true, data: createBackup(repo, result.filePath) }; } catch (error) { if (error instanceof WorkflowError) throw error; throw new WorkflowError('STORAGE', '备份未完成：请选择一个尚不存在的文件名，并检查目录写入权限'); }
    },
    restore: async request => {
      if (request.confirmed) { if (!request.confirmationToken) throw new WorkflowError('VALIDATION', '请先选择并预览恢复文件'); capture.suspendForRestore(); try { const result = await restore.confirm(request.confirmationToken); applyAutoLaunch(repo.snapshot().settings.autoLaunch); changed({ reason: 'restore' }); return { ok: true, data: result }; } finally { await capture.resume(); } }
      const result = await dialog.showOpenDialog(window!, { title: '选择日历备份以预览恢复', properties: ['openFile'], filters: [{ name: '日历备份', extensions: ['sqlite'] }] });
      if (result.canceled || !result.filePaths[0]) throw new WorkflowError('CANCELLED', '已取消恢复');
      try { return { ok: true, data: await restore.preview(result.filePaths[0]) }; } catch { throw new WorkflowError('STORAGE', '备份无法读取或校验未通过，请选择本应用生成的完整 SQLite 备份'); }
    },
  };
  Menu.setApplicationMenu(null);
  const icon = join(__dirname, '../assets/app-icon.png');
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 980, minHeight: 680, show: false, title: '终极日历', backgroundColor: '#f5f0e6', icon,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#f5f0e6', symbolColor: '#1f1c18', height: 32 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: !app.isPackaged } });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-start-loading', () => { navigationReady = false; });
  window.webContents.on('render-process-gone', () => { dialog.showErrorBox('界面进程已停止', '本地数据已保存。请从托盘退出后重新打开终极日历。'); });
  window.webContents.on('preload-error', () => { dialog.showErrorBox('本机服务连接失败', '桌面接口未能载入。请重新安装应用；现有数据保留在用户数据目录。'); });
  session.defaultSession.on('will-download', (event, item, contents) => {
    if (contents !== window?.webContents || contents.getURL() !== documentUrl() || !item.getURL().startsWith('blob:')) { event.preventDefault(); return; }
    // Chromium's native save dialog is opened only by the user-triggered template Blob download.
    item.setSaveDialogOptions({ title: '保存课表 CSV 模板', defaultPath: join(app.getPath('documents'), '终极日历课表模板.csv'), filters: [{ name: 'CSV 模板', extensions: ['csv'] }], properties: ['showOverwriteConfirmation'] });
  });
  const updateMethods = new Set(['updateSnapshot', 'checkForUpdates', 'downloadUpdate', 'installUpdate']);
  for (const method of methods) ipcMain.handle(`planner:${method}`, (event, input: unknown) => dispatchRequest(method, input, actual(event), owner(), {
    [method]: async (request: unknown) => {
      const handler = api[method] as (value: unknown) => Promise<unknown>;
      if (updateMethods.has(method)) return handler(request);
      if (updates.isInstalling()) throw new WorkflowError('CONFLICT', '正在备份并准备重启更新，请稍候再操作。');
      activeRequests++;
      try { return await handler(request); } finally { activeRequests--; }
    },
  }));
  ipcMain.on('planner:navigation-ready', event => { if (!trustedCaller(actual(event), owner())) return; navigationReady = true; void showRetainedSummary(); });
  // On Windows the multi-size ICO lets the tray pick a drawn size for the current scale; elsewhere scale the PNG down.
  // Load it through nativeImage: a bare path inside app.asar cannot be opened by the tray itself.
  const trayIcon = process.platform === 'win32' ? nativeImage.createFromPath(join(__dirname, '../assets/app-icon.ico')) : nativeImage.createFromPath(icon).resize({ width: 20, height: 20 });
  tray = new Tray(trayIcon); tray.setToolTip('终极日历 · 本地计划与提醒');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开终极日历', click: () => { showWindow(); void showRetainedSummary(); } }, { label: '查看漏过提醒', click: () => { showWindow(); void showRetainedSummary(true); } }, { type: 'separator' }, { label: '退出（停止提醒）', click: () => { quitting = true; app.quit(); } }]));
  tray.on('double-click', showWindow);
  const noticeFile = join(data, 'tray-notice-seen'); let noticeSeen = false;
  try { noticeSeen = (await readFile(noticeFile, 'utf8')) === 'yes'; } catch { /* first close */ }
  window.on('close', event => {
    if (quitting || !repo.snapshot().settings.closeToTray) return;
    event.preventDefault(); window!.hide();
    if (!noticeSeen) { noticeSeen = true; void writeFile(noticeFile, 'yes').catch(() => {}); const notification = new Notification({ title: '终极日历仍在托盘运行', body: '提醒仅在应用运行时工作。右键托盘图标选择“退出”可停止运行。', icon }); notification.on('click', showWindow); notification.show(); }
  });
  window.on('closed', () => { window = null; if (!quitting) app.quit(); });
  window.on('focus', () => { void account.refresh(); });
  const scheduler = createReminderScheduler(repo, join(data, 'reminder-cursor.json')); await scheduler.initialize(); acknowledgeReminders = scheduler.acknowledge; let lastTick = Date.now(); let reminderFailureShown = false;
  const check = async (catchUp: boolean) => {
    try {
      const reminders = await scheduler.check(nowInstant()); reminderFailureShown = false; if (!reminders.length) return;
      const newReminders = reminders.filter(r => !missed.has(r.id)); if (!newReminders.length) return;
      if (catchUp || reminders.length > 1) { missed.enqueue(reminders); void showRetainedSummary(); }
      else {
        const reminder = reminders[0]!; const notification = new Notification({ title: reminder.title, body: reminder.message, icon });
        notification.on('click', () => navigate({ entity: reminder.refKind, id: reminder.refId })); notification.show(); await scheduler.acknowledge([reminder.id]);
      }
    } catch { if (!reminderFailureShown) { reminderFailureShown = true; startupNotice = { title: '提醒检查未完成', message: '尚未展示的提醒已保留。请检查数据目录空间与写入权限；修复后会再次检查。' }; void showRetainedSummary(); } }
  };
  await check(true);
  timer = setInterval(() => { const catchUp = Date.now() - lastTick > 90_000; lastTick = Date.now(); void check(catchUp); }, 30_000);
  powerMonitor.on('resume', () => { lastTick = Date.now(); void check(true); void account.refresh({ force: true, balanceOnly: true }); });
  applyAutoLaunch(repo.snapshot().settings.autoLaunch);
  account.start();
  updates.start();
  void capture.start().catch(() => { /* Connection detail is shown in the QQ page. */ });
  await window.loadURL(documentUrl()); showWindow(); void showRetainedSummary();
}
function applyAutoLaunch(enabled: boolean) {
  // Isolated profiles never change the user's startup entry. Production default remains off.
  if (profile || !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [] });
}
