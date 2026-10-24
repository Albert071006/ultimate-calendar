import { randomUUID, createHash } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createBackup, openBackupFile, requireRestoreSpace, requireRestoreStagingSpace, restoreOpenedBackup, type OpenBackupFile } from '../storage/backups';
import { kinds, type Repository } from '../storage/repository';
import { WorkflowError } from '../ai/deepseek';
import type { RestoreResult } from '../shared/contracts';
import type { CaptureStore } from '../capture/store';
import { readLedgerDatabase } from '../ledger/service';
import { openDatabase } from '../storage/database';
import { resolveBackupDirectory } from '../storage/space-policy';
const fingerprint = (repository: Repository, capture?: CaptureStore) => {
  const db = openDatabase(repository.path,true);
  try { return createHash('sha256').update(JSON.stringify(repository.read())).update(capture?.fingerprint() ?? '').update(JSON.stringify(readLedgerDatabase(db))).digest('hex'); } finally { db.close(); }
};
export function createRestoreManager(repository: Repository, canRestore: () => boolean = () => true, captureStore?: CaptureStore) {
  let generation = 0;
  let pending: { token: string; file: OpenBackupFile; staging: string; fingerprint: string; expires: number; timer: ReturnType<typeof setTimeout> } | null = null;
  const removeStaging = (path: string) => { try { rmSync(path, { force: true }); } catch { /* Own temporary file only; a later cleanup can retry. */ } };
  function dispose() {
    generation++;
    if (!pending) return;
    const chosen = pending; pending = null;
    clearTimeout(chosen.timer); chosen.file.close(); removeStaging(chosen.staging);
  }
  return {
    dispose,
    async preview(path: string): Promise<Extract<RestoreResult, {status:'preview'}>> {
      dispose(); const request = generation;
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new WorkflowError('VALIDATION', '请选择日历 SQLite 备份文件');
      const dir = join(dirname(repository.path), 'restore-staging');
      await mkdir(dir, { recursive: true }); const staging = join(dir, `${randomUUID()}.sqlite`);
      let file: OpenBackupFile | null = null;
      try {
        requireRestoreStagingSpace(dir, metadata.size);
        await copyFile(path, staging); file = openBackupFile(staging);
        if (generation !== request) throw new WorkflowError('CANCELLED', '已使用新的恢复预览');
        if (file.capture && !captureStore) throw new WorkflowError('VALIDATION', '该备份含有 QQ 采集资料，需要同时初始化采集存储后恢复');
        const token = randomUUID();
        const currentFingerprint = fingerprint(repository, captureStore);
        const timer = setTimeout(() => { if (pending?.token === token) dispose(); }, 10 * 60_000); timer.unref?.();
        pending = { token, file, staging, fingerprint: currentFingerprint, expires: Date.now() + 10 * 60_000, timer };
        const qq = captureStore ? file.capture ? `包含 ${file.capture.messages} 条 QQ 消息和 ${file.capture.attachments} 个附件；QQ 收集与自动分析在恢复后暂停。` : '这是不含 QQ 资料的旧备份，恢复会清空当前 QQ 采集资料并暂停采集与分析。' : '';
        return { status: 'preview', message: `恢复会替换当前日历及账本数据（备份中 ${file.ledger.entries.length} 笔账目）；确认前会自动另存当前数据。密钥不受影响。${qq}`, confirmationToken: token, counts: Object.fromEntries(kinds.map(k => [k, file!.planner.entities[k].length])) as Extract<RestoreResult, {status:'preview'}>['counts'] };
      } catch (error) { file?.close(); removeStaging(staging); throw error; }
    },
    async confirm(token: string): Promise<Extract<RestoreResult, {status:'restored'}>> {
      if (!canRestore()) throw new WorkflowError('CONFLICT', '分析、附件处理、QQ 补采或自然语言操作仍在处理中，请完成后再确认恢复');
      if (!pending || pending.token !== token || pending.expires < Date.now()) {
        if (pending && pending.expires < Date.now()) dispose();
        throw new WorkflowError('CONFLICT', '恢复预览已过期或凭据无效，请重新选择备份');
      }
      const chosen = pending;
      if (chosen.fingerprint !== fingerprint(repository, captureStore)) { dispose(); throw new WorkflowError('CONFLICT', '当前日历、账本或 QQ 采集数据已改变，请重新预览恢复，避免覆盖新修改'); }
      requireRestoreSpace(repository, chosen.file);
      const safetyBackupPath = join(resolveBackupDirectory(dirname(repository.path)), `before-restore-${randomUUID()}.sqlite`);
      createBackup(repository, safetyBackupPath);
      try { restoreOpenedBackup(repository, chosen.file, captureStore); }
      finally { dispose(); }
      return { status: 'restored', message: `已恢复备份；恢复前数据已另存安全备份。${captureStore ? 'QQ 收集与自动分析已暂停，请核对资料后再启用。' : ''}`, safetyBackupPath };
    },
  };
}
