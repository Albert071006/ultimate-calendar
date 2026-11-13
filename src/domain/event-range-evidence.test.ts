import { afterEach, describe, expect, it } from 'vitest';
import { CandidateSchema, SourceSchema } from '../shared/contracts';
import { normalizeCandidate, recoverCandidateTiming } from '../imports/messages';
import { candidateWithRecoveredTiming } from './temporal-evidence';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from './planner';
import { buildBusyContext } from '../plan-import/busy-context';
import { BusyExportRequestSchema } from '../shared/busy-context';

const sentAt = '2032-04-15T10:00:00+08:00';
const startQuote = '2032年4月17日下午 14:30';
const text = `合成交流会定在${startQuote} 到 16:00，示例报告厅。`;
const start = '2032-04-17T14:30:00+08:00', end = '2032-04-17T16:00:00+08:00';
const metadata = { version: 1, createdAt: sentAt, updatedAt: sentAt };
function source(value = text) { return SourceSchema.parse({ ...metadata, id: 'source', kind: 'text', text: value, sentAt, importedAt: sentAt }); }
function candidate(quote = '到 16:00') { return CandidateSchema.parse({ ...metadata, id: 'notice', title: '参加合成交流会', sourceIds: ['source'], sourceQuote: text,
  eventStart: start, eventEnd: null, temporalEvidence: [{ field: 'eventStart', basis: 'explicit', quote: startQuote }, { field: 'eventEnd', basis: 'explicit', quote }] }); }
function extracted(overrides = {}) { return { title: '参加合成交流会', action: '', benefit: '', benefitKind: 'unknown' as const, potentialBenefit: '', conditions: [], uncertainties: [],
  sourceIds: ['source'], sourceQuote: text, deadline: null, eventStart: start, eventEnd: end, location: '', temporalEvidence: candidate().temporalEvidence,
  relation: { kind: 'new' as const, candidateId: null }, ...overrides }; }
const repos: Repository[] = [];
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });

describe('same-event time range evidence', () => {
  it('retains a model end whose quote shares the verified start date and does not add a false warning', () => {
    const result = normalizeCandidate(extracted(), source(), []).values;
    expect(result).toMatchObject({ eventStart: start, eventEnd: end, uncertainties: [] });
    expect(result.temporalEvidence?.find(e => e.field === 'eventEnd')?.quote).toContain(startQuote);
  });
  it('recovers an omitted start and end together from the original range', () => {
    const result = normalizeCandidate(extracted({ eventStart: null }), source(), []).values;
    expect(result).toMatchObject({ eventStart: start, eventEnd: end, uncertainties: [] });
  });
  it('projects legacy missing ends and removes only resolved system warnings without changing stored values', () => {
    const saved = { ...candidate(), uncertainties: ['时间缺少可核对的原文依据，请校对', '需自行确认是否参加'] };
    const recovered = candidateWithRecoveredTiming(saved, [source(`${text}\n${text}\n${startQuote}\n到 16:00`)]);
    expect(recovered).toMatchObject({ eventEnd: end, uncertainties: ['需自行确认是否参加'] });
    expect(saved.eventEnd).toBeNull();
    expect(recoverCandidateTiming({ ...saved, eventEnd: '2032-04-17T15:00:00+08:00' }, [source()])).toEqual({});
  });
  it.each(['至16:00', '—16:00', '到 下午4点', '到 4点'])('grounds a supported right endpoint: %s', ending => {
    const value = `${startQuote}${ending}开会`;
    const saved = candidate(ending);
    expect(recoverCandidateTiming(saved, [source(value)])).toEqual({ eventEnd: end });
  });
  it.each([
    `${startQuote}开始，到16:00另有讲座。`,
    `${startQuote}开会。另一个活动到16:00。`,
    `${startQuote}到次日16:00。`,
    `${startQuote}到2032年4月18日16:00。`,
    `${startQuote}到明天16:00。`,
    `${startQuote}或16:00开会。`,
    `${startQuote}到16:00或17:00。`,
    `${startQuote}到13:00，其他事项到16:00。`,
  ])('does not borrow a clock from an unrelated, ambiguous or cross-day range: %s', value => {
    expect(recoverCandidateTiming(candidate('16:00'), [source(value)])).toEqual({});
  });
  it('requires source-backed start timing and does not borrow dates across different sources', () => {
    expect(recoverCandidateTiming({ ...candidate(), eventStart: '2032-04-18T14:30:00+08:00' }, [source()])).toEqual({});
    expect(recoverCandidateTiming({ ...candidate(), temporalEvidence: candidate().temporalEvidence.map(e => ({ ...e, basis: 'unknown' as const })) }, [source()])).toEqual({});
    expect(recoverCandidateTiming(candidate(), [source(startQuote), { ...source('到 16:00'), id: 'other' }])).toEqual({});
    expect(recoverCandidateTiming(candidate(), [{ ...source(), text: '', kind: 'image' }])).toEqual({});
  });
  it.each(['（次日结束）', '，次日结束'])('does not hide a cross-day qualifier inside a whole-range start citation: %s', qualifier => {
    const value = `${startQuote}至16:00${qualifier}`;
    const saved = candidate('16:00');
    saved.temporalEvidence[0]!.quote = `${startQuote}至16:00${qualifier.startsWith('，') ? '' : qualifier}`;
    expect(recoverCandidateTiming(saved, [source(value)])).toEqual({});
  });
  it('preserves a separately dated explicit next-day end', () => {
    const endQuote = '2032年4月18日16:00';
    expect(recoverCandidateTiming(candidate(endQuote), [source(`${startQuote}到${endQuote}`)])).toEqual({ eventEnd: '2032-04-18T16:00:00+08:00' });
  });
  it('accepts the full duration into the calendar and preserves it through undo/idempotent retry', () => {
    const repo = createRepository(':memory:'); repos.push(repo);
    const savedSource = repo.writeInternal({ operationId: 'source', changes: [{ entity: 'source', values: source() }] }).entities[0]!;
    const savedCandidate = repo.writeInternal({ operationId: 'notice', changes: [{ entity: 'candidate', values: { ...candidate(), sourceIds: [savedSource.id] } }] }).entities[0]!;
    const planner = createPlanner(repo, { automaticBackup: () => {} });
    const request = { operationId: 'accept-range', origin: 'manual' as const, confirmed: false,
      mutations: [{ type: 'acceptCandidate' as const, id: savedCandidate.id, expectedVersion: 1 }] };
    const result = planner.mutate(request);
    expect(result.status).toBe('applied');
    expect(planner.snapshot().blocks).toMatchObject([{ start, end, kind: 'event' }]);
    const busy = buildBusyContext(planner.snapshot(), BusyExportRequestSchema.parse({ fromDate: '2032-04-17', toDate: '2032-04-17' }),
      { kind: 'local', dataInstanceId: '44444444-4444-4444-8444-444444444444' });
    expect(busy.busyIntervals).toMatchObject([{ start, end, category: 'event' }]);
    expect(planner.mutate(request)).toEqual(result);
    expect(planner.undo().status).toBe('applied');
    expect(planner.snapshot().candidates[0]).toMatchObject({ status: 'pending', eventStart: start, eventEnd: null });
  });
});
