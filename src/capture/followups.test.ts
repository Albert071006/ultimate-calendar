import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from './store';
import { analyzeCapture, applyCaptureResult, prepareAnalysis } from './analysis';
import type { ExtractedCandidate } from '../ai/schemas';
import type { Candidate } from '../shared/contracts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const at = '2026-10-23T12:00:00+08:00';
const supplement = '补充：请自带练习本';
function fixture(text = supplement) {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-followup-'));
  const path = join(dir, 'planner.sqlite');
  const repository = createRepository(path, { automaticBackup: () => {} }); const store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200', '201'] });
  function seed(groupId = '200', status: Candidate['status'] = 'pending', action = '参加晚自习，按分组入座') {
    const source = repository.writeInternal({ operationId: `source-${groupId}-${status}`, changes: [{ entity: 'source', values: {
      kind: 'text', text: '原始合成自习通知', importedAt: at, sentAt: at,
      captureRef: { accountId: '100', groupId, messageId: `original-${groupId}`, attachmentId: null, locator: '合成通知', transcribed: false },
    } }] }).entities[0]!;
    const saved = repository.writeInternal({ operationId: `candidate-${groupId}-${status}`, changes: [{ entity: 'candidate', values: {
      title: '参加晚自习', action, sourceIds: [source.id], sourceQuote: '原始合成自习通知', status,
      conditions: ['按分组入座'], location: '示例教室', deadline: { date: '2026-10-24', time: '18:00' },
      eventStart: '2026-10-25T19:00:00+08:00', eventEnd: '2026-10-25T20:00:00+08:00',
    } }] }).entities[0]!;
    return repository.snapshot().candidates.find(candidate => candidate.id === saved.id)!;
  }
  const original = seed();
  const message = store.ingest([{ accountId: '100', groupId: '200', messageId: 'followup', sentAt: '2026-10-23T13:00:00+08:00', text }]).ids[0]!;
  store.sealBatches({ force: true }); const batch = store.claimBatch()!;
  const unit = prepareAnalysis(store, batch).units.find(unit => unit.messageId === message)!;
  const extracted: ExtractedCandidate = { title: '携带练习本', action: '请自带练习本', benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: ['自带练习本'], uncertainties: [],
    sourceIds: [unit.id], sourceQuote: supplement, deadline: null, eventStart: null, eventEnd: null, location: '', temporalEvidence: [],
    relation: { kind: 'supplement', candidateId: original.id } };
  return { repository, store, original, batch, extracted, seed };
}
function response(candidates: ExtractedCandidate[]) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
}
function options(f: ReturnType<typeof fixture>) { return { store: f.store, repository: f.repository, batch: f.batch, getApiKey: async () => 'synthetic', canContinue: () => true }; }

