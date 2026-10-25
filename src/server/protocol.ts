import { z } from 'zod';
import { SnapshotSchema, MutationRequestSchema, MutationResultSchema, IdSchema, ImportSourceRequestSchema, SourceSchema, AnalyzeSourceRequestSchema, AnalysisResultSchema, CommandRequestSchema, CommandResultSchema, apiResultSchema } from '../shared/contracts';
import { LedgerMonthSchema, LedgerMutationRequestSchema, LedgerMutationResultSchema, LedgerSnapshotSchema, LedgerUndoRequestSchema } from '../shared/ledger';
import type { RemoteMethod } from '../shared/remote';

/** Deliberately independent of the wider Electron protocol. */
export const remoteInputs = {
  snapshot: z.undefined(), mutate: MutationRequestSchema, undo: IdSchema,
  command: CommandRequestSchema, importSource: ImportSourceRequestSchema, analyzeSource: AnalyzeSourceRequestSchema,
  ledgerSnapshot: z.strictObject({ month: LedgerMonthSchema.optional() }).optional(),
  ledgerMutate: LedgerMutationRequestSchema, ledgerUndo: LedgerUndoRequestSchema,
} satisfies Record<RemoteMethod, z.ZodType>;
export const remoteOutputs = {
  snapshot: apiResultSchema(SnapshotSchema), mutate: apiResultSchema(MutationResultSchema), undo: apiResultSchema(MutationResultSchema),
  command: apiResultSchema(CommandResultSchema), importSource: apiResultSchema(SourceSchema), analyzeSource: apiResultSchema(AnalysisResultSchema),
  ledgerSnapshot: apiResultSchema(LedgerSnapshotSchema), ledgerMutate: apiResultSchema(LedgerMutationResultSchema), ledgerUndo: apiResultSchema(LedgerMutationResultSchema),
} satisfies Record<RemoteMethod, z.ZodType>;
