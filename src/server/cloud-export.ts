import { readFileSync, statSync } from 'node:fs';
import { WorkflowError } from '../ai/deepseek';
import { BackupExportDataSchema, LedgerExportDataSchema, MAX_CLOUD_EXPORT_BYTES } from '../shared/cloud-management';
import { validateSafeBackup } from './backup';

/** Historical ledger entries and audits may retain input text; it is not formal accounting data. */
export function withoutOriginalText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutOriginalText);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'originalText' ? '' : withoutOriginalText(item)]));
}
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
  const content = JSON.stringify(withoutOriginalText({ format: 'ultimate-calendar-safe-backup', formatVersion: 1, createdAt: raw.createdAt, planner,
    ledger: { format: 'ultimate-calendar-ledger', formatVersion: 1, ...fields } }));
  const result = BackupExportDataSchema.safeParse({ content });
  if (!result.success) throw new WorkflowError('VALIDATION', '安全备份超过 8 MiB 传输上限，未截断或保存文件');
  return result.data;
}
