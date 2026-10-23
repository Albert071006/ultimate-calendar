import { z } from 'zod';
import { LedgerMonthSchema, LedgerMutationRequestSchema, LedgerMutationResultSchema, LedgerSnapshotSchema, LedgerUndoRequestSchema } from '../shared/ledger';
import { AccountStateSchema } from '../shared/account';
import { CaptureConfigSchema, CaptureSnapshotSchema, CaptureGroupSchema, CapturePageRequestSchema, CaptureMessagePageSchema, CaptureBatchPageSchema, CaptureCleanupRequestSchema } from '../shared/capture';
import { CaptureConnectSchema, CaptureActionSchema, CaptureChunksRequestSchema, CaptureChunksSchema } from '../shared/capture-api';
import { SnapshotSchema, MutationRequestSchema, MutationResultSchema, IdSchema, ImportSourceRequestSchema, SourceSchema, AnalyzeSourceRequestSchema, AnalysisResultSchema, CommandRequestSchema, CommandResultSchema, CourseImportRequestSchema, CourseImportResultSchema, SaveSettingsRequestSchema, SettingsSchema, SetApiKeyRequestSchema, KeyStatusSchema, BackupResultSchema, RestoreRequestSchema, RestoreResultSchema, SelectedImageSchema, apiResultSchema } from '../shared/contracts';
export const requests = {
  ledgerSnapshot: z.strictObject({ month: LedgerMonthSchema.optional() }).optional(), ledgerMutate: LedgerMutationRequestSchema, ledgerUndo: LedgerUndoRequestSchema,
  ledgerExport: z.strictObject({ format: z.enum(['csv', 'json']), month: LedgerMonthSchema.optional() }),
  captureSnapshot: z.undefined(), captureConfigure: CaptureConfigSchema, captureConnect: CaptureConnectSchema, captureGroups: z.undefined(), captureMessages: CapturePageRequestSchema, captureBatches: CapturePageRequestSchema, captureAction: CaptureActionSchema, captureChunks: CaptureChunksRequestSchema, captureCleanup: CaptureCleanupRequestSchema,
  accountSnapshot: z.undefined(), refreshAccount: z.undefined(),
  snapshot: z.undefined(), selectImage: z.undefined(), mutate: MutationRequestSchema, undo: IdSchema.optional(),
  importSource: ImportSourceRequestSchema, analyzeSource: AnalyzeSourceRequestSchema, command: CommandRequestSchema,
  importCourses: CourseImportRequestSchema, saveSettings: SaveSettingsRequestSchema, setApiKey: SetApiKeyRequestSchema, retryApiKey: z.undefined(),
  backup: z.undefined(), restore: RestoreRequestSchema,
} as const;
export const responses = {
  ledgerSnapshot: apiResultSchema(LedgerSnapshotSchema), ledgerMutate: apiResultSchema(LedgerMutationResultSchema), ledgerUndo: apiResultSchema(LedgerMutationResultSchema), ledgerExport: apiResultSchema(z.strictObject({ path: z.string() })),
  captureSnapshot: apiResultSchema(CaptureSnapshotSchema), captureConfigure: apiResultSchema(CaptureSnapshotSchema), captureConnect: apiResultSchema(CaptureSnapshotSchema), captureGroups: apiResultSchema(z.array(CaptureGroupSchema)), captureMessages: apiResultSchema(CaptureMessagePageSchema), captureBatches: apiResultSchema(CaptureBatchPageSchema), captureAction: apiResultSchema(CaptureSnapshotSchema), captureChunks: apiResultSchema(CaptureChunksSchema), captureCleanup: apiResultSchema(CaptureSnapshotSchema),
  accountSnapshot: apiResultSchema(AccountStateSchema), refreshAccount: apiResultSchema(AccountStateSchema),
  snapshot: apiResultSchema(SnapshotSchema), selectImage: apiResultSchema(SelectedImageSchema.nullable()),
  mutate: apiResultSchema(MutationResultSchema), undo: apiResultSchema(MutationResultSchema),
  importSource: apiResultSchema(SourceSchema), analyzeSource: apiResultSchema(AnalysisResultSchema),
  command: apiResultSchema(CommandResultSchema), importCourses: apiResultSchema(CourseImportResultSchema),
  saveSettings: apiResultSchema(SettingsSchema), setApiKey: apiResultSchema(KeyStatusSchema), retryApiKey: apiResultSchema(KeyStatusSchema), backup: apiResultSchema(BackupResultSchema), restore: apiResultSchema(RestoreResultSchema),
} as const;
export type Method = keyof typeof requests;
export const methods = Object.keys(requests) as Method[];
