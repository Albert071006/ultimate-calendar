import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ExtractedCandidateSchema, type ExtractedCandidate } from '../ai/schemas';
import { WorkflowError } from '../ai/deepseek';
import { CandidateSchema, IdSchema, type Candidate, type CandidateInput, type Source } from '../shared/contracts';
import { candidateFingerprint, normalizeCandidate, supplementCandidate } from '../imports/messages';

// Optional without defaults: parsing an old paid checkpoint must not change its receipt hash.
export const CaptureCandidateSchema = ExtractedCandidateSchema.extend({
  supportingSources: z.array(z.strictObject({ sourceId: IdSchema, quote: z.string().min(1).max(2000) })).max(99).optional(),
  eventKey: z.string().trim().min(1).max(80).optional(),
});
export const CaptureExtractionSchema = z.strictObject({ candidates: z.array(CaptureCandidateSchema).max(100) });
export type CaptureExtraction = z.infer<typeof CaptureExtractionSchema>;
export type CompletedCapture = { key: string; value: CaptureExtraction };
export type CaptureEntry = { id: string; candidate: ExtractedCandidate; supportingSources: { sourceId: string; quote: string }[]; groupKey: string };

/** Stable aliases derive only from the saved request/result, never a fresh UUID or current planner state. */
export function captureEntries(completed: CompletedCapture[], operationId: string): CaptureEntry[] {
  return completed.flatMap(group => {
    const eventIds = new Map<string, { id: string; targetId: string | null }>();
    return group.value.candidates.map((item, index) => {
      const id = `qq-stage:${createHash('sha256').update(JSON.stringify([operationId, group.key, index])).digest('hex')}`;
      const { eventKey, supportingSources = [], ...candidate } = item;
      const prior = eventKey ? eventIds.get(eventKey) : undefined;
      if (prior) {
        if (candidate.relation.candidateId && candidate.relation.candidateId !== prior.id && candidate.relation.candidateId !== prior.targetId) throw new WorkflowError('AI_RESPONSE', '同一事项的批内标识与关联候选不一致，请人工校对');
        candidate.relation = { kind: candidate.relation.kind === 'revision' ? 'revision' : 'supplement', candidateId: prior.id };
      } else if (eventKey) eventIds.set(eventKey, { id, targetId: candidate.relation.candidateId });
      return { id, candidate, supportingSources, groupKey: group.key };
    });
  });
}

export function supportingEvidence(entry: CaptureEntry, available: ReadonlyMap<string, Source>): string[] {
  const ids = [...entry.candidate.sourceIds];
  if (ids.length !== 1 || !available.has(ids[0]!)) throw new WorkflowError('AI_RESPONSE', 'AI 引用了当前分片之外的来源，请手动重试或校对');
  for (const reference of entry.supportingSources) {
    const source = available.get(reference.sourceId);
    if (!source || ids.includes(reference.sourceId)) throw new WorkflowError('AI_RESPONSE', '补充来源不在当前分片内或重复引用，请人工校对');
    if (source.kind === 'text' && !source.text.includes(reference.quote)) throw new WorkflowError('AI_RESPONSE', '补充来源引用与原文不符，请人工校对');
    ids.push(source.id);
  }
  return ids;
}

export type CaptureDecision = { kind: 'ignore'; id: string } | { kind: 'update'; id: string; values: Partial<CandidateInput> } | { kind: 'create'; values: CandidateInput };

/** Both staged context and the final transaction use these exact same additive decisions. */
export function reconcileCaptureCandidate(item: ExtractedCandidate, source: Source, sourceIds: string[], existing: Candidate[], warnings: string[]): CaptureDecision {
  // An explicit same-event relation can use different wording. Apply the same guarded, additive
  // merge as a supplement instead of creating a fresh root from that paraphrase.
  if (item.relation.kind === 'duplicate' && item.relation.candidateId) item = { ...item, relation: { ...item.relation, kind: 'supplement' } };
  const normalized = normalizeCandidate(item, source, existing);
  const target = item.relation.candidateId ? existing.find(candidate => candidate.id === item.relation.candidateId) : null;
  if (item.relation.kind === 'supplement' && target?.status === 'ignored') return { kind: 'ignore', id: target.id };
  const uncertainties = [...new Set([...(normalized.values.uncertainties ?? []), ...warnings])].slice(0, 100);
  const values = { ...normalized.values, sourceIds, uncertainties };
  if ((item.relation.kind === 'supplement' || item.relation.kind === 'revision') && target && normalized.duplicate?.id !== target.id) {
    const merged = supplementCandidate(target, values);
    if (item.relation.kind === 'supplement' && target.status === 'pending' && !merged.conflicts) {
      return { kind: 'update', id: target.id, values: { ...merged.values, sourceQuote: target.sourceQuote,
        status: target.status, taskId: target.taskId, snoozedUntil: target.snoozedUntil,
        duplicateOfId: target.duplicateOfId, revisionOfId: target.revisionOfId } };
    }
    return { kind: 'create', values: { ...merged.values, title: item.relation.kind === 'revision' ? values.title : target.title,
      revisionOfId: target.id, duplicateOfId: null, status: 'pending', taskId: null,
      uncertainties: [...new Set([...merged.values.uncertainties!, ...(merged.conflicts ? ['补充内容与原事项的时间或地点不同，请作为变更核对'] : [])])] } };
  }
  const duplicate = normalized.duplicate ?? existing.find(c => candidateFingerprint(c) === candidateFingerprint(values));
  if (duplicate) {
    const joined = { sourceIds: [...new Set([...duplicate.sourceIds, ...sourceIds])], uncertainties: [...new Set([...duplicate.uncertainties, ...uncertainties])],
      temporalEvidence: [...new Map([...duplicate.temporalEvidence, ...(values.temporalEvidence ?? [])].map(e => [JSON.stringify(e), e])).values()] };
    if (CandidateSchema.safeParse({ ...duplicate, ...joined }).success) return { kind: 'update', id: duplicate.id, values: joined };
    return { kind: 'create', values: { ...values, duplicateOfId: duplicate.id } };
  }
  return { kind: 'create', values };
}
