import { z } from 'zod';
import { SnapshotSchema, MutationRequestSchema, MutationResultSchema, IdSchema, ImportSourceRequestSchema, SourceSchema, AnalyzeSourceRequestSchema, AnalysisResultSchema, CommandRequestSchema, CommandResultSchema, SettingsSchema, CourseImportResultSchema, apiResultSchema } from '../shared/contracts';
import { LedgerMonthSchema, LedgerMutationRequestSchema, LedgerMutationResultSchema, LedgerSnapshotSchema, LedgerUndoRequestSchema } from '../shared/ledger';
import type { RemoteMethod } from '../shared/remote';
import { AccountStateSchema } from '../shared/account';
import { CloudSaveSettingsRequestSchema, CloudCourseImportRequestSchema, LedgerExportDataRequestSchema, LedgerExportDataSchema, BackupExportDataSchema, CloudRestorePreviewRequestSchema, CloudRestorePreviewSchema, CloudRestoreConfirmRequestSchema, CloudRestoreConfirmSchema } from '../shared/cloud-management';

/** Deliberately independent of the wider Electron protocol. */
export const remoteInputs = {
  snapshot: z.undefined(), mutate: MutationRequestSchema, undo: IdSchema,
  command: CommandRequestSchema, importSource: ImportSourceRequestSchema, analyzeSource: AnalyzeSourceRequestSchema,
  ledgerSnapshot: z.strictObject({ month: LedgerMonthSchema.optional() }).optional(),
  ledgerMutate: LedgerMutationRequestSchema, ledgerUndo: LedgerUndoRequestSchema,
  saveSettings: CloudSaveSettingsRequestSchema, accountSnapshot: z.undefined(), refreshAccount: z.undefined(),
  importCourses: CloudCourseImportRequestSchema, ledgerExportData: LedgerExportDataRequestSchema, backupExportData: z.undefined(),
  restorePreview: CloudRestorePreviewRequestSchema, restoreConfirm: CloudRestoreConfirmRequestSchema,
} satisfies Record<RemoteMethod, z.ZodType>;
export const remoteOutputs = {
  snapshot: apiResultSchema(SnapshotSchema), mutate: apiResultSchema(MutationResultSchema), undo: apiResultSchema(MutationResultSchema),
  command: apiResultSchema(CommandResultSchema), importSource: apiResultSchema(SourceSchema), analyzeSource: apiResultSchema(AnalysisResultSchema),
  ledgerSnapshot: apiResultSchema(LedgerSnapshotSchema), ledgerMutate: apiResultSchema(LedgerMutationResultSchema), ledgerUndo: apiResultSchema(LedgerMutationResultSchema),
  saveSettings: apiResultSchema(SettingsSchema), accountSnapshot: apiResultSchema(AccountStateSchema), refreshAccount: apiResultSchema(AccountStateSchema),
  importCourses: apiResultSchema(CourseImportResultSchema), ledgerExportData: apiResultSchema(LedgerExportDataSchema), backupExportData: apiResultSchema(BackupExportDataSchema),
  restorePreview: apiResultSchema(CloudRestorePreviewSchema), restoreConfirm: apiResultSchema(CloudRestoreConfirmSchema),
} satisfies Record<RemoteMethod, z.ZodType>;
