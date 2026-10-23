import { describe, expect, it } from 'vitest';
import { CandidateSchema, SourceSchema } from '../shared/contracts';
import { evidenceDate, evidenceTimes, normalizeCandidate, recoverCandidateTiming } from './messages';

const at = '2026-10-21T10:00:00+08:00';
function source(text: string, sentAt: string | null = at) {
  return SourceSchema.parse({ id: 'source', version: 1, createdAt: at, updatedAt: at, importedAt: at, kind: 'text', text, sentAt });
}
function candidate(quote: string) {
  return CandidateSchema.parse({ id: 'candidate', version: 1, createdAt: at, updatedAt: at, title: '参加会议', sourceIds: ['source'], sourceQuote: quote,
    temporalEvidence: [{ field: 'eventStart', basis: 'relative', quote }] });
}
describe('Chinese temporal evidence', () => {
  it.each([
    ['明天下午四点', ['16:00']], ['周四晚上九点半', ['21:30']], ['今天下午三点五十', ['15:50']],
    ['2026年10月30日下午两点到四点', ['14:00', '16:00']], ['上午9:00', ['09:00']], ['下午4：05', ['16:05']],
    ['中午一点一刻', ['13:15']], ['上午十二点', ['12:00']], ['凌晨十二点', ['00:00']], ['晚上十二点', []], ['十三点六十分', []],
  ])('reads supported clock evidence: %s', (quote, times) => { expect(evidenceTimes(quote)).toEqual(times); });
  it('resolves a bare upcoming weekday from its sending week and rejects ambiguous previous weekdays', () => {
    expect(evidenceDate('周四晚上九点半', at)).toBe('2026-10-22');
    expect(evidenceDate('周一晚上九点半', at)).toBeNull();
    expect(evidenceDate('周四晚上九点半', null)).toBeNull();
    for (const quote of ['下下周五', '周五前', '明天或后天', '三天后和明天']) expect(evidenceDate(quote, at)).toBeNull();
  });
  it('grounds month/day in sending year without guessing an inconsistent weekday or a remote year', () => {
    expect(evidenceDate('10月24日（本周六）上午9:00', at)).toBe('2026-10-24');
    expect(evidenceDate('10月24日（本周日）上午9:00', at)).toBeNull();
    expect(evidenceDate('1月2日', '2026-12-31T18:00:00+08:00')).toBeNull();
  });
  it('does not erase a correctly extracted Chinese time', () => {
    const quote = '周四晚上九点半，活动室开个会哈'; const saved = candidate(quote);
    const result = normalizeCandidate({ title: saved.title, action: '', benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: [], uncertainties: [],
      sourceIds: saved.sourceIds, sourceQuote: quote, deadline: null, eventStart: '2026-10-22T21:30:00+08:00', eventEnd: null, location: '活动室',
      temporalEvidence: saved.temporalEvidence, relation: { kind: 'new', candidateId: null } }, source(quote), []);
    expect(result.values.eventStart).toBe('2026-10-22T21:30:00+08:00');
    expect(result.values.uncertainties).toEqual([]);
  });
  it('restores an omitted or rejected clock from the original sending date during normalization', () => {
    const quote = '周四晚上九点半，活动室开个会哈'; const saved = candidate(quote);
    for (const eventStart of [null, '2026-10-23T09:00:00+08:00']) {
      const result = normalizeCandidate({ title: saved.title, action: '', benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: [], uncertainties: [],
        sourceIds: saved.sourceIds, sourceQuote: quote, deadline: null, eventStart, eventEnd: null, location: '活动室',
        temporalEvidence: saved.temporalEvidence, relation: { kind: 'new', candidateId: null } }, source(quote), []);
      expect(result.values.eventStart).toBe('2026-10-22T21:30:00+08:00');
      expect(result.values.eventEnd).toBeNull();
    }
  });
  it.each([
    ['周四晚上九点半', 'unknown', at],
    ['周四晚上九点半', 'relative', null],
    ['周四或周五晚上九点半', 'relative', at],
    ['周四晚上七点或九点半', 'relative', at],
    ['周四九点半', 'relative', at],
  ] as const)('does not infer omitted timing from ambiguous evidence: %s', (quote, basis, sentAt) => {
    const saved = candidate(quote);
    const result = normalizeCandidate({ title: saved.title, action: '', benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: [], uncertainties: [],
      sourceIds: saved.sourceIds, sourceQuote: quote, deadline: null, eventStart: null, eventEnd: null, location: '',
      temporalEvidence: [{ field: 'eventStart', basis, quote }], relation: { kind: 'new', candidateId: null } }, source(quote, sentAt), []);
    expect(result.values.eventStart).toBeNull();
    expect(result.values.eventEnd).toBeNull();
  });
  it('repairs only absent timing with unique source evidence and leaves existing user values alone', () => {
    const quote = '周四晚上九点半，活动室开个会哈'; const saved = candidate(quote);
    expect(recoverCandidateTiming(saved, [source(quote)])).toEqual({ eventStart: '2026-10-22T21:30:00+08:00' });
    expect(recoverCandidateTiming({ ...saved, eventStart: '2026-10-23T20:00:00+08:00' }, [source(quote)])).toEqual({});
    expect(recoverCandidateTiming(saved, [source(' unrelated ')] )).toEqual({});
    expect(recoverCandidateTiming(saved, [source(quote, null)])).toEqual({});
    const ambiguous = candidate('明天下午两点或四点');
    expect(recoverCandidateTiming(ambiguous, [source(ambiguous.sourceQuote)])).toEqual({});
    const noPeriod = candidate('这周六，五点');
    expect(recoverCandidateTiming(noPeriod, [source(noPeriod.sourceQuote)])).toEqual({});
  });
  it('recovers the end of a bounded registration range only for its deadline', () => {
    const quote = '宣传报名：10月20日—10月21日';
    const saved = { ...candidate(quote), temporalEvidence: [
      { field: 'deadline' as const, basis: 'explicit' as const, quote },
      { field: 'eventStart' as const, basis: 'explicit' as const, quote },
    ] };
    expect(recoverCandidateTiming(saved, [source(quote)])).toEqual({ deadline: { date: '2026-10-21', time: null } });
    const unknown = { ...saved, temporalEvidence: [{ field: 'deadline' as const, basis: 'explicit' as const, quote: '预计10月20日—10月21日' }] };
    expect(recoverCandidateTiming(unknown, [source(unknown.temporalEvidence[0]!.quote)])).toEqual({});
  });
  it('keeps the right endpoint when a range mixes a complete date and a month/day', () => {
    const quote = '报名：2026年10月20日—10月21日';
    const saved = { ...candidate(quote), temporalEvidence: [{ field: 'deadline' as const, basis: 'explicit' as const, quote }] };
    expect(evidenceDate(quote, at)).toBeNull();
    expect(recoverCandidateTiming(saved, [source(quote)])).toEqual({ deadline: { date: '2026-10-21', time: null } });
    const extracted = { title: saved.title, action: '', benefit: '', benefitKind: 'unknown' as const, potentialBenefit: '', conditions: [], uncertainties: [],
      sourceIds: saved.sourceIds, sourceQuote: quote, deadline: { date: '2026-10-21', time: null }, eventStart: null, eventEnd: null, location: '',
      temporalEvidence: saved.temporalEvidence, relation: { kind: 'new' as const, candidateId: null } };
    expect(normalizeCandidate(extracted, source(quote), []).values.deadline).toEqual(extracted.deadline);
    expect(normalizeCandidate({ ...extracted, deadline: { date: '2026-10-20', time: null } }, source(quote), []).values.deadline).toEqual({ date: '2026-10-21', time: null });
  });
});
