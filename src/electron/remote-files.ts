import { app, dialog, type BrowserWindow } from 'electron';
import { basename, extname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CourseImportRequestSchema, RestoreRequestSchema, type ApiResult } from '../shared/contracts';
import { MAX_CLOUD_EXPORT_BYTES } from '../shared/cloud-management';
import { remoteOutputs } from '../server/protocol';
import type { RemoteMethod } from '../shared/remote';
import type { NodeRemoteClient } from '../remote/node-client';
import { WorkflowError } from '../ai/deepseek';
import { parseCourseFile } from '../imports/courses';
import { boundedFile } from './files';
import { validateSafeBackup } from '../server/backup';
import { withoutOriginalText } from '../server/cloud-export';
import { writeLocalResourcesCompanion, readLocalResourcesCompanion, mergeLocalResources, type LocalResourceRegistry } from '../storage/local-resources';

/** Native file selection stays local; shared data export always comes from the cloud. */
export function createRemoteFiles(options: { window: BrowserWindow; resourceDirectory?: string; rpc(method: RemoteMethod, input?: unknown): Promise<unknown>; client: NodeRemoteClient; canRestore(): Promise<boolean> }) {
  let preview: { confirmationToken: string; token: string; digest: string; localResources: LocalResourceRegistry | null } | null = null;
  return {
    async handle(method: string, input?: unknown): Promise<ApiResult<unknown> | null> {
      if (method === 'importCourses') {
        const request = CourseImportRequestSchema.parse(input);
        if (request.kind !== 'file') return null;
        const selected = await dialog.showOpenDialog(options.window, { title: '选择课表 CSV/XLSX', properties: ['openFile'], filters: [{ name: '课表', extensions: ['csv', 'xlsx'] }] });
        const path = selected.filePaths[0]; if (selected.canceled || !path) throw new WorkflowError('CANCELLED', '未选择课表文件');
        const extension = extname(path).toLowerCase();
        if (!['.csv', '.xlsx'].includes(extension)) throw new WorkflowError('VALIDATION', '请选择 CSV 或 XLSX 文件');
        const bytes = await boundedFile(path, 10 * 1024 * 1024);
        if (extension === '.xlsx' && !(bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4)) throw new WorkflowError('VALIDATION', 'XLSX 文件内容无效');
        const snapshot = remoteOutputs.snapshot.parse(await options.rpc('snapshot'));
        if (!snapshot.ok) return snapshot;
        return { ok: true, data: await parseCourseFile({ name: basename(path), bytes }, snapshot.data.settings) };
      }
      if (method === 'ledgerExport' || method === 'backup') {
        const exported = method === 'backup' ? remoteOutputs.backupExportData.parse(await options.rpc('backupExportData')) : remoteOutputs.ledgerExportData.parse(await options.rpc('ledgerExportData', input));
        if (!exported.ok) return exported;
        const format = 'format' in exported.data && exported.data.format === 'csv' ? 'csv' : 'json';
        const selected = await dialog.showSaveDialog(options.window, { title: method === 'backup' ? '导出共用日历和账本备份' : '导出云端账本', defaultPath: join(app.getPath('documents'), `终极日历${method === 'backup' ? '备份' : '账本'}-${new Date().toISOString().slice(0, 10)}.${format}`), filters: [{ name: format.toUpperCase(), extensions: [format] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
        if (selected.canceled || !selected.filePath) throw new WorkflowError('CANCELLED', '已取消导出');
        await writeFile(selected.filePath, exported.data.content, { encoding: 'utf8', mode: 0o600 });
        if (method === 'backup' && options.resourceDirectory) writeLocalResourcesCompanion(options.resourceDirectory, selected.filePath);
        return { ok: true, data: { path: selected.filePath, ...(method === 'backup' ? { includesSources: false } : {}) } };
      }
      if (method === 'restore') {
        const request = RestoreRequestSchema.parse(input);
        if (!await options.canRestore()) throw new WorkflowError('CONFLICT', '先核对尚未确认的云端操作，再恢复备份');
        if (!request.confirmed) {
          preview = null;
          const selected = await dialog.showOpenDialog(options.window, { title: '选择共用日历和账本安全备份', properties: ['openFile'], filters: [{ name: '云端安全备份 JSON', extensions: ['json'] }] });
          const path = selected.filePaths[0]; if (selected.canceled || !path) throw new WorkflowError('CANCELLED', '已取消恢复');
          const bytes = await boundedFile(path, MAX_CLOUD_EXPORT_BYTES);
          // Validate locally before transmission: a desktop SQLite backup or raw QQ export is never uploaded here.
          let content: string, counts: Record<string, number>;
          try {
            const raw = JSON.parse(bytes.toString('utf8')), clean = validateSafeBackup(raw);
            counts = Object.fromEntries(Object.entries(clean.planner.entities).map(([kind, records]) => [kind, records.length]));
            const { revision: _revision, ...ledger } = clean.ledger;
            content = JSON.stringify(withoutOriginalText({ format: 'ultimate-calendar-safe-backup', formatVersion: 1, createdAt: raw.createdAt, planner: clean.planner, ledger: { format: 'ultimate-calendar-ledger', formatVersion: 1, ...ledger } }));
          } catch { throw new WorkflowError('VALIDATION', '请选择共用资料安全备份 JSON；原本机完整备份仍保留在电脑，不会上传'); }
          const localResources = options.resourceDirectory ? readLocalResourcesCompanion(path) : null;
          const result = remoteOutputs.restorePreview.parse(await options.client.rpc('restorePreview', { content }));
          if (!result.ok) return result;
          preview = { confirmationToken: randomUUID(), token: result.data.token, digest: result.data.digest, localResources };
          return { ok: true, data: { status: 'preview', confirmationToken: preview.confirmationToken, message: `将恢复 ${result.data.createdAt} 的共用资料，包含 ${result.data.ledgerEntryCount} 笔账目。手机和电脑都会受影响；QQ 原文和附件保留在本机。`, counts } };
        }
        if (!preview || request.confirmationToken !== preview.confirmationToken) throw new WorkflowError('CONFLICT', '请重新选择备份并核对预览');
        const selected = preview; preview = null; // A missing reply must never silently resubmit a restore.
        if (options.resourceDirectory) mergeLocalResources(options.resourceDirectory, selected.localResources);
        const result = await options.client.confirmRestore({ token: selected.token, digest: selected.digest });
        if (!result.ok) return result;
        return { ok: true, data: { status: 'restored', message: '共用日历和账本已恢复，其他设备需核对资料代际并重新连接；本机原文未更改', safetyBackupPath: '服务器自动备份目录（恢复前备份已保存）' } };
      }
      return null;
    },
  };
}
