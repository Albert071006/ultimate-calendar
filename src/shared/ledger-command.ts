import { z } from 'zod';
import { LedgerAccountIdSchema, LedgerBalanceSnapshotDraftSchema, LedgerDateSchema, LedgerEntryDraftSchema, LedgerMutationRequestSchema, LedgerQuerySchema, LedgerRulesSchema } from './ledger';

const entryValues = LedgerEntryDraftSchema.omit({ id: true, sourceId: true, sourceKey: true, ruleKey: true, originalText: true });
// Zod 4 applies an inner default even underneath .optional(). A patch must leave
// omitted fields absent; otherwise an account-only correction wipes linked refunds.
const entryPatch = entryValues.partial().extend({
  dateNote: entryValues.shape.dateNote.removeDefault().optional(),
  occurredAt: entryValues.shape.occurredAt.removeDefault().optional(),
  incomeCents: entryValues.shape.incomeCents.removeDefault().optional(),
  assetSaleCents: entryValues.shape.assetSaleCents.removeDefault().optional(),
  adjustments: entryValues.shape.adjustments.removeDefault().optional(),
  relatedEntryIds: entryValues.shape.relatedEntryIds.removeDefault().optional(),
  snapshotPositions: entryValues.shape.snapshotPositions.removeDefault().optional(),
  note: entryValues.shape.note.removeDefault().optional(),
});
export const LedgerAIChangeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('createEntry'), key: z.string().regex(/^new:\d+$/), values: entryValues, confirmDuplicate: z.boolean().default(false) }),
  z.strictObject({ type: z.literal('updateEntry'), id: z.string().min(1).max(200), expectedVersion: z.number().int().positive(), patch: entryPatch, note: z.string().max(2000) }),
  z.strictObject({ type: z.literal('voidEntry'), id: z.string().min(1).max(200), expectedVersion: z.number().int().positive(), note: z.string().max(2000) }),
  z.strictObject({ type: z.literal('setBalance'), accountId: LedgerAccountIdSchema.exclude(['family']), balanceCents: LedgerBalanceSnapshotDraftSchema.shape.balanceCents, date: LedgerDateSchema, asOf: LedgerBalanceSnapshotDraftSchema.shape.asOf, timing: z.enum(['current', 'historical']).default('historical'), note: z.string().max(2000) }),
  z.strictObject({ type: z.literal('updateRules'), patch: LedgerRulesSchema.partial().extend({ sameDayNewEntryOrder: LedgerRulesSchema.shape.sameDayNewEntryOrder.removeDefault().optional() }), note: z.string().max(2000) }),
]);

export const LedgerIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('query'), query: LedgerQuerySchema, detail: z.enum(['summary', 'entries', 'balances', 'receivables']).default('summary') }),
  z.strictObject({ kind: z.literal('mutate'), changes: z.array(LedgerAIChangeSchema).min(1).max(50) }),
  z.strictObject({ kind: z.literal('undo') }),
  z.strictObject({ kind: z.literal('clarification'), question: z.string().trim().min(1).max(2000) }),
]);
export type LedgerIntent = z.infer<typeof LedgerIntentSchema>;
export const LedgerCommandProposalSchema = z.strictObject({ intent: LedgerIntentSchema, revision: z.number().int().nonnegative(), mutationRequest: LedgerMutationRequestSchema.optional() });
