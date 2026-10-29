import { describe, expect, it } from 'vitest';
import type { ExtractedCandidate } from '../ai/schemas';
import { CandidateSchema } from '../shared/contracts';
import { assertArrivalFollowup, type ArrivalFollowupInput } from './arrival-followup';

const priorText = '11月12日19:00在示例活动室举行读书交流会。';
const followup = '明天有实验课的同学可以稍微晚一点来，但是必须七点二十分之前到。';
function fixture(text = followup): ArrivalFollowupInput {
  const target = CandidateSchema.parse({ id: 'reading-event', version: 1, createdAt: '2032-11-11T10:00:00+08:00', updatedAt: '2032-11-11T10:00:00+08:00',
    title: '参加读书交流会', action: '参加交流讨论', eventStart: '2032-11-12T19:00:00+08:00', eventEnd: null, location: '示例活动室', sourceIds: ['prior-source'] });
  const candidate: ExtractedCandidate = { title: '参加实验课', action: '七点二十分前到达实验课', benefit: '', benefitKind: 'unknown', potentialBenefit: '',
    conditions: [], uncertainties: [], sourceIds: ['current-unit'], sourceQuote: text, deadline: null, eventStart: null, eventEnd: null, location: '', temporalEvidence: [],
    relation: { kind: 'new', candidateId: null } };
  return { candidate, unit: { id: 'current-unit', messageId: 'current-message', text, attachmentId: null, imageDataUrl: null },
    context: [{ id: 'prior-message', text: priorText }, { id: 'current-message', text }], existingCandidates: [target] };
}
function linked(input = fixture()): ArrivalFollowupInput {
  input.candidate.relation = { kind: 'supplement', candidateId: 'reading-event' };
  input.candidate.action = '有实验课的同学可以稍晚到场，但须七点二十分之前到。';
  return input;
}

