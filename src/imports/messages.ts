import { CandidateInputSchema, type Candidate, type CandidateInput, type Source } from '../shared/contracts';
import type { ExtractedCandidate } from '../ai/schemas';
import { WorkflowError } from '../ai/deepseek';
import { evidenceTimes, fieldEvidenceDate, recoverCandidateTiming } from '../domain/temporal-evidence';
export { evidenceDate, evidenceTimes, recoverCandidateTiming } from '../domain/temporal-evidence';

function quotedTime(quote: string, time: string): boolean { return evidenceTimes(quote).includes(time); }

export const candidateFingerprint = (c: CandidateInput) => JSON.stringify([c.title, c.action, c.benefit, c.benefitKind, c.potentialBenefit, c.conditions, c.deadline, c.eventStart, c.eventEnd, c.location]);
const joinedText = (original: string, incoming: string) => !incoming.trim() || original.includes(incoming) ? original : !original.trim() ? incoming : `${original}\n补充：${incoming}`;
/** A follow-up is additive. Only explicitly supplied values may replace an existing field for review. */
export function supplementCandidate(target: Candidate, incoming: CandidateInput) {
  const different = (a: unknown, b: unknown) => a != null && b != null && JSON.stringify(a) !== JSON.stringify(b);
  const deadline = incoming.deadline && target.deadline?.date === incoming.deadline.date
    ? { ...incoming.deadline, time: incoming.deadline.time ?? target.deadline.time } : incoming.deadline ?? target.deadline;
  const deadlineConflict = !!(target.deadline && incoming.deadline && (target.deadline.date !== incoming.deadline.date
    || target.deadline.time && incoming.deadline.time && target.deadline.time !== incoming.deadline.time));
  const conflicts = deadlineConflict || different(target.eventStart, incoming.eventStart)
    || different(target.eventEnd, incoming.eventEnd) || !!(target.location && incoming.location && target.location !== incoming.location);
  const eventStart = incoming.eventStart ?? target.eventStart;
  const end = incoming.eventEnd ?? target.eventEnd;
  const eventEnd = end && eventStart && Date.parse(end) > Date.parse(eventStart) ? end : null;
  const uncertainties = [...new Set([...target.uncertainties, ...(incoming.uncertainties ?? []),
    ...(end && !eventEnd ? ['原结束时间与补充后的开始时间不相容，请核对结束时间'] : [])])];
  const values = CandidateInputSchema.parse({ ...incoming, title: target.title,
    action: joinedText(target.action, incoming.action ?? ''), benefit: joinedText(target.benefit, incoming.benefit ?? ''),
    benefitKind: target.benefitKind === 'stated' || incoming.benefitKind === 'stated' ? 'stated'
      : target.benefitKind === 'inferred' || incoming.benefitKind === 'inferred' ? 'inferred' : 'unknown',
    potentialBenefit: joinedText(target.potentialBenefit, incoming.potentialBenefit ?? ''),
    conditions: [...new Set([...target.conditions, ...(incoming.conditions ?? [])])], uncertainties,
    sourceIds: [...new Set([...target.sourceIds, ...incoming.sourceIds])],
    deadline, eventStart, eventEnd,
    location: incoming.location || target.location,
    temporalEvidence: [...new Map([...target.temporalEvidence, ...(incoming.temporalEvidence ?? [])].map(e => [JSON.stringify(e), e])).values()].slice(-10),
  });
  return { values, conflicts };
}
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
  if (relation.kind === 'supplement' && !target) throw new WorkflowError('AI_RESPONSE', '补充通知必须关联已有事项，请人工校对');
  const exact = existing.find(c => candidateFingerprint(c) === candidateFingerprint(CandidateInputSchema.parse(values)));
  if (exact) return { values: CandidateInputSchema.parse(values), duplicate: exact };
  if (relation.kind === 'duplicate' || relation.kind === 'uncertain') values.uncertainties!.push('与已有通知的关系不确定，请核对差异');
  if ((relation.kind === 'revision' || relation.kind === 'supplement') && target) { values.revisionOfId = target.id; values.uncertainties!.push(relation.kind === 'supplement' ? '此通知补充已有事项，请核对新增内容' : '此通知修改已有事项，请核对修改前后再接受'); }
  return { values: CandidateInputSchema.parse(values), duplicate: null };
}
