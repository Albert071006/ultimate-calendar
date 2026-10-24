import { join } from 'node:path';
import { statfsSync } from 'node:fs';
import { openDatabase } from './database';
import { directoryBytes, planBackupRetention, pruneManagedBackups } from './backup-retention';
import { readSpaceState, resolveBackupDirectory, saveSpacePolicy, writeSpaceState } from './space-policy';
import { SpaceSnapshotSchema, type SpaceSnapshot, type SpacePolicy } from '../shared/space';
import { WorkflowError } from '../ai/deepseek';

type AttachmentPolicy = { retentionDays: number; maxBytes: number };
type AttachmentReport = SpaceSnapshot['attachments'];
type Options = {
  directory: string;
  isBusy: () => boolean;
  attachments: { previewAttachmentRetention(policy: AttachmentPolicy): AttachmentReport; cleanAttachments(policy: AttachmentPolicy): AttachmentReport };
  clearCache: () => Promise<void>;
};
const caches = ['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache'];
const attachmentPolicy = (policy: SpacePolicy): AttachmentPolicy => ({ retentionDays: policy.attachmentDays, maxBytes: policy.attachmentBudgetMiB * 1024 * 1024 });
const MiB = 1024 * 1024;

/** SQLite owns compaction, so existing connections keep referring to the same live database. */
function databaseSpace(path: string) {
  const db = openDatabase(path, true);
  try {
    const pageSize = Number(db.prepare('PRAGMA page_size').get()!['page_size']);
    return {
      databaseBytes: Number(db.prepare('PRAGMA page_count').get()!['page_count']) * pageSize,
      reusableBytes: Number(db.prepare('PRAGMA freelist_count').get()!['freelist_count']) * pageSize,
    };
  } finally { db.close(); }
}
function compactDatabase(path: string, directory: string): string | null {
  const usage = databaseSpace(path);
  if (usage.reusableBytes < 16 * MiB) return null;
  const disk = statfsSync(directory);
  if (disk.bavail * disk.bsize < usage.databaseBytes * 2 + 16 * MiB) return '磁盘空间不足以压缩数据库；已释放的页会被新数据复用。';
  const db = openDatabase(path);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
    return null;
  } catch { return '数据库暂时忙，已释放的页可复用，稍后会再次尝试压缩。'; }
  finally { db.close(); }
}

export function createSpaceManager(options: Options) {
  const { directory } = options;
  const path = join(directory, 'planner.sqlite');
  let running = false, stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let initial: ReturnType<typeof setTimeout> | undefined;
  const snapshot = (): SpaceSnapshot => {
    const state = readSpaceState(directory);
    const backups = planBackupRetention(directory, state.policy);
    const attachments = options.attachments.previewAttachmentRetention(attachmentPolicy(state.policy));
    const warnings = [...backups.warnings];
    if (attachments.overBudgetBytes > 0) warnings.push('部分附件仍用于待处理消息或未完成事项，会继续保留；容量目标不能覆盖保护规则。');
    if (backups.unmanagedBytes > 0) warnings.push('手工备份、旧版排障备份和子目录仅统计，不自动删除。');
    return SpaceSnapshotSchema.parse({ policy: state.policy, backupDirectory: resolveBackupDirectory(directory), lastRunAt: state.lastRunAt, lastResult: state.lastResult, ...databaseSpace(path),
      cacheBytes: caches.reduce((sum, name) => sum + directoryBytes(join(directory, name)), 0),
      backupBytes: backups.totalBytes, managedBackupBytes: backups.managedBytes, unmanagedBackupBytes: backups.unmanagedBytes,
      backupCount: backups.count, removableBackupCount: backups.removable.length,
      removableBackupBytes: backups.removable.reduce((sum, entry) => sum + entry.bytes, 0), attachments, warnings });
  };
  const cleanup = async ({ clearCache = false, automatic = false } = {}): Promise<SpaceSnapshot> => {
    if (running || options.isBusy()) throw new WorkflowError('CONFLICT', '请等待当前分析、导入、恢复或更新完成后再清理。');
    const state = readSpaceState(directory);
    if (automatic && !state.policy.enabled) return snapshot();
    running = true;
    try {
      const attachments = options.attachments.cleanAttachments(attachmentPolicy(state.policy));
      const backups = pruneManagedBackups(directory, true);
      const note = compactDatabase(path, directory);
      if (clearCache) await options.clearCache();
      const result = `已清理 ${backups.deletedCount} 份旧备份、${attachments.selectedAttachments} 个 QQ 附件${clearCache ? '，并清除界面缓存' : ''}。${note ?? ''}${backups.warnings.join('')}`;
      writeSpaceState(directory, { ...state, lastRunAt: new Date().toISOString(), lastResult: result });
      return snapshot();
    } catch (error) {
      writeSpaceState(directory, { ...state, lastRunAt: new Date().toISOString(), lastResult: '本次清理未全部完成，未删除的内容会保留；请稍后重试。' });
      throw error;
    } finally { running = false; }
  };
  const tick = () => {
    if (stopped || running || options.isBusy()) return;
    try {
      const state = readSpaceState(directory);
      if (!state.policy.enabled || (state.lastRunAt && Date.now() - Date.parse(state.lastRunAt) < 3600_000)) return;
      void cleanup({ automatic: true }).catch(() => {});
    } catch { /* Invalid or unreadable policy must never trigger cleanup with defaults. */ }
  };
  return {
    snapshot, cleanup,
    configure(policy: SpacePolicy) { if (running) throw new WorkflowError('CONFLICT', '正在清理，请稍候再修改规则。'); saveSpacePolicy(directory, policy); return snapshot(); },
    isRunning: () => running,
    start() { if (timer) return; stopped = false; initial = setTimeout(tick, 60_000); timer = setInterval(tick, 60_000); },
    stop() { stopped = true; if (initial) clearTimeout(initial); if (timer) clearInterval(timer); timer = undefined; },
  };
}
