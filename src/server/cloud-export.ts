import { readFileSync, statSync } from 'node:fs';
import { WorkflowError } from '../ai/deepseek';
import { BackupExportDataSchema, LedgerExportDataSchema, MAX_CLOUD_EXPORT_BYTES } from '../shared/cloud-management';
import { validateSafeBackup } from './backup';

export function ledgerExportData(content: string, format: 'csv' | 'json') {
  const result = LedgerExportDataSchema.safeParse({ content, format });
  if (!result.success) throw new WorkflowError('VALIDATION', '账本导出超过 8 MiB 传输上限，未截断或保存文件');
  return result.data;
}
export function backupExportData(path: string) {
  if (statSync(path).size > MAX_CLOUD_EXPORT_BYTES) throw new WorkflowError('VALIDATION', '安全备份超过 8 MiB 传输上限，未截断或保存文件');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const { planner, ledger } = validateSafeBackup(raw);
  const { revision: _revision, ...fields } = ledger;
  const content = JSON.stringify({ format: 'ultimate-calendar-safe-backup', formatVersion: 1, createdAt: raw.createdAt, planner,
    ledger: { format: 'ultimate-calendar-ledger', formatVersion: 1, ...fields } });
  const result = BackupExportDataSchema.safeParse({ content });
  if (!result.success) throw new WorkflowError('VALIDATION', '安全备份超过 8 MiB 传输上限，未截断或保存文件');
  return result.data;
}
