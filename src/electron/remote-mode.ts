import { BrowserWindow, Menu, app, dialog, ipcMain, safeStorage, session } from 'electron';
import { join } from 'node:path';
import { createNodeRemoteClient, RemoteClientError, type RemoteCredential } from '../remote/node-client';
import { readPrivate, writePrivate } from '../remote/private-file';
import { createWriteJournal } from '../remote/write-journal';
import { REMOTE_METHODS, type RemoteMethod } from '../shared/remote';
import { MAX_IMAGE_BYTES } from '../shared/contracts';
import { boundedFile, imageFromBytes } from './files';
import { dispatchRequest } from './ipc';
import { methods } from './protocol';
import type { NativeRemoteConfig } from './remote-config';

/** Uses bundled trusted UI and main-process networking, never a remote page with Electron privileges. */
export async function startNativeRemote(config: NativeRemoteConfig, directory: string, documentUrl: string) {
  if (!safeStorage.isEncryptionAvailable()) throw Error('系统凭据加密不可用，未保存或发送配对凭据');
  const credentialFile = join(directory, 'credentials', 'remote-device.bin');
  const client = createNodeRemoteClient({ origin: config.origin, credentials: {
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
    const window = new BrowserWindow({ width: 1440, height: 940, minWidth: 980, minHeight: 680, show: false, title: '终极日历 · 云端资料', backgroundColor: '#f5f0e6', icon: join(__dirname, '../assets/app-icon.png'),
      webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: !app.isPackaged } });
    const changed = () => { if (!window.isDestroyed()) window.webContents.send('planner:changed', { reason: 'mutation' }); };
    session.defaultSession.setPermissionRequestHandler((_c, _p, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    session.defaultSession.on('will-download', event => event.preventDefault());
    const failure = (code: 'AUTH' | 'CONFLICT' | 'NETWORK' | 'VALIDATION' | 'STORAGE', message: string) => ({ ok: false, error: { code, message, retryable: code === 'NETWORK' } });
    for (const method of methods) ipcMain.handle(`planner:${method}`, (event, input: unknown) => dispatchRequest(method, input,
      event.senderFrame ? { senderId: event.sender.id, frameId: event.senderFrame.routingId, url: event.senderFrame.url } : null,
      window.isDestroyed() ? null : { senderId: window.webContents.id, frameId: window.webContents.mainFrame.routingId, url: documentUrl }, {
        [method]: async (value: unknown) => {
          try {
            if (method === 'selectImage') {
              const result = await dialog.showOpenDialog(window, { title: '选择导入云端的图片', properties: ['openFile'], filters: [{ name: 'PNG / JPEG', extensions: ['png', 'jpg', 'jpeg'] }] });
              const path = result.filePaths[0]; return { ok: true, data: result.canceled || !path ? null : imageFromBytes(path, await boundedFile(path, MAX_IMAGE_BYTES)) };
            }
            if (!(REMOTE_METHODS as readonly string[]).includes(method)) return failure('VALIDATION', '云端模式不提供此本机管理功能；密钥、备份和 QQ 采集在各自服务端管理');
            if (method === 'undo' && value === undefined) {
              const snapshot = await client.rpc('snapshot');
              if (!snapshot.ok || !('journal' in snapshot.data)) return snapshot;
              const latest = snapshot.data.journal.find(item => item.undoable && !item.undoneAt);
              if (!latest) return failure('VALIDATION', '没有可撤销的记录'); value = latest.id;
            }
            const result = await journal.rpc(method as RemoteMethod, value);
            if (!['snapshot', 'ledgerSnapshot'].includes(method)) changed();
            return result;
          } catch (error) {
            if (error instanceof RemoteClientError) return failure(error.status === 401 ? 'AUTH' : error.status === 409 ? 'CONFLICT' : 'NETWORK', error.message);
            return failure('STORAGE', '无法可靠读取或保存连接状态，未确认保存；请检查独立配置目录');
          }
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
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '云端资料', submenu: [ { label: '刷新', click: changed }, { label: '核对云端操作', click: () => { void inspect(); } }, { type: 'separator' }, { role: 'quit' } ] }]));
    // Canonical snapshots are fetched by the existing client on this event. No local DB or QQ socket is opened.
    const poll = setInterval(() => { if (window.isVisible() && !window.isMinimized()) changed(); }, 30_000);
    window.on('focus', changed);
    const close = () => { clearInterval(poll); client.close(); for (const method of methods) ipcMain.removeHandler(`planner:${method}`); };
    window.once('closed', close);
    try { await window.loadURL(documentUrl); window.show(); } catch (error) { window.destroy(); throw error; }
    return { window, close };
  } catch (error) { client.close(); throw error; }
}