describe('QQ event supplements', () => {
  it('includes preceding same-group corrections with their own recipients, only as non-source context', async () => {
    const f = fixture();
    const ingest = (messageId: string, sentAt: string, text: string, groupId = '200', mentions: string[] = []) => f.store.ingest([{
      accountId: '100', groupId, messageId, sentAt, text, senderId: '300',
      segments: [...mentions.map(qq => ({ type: 'at', data: { qq } })), { type: 'text', data: { text } }],
    }]).ids[0]!;
    const deleted = ingest('deleted', at, '已删除的旧说法');
    f.store.cleanup({ accountId: '100', groupId: '200', before: '2026-10-23T12:01:00+08:00' });
    const correction = ingest('correction', '2026-10-23T12:30:00+08:00', '小组人数不限，先确定要参加', '200', ['all']);
    const other = ingest('other-recipient', '2026-10-23T12:40:00+08:00', '请另一个同学收表', '200', ['999']);
    const recalled = ingest('recalled', '2026-10-23T12:45:00+08:00', '已撤回的更改'); f.store.markMessageChanged(recalled);
    const excluded = [deleted, recalled, ingest('stale', '2026-10-22T12:59:00+08:00', '超过24小时'),
      ingest('different-group', '2026-10-23T12:50:00+08:00', '另一个群', '201'),
      ingest('future', '2026-10-23T14:00:00+08:00', '后来的消息')];
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      const input = JSON.parse(JSON.parse(String(request?.body)).messages.find((m: { role: string }) => m.role === 'user').content[0].text);
      expect(input.context.find((item: { id: string }) => item.id === correction)).toMatchObject({ text: '小组人数不限，先确定要参加', contextOnly: true, recipient: { audience: 'all', sender: 'other' } });
      expect(input.context.find((item: { id: string }) => item.id === other)).toMatchObject({ recipient: { audience: 'others' }, contextOnly: true });
      for (const id of excluded) expect(input.context.some((item: { id: string }) => item.id === id)).toBe(false);
      expect(input.units).toHaveLength(1);
      return response([f.extracted]);
    } });
    expect(f.repository.snapshot().sources).toHaveLength(2);
  });

  it('bounds preceding context to the latest 20 messages and 8000 characters', () => {
    const f = fixture();
    for (let index = 0; index < 25; index++) f.store.ingest([{ accountId: '100', groupId: '200', messageId: `prior-${index}`,
      sentAt: `2026-10-23T12:${String(index).padStart(2, '0')}:00+08:00`, text: `previous-${index}:` + '背景'.repeat(300) }]);
    const prior = f.store.contextMessagesBefore(f.batch.id); expect(prior).toHaveLength(20);
    expect(prior.some(message => message.messageId === 'prior-0')).toBe(false);
    const ids = new Set(prior.map(message => message.id));
    const context = prepareAnalysis(f.store, f.batch).context.filter(message => ids.has(message.id));
    expect(context.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(8000);
    expect(context.at(-1)?.text).toContain('previous-24:');
  });

  it('supplies full same-group event context and merges a later supplement with both sources and original timing', async () => {
    const f = fixture(); const other = f.seed('201');
    const longAction = '原活动要求'.repeat(600);
    f.repository.writeInternal({ operationId: 'long-action', changes: [{ entity: 'candidate', id: f.original.id, expectedVersion: f.original.version, values: { action: longAction } }] });
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      const input = JSON.parse(JSON.parse(String(request?.body)).messages.find((m: { role: string }) => m.role === 'user').content[0].text);
      expect(input.existingCandidates).toHaveLength(1);
      expect(input.existingCandidates[0]).toMatchObject({ id: f.original.id, action: longAction, conditions: ['按分组入座'], location: '示例教室', sourceSentAt: [at] });
      expect(JSON.stringify(input.existingCandidates)).not.toContain(other.id);
      return response([f.extracted]);
    } });
    const current = f.repository.snapshot().candidates.find(c => c.id === f.original.id)!;
    expect(f.repository.snapshot().candidates).toHaveLength(2); // One unrelated event in the other group.
    expect(current).toMatchObject({ title: f.original.title, status: 'pending', deadline: f.original.deadline, eventStart: f.original.eventStart, eventEnd: f.original.eventEnd, revisionOfId: null });
    expect(current.action).toContain(longAction); expect(current.action).toContain('请自带练习本');
    expect(current.conditions).toEqual(['按分组入座', '自带练习本']); expect(current.sourceIds).toHaveLength(2);
    expect(current.sourceIds).toContain(f.original.sourceIds[0]);
    applyCaptureResult(f.store, f.repository, f.store.batch(f.batch.id)!);
    expect(f.repository.snapshot().candidates.find(c => c.id === current.id)).toEqual(current);
  });

  it('rejects a relation pointing at a different group before applying it', async () => {
    const f = fixture(); const other = f.seed('201');
    await expect(analyzeCapture({ ...options(f), fetch: async () => response([{ ...f.extracted, relation: { kind: 'supplement', candidateId: other.id } }]) })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(f.repository.snapshot().candidates.find(c => c.id === other.id)).toEqual(other);
    expect(f.repository.snapshot().candidates.find(c => c.id === f.original.id)).toEqual(f.original);
  });

  it('leaves an accepted event and task intact while creating a complete linked review candidate', async () => {
    const f = fixture();
    const task = f.repository.writeInternal({ operationId: 'accepted-task', changes: [{ entity: 'task', values: { title: f.original.title, description: f.original.action, candidateId: f.original.id } }] }).entities[0]!;
    f.repository.writeInternal({ operationId: 'accepted-event', changes: [{ entity: 'candidate', id: f.original.id, expectedVersion: f.original.version, values: { status: 'accepted', taskId: task.id } }] });
    const before = f.repository.snapshot();
    await analyzeCapture({ ...options(f), fetch: async () => response([f.extracted]) });
    const after = f.repository.snapshot();
    expect(after.tasks).toEqual(before.tasks); expect(after.candidates.find(c => c.id === f.original.id)).toEqual(before.candidates[0]);
    const review = after.candidates.find(c => c.id !== f.original.id)!;
    expect(review).toMatchObject({ status: 'pending', revisionOfId: f.original.id, deadline: f.original.deadline, eventStart: f.original.eventStart, eventEnd: f.original.eventEnd, location: f.original.location });
    expect(review.action).toContain(f.original.action); expect(review.action).toContain('请自带练习本'); expect(review.sourceIds).toHaveLength(2);
  });

  it('does not revive an ignored event for a follow-up', async () => {
    const f = fixture();
    f.repository.writeInternal({ operationId: 'ignore-original', changes: [{ entity: 'candidate', id: f.original.id, expectedVersion: f.original.version, values: { status: 'ignored' } }] });
    const before = f.repository.snapshot().candidates;
    await analyzeCapture({ ...options(f), fetch: async () => response([f.extracted]) });
    expect(f.repository.snapshot().candidates).toEqual(before); expect(f.repository.snapshot().sources).toHaveLength(1);
  });

  it.each(['supplement', 'revision'] as const)('keeps a conflicting %s as a separate linked review', async kind => {
    const f = fixture(`${supplement}。改到2026年10月26日19:00开始。`);
    await analyzeCapture({ ...options(f), fetch: async () => response([{ ...f.extracted, eventStart: '2026-10-26T19:00:00+08:00',
      temporalEvidence: [{ field: 'eventStart', basis: 'explicit', quote: '2026年10月26日19:00开始' }], relation: { kind, candidateId: f.original.id } }]) });
    expect(f.repository.snapshot().candidates.find(c => c.id === f.original.id)).toEqual(f.original);
    const review = f.repository.snapshot().candidates.find(c => c.id !== f.original.id)!;
    expect(review).toMatchObject({ revisionOfId: f.original.id, eventStart: '2026-10-26T19:00:00+08:00', eventEnd: null });
    expect(review.action).toContain(f.original.action);
  });

  it('does not combine a distinct event just because it is in the same group', async () => {
    const f = fixture();
    await analyzeCapture({ ...options(f), fetch: async () => response([{ ...f.extracted, title: '参加另一个读书会', relation: { kind: 'new', candidateId: null } }]) });
    expect(f.repository.snapshot().candidates).toHaveLength(2);
    expect(f.repository.snapshot().candidates.find(c => c.id === f.original.id)).toEqual(f.original);
  });

  it('resumes a paid supplement checkpoint without charging again for its completed fragment', async () => {
    const f = fixture(supplement + '背景文字'.repeat(12_000)); let calls = 0;
    await expect(analyzeCapture({ ...options(f), fetch: async () => { calls++; if (calls === 2) throw Error('network'); return response([f.extracted]); } })).rejects.toMatchObject({ code: 'NETWORK' });
    f.store.recoverInterrupted(); f.store.retryBatch(f.batch.id);
    f.store.ingest([{ accountId: '100', groupId: '200', messageId: 'late-history', sentAt: '2026-10-23T12:50:00+08:00', text: 'LATE_CONTEXT_MUST_NOT_REWRITE_CHECKPOINT' }]);
    await analyzeCapture({ ...options(f), batch: f.store.claimBatch()!, fetch: async (_url, request) => {
      calls++; expect(String(request?.body)).not.toContain('LATE_CONTEXT_MUST_NOT_REWRITE_CHECKPOINT'); return response([]);
    } });
    expect(calls).toBe(3); expect(f.repository.snapshot().candidates).toHaveLength(1);
    expect(f.repository.snapshot().candidates[0]!.sourceIds).toHaveLength(2);
    expect(f.repository.snapshot().tokenUsage).toHaveLength(2);
  });
});
