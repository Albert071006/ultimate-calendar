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
  it('strictly validates current source IDs even though the prompt schema has a stable structure', () => {
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

  const journal = { ...original, title: '提交观察日志', action: '提交观察日志', sourceQuote: '请提交观察日志' };
  function addedWork(text: string, target = journal) {
    return { ...candidate, title: '观察日志补充要求', action: text, sourceQuote: text,
      relation: { kind: 'supplement' as const, candidateId: target.id } };
  }
  it.each([
    ['请绘制路线图，与观察日志一同提交。', '绘制路线图'],
    ['同学们，请将这本练习册打印出来，手写完成，最后和观察日志一起上交。', '打印并手写完成练习册'],
  ])('recognizes a previously mislabelled joint submission and keeps its repeat on the new card', (text, title) => {
    const current = { ...source, text }, proposal = addedWork(text);
    const result = reconcileCaptureCandidate(proposal, current, [current.id], [journal], []);
    expect(result).toMatchObject({ kind: 'create', values: { title, revisionOfId: null, duplicateOfId: null, sourceIds: [current.id] } });
    if (result.kind !== 'create') throw Error('Expected a separate deliverable');
    const independent = CandidateSchema.parse({ ...result.values, id: 'separate-deliverable', version: 1, createdAt: at, updatedAt: at });
    const repeated = { ...current, id: 'repeat-source' };
    const next = { ...proposal, relation: { kind: 'duplicate' as const, candidateId: journal.id }, sourceIds: [repeated.id] };
    expect(reconcileCaptureCandidate(next, repeated, [repeated.id], [journal, independent], [])).toMatchObject({ kind: 'update', id: independent.id });
    expect(reconcileCaptureCandidate(next, repeated, [repeated.id], [journal, { ...independent, status: 'ignored' }], [])).toEqual({ kind: 'ignore', id: independent.id });
  });

  it.each(['请将观察日志双面打印一式两份。', '请带上现成的模板，和观察日志一起交。', '请补上封面，和观察日志一起交。', '观察日志截止改到周五。'])
  ('keeps ordinary requirements on the existing deliverable: %s', text => {
    const current = { ...source, text };
    expect(reconcileCaptureCandidate(addedWork(text), current, [current.id], [journal], [])).toMatchObject({ kind: 'update', id: journal.id });
  });

  it('resolves an explicit independent action on its own evidence even if the old card was ignored and event keys collide', () => {
    const text = '日志仍按原格式交。另外请为同学演示测量过程。', current = { ...source, text };
    const extra = { ...addedWork(text), title: '演示测量过程', action: '为同学演示测量过程', sourceQuote: '请为同学演示测量过程',
      eventKey: 'same-course', relation: { kind: 'independent_action' as const, candidateId: journal.id } };
    const value = captureRequestSchema([source.id]).parse({ candidates: [{ ...addedWork(text), eventKey: extra.eventKey }, extra] });
    const [, entry] = captureEntries([{ key: 'mixed', value }], 'replayable-op');
    const ignored = { ...journal, status: 'ignored' as const };
    expect(entry!.independentOf).toBe(journal.id);
    expect(reconcileCaptureCandidate(entry!.candidate, current, [current.id], [ignored], [], [], [], entry!.independentOf))
      .toMatchObject({ kind: 'create', values: { title: extra.title, revisionOfId: null, duplicateOfId: null, status: 'pending' } });
    expect(reconcileCaptureCandidate({ ...entry!.candidate, sourceQuote: text }, current, [current.id],
      [{ ...ignored, sourceQuote: text }], [], [], [], journal.id)).toMatchObject({ kind: 'create', values: { title: extra.title, revisionOfId: null } });
    for (const unchanged of [journal.sourceQuote, '将观察日志双面打印一式两份。']) {
      expect(reconcileCaptureCandidate({ ...entry!.candidate, sourceQuote: unchanged }, { ...source, text: unchanged },
        [source.id], [ignored], [], [], [], journal.id)).toEqual({ kind: 'ignore', id: journal.id });
    }
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

  it.each(['pending', 'accepted'] as const)('keeps overflowing evidence as a linked review without altering the %s original', status => {
    const target = { ...original, status, sourceIds: Array.from({ length: 90 }, (_, index) => `saved-evidence-${index}`) };
    const before = structuredClone(target);
    const incomingSources = [source.id, ...Array.from({ length: 29 }, (_, index) => `new-evidence-${index}`)];
    const result = reconcileCaptureCandidate({ ...candidate, relation: { kind: 'supplement', candidateId: target.id } }, source, incomingSources, [target], []);
    expect(result).toMatchObject({ kind: 'create', values: { title: target.title, revisionOfId: target.id, duplicateOfId: null,
      status: 'pending', taskId: null, sourceIds: incomingSources, action: candidate.action, sourceQuote: candidate.sourceQuote } });
    if (result.kind !== 'create') throw Error('Expected a linked review');
    expect(CandidateSchema.safeParse({ ...result.values, id: 'linked-review', version: 1, createdAt: at, updatedAt: at }).success).toBe(true);
    expect(new Set([...target.sourceIds, ...result.values.sourceIds]).size).toBe(120);
    expect(target).toEqual(before);
    expect(reconcileCaptureCandidate(candidate, source, incomingSources, [{ ...target, status: 'ignored' }], [])).toEqual({ kind: 'ignore', id: target.id });
  });

  it('still merges all evidence at the existing 100-source boundary', () => {
    const target = { ...original, sourceIds: Array.from({ length: 70 }, (_, index) => `saved-evidence-${index}`) };
    const incomingSources = [source.id, ...Array.from({ length: 29 }, (_, index) => `new-evidence-${index}`)];
    const result = reconcileCaptureCandidate(candidate, source, incomingSources, [target], []);
    expect(result.kind).toBe('update');
    if (result.kind !== 'update') throw Error('Expected additive merge');
    expect(result.values.sourceIds).toEqual([...target.sourceIds, ...incomingSources]);
  });

  it('adds later fragments to an open continuation but preserves accepted continuations', () => {
    const target = { ...original, sourceIds: Array.from({ length: 90 }, (_, index) => `saved-evidence-${index}`) };
    const incomingSources = [source.id, ...Array.from({ length: 29 }, (_, index) => `new-evidence-${index}`)];
    const first = reconcileCaptureCandidate(candidate, source, incomingSources, [target], []);
    if (first.kind !== 'create') throw Error('Expected linked review');
    const continuation = CandidateSchema.parse({ ...first.values, id: 'continuation', version: 1, createdAt: at, updatedAt: at });
    const nextSource = { ...source, id: 'later-source', text: '领取时请核对奖品数量' };
    const nextSources = [nextSource.id, ...Array.from({ length: 29 }, (_, index) => `later-evidence-${index}`)];
    const next = { ...candidate, sourceIds: [nextSource.id], sourceQuote: nextSource.text, action: nextSource.text };
    const result = reconcileCaptureCandidate(next, nextSource, nextSources, [target, continuation], []);
    expect(result).toMatchObject({ kind: 'update', id: continuation.id, values: {
      revisionOfId: target.id, sourceIds: [...incomingSources, ...nextSources], sourceQuote: continuation.sourceQuote,
    } });
    if (result.kind !== 'update') throw Error('Expected additive continuation');
    expect(result.values.action).toContain(candidate.action); expect(result.values.action).toContain(next.action);
    expect(reconcileCaptureCandidate(next, nextSource, nextSources, [target, { ...continuation, status: 'accepted' }], []))
      .toMatchObject({ kind: 'create', values: { revisionOfId: target.id, sourceIds: nextSources } });
    expect(target.sourceIds).toHaveLength(90); expect(continuation.sourceIds).toEqual(incomingSources);
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
