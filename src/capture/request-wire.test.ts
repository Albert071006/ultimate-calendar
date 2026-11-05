import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../ai/deepseek';
import { compactCaptureMessages, expandCaptureTable } from './request-wire';

const at = '2026-11-05T12:00:00+08:00';
function fixture() {
  const unit = { id: 'qqs:synthetic-current-source', messageId: 'synthetic-message', accountId: '100', groupId: '200', attachmentId: null,
    text: '明天中午到合成苑', sentAt: at, locator: '消息正文 1', label: 'QQ · 合成群 · 合成成员', hasImage: false,
    recipient: { audience: 'self', sender: 'other', addressedText: '明天中午到合成苑', truncated: false } };
  const existing = { id: 'synthetic-candidate', title: '参加合成说明会', action: '带证件到合成楼参加说明会', status: 'pending', conditions: ['带证件'],
    benefit: '领取合成材料', benefitKind: 'stated', potentialBenefit: '', deadline: null, eventStart: '2026-11-06T12:00:00+08:00', eventEnd: null,
    resolvedDates: { eventStart: ['2026-11-06'] }, sourceSentAt: ['2026-11-05T10:00:00+08:00'], location: '合成楼', revisionOfId: null };
  const input = { units: [unit], allowedSourceIds: [unit.id], warnings: [], userProfile: { personalContext: '合成学生；资料组' },
    context: [{ id: unit.messageId, sentAt: at, text: unit.text, recipient: unit.recipient },
      { id: 'synthetic-prior-day', sentAt: '2026-11-04T12:00:00+08:00', text: unit.text, recipient: { audience: 'others', sender: 'other' } },
      { id: 'synthetic-attachment', sentAt: at, text: '', attachments: { complete: false, omitted: 1, items: [] } }],
    existingCandidates: [existing] };
  const messages: ChatMessage[] = [{ role: 'system', content: '当前允许来源只取 allowedSourceIds。合成规则。' }, { role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }];
  return { unit, existing, input, messages };
}
function body(messages: ChatMessage[]) {
  const content = messages[1]!.content;
  if (typeof content === 'string' || content[0]?.type !== 'text') throw Error('No wire body');
  return JSON.parse(content[0].text);
}

describe('capture lossless wire packing', () => {
  it('keeps full evidence, identity, dates and conditions while eliminating long IDs and duplicate body', () => {
    const f = fixture(), packed = compactCaptureMessages(f.messages), sent = body(packed.messages);
    expect(sent.units[0]).toMatchObject({ id: 'u1', messageId: 'm1', text: f.unit.text, sentAt: at, recipient: { audience: 'self', sender: 'other' } });
    expect(sent.units[0].recipient.addressedText).toBeUndefined();
    expect(sent.context).toHaveLength(2);
    expect(sent.context[0]).toMatchObject({ id: 'm2', sentAt: '2026-11-04T12:00:00+08:00', sameTextAs: 'u1', recipient: { audience: 'others' } });
    expect(sent.context[1].attachments).toEqual(f.input.context[2]!.attachments);
    const { revisionOfId: _revision, potentialBenefit: _potential, ...expected } = f.existing;
    expect(expandCaptureTable(sent.existingCandidates)[0]).toEqual({ ...expected, id: 'c1' });
    expect(JSON.stringify(packed.messages)).not.toContain(f.unit.id);
    expect(JSON.stringify(packed.messages)).not.toContain(f.existing.id);
    expect(sent.userProfile).toEqual(f.input.userProfile);
  });

  it('maps response aliases into durable IDs and never allows context/candidate IDs as current sources', () => {
    const f = fixture(), wire = compactCaptureMessages(f.messages);
    const result = wire.decode({ candidates: [{ sourceIds: ['u1'], supportingSources: [{ sourceId: 'u1', quote: f.unit.text }], relation: { kind: 'supplement', candidateId: 'c1' } }] });
    expect(result).toEqual({ candidates: [{ sourceIds: [f.unit.id], supportingSources: [{ sourceId: f.unit.id, quote: f.unit.text }], relation: { kind: 'supplement', candidateId: f.existing.id } }] });
    for (const id of ['u99', 'm1', 'c1', 'another-real-id']) expect(wire.decode({ candidates: [{ sourceIds: [id] }] })).toEqual({ candidates: [{ sourceIds: [`invalid-wire-id:${id}`] }] });
  });

  it('keeps system prefix identical when live evidence and the profile change', () => {
    const first = fixture(), second = fixture();
    second.input.units[0]!.text = '后天下午到另一合成地点'; second.input.userProfile.personalContext = '另一个合成职务';
    second.messages[1]!.content = [{ type: 'text', text: JSON.stringify(second.input) }];
    expect(compactCaptureMessages(first.messages).messages[0]).toEqual(compactCaptureMessages(second.messages).messages[0]);
  });

  it('supplements only requested known originals without granting old evidence source authority', () => {
    const f = fixture(), wire = compactCaptureMessages(f.messages);
    expect(wire.decode({ needsDetails: { context: ['m2'], candidates: ['c1'] } })).toEqual({ needsDetails: { context: ['synthetic-prior-day'], candidates: [f.existing.id] } });
    const expanded = compactCaptureMessages(f.messages, { context: ['synthetic-prior-day'], candidates: [f.existing.id] }, {
      context: new Map([['synthetic-prior-day', { text: '完整的旧通知正文' }]]),
      candidates: new Map([[f.existing.id, [{ text: '旧事项的原始证据', sentAt: at }]]]),
    });
    expect(body(expanded.messages).context[0]).toMatchObject({ id: 'm2', text: '完整的旧通知正文' });
    expect(expandCaptureTable(body(expanded.messages).existingCandidates)[0]!.originalEvidence).toEqual([{ text: '旧事项的原始证据', sentAt: at }]);
    expect(expanded.decode({ candidates: [{ sourceIds: ['c1'] }] })).toEqual({ candidates: [{ sourceIds: ['invalid-wire-id:c1'] }] });
    expect(() => compactCaptureMessages(f.messages, { context: ['outside-request'], candidates: [] })).toThrow('未知上下文');
  });

  it('does not clip long old context or conditions for a nominal token saving', () => {
    const f = fixture(); f.input.context[1]!.text = '关键条件'.repeat(500); f.input.existingCandidates[0]!.conditions = ['必须携带原件'.repeat(100)];
    f.messages[1]!.content = [{ type: 'text', text: JSON.stringify(f.input) }];
    const sent = body(compactCaptureMessages(f.messages).messages);
    expect(sent.context[0].text).toBe(f.input.context[1]!.text);
    expect(expandCaptureTable(sent.existingCandidates)[0]!.conditions).toEqual(f.input.existingCandidates[0]!.conditions);
  });
});
