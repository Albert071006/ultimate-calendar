import { BrowserWindow, Menu, app, dialog, ipcMain, safeStorage, session } from 'electron';
import { join } from 'node:path';
import { createNodeRemoteClient, RemoteClientError, type RemoteCredential } from '../remote/node-client';
import { readPrivate, writePrivate } from '../remote/private-file';
import { createWriteJournal } from '../remote/write-journal';
import { REMOTE_METHODS, REMOTE_READ_METHODS, type RemoteMethod } from '../shared/remote';
import { MAX_IMAGE_BYTES, SetApiKeyRequestSchema, SaveSettingsRequestSchema, SnapshotSchema, ImportSourceRequestSchema, LocalSourceEvidenceRequestSchema, CourseImportRequestSchema, MutationRequestSchema, type ApiError } from '../shared/contracts';
import { boundedFile, imageFromBytes } from './files';
import { dispatchRequest } from './ipc';
import { methods } from './protocol';
import type { NativeRemoteConfig } from './remote-config';
import { COLLECTOR_CONTROL_METHODS, createCollectorControlClient, type CollectorControlMethod } from './collector-control';
import { createRemoteFiles } from './remote-files';
import { createRemoteDesktopShell } from './remote-desktop-shell';
import { WorkflowError } from '../ai/deepseek';
import { createRemoteSourceCache } from './remote-source-cache';
import { remoteOutputs } from '../server/protocol';
import { createNativeResourceHost } from './resources-native';
import { createNativePlanImport } from './plan-import';
import { createNativePlanExport } from './plan-export';
import { createNativeBusyExport } from './busy-export';
import type { PlanSource } from '../shared/plan-context';