describe('dependent arrival supplement validation', () => {
  it('rejects a course invented from the reason for arriving late even when the prior notice is available', () => {
    const input = fixture(), before = structuredClone(input);
    expect(() => assertArrivalFollowup(input)).toThrow(/到场补充需要关联/);
    expect(input).toEqual(before);
  });
  it('never treats the current message as prior context or selects the nearest event', () => {
    const input = fixture(); input.context = [input.context[1]!];
    expect(() => assertArrivalFollowup(input)).toThrow(/缺少可验证/);
    expect(input.candidate.relation).toEqual({ kind: 'new', candidateId: null });
  });
  it.each(['missing', 'unknown-id'])('requires a real relation target when %s', mode => {
    const input = linked();
    if (mode === 'missing') input.existingCandidates = [];
    else input.candidate.relation.candidateId = 'not-provided';
    expect(() => assertArrivalFollowup(input)).toThrow(/关联已确认身份/);
  });
  it.each(['pending', 'accepted', 'ignored'] as const)('allows a grounded supplement without changing the %s target', status => {
    const input = linked(); input.existingCandidates = input.existingCandidates.map(item => ({ ...item, status }));
    const before = structuredClone(input); expect(() => assertArrivalFollowup(input)).not.toThrow(); expect(input).toEqual(before);
  });
  it('allows duplicate relations that the existing reconciliation converts into supplements', () => {
    const input = linked(); input.candidate.relation.kind = 'duplicate'; expect(() => assertArrivalFollowup(input)).not.toThrow();
  });
  it.each(['eventStart', 'eventEnd', 'deadline', 'revision'] as const)('rejects a local exception represented as a global %s', field => {
    const input = linked();
    if (field === 'revision') input.candidate.relation.kind = 'revision';
    else if (field === 'deadline') input.candidate.deadline = { date: '2032-11-12', time: '19:20' };
    else input.candidate[field] = '2032-11-12T19:20:00+08:00';
    expect(() => assertArrivalFollowup(input)).toThrow(/到场补充/);
  });
  it('does not allow a null field to be restored into a global time through temporal evidence', () => {
    const input = linked();
    input.candidate.temporalEvidence = [{ field: 'deadline', basis: 'relative', quote: '明天晚上七点二十分之前到' }];
    expect(() => assertArrivalFollowup(input)).toThrow(/活动起止或全员截止/);
    input.candidate.temporalEvidence[0]!.basis = 'unknown';
    expect(() => assertArrivalFollowup(input)).not.toThrow();
  });
  it.each(['有实验课的同学可以稍晚到实验课，但须七点二十分前到', '有实验课的同学可以稍晚来参加实验课，但须七点二十分前到', '有实验课的同学可以稍晚到实验课的教室，但须七点二十分前到', '有实验课的同学请去上实验课'])('rejects an explicit reason-as-destination even with a valid event ID: %s', action => {
    const input = linked(); input.candidate.action = action;
    expect(() => assertArrivalFollowup(input)).toThrow(/晚到原因不能被改写/);
  });
  it('does not mistake a previously saved course exception in the target action for its event identity', () => {
    const input = linked(); input.existingCandidates = input.existingCandidates.map(target => ({ ...target, action: '有实验课的同学可以稍晚来参加读书交流会' }));
    input.candidate.action = '有实验课的同学可以稍晚到实验课，但须七点二十分前到';
    expect(() => assertArrivalFollowup(input)).toThrow(/晚到原因不能被改写/);
  });
  it.each(['上完实验课后可以晚一点来参加读书交流会，但须七点二十分前到', '参加实验课的同学可以稍晚到场，但须七点二十分前到', '参加实验课后可以稍晚到场，但须七点二十分前到'])('allows the reason in a scoped clause: %s', action => {
    const input = linked(); input.candidate.action = action;
    expect(() => assertArrivalFollowup(input)).not.toThrow();
  });
  it('does not reject an arrival destination that is the verified event itself', () => {
    const input = linked(); input.existingCandidates = input.existingCandidates.map(target => ({ ...target, title: '参加实验课', action: '参加实验操作' }));
    input.candidate.action = '有实验课的同学可以稍晚到实验课，但须七点二十分前到';
    expect(() => assertArrivalFollowup(input)).not.toThrow();
  });
  it('does not mistake a timed cause clause for a complete new event announcement', () => {
    const input = fixture('有实验课的同学明天18:00开始上课，可以稍晚来，但必须七点二十分前到。');
    expect(() => assertArrivalFollowup(input)).toThrow(/到场补充/);
  });
  it.each(['所有人七点二十分到场', '所有人可以稍晚到场，但须七点二十分前到', '有实验课的同学须七点二十分前到场'])('preserves both the applicable group and permission in %s', action => {
    const input = linked(); input.candidate.action = action;
    expect(() => assertArrivalFollowup(input)).toThrow(/保留适用对象/);
  });
  it('retains a specifically stated partial audience', () => {
    const input = linked(fixture('部分同学可以晚一点来，但必须七点之前到。'));
    input.candidate.action = '大家可以晚一点来，但必须七点之前到。';
    expect(() => assertArrivalFollowup(input)).toThrow(/保留适用对象/);
    input.candidate.action = '部分同学可以晚一点来，但必须七点之前到。';
    expect(() => assertArrivalFollowup(input)).not.toThrow();
  });
  it('requires a target for an explicit arrival addendum without late permission', () => {
    const input = fixture('补充：最晚七点二十分到场。');
    expect(() => assertArrivalFollowup(input)).toThrow(/到场补充/);
    input.candidate.relation = { kind: 'supplement', candidateId: 'reading-event' };
    expect(() => assertArrivalFollowup(input)).not.toThrow();
  });
  it.each([
    '通知：明天19:00在示例活动室举行读书交流会，有实验课的同学可以稍晚到场，但须19:20前到。',
    '明天19:00在示例活动室开读书会，可以晚一点来。',
    '摄影课程明天19:00在示例教室上课，可以稍晚到场。',
    '读书交流会时间：明天19:00，地点：示例活动室，可以晚一点来。',
    '报告会时间统一改到明天19:30，有实验课的同学可以稍晚到场。',
    '所有人的到场时间统一改为19:30，可以晚一点来。',
    '请大家明天19:00到示例活动室参加读书交流会。',
    '请明天19:20前完成实验课报告。',
  ])('allows a complete independent announcement or explicit global reschedule: %s', text => {
    expect(() => assertArrivalFollowup(fixture(text))).not.toThrow();
  });
  it('allows a complete new weekly meeting announcement with a late-arrival permission', () => {
    const text = '明天17:45在示例教室开展周见面，可以稍微晚一点来，但是必须六点之前到。';
    const input = fixture(text);
    input.context = []; input.existingCandidates = [];
    input.candidate.title = '参加周见面'; input.candidate.action = text;
    input.candidate.eventStart = '2032-11-12T17:45:00+08:00';
    expect(() => assertArrivalFollowup(input)).not.toThrow();
  });
  it('allows an explicit whole weekly meeting reschedule even when it includes a late-arrival exception', () => {
    const text = '周见面会时间统一改到明天19:30，有实验课的同学可以稍晚到场。';
    const input = linked(fixture(text));
    input.existingCandidates = input.existingCandidates.map(target => ({ ...target, title: '参加周见面会' }));
    input.candidate.relation.kind = 'revision';
    input.candidate.eventStart = '2032-11-12T19:30:00+08:00';
    input.candidate.action = text;
    expect(() => assertArrivalFollowup(input)).not.toThrow();
  });
  it.each(['attachment', 'image', 'long', 'invalid-source', 'invalid-quote'] as const)('leaves %s evidence to existing validators', kind => {
    const input = fixture();
    if (kind === 'attachment') input.unit.attachmentId = 'file';
    if (kind === 'image') input.unit.imageDataUrl = 'data:image/png;base64,synthetic';
    if (kind === 'long') input.unit.text = followup + '示例资料'.repeat(1100);
    if (kind === 'invalid-source') input.candidate.sourceIds = ['elsewhere'];
    if (kind === 'invalid-quote') input.candidate.sourceQuote = 'not in source';
    expect(() => assertArrivalFollowup(input)).not.toThrow();
  });
});
