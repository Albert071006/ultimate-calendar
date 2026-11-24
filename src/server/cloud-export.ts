import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { WorkflowError } from '../ai/deepseek';
import { BackupExportDataSchema, CLOUD_BACKUP_CHUNK_BYTES, LedgerExportDataSchema, MAX_CLOUD_BACKUP_BYTES, MAX_CLOUD_EXPORT_BYTES } from '../shared/cloud-management';
import { validateSafeBackup } from './backup';

export function ledgerExportData(content: string, format: 'csv' | 'json') {
  const result = LedgerExportDataSchema.safeParse({ content, format });
  if (!result.success) throw new WorkflowError('VALIDATION', '账本导出超过 8 MiB 传输上限，未截断或保存文件');
  return result.data;
}
function oversizedBackup(limit: number) {
  return new WorkflowError('VALIDATION', `安全备份超过 ${limit / (1024 * 1024)} MiB 传输上限，未截断或保存文件`);
}
function readBackup(path: string, limit: number) {
  const file = lstatSync(path);
  if (!file.isFile()) throw new WorkflowError('STORAGE', '安全备份文件不可读取');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== file.ino || stat.dev !== file.dev) throw new WorkflowError('STORAGE', '安全备份文件已改变');
    if (stat.size > limit) throw oversizedBackup(limit);
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new WorkflowError('STORAGE', '安全备份文件读取不完整');
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new WorkflowError('STORAGE', '安全备份文件已改变');
    return JSON.parse(bytes.toString('utf8'));
  } finally { closeSync(fd); }
}
function backupContent(path: string, limit: number) {
  const raw = readBackup(path, limit);
  const { planner, ledger } = validateSafeBackup(raw);
  const { revision: _revision, ...fields } = ledger;
  const content = JSON.stringify({ format: 'ultimate-calendar-safe-backup', formatVersion: 1, createdAt: raw.createdAt, planner,
    ledger: { format: 'ultimate-calendar-ledger', formatVersion: 1, ...fields } });
  if (Buffer.byteLength(content) > limit) throw oversizedBackup(limit);
  return content;
}
export function backupExportData(path: string) {
  const content = backupContent(path, MAX_CLOUD_EXPORT_BYTES);
  const result = BackupExportDataSchema.safeParse({ content });
  if (!result.success) throw new WorkflowError('VALIDATION', '安全备份超过 8 MiB 传输上限，未截断或保存文件');
  return result.data;
}

/** Hold the exact validated export for the life of a download, across backup rotation and writes. */
export function createBackupDownloads() {
  type Download = {
    deviceId: string; identity: string; bytes: Buffer; served: Set<number>;
    expires: number; timer: ReturnType<typeof setTimeout>;
  };
  const downloads = new Map<string, Download>();
  let preparing = 0;
  const lifetime = 15 * 60_000;
  const discard = (id: string, item: Download) => { clearTimeout(item.timer); downloads.delete(id); };
  return {
    async start(deviceId: string, identity: string, makeBackup: () => Promise<string>) {
      for (const [id, item] of downloads) {
        if (item.identity !== identity || item.expires <= Date.now()) discard(id, item);
      }
      if (downloads.size + preparing >= 2) {
        const finished = [...downloads].find(([, item]) => item.served.size === Math.ceil(item.bytes.length / CLOUD_BACKUP_CHUNK_BYTES));
        if (finished) discard(...finished);
      }
      // Up to two immutable snapshots (128 MiB retained). A concurrent start never
      // invalidates an unfinished download belonging to this or another device.
      if (downloads.size + preparing >= 2) throw new WorkflowError('CONFLICT', '其他安全备份下载尚未结束，请稍后重试', true);
      preparing++;
      try {
        const bytes = Buffer.from(backupContent(await makeBackup(), MAX_CLOUD_BACKUP_BYTES));
        const downloadId = randomUUID(), sha256 = createHash('sha256').update(bytes).digest('hex');
        const timer = setTimeout(() => downloads.delete(downloadId), lifetime);
        timer.unref();
        downloads.set(downloadId, { deviceId, identity, bytes, served: new Set(), expires: Date.now() + lifetime, timer });
        return { downloadId, totalBytes: bytes.length, sha256, chunkBytes: CLOUD_BACKUP_CHUNK_BYTES };
      } finally { preparing--; }
    },
    finish(downloadId: string, deviceId: string, identity: string) {
      const item = downloads.get(downloadId);
      if (item?.deviceId === deviceId && item.identity === identity) discard(downloadId, item);
      return { released: true };
    },
    chunk(downloadId: string, offset: number, deviceId: string, identity: string) {
      const item = downloads.get(downloadId);
      if (!item || item.deviceId !== deviceId || item.identity !== identity || item.expires <= Date.now())
        throw new WorkflowError('CONFLICT', '安全备份下载已失效或不属于当前设备，请重新导出');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= item.bytes.length || offset % CLOUD_BACKUP_CHUNK_BYTES !== 0)
        throw new WorkflowError('VALIDATION', '安全备份分块位置无效');
      item.served.add(offset);
      return { downloadId, offset, data: item.bytes.toString('base64', offset, offset + CLOUD_BACKUP_CHUNK_BYTES) };
    },
    clear() { for (const [id, item] of downloads) discard(id, item); },
  };
}
