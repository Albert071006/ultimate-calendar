import { z } from 'zod';
import { CourseImportRequestSchema, SettingsSchema, type Settings } from './contracts';
import { LedgerMonthSchema } from './ledger';
import { RemoteIdentitySchema } from './remote';

export const CloudSaveSettingsRequestSchema = z.strictObject({ settings: SettingsSchema, expectedSettings: SettingsSchema });
/** These switches belong to one Windows installation, never to the shared calendar. */
export function sharedSettings(settings: Settings) {
  const { closeToTray: _closeToTray, autoLaunch: _autoLaunch, ...shared } = settings;
  return shared;
}
export const CloudCourseImportRequestSchema = CourseImportRequestSchema.refine(value => value.kind !== 'file', '文件选择和解析须由电脑完成');
export const LedgerExportDataRequestSchema = z.strictObject({ format: z.enum(['csv', 'json']), month: LedgerMonthSchema.optional() });
export const MAX_CLOUD_EXPORT_BYTES = 8 * 1024 * 1024;
export const MAX_CLOUD_EXPORT_WIRE_BYTES = 16 * 1024 * 1024;
const exportedContent = z.string().max(MAX_CLOUD_EXPORT_BYTES).refine(value => {
  const encoder = new TextEncoder();
  return encoder.encode(value).byteLength <= MAX_CLOUD_EXPORT_BYTES && encoder.encode(JSON.stringify(value)).byteLength <= MAX_CLOUD_EXPORT_WIRE_BYTES;
}, '导出内容超过传输上限，未截断内容');
export const LedgerExportDataSchema = z.strictObject({ content: exportedContent, format: z.enum(['csv', 'json']) });
export const BackupExportDataSchema = z.strictObject({ content: exportedContent });
export const CloudRestorePreviewRequestSchema = BackupExportDataSchema;
export const CloudRestorePreviewSchema = z.strictObject({
  token: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime(), createdAt: z.string().datetime(),
  taskCount: z.number().int().nonnegative(), courseCount: z.number().int().nonnegative(), goalCount: z.number().int().nonnegative(), ledgerEntryCount: z.number().int().nonnegative(),
});
export const CloudRestoreConfirmRequestSchema = z.strictObject({ token: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const CloudRestoreConfirmSchema = z.strictObject({ identity: RemoteIdentitySchema, backupCreated: z.literal(true),
  taskCount: z.number().int().nonnegative(), courseCount: z.number().int().nonnegative(), ledgerEntryCount: z.number().int().nonnegative() });
