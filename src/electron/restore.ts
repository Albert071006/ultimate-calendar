import { randomUUID, createHash } from 'node:crypto';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createBackup, inspectBackupBundle } from '../storage/backups';
import { kinds, type Repository, type StoredState } from '../storage/repository';
import { WorkflowError } from '../ai/deepseek';
import type { RestoreResult } from '../shared/contracts';
import type { CaptureExportState, CaptureStore } from '../capture/store';
import { replacePlannerAndCapture } from '../capture/backup';
import { readLedgerDatabase, replaceLedgerDatabase } from '../ledger/service';
import { openDatabase } from '../storage/database';
import type { LedgerData } from '../shared/ledger';
const fingerprint = (repository: Repository, capture?: CaptureStore) => {
  const db = openDatabase(repository.path,true);
  try { return createHash('sha256').update(JSON.stringify(repository.read())).update(capture?.fingerprint() ?? '').update(JSON.stringify(readLedgerDatabase(db))).digest('hex'); } finally { db.close(); }
};
export function createRestoreManager(repository: Repository, canRestore: () => boolean = () => true, captureStore?: CaptureStore) {
  let pending: { token: string; state: StoredState; capture: CaptureExportState | null; ledger:LedgerData; fingerprint: string; expires: number } | null = null;
  return {
    async preview(path: string): Promise<Extract<RestoreResult, {status:'preview'}>> {
      pending = null;
      const metadata = await stat(path); if (!metadata.isFile() || metadata.size > 512 * 1024 * 1024) throw new WorkflowError('VALIDATION', '请选择不超过 512 MB 的日历 SQLite 备份');
      const dir = join(dirname(repository.path), 'restore-staging'); await mkdir(dir, { recursive: true }); const staging = join(dir, `${randomUUID()}.sqlite`);
      try {
        await copyFile(path, staging); const bundle = inspectBackupBundle(staging); const state = bundle.planner; const token = randomUUID();
        if (bundle.capture && !captureStore) throw new WorkflowError('VALIDATION', '该备份含有 QQ 采集资料，需要同时初始化采集存储后恢复');
        pending = { token, state, capture: bundle.capture, ledger:bundle.ledger, fingerprint: fingerprint(repository, captureStore), expires: Date.now() + 10 * 60_000 };
        const qq = captureStore ? bundle.capture ? `包含 ${bundle.capture.messages.length} 条 QQ 消息和 ${bundle.capture.attachments.length} 个附件；QQ 收集与自动分析在恢复后暂停。` : '这是不含 QQ 资料的旧备份，恢复会清空当前 QQ 采集资料并暂停采集与分析。' : '';
        return { status: 'preview', message: `恢复会替换当前日历及账本数据（备份中 ${bundle.ledger.entries.length} 笔账目）；确认前会自动另存当前数据。密钥不受影响。${qq}`, confirmationToken: token, counts: Object.fromEntries(kinds.map(k => [k, state.entities[k].length])) as Extract<RestoreResult, {status:'preview'}>['counts'] };
      } finally { await rm(staging, { force: true }); }
    },
    async confirm(token: string): Promise<Extract<RestoreResult, {status:'restored'}>> {
      if (!canRestore()) throw new WorkflowError('CONFLICT', '分析、附件处理、QQ 补采或自然语言操作仍在处理中，请完成后再确认恢复');
      if (!pending || pending.token !== token || pending.expires < Date.now()) throw new WorkflowError('CONFLICT', '恢复预览已过期或凭据无效，请重新选择备份');
      const chosen = pending;
      if (chosen.fingerprint !== fingerprint(repository, captureStore)) { pending = null; throw new WorkflowError('CONFLICT', '当前日历、账本或 QQ 采集数据已改变，请重新预览恢复，避免覆盖新修改'); }
      const safetyBackupPath = join(dirname(repository.path), 'backups', `before-restore-${randomUUID()}.sqlite`);
      createBackup(repository, safetyBackupPath); replacePlannerAndCapture(repository, chosen.state, chosen.capture, captureStore, db => replaceLedgerDatabase(db, chosen.ledger)); pending = null;
      return { status: 'restored', message: `已恢复备份；恢复前数据已另存安全备份。${captureStore ? 'QQ 收集与自动分析已暂停，请核对资料后再启用。' : ''}`, safetyBackupPath };
    },
  };
}
