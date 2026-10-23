import { CandidateInputSchema, type Candidate, type CandidateInput, type Source } from '../shared/contracts';
import type { ExtractedCandidate } from '../ai/schemas';
import { WorkflowError } from '../ai/deepseek';
import { evidenceTimes, fieldEvidenceDate, recoverCandidateTiming } from '../domain/temporal-evidence';
export { evidenceDate, evidenceTimes, recoverCandidateTiming } from '../domain/temporal-evidence';

function quotedTime(quote: string, time: string): boolean { return evidenceTimes(quote).includes(time); }

export const candidateFingerprint = (c: CandidateInput) => JSON.stringify([c.title, c.action, c.benefit, c.benefitKind, c.potentialBenefit, c.conditions, c.deadline, c.eventStart, c.eventEnd, c.location]);
export function normalizeCandidate(extracted: ExtractedCandidate, source: Source, existing: Candidate[]): { values: CandidateInput; duplicate: Candidate | null } {
  if (extracted.sourceIds.some(id => id !== source.id) || new Set(extracted.sourceIds).size !== 1) throw new WorkflowError('AI_RESPONSE', 'AI 引用了本次来源之外的 ID，请人工校对');
  if (source.kind === 'text' && !source.text.includes(extracted.sourceQuote)) throw new WorkflowError('AI_RESPONSE', 'AI 引用与原文不符，请人工校对');
  const { relation, ...input } = extracted; const values: CandidateInput = { ...input, uncertainties: [...input.uncertainties], sourceIds: [source.id] };
  for (const field of ['deadline', 'eventStart', 'eventEnd'] as const) {
    const value = values[field]; if (!value) continue;
    const date = typeof value === 'string' ? value.slice(0, 10) : value.date;
    const evidence = extracted.temporalEvidence.find(e => e.field === field);
    const quoted = !!evidence && (source.kind === 'image' || source.text.includes(evidence.quote));
    const grounded = evidence ? fieldEvidenceDate(evidence.quote, source.sentAt, field) : null;
    const explicit = quoted && evidence.basis === 'explicit' && grounded === date;
    const expectedRelative = grounded;
    const relative = quoted && evidence.basis === 'relative' && source.sentAt !== null && expectedRelative !== null && expectedRelative === date;
    if (!explicit && !relative) {
      values[field] = null; values.uncertainties!.push(source.sentAt === null ? '原消息发送时间未知，时间需校对；不能按导入时间推算' : '时间缺少可核对的原文依据，请校对');
    } else {
      const time = typeof value === 'string' ? value.slice(11, 16) : value.time;
      if (time && !quotedTime(evidence!.quote, time)) {
        if (field === 'deadline' && typeof value !== 'string') values.deadline = { date, time: null };
        else values[field] = null;
        values.uncertainties!.push('原文未提供可核对的具体钟点，已保留日期依据，请校对时间');
      }
    }
  }
  Object.assign(values, recoverCandidateTiming(values, [source]));
  if (!values.eventStart) values.eventEnd = null;
  if (values.benefitKind === 'inferred') { values.potentialBenefit = [values.potentialBenefit, values.benefit].filter(Boolean).join('；'); values.benefit = ''; }
  if (values.benefitKind === 'unknown') values.benefit = '';
  const target = relation.candidateId ? existing.find(c => c.id === relation.candidateId) : null;
  if (relation.candidateId && !target) throw new WorkflowError('AI_RESPONSE', 'AI 引用了未知候选 ID，请人工校对');
  const exact = existing.find(c => candidateFingerprint(c) === candidateFingerprint(CandidateInputSchema.parse(values)));
  if (exact) return { values: CandidateInputSchema.parse(values), duplicate: exact };
  if (relation.kind === 'duplicate' || relation.kind === 'uncertain') values.uncertainties!.push('与已有通知的关系不确定，请核对差异');
  if (relation.kind === 'revision' && target) { values.revisionOfId = target.id; values.uncertainties!.push('此通知修改已有事项，请核对修改前后再接受'); }
  return { values: CandidateInputSchema.parse(values), duplicate: null };
}
