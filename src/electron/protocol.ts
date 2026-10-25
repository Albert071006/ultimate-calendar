import { z } from 'zod';
import { PlanImportConfirmSchema, PlanImportPreviewSchema, PlanImportResultSchema } from '../shared/plan-import';
import { PlanExportRequestSchema, PlanExportPreviewSchema, PlanExportSaveRequestSchema, PlanExportSaveResultSchema } from '../shared/plan-context';
import { ResourceReferenceSchema } from '../shared/resources';
import { ResourcePickRequestSchema, ResourceRegisterRequestSchema, ResourceOpenRequestSchema, ResourceStatusRequestSchema, ResourceStatusSchema } from '../shared/resource-host';
import { LocalSourceEvidenceRequestSchema, LocalSourceEvidenceSchema } from '../shared/contracts';
import { SpacePolicySchema, SpaceSnapshotSchema, SpaceCleanupRequestSchema } from '../shared/space';
import { LedgerMonthSchema, LedgerMutationRequestSchema, LedgerMutationResultSchema, LedgerSnapshotSchema, LedgerUndoRequestSchema } from '../shared/ledger';
import { AccountStateSchema } from '../shared/account';
import { UpdateStateSchema } from '../shared/update';
import { CaptureConfigSchema, CaptureSnapshotSchema, CaptureGroupSchema, CapturePageRequestSchema, CaptureMessagePageSchema, CaptureBatchPageSchema, CaptureCleanupRequestSchema } from '../shared/capture';
import { CaptureConnectSchema, CaptureActionSchema, CaptureChunksRequestSchema, CaptureChunksSchema } from '../shared/capture-api';
import { SnapshotSchema, MutationRequestSchema, MutationResultSchema, IdSchema, ImportSourceRequestSchema, SourceSchema, AnalyzeSourceRequestSchema, AnalysisResultSchema, CommandRequestSchema, CommandResultSchema, CourseImportRequestSchema, CourseImportResultSchema, SaveSettingsRequestSchema, SettingsSchema, SetApiKeyRequestSchema, KeyStatusSchema, BackupResultSchema, RestoreRequestSchema, RestoreResultSchema, SelectedImageSchema, apiResultSchema } from '../shared/contracts';
export const requests = {
  planExportPreview: PlanExportRequestSchema, planExportSave: PlanExportSaveRequestSchema,
  planImportOpen: z.undefined(), planImportConfirm: PlanImportConfirmSchema, planImportTemplate: z.undefined(),
  resourcePick: ResourcePickRequestSchema, resourceRegister: ResourceRegisterRequestSchema,
  resourceOpen: ResourceOpenRequestSchema, resourceRelocate: ResourceOpenRequestSchema, resourceStatus: ResourceStatusRequestSchema,
  localSourceEvidence: LocalSourceEvidenceRequestSchema,
  spaceSnapshot: z.undefined(), spaceConfigure: SpacePolicySchema, spaceCleanup: SpaceCleanupRequestSchema,
  updateSnapshot: z.undefined(), checkForUpdates: z.undefined(), downloadUpdate: z.undefined(), installUpdate: z.undefined(),
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
  planExportPreview: apiResultSchema(PlanExportPreviewSchema), planExportSave: apiResultSchema(PlanExportSaveResultSchema),
  planImportOpen: apiResultSchema(PlanImportPreviewSchema.nullable()), planImportConfirm: apiResultSchema(PlanImportResultSchema), planImportTemplate: apiResultSchema(z.strictObject({ saved: z.boolean() })),
  resourcePick: apiResultSchema(z.array(ResourceReferenceSchema)), resourceRegister: apiResultSchema(z.array(ResourceReferenceSchema)),
  resourceOpen: apiResultSchema(z.strictObject({ opened: z.literal(true) })), resourceRelocate: apiResultSchema(ResourceReferenceSchema.nullable()), resourceStatus: apiResultSchema(z.array(ResourceStatusSchema)),
  localSourceEvidence: apiResultSchema(LocalSourceEvidenceSchema),
  spaceSnapshot: apiResultSchema(SpaceSnapshotSchema), spaceConfigure: apiResultSchema(SpaceSnapshotSchema), spaceCleanup: apiResultSchema(SpaceSnapshotSchema),
  updateSnapshot: apiResultSchema(UpdateStateSchema), checkForUpdates: apiResultSchema(UpdateStateSchema), downloadUpdate: apiResultSchema(UpdateStateSchema), installUpdate: apiResultSchema(UpdateStateSchema),
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
