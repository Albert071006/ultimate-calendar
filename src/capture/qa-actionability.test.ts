import { describe, expect, it } from 'vitest';
import type { CaptureEntry } from './candidate-batch';
import type { ExtractedCandidate } from '../ai/schemas';
import { shouldSuppressPassiveQuestion, type QuestionEvidence } from './qa-actionability';

function fixture(texts: string[], main = 0) {
  const evidence: QuestionEvidence[] = texts.map((text, index) => ({ id: `source-${index}`, text, attachmentId: null,
    recipient: { audience: 'unspecified', sender: 'other' } }));
  const candidate: ExtractedCandidate = { title: '确认短片活动规则', action: '向组织方确认活动规则，了解是否符合条件。',
    benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: [], uncertainties: [],
    sourceIds: [evidence[main]!.id], sourceQuote: evidence[main]!.text,
    deadline: null, eventStart: null, eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'new', candidateId: null } };
  const entry: CaptureEntry = { id: 'entry', groupKey: 'group', candidate,
    supportingSources: evidence.filter((_, index) => index !== main).map(unit => ({ sourceId: unit.id, quote: unit.text })) };
  return { entry, evidence };
}

describe('passive group Q&A actionability fallback', () => {
  it.each([
    { texts: ['短片只有四分钟可以参赛吗', '可以', '好的谢谢'], main: 0 },
    { texts: ['提交视频符合要求就有积分吗还是通过初赛才可以', '对的', '参加初赛就有，但是需要成功参赛哈'], main: 2 },
    { texts: ['请问作品长度最多多少？', '时长最多五分钟'], main: 1 },
    { texts: ['作品合格就有加分吗？'], main: 0 },
  ])('suppresses an invented clarification without changing evidence ($main)', ({ texts, main }) => {
    const value = fixture(texts, main), before = structuredClone(value);
    expect(shouldSuppressPassiveQuestion(value.entry, value.evidence)).toBe(true);
    expect(value).toEqual(before);
  });

  it.each(['self', 'all', 'others', 'unknown'] as const)('preserves explicitly addressed or ambiguous audience %s', audience => {
    const { entry, evidence } = fixture(['可以参加吗？', '可以']); evidence[0]!.recipient!.audience = audience;
    expect(shouldSuppressPassiveQuestion(entry, evidence)).toBe(false);
  });

  it.each(['self', 'unknown', undefined] as const)('does not infer whose question it is when sender=%s', sender => {
    const { entry, evidence } = fixture(['可以参加吗？', '可以']);
    evidence[0]!.recipient = sender ? { audience: 'unspecified', sender } : undefined;
    expect(shouldSuppressPassiveQuestion(entry, evidence)).toBe(false);
  });

  it.each([
    ['能帮我确认一下报名结果吗？', '可以'],
    ['你可以确认一下材料齐全吗？', '可以'],
    ['有没有人愿意参加短片活动？', '可以'],
    ['请大家确认报名信息好吗？', '可以'],
    ['短片长度够吗？', '大家明晚八点前提交作品'],
    ['短片长度够吗？', '补交通知：需要重新提交文件'],
    ['短片长度够吗？', '时间改到下周五'],
    ['短片长度够吗？', '请确认作品有字幕'],
    ['短片长度够吗？', '四分钟。提交作品到邮箱'],
  ].map(texts => ({ texts })))('keeps requests, invitations and new obligations in $texts', ({ texts }) => {
    const { entry, evidence } = fixture(texts);
    expect(shouldSuppressPassiveQuestion(entry, evidence)).toBe(false);
  });

  it.each(['supplement', 'revision', 'duplicate'] as const)('preserves existing %s relations', kind => {
    const { entry, evidence } = fixture(['作品符合要求就有积分吗？', '对的']);
    entry.candidate.relation = { kind, candidateId: 'existing' };
    expect(shouldSuppressPassiveQuestion(entry, evidence)).toBe(false);
  });

  it('allows only unlinked uncertain clarification candidates to use the same narrow fallback', () => {
    const { entry, evidence } = fixture(['作品符合要求就有积分吗？', '对的']);
    entry.candidate.relation.kind = 'uncertain'; expect(shouldSuppressPassiveQuestion(entry, evidence)).toBe(true);
    entry.candidate.relation.candidateId = 'existing'; expect(shouldSuppressPassiveQuestion(entry, evidence)).toBe(false);
  });

  it('preserves an actual task, dates, attachments, images, and unrecognized standalone explanations', () => {
    for (const change of [
      (value: ReturnType<typeof fixture>) => { value.entry.candidate.title = '提交参赛作品'; value.entry.candidate.action = '准备并提交作品'; },
      (value: ReturnType<typeof fixture>) => { value.entry.candidate.deadline = { date: '2031-04-18', time: null }; },
      (value: ReturnType<typeof fixture>) => { value.entry.candidate.eventStart = '2031-04-18T12:00:00+08:00'; },
      (value: ReturnType<typeof fixture>) => { value.entry.candidate.location = '示例教室'; },
      (value: ReturnType<typeof fixture>) => { value.evidence[0]!.attachmentId = 'document'; },
      (value: ReturnType<typeof fixture>) => { value.evidence[0]!.imageDataUrl = 'data:image/png;base64,synthetic'; },
    ]) {
      const value = fixture(['作品符合要求就有积分吗？', '对的']); change(value);
      expect(shouldSuppressPassiveQuestion(value.entry, value.evidence)).toBe(false);
    }
    const value = fixture(['参加初赛就有积分']); expect(shouldSuppressPassiveQuestion(value.entry, value.evidence)).toBe(false);
  });

  it('does not hide malformed references or fabricated quotes from normal validation', () => {
    for (const change of [
      (value: ReturnType<typeof fixture>) => { value.entry.candidate.sourceQuote = '伪造的原文'; },
      (value: ReturnType<typeof fixture>) => { value.entry.supportingSources[0]!.quote = '伪造的补充'; },
      (value: ReturnType<typeof fixture>) => { value.entry.supportingSources[0]!.sourceId = 'missing'; },
      (value: ReturnType<typeof fixture>) => { value.entry.supportingSources.push({ ...value.entry.supportingSources[0]! }); },
    ]) {
      const value = fixture(['作品符合要求就有积分吗？', '对的']); change(value);
      expect(shouldSuppressPassiveQuestion(value.entry, value.evidence)).toBe(false);
    }
  });
});
