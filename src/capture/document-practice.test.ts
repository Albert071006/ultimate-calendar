import { describe, expect, it } from 'vitest';
import { classifyPracticeEntry, practiceGrouping, type PracticeUnit } from './document-practice';
import { captureEntries, type CaptureEntry } from './candidate-batch';
import type { ExtractedCandidate } from '../ai/schemas';

const unit = (id: string, text: string, extra: Partial<PracticeUnit> = {}): PracticeUnit => ({ id, text,
  messageId: 'message', accountId: 'account', groupId: 'group', attachmentId: 'document', locator: '合成课程.doc · 段落', ...extra });
const units = [unit('heading', '第六章 线性表\n教材配套课堂练习'),
  unit('first', '练习1：在给定程序中增加求平均值的功能。'),
  unit('second', '思考：编写测试代码验证未赋值元素。'),
  unit('third', '练习：课件中的排序法；教材例6.1和例6.2。')];
const candidate = (sourceId: string, extra: Partial<ExtractedCandidate> = {}): ExtractedCandidate => ({
  title: `完成${sourceId}题`, action: `${sourceId}的独立措辞`, benefit: '', benefitKind: 'unknown', potentialBenefit: '',
  conditions: [], uncertainties: [], sourceIds: [sourceId], sourceQuote: units.find(value => value.id === sourceId)!.text,
  deadline: null, eventStart: null, eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'new', candidateId: null }, ...extra,
});
const entries = () => captureEntries(['first', 'second', 'third'].map((id, index) => ({ key: `request-${index}`,
  value: { candidates: [{ ...candidate(id), eventKey: `different-event-${index}` }] } })), 'operation');

describe('teaching document practice grouping', () => {
  it('groups three separately emitted new exercises and retains each original step and evidence', () => {
    const input = entries(), before = structuredClone(input), groups = practiceGrouping(input, units);
    expect(groups.size).toBe(3);
    expect(new Set([...groups.values()].map(value => value.rootEntryId))).toEqual(new Set([input[0]!.id]));
    expect([...groups.values()].map(value => value.step)).toEqual(['first的独立措辞', 'second的独立措辞', 'third的独立措辞']);
    expect(groups.get(input[0]!.id)).toMatchObject({ title: '完成线性表练习', summary: '完成线性表相关练习。' });
    expect(input).toEqual(before);
  });

  it('makes the first root summary stable before later response groups arrive', () => {
    const input = entries();
    expect(practiceGrouping(input.slice(0, 1), units).get(input[0]!.id)).toEqual(practiceGrouping(input, units).get(input[0]!.id));
    expect(practiceGrouping(input, units).get(input[2]!.id)?.rootEntryId).toBe(input[0]!.id);
  });

  it('never uses a file name or a lone exercise marker to identify a teaching assignment', () => {
    const input = entries();
    expect(practiceGrouping(input, units.map(value => ({ ...value, text: value.id === 'first' ? value.text : '会议资料' }))).size).toBe(0);
    expect(practiceGrouping(input, units.map(value => ({ ...value, locator: '课程习题.exe' }))).size).toBe(0);
    expect(practiceGrouping(input, units.map(value => ({ ...value, attachmentId: null }))).size).toBe(0);
    const renamed = units.map(value => ({ ...value, locator: '新名字.doc · 段落' }));
    expect(practiceGrouping(input, renamed)).toEqual(practiceGrouping(input, units));
  });

  it('keeps different deadlines, activity times, places, documents and message recipients apart', () => {
    const changes: Partial<ExtractedCandidate>[] = [
      { deadline: { date: '2030-04-22', time: null } }, { eventStart: '2030-04-22T10:00:00+08:00', eventEnd: '2030-04-22T11:00:00+08:00' }, { location: '另一个教室' },
    ];
    for (const change of changes) {
      const input = entries(); input[1]!.candidate = { ...input[1]!.candidate, ...change };
      expect(practiceGrouping(input, units).get(input[1]!.id)?.rootEntryId).toBe(input[1]!.id);
    }
    for (const change of [{ messageId: 'other-message' }, { groupId: 'other-group' }, { accountId: 'other-account' }, { attachmentId: 'other-document' }]) {
      const duplicate = units.map(value => ({ ...value, id: `other-${value.id}`, ...change }));
      const input = entries(), other: CaptureEntry = { ...input[0]!, id: 'other-entry', candidate: { ...input[0]!.candidate, sourceIds: ['other-first'] } };
      expect(practiceGrouping([...input, other], [...units, ...duplicate]).get(other.id)?.rootEntryId).toBe(other.id);
    }
  });

  it('does not merge separate submission obligations, unrelated actions or unresolved time/audience', () => {
    const input = entries();
    for (const change of [
      { action: '单独提交本次作业' }, { conditions: ['分别提交两个报告'] }, { uncertainties: ['截止时间需确认'] },
      { uncertainties: ['适用对象需核对'] }, { temporalEvidence: [{ field: 'deadline' as const, basis: 'unknown' as const, quote: '稍后提交' }] },
      { title: '报名参加编程比赛' },
      { action: '第一组完成程序练习' }, { conditions: ['仅限另一小组'] }, { action: '下周二完成这道练习' },
    ]) {
      const second = { ...input[1]!, candidate: { ...input[1]!.candidate, ...change } };
      expect(practiceGrouping([input[0]!, second], units).has(second.id)).toBe(false);
    }
    expect(practiceGrouping(input, [...units, unit('notice', '第一次作业单独提交，第二次作业另行上交。')]).size).toBe(0);
  });

  it('can group ordinary no-deadline exercises with missing-information notes', () => {
    const input = entries();
    input[1]!.candidate.uncertainties = ['文档未提供具体截止时间，请查看课程要求', '未注明地点'];
    expect(practiceGrouping(input, units).get(input[1]!.id)?.rootEntryId).toBe(input[0]!.id);
  });

  it('never rewrites explicit relations to already saved, accepted or ignored candidates', () => {
    const input = entries();
    for (const kind of ['supplement', 'duplicate', 'revision', 'uncertain'] as const) {
      const item = { ...input[1]!, candidate: { ...input[1]!.candidate, relation: { kind, candidateId: 'saved-user-decision' } } };
      expect(practiceGrouping([input[0]!, item], units).has(item.id)).toBe(false);
      expect(classifyPracticeEntry(item, units)?.summary).toBe('完成线性表相关练习。');
    }
    const explicit = { ...input[1]!, candidate: { ...input[1]!.candidate, relation: { kind: 'supplement' as const, candidateId: input[0]!.id } } };
    expect(practiceGrouping([input[0]!, explicit], units).get(explicit.id)?.rootEntryId).toBe(input[0]!.id);
  });

  it('requires a continuous original exercise quote and rejects supporting sources from another message', () => {
    const input = entries(), second = input[1]!;
    expect(practiceGrouping([{ ...second, candidate: { ...second.candidate, sourceQuote: '练习：原文并不存在的编写要求' } }], units).size).toBe(0);
    expect(practiceGrouping([{ ...second, supportingSources: [{ sourceId: 'elsewhere', quote: '老师的新安排' }] }], [...units, unit('elsewhere', '老师的新安排', { messageId: 'different' })]).size).toBe(0);
  });
});
