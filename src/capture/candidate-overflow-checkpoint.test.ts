import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from './store';
import { analyzeCapture, applyCaptureResult, prepareAnalysis } from './analysis';
import { CandidateSchema, SourceSchema } from '../shared/contracts';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0)) dispose(); });

it('resumes a paid overflow response locally, preserving every source and replaying only once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-evidence-overflow-')), path = join(directory, 'planner.sqlite');
  const repository = createRepository(path, { automaticBackup: () => {} }), store = createCaptureStore(path);
  cleanup.push(() => { store.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const sentAt = '2027-03-08T16:00:00+08:00', accountId = 'synthetic-account', groupId = 'synthetic-group';
  const sources = repository.writeInternal({ operationId: 'seed-evidence', changes: Array.from({ length: 100 }, (_, index) => ({
    entity: 'source' as const, values: { kind: 'text', text: `合成奖品通知第${index + 1}段`, importedAt: sentAt, sentAt,
      captureRef: { messageId: `old-message-${index}`, accountId, groupId, attachmentId: null, locator: '消息正文 1', transcribed: false } },
  })) }).entities.map(value => SourceSchema.parse(value));
  const original = CandidateSchema.parse(repository.writeInternal({ operationId: 'seed-candidate', changes: [{ entity: 'candidate', values: {
    title: '领取合成活动奖品', action: '在示例服务台领取奖品', sourceQuote: sources[0]!.text,
    sourceIds: sources.map(source => source.id), conditions: ['已获奖同学'], location: '示例服务台',
  } }] }).entities[0]);
  store.saveConfig({ ...store.config(), enabled: true, accountId, groupIds: [groupId] });
  store.ingest([{ accountId, groupId, messageId: 'new-message', sentAt, text: '领取时请核对奖品数量' }]);
  store.sealBatches({ force: true }); const batch = store.claimBatch()!, unit = prepareAnalysis(store, batch).units[0]!;
  const answer = { candidates: [{ title: '奖品领取补充', action: unit.text, sourceIds: [unit.id], sourceQuote: unit.text,
    benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: [], uncertainties: [], deadline: null,
    eventStart: null, eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'supplement', candidateId: original.id } }] };
  const savePending = store.savePendingResponse.bind(store);
  const interrupted = vi.spyOn(store, 'savePendingResponse').mockImplementationOnce((...args) => {
    savePending(...args); throw Error('synthetic interruption after saving paid response');
  });
  let paid = 0;
  await expect(analyzeCapture({ store, repository, batch, canContinue: () => true, getApiKey: async () => 'synthetic-key',
    fetch: async () => { paid++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); },
  })).rejects.toThrow();
  interrupted.mockRestore();
  expect(store.batch(batch.id)?.result).toHaveProperty('pendingResponse');
  expect(repository.snapshot().candidates).toEqual([original]);
  let keys = 0, repeatedRequests = 0;
  await analyzeCapture({ store, repository, batch: store.batch(batch.id)!, canContinue: () => true,
    getApiKey: async () => { keys++; return null; }, fetch: async () => { repeatedRequests++; throw Error('must not repeat paid request'); } });
  expect({ paid, keys, repeatedRequests }).toEqual({ paid: 1, keys: 0, repeatedRequests: 0 });
  expect(store.batch(batch.id)?.status).toBe('applied');
  const saved = repository.snapshot(), supplement = saved.candidates.find(candidate => candidate.id !== original.id)!;
  expect(saved.candidates.find(candidate => candidate.id === original.id)).toEqual(original);
  expect(supplement).toMatchObject({ revisionOfId: original.id, status: 'pending', action: unit.text });
  expect(supplement.sourceIds).toHaveLength(1); expect(saved.sources).toHaveLength(101);
  expect(new Set(saved.candidates.flatMap(candidate => candidate.sourceIds)).size).toBe(101);
  applyCaptureResult(store, repository, store.batch(batch.id)!);
  expect(repository.snapshot().candidates).toEqual(saved.candidates); expect(repository.snapshot().sources).toEqual(saved.sources);
});
