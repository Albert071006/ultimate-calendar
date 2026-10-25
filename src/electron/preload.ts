import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { AccountStateSchema } from '../shared/account';
import { CaptureSnapshotSchema } from '../shared/capture';
import { UpdateStateSchema } from '../shared/update';
import { ChangedEventSchema, NavigateEventSchema, type DesktopAPI } from '../shared/contracts';
import { requests, responses, type Method } from './protocol';

async function invoke(method: Method, input?: unknown): Promise<unknown> {
  const parsed = requests[method].safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', message: '输入格式无效，请检查后重试', retryable: false } };
  try {
    const result = await ipcRenderer.invoke(`planner:${method}`, parsed.data);
    const response = responses[method].safeParse(result);
    return response.success ? response.data : { ok: false, error: { code: 'INTERNAL', message: '服务响应无效，请重新打开应用', retryable: false } };
  } catch { return { ok: false, error: { code: 'INTERNAL', message: '暂时无法连接本机服务，请重新打开应用', retryable: false } }; }
}
function changed(listener: Parameters<DesktopAPI['onChanged']>[0]) {
  const handler = (_event: IpcRendererEvent, data: unknown) => { const parsed = ChangedEventSchema.safeParse(data); if (parsed.success) listener(parsed.data); };
  ipcRenderer.on('planner:changed', handler); return () => ipcRenderer.removeListener('planner:changed', handler);
}
function navigate(listener: Parameters<DesktopAPI['onNavigate']>[0]) {
  const handler = (_event: IpcRendererEvent, data: unknown) => { const parsed = NavigateEventSchema.safeParse(data); if (parsed.success) listener(parsed.data); };
  ipcRenderer.on('planner:navigate', handler);
  ipcRenderer.send('planner:navigation-ready');
  return () => ipcRenderer.removeListener('planner:navigate', handler);
}
function accountChanged(listener: Parameters<DesktopAPI['onAccountChanged']>[0]) {
  const handler = (_event: IpcRendererEvent, data: unknown) => { const parsed = AccountStateSchema.safeParse(data); if (parsed.success) listener(parsed.data); };
  ipcRenderer.on('planner:account-changed', handler); return () => ipcRenderer.removeListener('planner:account-changed', handler);
}
// Explicit fixed methods only: no ipcRenderer, event objects or arbitrary channels cross contextBridge.
const api = {
  planExportPreview: (request: unknown) => invoke('planExportPreview', request), planExportSave: (request: unknown) => invoke('planExportSave', request),
  planImportOpen: () => invoke('planImportOpen'), planImportConfirm: (request: unknown) => invoke('planImportConfirm', request), planImportTemplate: () => invoke('planImportTemplate'),
  resourcePick: (request: unknown) => invoke('resourcePick', request), resourceRegister: (request: unknown) => invoke('resourceRegister', request),
  resourceOpen: (request: unknown) => invoke('resourceOpen', request), resourceRelocate: (request: unknown) => invoke('resourceRelocate', request), resourceStatus: (request: unknown) => invoke('resourceStatus', request),
  resourceDrop: (files: File[]) => {
    try {
      if (!Array.isArray(files) || files.length < 1 || files.length > 50) throw Error('invalid selection');
      const paths = files.map(file => webUtils.getPathForFile(file));
      if (paths.some(path => !path)) throw Error('not native files');
      return invoke('resourceRegister', { paths });
    } catch { return Promise.resolve({ ok: false, error: { code: 'VALIDATION', message: '请从文件资源管理器拖入本机资料文件', retryable: false } }); }
  },
  spaceSnapshot: () => invoke('spaceSnapshot'), spaceConfigure: (request: unknown) => invoke('spaceConfigure', request), spaceCleanup: (request: unknown) => invoke('spaceCleanup', request),
  updateSnapshot: () => invoke('updateSnapshot'), checkForUpdates: () => invoke('checkForUpdates'), downloadUpdate: () => invoke('downloadUpdate'), installUpdate: () => invoke('installUpdate'),
  onUpdateChanged: (listener: Parameters<DesktopAPI['onUpdateChanged']>[0]) => { const handler = (_event: IpcRendererEvent, value: unknown) => { const parsed = UpdateStateSchema.safeParse(value); if (parsed.success) listener(parsed.data); }; ipcRenderer.on('planner:update-changed', handler); return () => ipcRenderer.removeListener('planner:update-changed', handler); },
  ledgerSnapshot: (request?: unknown) => invoke('ledgerSnapshot', request), ledgerMutate: (request: unknown) => invoke('ledgerMutate', request), ledgerUndo: (request: unknown) => invoke('ledgerUndo', request), ledgerExport: (request: unknown) => invoke('ledgerExport', request),
  captureSnapshot: () => invoke('captureSnapshot'), captureConfigure: (request: unknown) => invoke('captureConfigure', request), captureConnect: (request: unknown) => invoke('captureConnect', request), captureGroups: () => invoke('captureGroups'), captureMessages: (request: unknown) => invoke('captureMessages', request), captureBatches: (request: unknown) => invoke('captureBatches', request), captureAction: (request: unknown) => invoke('captureAction', request), captureChunks: (request: unknown) => invoke('captureChunks', request), captureCleanup: (request: unknown) => invoke('captureCleanup', request),
  onCaptureChanged: (listener: Parameters<DesktopAPI['onCaptureChanged']>[0]) => { const handler = (_event: IpcRendererEvent, value: unknown) => { const parsed = CaptureSnapshotSchema.safeParse(value); if (parsed.success) listener(parsed.data); }; ipcRenderer.on('planner:capture-changed', handler); return () => ipcRenderer.removeListener('planner:capture-changed', handler); },
  accountSnapshot: () => invoke('accountSnapshot'), refreshAccount: () => invoke('refreshAccount'), onAccountChanged: accountChanged,
  snapshot: () => invoke('snapshot'), selectImage: () => invoke('selectImage'),
  mutate: (request: unknown) => invoke('mutate', request), undo: (id?: string) => invoke('undo', id),
  importSource: (request: unknown) => invoke('importSource', request), analyzeSource: (request: unknown) => invoke('analyzeSource', request),
  command: (request: unknown) => invoke('command', request), importCourses: (request: unknown) => invoke('importCourses', request),
  saveSettings: (request: unknown) => invoke('saveSettings', request), setApiKey: (request: unknown) => invoke('setApiKey', request), retryApiKey: () => invoke('retryApiKey'),
  localSourceEvidence: (request: unknown) => invoke('localSourceEvidence', request),
  backup: () => invoke('backup'), restore: (request: unknown) => invoke('restore', request), onChanged: changed, onNavigate: navigate,
};
contextBridge.exposeInMainWorld('planner', api);
