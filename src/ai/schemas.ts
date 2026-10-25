import { z } from 'zod';
import { CandidateInputSchema, IdSchema, TemporalEvidenceSchema } from '../shared/contracts';
// AI cannot set status, accepted task IDs, metadata, or authorize an operation.
export const ExtractedCandidateSchema = z.strictObject({
  title: z.string().trim().min(1).max(500), action: z.string().max(100_000), benefit: z.string().max(100_000), benefitKind: z.enum(['stated', 'inferred', 'unknown']), potentialBenefit: z.string().max(100_000), conditions: z.array(z.string().max(2000)).max(100), uncertainties: z.array(z.string().max(2000)).max(100), sourceIds: z.array(IdSchema).min(1).max(100), sourceQuote: z.string().min(1).max(2000),
  deadline: CandidateInputSchema.shape.deadline, eventStart: CandidateInputSchema.shape.eventStart, eventEnd: CandidateInputSchema.shape.eventEnd, location: z.string().max(2000), temporalEvidence: z.array(TemporalEvidenceSchema).max(10),
  relation: z.strictObject({ kind: z.enum(['new', 'duplicate', 'supplement', 'revision', 'uncertain']), candidateId: IdSchema.nullable() }),
});
export const ExtractionSchema = z.strictObject({ candidates: z.array(ExtractedCandidateSchema).max(100) });
export type ExtractedCandidate = z.infer<typeof ExtractedCandidateSchema>;