/** Uses bundled trusted UI and main-process networking, never a remote page with Electron privileges. */
export async function startNativeRemote(config: NativeRemoteConfig, directory: string, documentUrl: string) {
  if (!safeStorage.isEncryptionAvailable()) throw Error('系统凭据加密不可用，未保存或发送配对凭据');
  const credentialFile = join(directory, 'credentials', 'remote-device.bin');
  const client = createNodeRemoteClient({ origin: config.origin, localConnectAddress: config.localConnectAddress, credentials: {
    read() { const value = readPrivate(credentialFile, 32_768); return value ? JSON.parse(safeStorage.decryptString(value)) as RemoteCredential : null; },
    write(value) { writePrivate(credentialFile, safeStorage.encryptString(JSON.stringify(value))); },
  } });
  try {
    if (!readPrivate(credentialFile, 32_768)) {
      if (!config.pairingCodeFile) throw Error('首次连接需要配置 pairingCodeFile；配对码由服务器生成');
      const code = readPrivate(config.pairingCodeFile, 256); if (!code) throw Error('配对码文件不存在');
      await client.pair(code.toString('utf8').trim(), config.deviceName);
    }
    const journal = createWriteJournal(client, join(directory, 'remote-write.json'));
    const sourceCache = createRemoteSourceCache(directory);
    // Same frame as the local window: the paper page runs to the top, with only the system caption buttons overlaid.
    const window = new BrowserWindow({ width: 1440, height: 940, minWidth: 980, minHeight: 680, show: false, title: '终极日历 · 云端资料', backgroundColor: '#f5f0e6', icon: join(__dirname, '../assets/app-icon.png'),
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#f5f0e6', symbolColor: '#1f1c18', height: 32 },
      webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: !app.isPackaged } });
    const changed = () => { if (!window.isDestroyed()) window.webContents.send('planner:changed', { reason: 'mutation' }); };
    let activeRequests = 0;
    const collector = config.localDataDirectory ? createCollectorControlClient({ directory: config.localDataDirectory, encryption: safeStorage }) : null;
    const shell = createRemoteDesktopShell({ window, directory, config, collector, changed, rpc: journal.rpc, getIdentity: async () => (await client.getSession()).identity, isBusy: () => activeRequests > 0 });
    const resourceDirectory = config.localDataDirectory ?? directory;
    const resources = createNativeResourceHost(resourceDirectory, () => window);
    const planSource = async (): Promise<PlanSource> => { const { identity } = await client.getSession(); return { kind: 'cloud', dataInstanceId: identity.dataInstanceId, generation: identity.generation }; };
    const planSnapshot = async () => { const result = remoteOutputs.snapshot.parse(await journal.rpc('snapshot')); if (!result.ok) throw new Error(result.error.message); return result.data; };
    const planExport = createNativePlanExport({ window: () => window, snapshot: planSnapshot, source: planSource });
    const busyExport = createNativeBusyExport({ window: () => window, snapshot: planSnapshot, source: planSource });
    const planImport = createNativePlanImport({ directory: join(directory, 'plan-import'), resourceDirectory, window: () => window, changed,
      source: planSource,
      scope: async () => { const current = await client.getSession(); return JSON.stringify({ origin: client.origin, identity: current.identity, deviceId: current.deviceId }); },
      snapshot: planSnapshot,
      mutate: async input => {
        const pending = await journal.inspect();
        if (pending.status !== 'none' && (pending.method !== 'mutate' || pending.operationId !== input.operationId))
          throw new Error('另一项云端操作结果尚未核对。请先重试原操作，或从托盘菜单选择“核对云端操作”，然后重选原计划文件继续');
        const result = remoteOutputs.mutate.parse(await journal.rpc('mutate', input)); if (!result.ok) throw new Error(result.error.message); return result.data;
      },
    });
    const files = createRemoteFiles({ window, resourceDirectory, rpc: journal.rpc, client, canRestore: async () => (await journal.inspect()).status === 'none' });
    session.defaultSession.setPermissionRequestHandler((_c, _p, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const download = (event: Electron.Event, item: Electron.DownloadItem, contents: Electron.WebContents) => {
      if (contents !== window.webContents || contents.getURL() !== documentUrl || !item.getURL().startsWith('blob:')) { event.preventDefault(); return; }
      item.setSaveDialogOptions({ title: '保存课表 CSV 模板', defaultPath: join(app.getPath('documents'), '终极日历课表模板.csv'), filters: [{ name: 'CSV 模板', extensions: ['csv'] }], properties: ['showOverwriteConfirmation'] });
    };
    session.defaultSession.on('will-download', download);
    const failure = (code: ApiError['code'], message: string, retryable = code === 'NETWORK') => ({ ok: false, error: { code, message, retryable } });
    for (const method of methods) ipcMain.handle(`planner:${method}`, (event, input: unknown) => dispatchRequest(method, input,
      event.senderFrame ? { senderId: event.sender.id, frameId: event.senderFrame.routingId, url: event.senderFrame.url } : null,
      window.isDestroyed() ? null : { senderId: window.webContents.id, frameId: window.webContents.mainFrame.routingId, url: documentUrl }, {
        [method]: async (value: unknown) => {
          const updating = ['updateSnapshot', 'checkForUpdates', 'downloadUpdate', 'installUpdate'].includes(method);
          if (!updating && shell.isInstalling()) return failure('CONFLICT', '正在备份并准备更新，请稍候再操作', false);
          if (!updating) activeRequests++;
          try {
            if (method === 'busyExportPreview') return await busyExport.busyExportPreview(value as Parameters<typeof busyExport.busyExportPreview>[0]);
            if (method === 'busyExportSave') return await busyExport.busyExportSave(value as Parameters<typeof busyExport.busyExportSave>[0]);
            if (method === 'planExportPreview') return await planExport.planExportPreview(value as Parameters<typeof planExport.planExportPreview>[0]);
            if (method === 'planExportSave') return await planExport.planExportSave(value as Parameters<typeof planExport.planExportSave>[0]);
            if (method === 'planImportOpen') return await planImport.planImportOpen();
            if (method === 'planImportConfirm') return await planImport.planImportConfirm(value as Parameters<typeof planImport.planImportConfirm>[0]);
            if (method === 'planImportTemplate') return await planImport.planImportTemplate();
            const resourceResult = await resources.handle(method, value); if (resourceResult) return resourceResult;
            if (method === 'localSourceEvidence') {
              const { sourceId } = LocalSourceEvidenceRequestSchema.parse(value), source = sourceCache.read(sourceId);
              if (source) return { ok: true, data: { sourceId, match: 'legacy-id', sources: [source] } };
            }
            if ((COLLECTOR_CONTROL_METHODS as readonly string[]).includes(method)) {
              if (!collector) return failure('VALIDATION', '这台电脑尚未连接本机采集资料目录');
              const result = await collector.invoke(method as CollectorControlMethod, value);
              if (result.ok && method === 'captureSnapshot') window.webContents.send('planner:capture-changed', result.data);
              return result;
            }
            const localResult = await shell.handle(method) ?? await files.handle(method, value);
            if (localResult) { if (localResult.ok && method === 'restore') changed(); return localResult; }
            if (method === 'saveSettings') {
              const request = SaveSettingsRequestSchema.parse(value);
              if (!request.expectedSettings) return failure('VALIDATION', '请重新打开设置页后保存，以便核对共用设置');
              const result = await journal.rpc('saveSettings', request);
              if (result.ok) { shell.saveDeviceSettings(request.settings); changed(); return { ok: true, data: { ...result.data, closeToTray: request.settings.closeToTray, autoLaunch: request.settings.autoLaunch } }; }
              return result;
            }
            if (method === 'retryApiKey' || method === 'setApiKey') {
              const request = method === 'setApiKey' ? SetApiKeyRequestSchema.parse(value) : undefined;
              if (request && request.expectedRevision === undefined) return failure('VALIDATION', '请先读取云端配置状态，再进行修改');
              const status = request ? request.key === null ? await client.clearAiConfiguration(request.expectedRevision!) :
                await client.updateAiConfiguration(request.key, request.expectedRevision!) : await client.getAiConfiguration();
              if (request && collector) {
                // The collector retrieves an authorized encrypted snapshot, never this renderer input.
                const localKey = await collector.invoke('captureRefreshApiKey').catch(() => null);
                if (!localKey?.ok) await dialog.showMessageBox(window, { type: 'info', message: '云端密钥已更新，QQ 提炼正在等待自动同步。', detail: '无需重复保存。电脑采集服务恢复连接后会自动取得最新配置；同步状态可在 QQ 采集页查看。' }).catch(() => {});
              }
              if (request) changed();
              return { ok: true, data: { configured: status.configured, sessionOnly: false, scope: 'cloud', cloudConfiguration: status } };
            }
            if (method === 'selectImage') {
              const result = await dialog.showOpenDialog(window, { title: '选择导入云端的图片', properties: ['openFile'], filters: [{ name: 'PNG / JPEG', extensions: ['png', 'jpg', 'jpeg'] }] });
              const path = result.filePaths[0]; return { ok: true, data: result.canceled || !path ? null : imageFromBytes(path, await boundedFile(path, MAX_IMAGE_BYTES)) };
            }
            if (!(REMOTE_METHODS as readonly string[]).includes(method)) return failure('VALIDATION', '此操作尚未接入当前桌面接口');
            if (method === 'undo' && value === undefined) {
              const snapshot = await client.rpc('snapshot');
              if (!snapshot.ok || !('journal' in snapshot.data)) return snapshot;
              const latest = snapshot.data.journal.find(item => item.undoable && !item.undoneAt);
              if (!latest) return failure('VALIDATION', '没有可撤销的记录'); value = latest.id;
            }
            const result = await journal.rpc(method as RemoteMethod, value);
            if (result.ok && method === 'importSource') {
              const imported = remoteOutputs.importSource.parse(result);
              if (imported.ok) try { sourceCache.remember(ImportSourceRequestSchema.parse(value), imported.data); }
              catch { await dialog.showMessageBox(window, { type: 'warning', message: '云端来源已保存，但本机原文副本保存失败。', detail: '请保留手头的原始文字或图片，并检查电脑存储空间。无需重复提交已保存的来源。' }); }
            }
            if (result.ok && method === 'importCourses') {
              const imported = remoteOutputs.importCourses.parse(result), request = CourseImportRequestSchema.parse(value);
              if (imported.ok && imported.data.sourceId && request.kind === 'image') try { sourceCache.rememberCourseImage(request, imported.data.sourceId); }
              catch { await dialog.showMessageBox(window, { type: 'warning', message: '课表识别已完成，但本机截图副本保存失败。', detail: '请保留原始截图并检查电脑存储空间，不需要重复识别。' }); }
            }
            if (result.ok && method === 'mutate' && 'status' in result.data && result.data.status === 'applied') {
              const request = MutationRequestSchema.parse(value);
              for (const mutation of request.mutations) if (mutation.type === 'delete' && mutation.entity === 'source') sourceCache.forget(mutation.id);
            }
            if (method === 'snapshot' && result.ok && 'keyStatus' in result.data) return { ...result, data: shell.snapshot(SnapshotSchema.parse({ ...result.data, keyStatus: { ...result.data.keyStatus, scope: 'cloud' } })) };
            if (!(REMOTE_READ_METHODS as readonly string[]).includes(method)) changed();
            return result;
          } catch (error) {
            if (error instanceof WorkflowError) return failure(error.code, error.message, false);
            if (error instanceof RemoteClientError) return failure(error.status === 401 ? 'AUTH' : error.status === 409 ? 'CONFLICT' :
              error.status === 400 || error.status === 403 ? 'VALIDATION' : error.status === 429 ? 'RATE_LIMIT' : 'NETWORK', error.message,
              method === 'setApiKey' || method === 'restore' ? false : error.status === 0 || error.status >= 500);
            return failure('STORAGE', '无法可靠读取或保存连接状态，未确认保存；请检查独立配置目录');
          } finally { if (!updating) activeRequests--; }
        },
      }));
    let inspecting = false;
    const inspect = async () => {
      if (inspecting || window.isDestroyed()) return; inspecting = true;
      try {
        const state = await journal.inspect();
        if (state.status === 'none') { await dialog.showMessageBox(window, { message: '没有待核对的云端操作' }); return; }
        const canAcknowledge = state.status === 'completed' || state.status === 'interrupted';
        const result = await dialog.showMessageBox(window, { type: canAcknowledge ? 'warning' : 'info', message: `原操作状态：${({ unknown: '尚无回执', processing: '处理中', interrupted: '曾被中断', completed: '已返回结果' })[state.status]}`,
          detail: `操作编号：${state.requestId}\n先刷新并核对安排或账本，再解除保护。也可以重试原操作：已完成的请求会直接读取原回执。`,
          buttons: canAcknowledge ? ['保留保护', '已核对资料，解除保护'] : ['关闭'], defaultId: 0, cancelId: 0 });
        if (result.response === 1) { await journal.acknowledge(state.requestId); changed(); }
      } catch (error) { await dialog.showMessageBox(window, { type: 'error', message: error instanceof RemoteClientError ? error.message : '核对未完成，原操作保护仍然保留' }); }
      finally { inspecting = false; }
    };
    Menu.setApplicationMenu(null);
    shell.setTrayItems([{ label: '刷新共用资料', click: changed }, { label: '核对云端操作', click: () => { void inspect(); } }]);
    // Canonical snapshots are fetched by the existing client on this event. No local DB or QQ socket is opened.
    const poll = setInterval(() => { if (window.isVisible() && !window.isMinimized()) { changed(); void collector?.invoke('captureSnapshot').then(result => { if (result.ok && !window.isDestroyed()) window.webContents.send('planner:capture-changed', result.data); }).catch(() => {}); } }, 30_000);
    window.on('focus', changed);
    const close = () => { clearInterval(poll); shell.close(); collector?.close(); client.close(); session.defaultSession.removeListener('will-download', download); for (const method of methods) ipcMain.removeHandler(`planner:${method}`); };
    window.once('closed', close);
    try { await window.loadURL(documentUrl); window.show(); } catch (error) { window.destroy(); throw error; }
    return { window, close };
  } catch (error) { client.close(); throw error; }
}
