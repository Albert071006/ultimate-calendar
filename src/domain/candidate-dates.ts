import type { CandidateInput, Source } from '../shared/contracts';
import { evidenceDate, fieldEvidenceDate } from './temporal-evidence';

type DateField = 'deadline' | 'eventStart' | 'eventEnd' | 'unclassified';
type DatedCandidate = Pick<CandidateInput, 'sourceIds' | 'sourceQuote' | 'temporalEvidence' | 'deadline' | 'eventStart' | 'eventEnd'>;

/** A known day remains event evidence even when "中午" provides no exact clock. */
export function candidateDates(candidate: DatedCandidate, sources: Source[]): Partial<Record<DateField, string[]>> {
  const dates = new Map<DateField, Set<string>>();
  const add = (field: DateField, date: string | null | undefined) => {
    if (date) { const values = dates.get(field) ?? new Set<string>(); values.add(date); dates.set(field, values); }
  };
  add('deadline', candidate.deadline?.date);
  add('eventStart', candidate.eventStart?.slice(0, 10));
  add('eventEnd', candidate.eventEnd?.slice(0, 10));
  const ownSources = sources.filter(source => candidate.sourceIds.includes(source.id));
  for (const evidence of candidate.temporalEvidence ?? []) {
    // "unknown" may describe an unknown clock, while the day itself is unambiguous.
    for (const source of ownSources) if (source.kind === 'image' || source.text.includes(evidence.quote)) {
      add(evidence.field, fieldEvidenceDate(evidence.quote, source.sentAt, evidence.field));
    }
  }
  if (!dates.size && candidate.sourceQuote) {
    for (const source of ownSources) if (source.kind === 'image' || source.text.includes(candidate.sourceQuote)) {
      add('unclassified', evidenceDate(candidate.sourceQuote, source.sentAt));
    }
  }
  return Object.fromEntries([...dates].map(([field, values]) => [field, [...values].sort()]));
}

/** Compare like temporal fields; never equate a submission deadline with an activity day. */
export function candidateDatesConflict(left: DatedCandidate, right: DatedCandidate, sources: Source[]): boolean {
  const a = candidateDates(left, sources), b = candidateDates(right, sources);
  for (const field of ['deadline', 'eventStart', 'eventEnd'] as const) {
    if (a[field]?.length && b[field]?.length && JSON.stringify(a[field]) !== JSON.stringify(b[field])) return true;
  }
  // A quote without a field is comparable only when each side has one distinct day.
  if (a.unclassified || b.unclassified) {
    const allA = [...new Set(Object.values(a).flat())], allB = [...new Set(Object.values(b).flat())];
    if (allA.length === 1 && allB.length === 1) return allA[0] !== allB[0];
  }
  return false;
}

export function hasExplicitReschedule(source: Source, candidate: Pick<DatedCandidate, 'sourceQuote' | 'temporalEvidence'>): boolean {
  const quotes = candidate.temporalEvidence?.length ? candidate.temporalEvidence.map(evidence => evidence.quote) : [candidate.sourceQuote ?? ''];
  // Only the sentence carrying this candidate's time evidence may establish a change.
  // An unrelated "提前准备" elsewhere in a long notice is not a reschedule.
  return source.text.split(/[。！？!?；;\n]/).some(sentence =>
    /改(?:到|为|期|成)|推迟|延(?:期|后)|提前(?:到|至|为)(?:明|后|今|本|这|下|[一二三四五六七八九十\d])|调整(?:到|为|至)|(?:时间|日期)(?:变更|更正|调整)|取消/.test(sentence)
    && quotes.some(quote => quote.trim() && (sentence.includes(quote) || quote.includes(sentence.trim()))));
}
