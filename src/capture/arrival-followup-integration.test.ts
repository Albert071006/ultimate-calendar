import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from './store';
import { ANALYSIS_VERSION, analyzeCapture, applyCaptureResult, hashInput, prepareAnalysis } from './analysis';
import type { ExtractedCandidate } from '../ai/schemas';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const announcement = '2027年3月9日19:00在示例活动室举行读书交流会，请准时参加。';
const addendum = '明天有实验课的同学可以稍晚到场，但必须七点二十分之前到。';
const blank = { benefit: '', benefitKind: 'unknown' as const, potentialBenefit: '', conditions: [], uncertainties: [],
  deadline: null, eventStart: null, eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'new' as const, candidateId: null } };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'arrival-followup-')), path = join(dir, 'planner.sqlite');
  const repository = createRepository(path, { automaticBackup: () => {} }), store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: 'synthetic-account', groupIds: ['synthetic-group'] });
  function add(messageId: string, text: string, sentAt: string) {
    const id = store.ingest([{ accountId: 'synthetic-account', groupId: 'synthetic-group', messageId, text, sentAt }]).ids[0]!;
    store.sealBatches({ force: true }); const batch = store.claimBatch()!;
    return { batch, unit: prepareAnalysis(store, batch).units.find(unit => unit.messageId === id)! };
  }
  const first = add('main-notice', announcement, '2027-03-08T16:00:00+08:00');
  const original: ExtractedCandidate = { ...blank, title: '参加读书交流会', action: '参加读书交流会',
    sourceIds: [first.unit.id], sourceQuote: announcement, eventStart: '2027-03-09T19:00', location: '示例活动室',
    temporalEvidence: [{ field: 'eventStart', basis: 'explicit', quote: '2027年3月9日19:00' }] };
  return { repository, store, add, ...first, original };
}
const response = (candidates: ExtractedCandidate[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
const options = (f: ReturnType<typeof fixture>, batch = f.batch) => ({ store: f.store, repository: f.repository, batch, getApiKey: async () => 'synthetic', canContinue: () => true });

describe('arrival follow-up checkpoints and event preservation', () => {
  it('recovers a cached timezone-less original notice locally and replays it without duplicate records', async () => {
    const f = fixture(), prepared = prepareAnalysis(f.store, f.batch);
    const units = prepared.units.map(({ text, imageDataUrl, ...unit }) => ({ ...unit, textHash: hashInput(text), imageHash: imageDataUrl ? hashInput(imageDataUrl) : null }));
    const raw = { candidates: [f.original] }, before = structuredClone(raw);
    const checkpoint = { ...prepared, units, planFingerprint: hashInput({ version: ANALYSIS_VERSION, model: f.repository.snapshot().settings.model,
      attachmentDedupe: 1, documentGrouping: 1, passiveQuestionFilter: 1, units, context: prepared.context, warnings: prepared.warnings }),
      completed: [], final: false, pendingResponse: { key: hashInput(units.map(unit => unit.id)), value: raw, candidateIds: [] } };
    f.store.startAttempt(f.batch.id, 'synthetic-legacy-request');
    f.store.savePendingResponse(f.batch.id, checkpoint);
    let keys = 0, calls = 0;
    await analyzeCapture({ ...options(f, f.store.batch(f.batch.id)!), getApiKey: async () => { keys++; return null; }, fetch: async () => { calls++; throw Error('no paid retry'); } });
    expect({ keys, calls }).toEqual({ keys: 0, calls: 0 }); expect(raw).toEqual(before);
    const saved = f.repository.snapshot();
    expect(saved.candidates).toHaveLength(1);
    expect(saved.candidates[0]).toMatchObject({ title: '参加读书交流会', eventStart: '2027-03-09T19:00:00+08:00', location: '示例活动室' });
    applyCaptureResult(f.store, f.repository, f.store.batch(f.batch.id)!);
    expect(f.repository.snapshot().candidates).toEqual(saved.candidates); expect(f.repository.snapshot().sources).toEqual(saved.sources);
  });

  it('holds a mistaken independent course answer for review and never pays again on retry', async () => {
    const f = fixture(); await analyzeCapture({ ...options(f), fetch: async () => response([f.original]) });
    const next = f.add('late-arrival', addendum, '2027-03-08T16:20:00+08:00');
    const wrong = { ...blank, title: '参加实验课', action: '七点二十分前到达实验课', sourceIds: [next.unit.id], sourceQuote: addendum };
    let calls = 0;
    await expect(analyzeCapture({ ...options(f, next.batch), fetch: async () => { calls++; return response([wrong]); } })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    const pending = f.store.batch(next.batch.id)!.result;
    expect(pending).toHaveProperty('pendingResponse'); expect(f.repository.snapshot().candidates).toHaveLength(1);
    await expect(analyzeCapture({ ...options(f, f.store.batch(next.batch.id)!), getApiKey: async () => { throw Error('unexpected key lookup'); },
      fetch: async () => { calls++; throw Error('unexpected request'); } })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(calls).toBe(1); expect(f.store.batch(next.batch.id)!.result).toEqual(pending);
    expect(f.repository.snapshot().candidates).toHaveLength(1);
  });

  it.each(['pending', 'accepted'] as const)('preserves a %s main event and its time when adding a scoped late-arrival exception', async status => {
    const f = fixture(); await analyzeCapture({ ...options(f), fetch: async () => response([f.original]) });
    let original = f.repository.snapshot().candidates[0]!;
    if (status === 'accepted') {
      f.repository.writeInternal({ operationId: 'synthetic-accept', changes: [{ entity: 'candidate', id: original.id, expectedVersion: original.version, values: { status } }] });
      original = f.repository.snapshot().candidates[0]!;
    }
    const next = f.add('late-arrival', addendum, '2027-03-08T16:20:00+08:00');
    const supplement: ExtractedCandidate = { ...blank, title: '到场补充', action: '有实验课的同学可以稍晚到场，但须七点二十分之前到。',
      sourceIds: [next.unit.id], sourceQuote: addendum, relation: { kind: 'supplement', candidateId: original.id } };
    await analyzeCapture({ ...options(f, next.batch), fetch: async () => response([supplement]) });
    const snapshot = f.repository.snapshot();
    expect(snapshot.candidates).toHaveLength(status === 'pending' ? 1 : 2);
    const current = status === 'pending' ? snapshot.candidates[0]! : snapshot.candidates.find(candidate => candidate.id !== original.id)!;
    expect(current).toMatchObject({ title: original.title, eventStart: original.eventStart, eventEnd: null, deadline: null, location: original.location });
    expect(current.action).toContain('有实验课的同学'); expect(current.action).toContain('七点二十分');
    expect(current.sourceIds).toHaveLength(2);
    if (status === 'accepted') {
      expect(snapshot.candidates.find(candidate => candidate.id === original.id)).toEqual(original);
      expect(current.revisionOfId).toBe(original.id);
    }
  });
});
