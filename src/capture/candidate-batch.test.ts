import { describe, expect, it } from 'vitest';
import { CandidateSchema, SourceSchema } from '../shared/contracts';
import { CaptureExtractionSchema, captureRequestSchema, captureEntries, reconcileCaptureCandidate } from './candidate-batch';
import type { ExtractedCandidate } from '../ai/schemas';
import { hashInput } from './analysis';

const at = '2026-10-23T12:00:00+08:00';
const source = SourceSchema.parse({ id: 'current-source', version: 1, createdAt: at, updatedAt: at,
  importedAt: at, sentAt: at, kind: 'text', text: '获奖同学请携带校园卡领取奖品' });
const original = CandidateSchema.parse({ id: 'original', version: 1, createdAt: at, updatedAt: at,
  title: '领取活动奖品', action: '到服务台领取奖品', sourceIds: ['original-source'], sourceQuote: '获奖名单', conditions: ['名单中获奖者'], location: '服务台' });
const candidate: ExtractedCandidate = { title: '获奖同学领礼品', action: '携带校园卡领取奖品', benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: ['携带校园卡'], uncertainties: [],
  sourceIds: [source.id], sourceQuote: source.text, deadline: null, eventStart: null, eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'duplicate', candidateId: original.id } };

describe('capture-only event reconciliation', () => {
  it('uses the same strict current-source schema for the prompt and response validation', () => {
    const schema = captureRequestSchema([source.id, 'supporting-source']);
    expect(schema.safeParse({ candidates: [candidate] }).success).toBe(true);
    expect(schema.safeParse({ candidates: [{ ...candidate, sourceIds: [source.id, 'supporting-source'] }] }).success).toBe(false);
    expect(schema.safeParse({ candidates: [{ ...candidate, sourceIds: ['other-fragment-source'] }] }).success).toBe(false);
    expect(schema.safeParse({ candidates: [{ ...candidate, supportingSources: [{ sourceId: 'other-fragment-source', quote: '旧资料' }] }] }).success).toBe(false);
  });
  it('parses a legacy paid response without adding fields or changing its receipt fingerprint', () => {
    const legacy = { candidates: [candidate] };
    const parsed = CaptureExtractionSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(hashInput(parsed)).toBe(hashInput(legacy));
    expect(parsed.candidates[0]).not.toHaveProperty('supportingSources');
    expect(parsed.candidates[0]).not.toHaveProperty('eventKey');
  });

  it('merges an explicitly identified paraphrase with all evidence and conditions', () => {
    const result = reconcileCaptureCandidate(candidate, source, [source.id, 'supporting-source'], [original], []);
    expect(result).toMatchObject({ kind: 'update', id: original.id, values: { title: original.title, status: 'pending', revisionOfId: null,
      sourceIds: ['original-source', source.id, 'supporting-source'], conditions: ['名单中获奖者', '携带校园卡'], location: '服务台' } });
    if (result.kind !== 'ignore') expect(result.values.action).toContain('携带校园卡');
  });

  it('keeps an accepted paraphrase as a linked review and never revives an ignored original', () => {
    const accepted = { ...original, status: 'accepted' as const, taskId: 'accepted-task' };
    expect(reconcileCaptureCandidate(candidate, source, [source.id], [accepted], [])).toMatchObject({ kind: 'create', values: {
      revisionOfId: original.id, status: 'pending', taskId: null, sourceIds: ['original-source', source.id],
    } });
    expect(reconcileCaptureCandidate(candidate, source, [source.id], [{ ...original, status: 'ignored' }], [])).toEqual({ kind: 'ignore', id: original.id });
    expect(accepted.action).toBe('到服务台领取奖品');
  });

  it('does not overwrite a conflicting place on an explicit duplicate', () => {
    expect(reconcileCaptureCandidate({ ...candidate, location: '另一个领取点' }, source, [source.id], [original], [])).toMatchObject({ kind: 'create', values: {
      revisionOfId: original.id, location: '另一个领取点', uncertainties: expect.arrayContaining(['补充内容与原事项的时间或地点不同，请作为变更核对']),
    } });
    expect(original.location).toBe('服务台');
  });

  it('uses response-local event keys and durable distinct aliases without modifying saved responses', () => {
    const item = { ...candidate, eventKey: 'prize', relation: { kind: 'new' as const, candidateId: null } };
    const completed = [{ key: 'first-request', value: { candidates: [item, item] } }, { key: 'second-request', value: { candidates: [item] } }];
    const before = structuredClone(completed);
    const entries = captureEntries(completed, 'batch-operation');
    expect(new Set(entries.map(entry => entry.id)).size).toBe(3);
    expect(entries[1]?.candidate.relation).toEqual({ kind: 'supplement', candidateId: entries[0]!.id });
    expect(entries[2]?.candidate.relation).toEqual({ kind: 'new', candidateId: null });
    expect(captureEntries(completed, 'batch-operation')).toEqual(entries);
    expect(captureEntries(completed, 'different-operation')[0]?.id).not.toBe(entries[0]!.id);
    expect(completed).toEqual(before);
  });

  it('allows one event key to supplement the same existing target twice but rejects conflicting targets', () => {
    const item = { ...candidate, eventKey: 'prize', relation: { kind: 'supplement' as const, candidateId: original.id } };
    const entries = captureEntries([{ key: 'request', value: { candidates: [item, item] } }], 'batch-operation');
    expect(entries[0]?.candidate.relation).toEqual(item.relation);
    expect(entries[1]?.candidate.relation).toEqual({ kind: 'supplement', candidateId: entries[0]!.id });
    expect(() => captureEntries([{ key: 'request', value: { candidates: [item,
      { ...item, relation: { kind: 'supplement', candidateId: 'a-different-event' } },
    ] } }], 'batch-operation')).toThrow('同一事项的批内标识与关联候选不一致');
  });
});
