import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRepository } from '../storage/repository';
import { createCaptureStore, type CaptureBatch } from './store';
import { ANALYSIS_VERSION, analyzeCapture, applyCaptureResult, hashInput, prepareAnalysis } from './analysis';
import { locationProfile } from '../ai/prompts';
import type { ExtractedCandidate } from '../ai/schemas';
import type { Candidate } from '../shared/contracts';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });
const at = '2026-10-23T12:00:00+08:00';
type ModelInput = { units: { id: string; text: string }[]; existingCandidates: { id: string; title: string; action: string; status: string }[] };
function input(request?: RequestInit): ModelInput {
  return JSON.parse(JSON.parse(String(request?.body)).messages.find((message: { role: string }) => message.role === 'user').content[0].text);
}
function response(value: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
}
function candidate(sourceId: string, quote: string, changes: Partial<ExtractedCandidate> = {}): ExtractedCandidate {
  return { title: '领取活动奖品', action: '获奖同学领取奖品', benefit: '', benefitKind: 'unknown', potentialBenefit: '',
    conditions: [], uncertainties: [], sourceIds: [sourceId], sourceQuote: quote, deadline: null, eventStart: null, eventEnd: null,
    location: '', temporalEvidence: [], relation: { kind: 'new', candidateId: null }, ...changes };
}
function fixture(chunkCount = 31) {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-capture-progress-'));
  const path = join(directory, 'planner.sqlite');
  let repository = createRepository(path, { automaticBackup: () => {} }); let store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200'] });
  const message = store.ingest([{ accountId: '100', groupId: '200', messageId: 'synthetic-table', text: '', sentAt: at, importedAt: at,
    attachments: [{ kind: 'file', name: '合成名单.xlsx' }] }]).ids[0]!;
  store.saveExtraction(store.attachments(message)[0]!.id, { extractorVersion: 'synthetic', chunks: Array.from({ length: chunkCount }, (_, ordinal) => ({
    ordinal, location: `第 ${ordinal + 1} 页`, text: `获奖同学领取奖品；合成名单第 ${ordinal + 1} 页`, imageDataUrl: null, status: 'ready' as const, error: null,
  })) });
  store.sealBatches({ force: true }); const batch = store.claimBatch()!;
  return {
    get repository() { return repository; }, get store() { return store; }, batch,
    reopen() { store.close(); repository.close(); repository = createRepository(path, { automaticBackup: () => {} }); store = createCaptureStore(path); },
    claimRetry() { const status = store.batch(batch.id)!.status; if (status === 'failed' || status === 'uncertain') store.retryBatch(batch.id); return store.claimBatch()!; },
  };
}
function options(f: ReturnType<typeof fixture>) { return { store: f.store, repository: f.repository, batch: f.batch, getApiKey: async () => 'synthetic', canContinue: () => true }; }
function savedResponse(f: ReturnType<typeof fixture>) {
  return (f.store.batch(f.batch.id)!.result as unknown as { pendingResponse?: { key: string; value: unknown }; completed: unknown[] });
}
function legacyCheckpoint(f: ReturnType<typeof fixture>, batch: CaptureBatch, final = false) {
  const prepared = prepareAnalysis(f.store, batch, { deduplicateAttachments: false, documentGrouping: false, passiveQuestionFilter: false, noticeFirst: false });
  const units = prepared.units.map(({ text, imageDataUrl, ...unit }) => ({ ...unit, textHash: hashInput(text), imageHash: imageDataUrl ? hashInput(imageDataUrl) : null }));
  const profile = locationProfile(f.repository.snapshot().settings);
  const profileFingerprint = profile.campus || profile.locationContext ? { userProfile: profile } : {};
  const completed = [];
  for (let offset = 0; offset < prepared.units.length; offset += 30) {
    const group = prepared.units.slice(offset, offset + 30), unit = group[0]!;
    completed.push({ key: hashInput(group.map(item => item.id)), value: { candidates: [candidate(unit.id, unit.text, {
      title: `完成第 ${offset / 30 + 1} 项活动`, action: `完成独立活动 ${offset / 30 + 1}`,
    })] } });
  }
  return { ...prepared, units, planFingerprint: hashInput({ version: ANALYSIS_VERSION, model: f.repository.snapshot().settings.model,
    ...profileFingerprint, units, context: prepared.context, warnings: prepared.warnings }), completed, final };
}

describe('QQ durable paid responses and incremental progress', () => {
  it('does not resurrect a candidate deleted while a later paid response is in flight', async () => {
    const f = fixture(); let calls = 0;
    await expect(analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      calls++; const sent = input(request);
      if (calls === 1) return response({ candidates: [candidate(sent.units[0]!.id, sent.units[0]!.text)] });
      const original = f.repository.snapshot().candidates[0]!;
      f.repository.writeInternal({ operationId: 'synthetic-user-delete', changes: [{ entity: 'candidate', id: original.id, expectedVersion: original.version, delete: true }] });
      return response({ candidates: [candidate(sent.units[0]!.id, sent.units[0]!.text, { relation: { kind: 'supplement', candidateId: original.id } })] });
    } })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(f.repository.snapshot().candidates).toEqual([]); expect(savedResponse(f).pendingResponse).toBeDefined();
    f.reopen();
    await expect(analyzeCapture({ ...options(f), batch: f.claimRetry(), fetch: async () => { calls++; return response({ candidates: [] }); } })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(calls).toBe(2); expect(f.repository.snapshot().candidates).toEqual([]);
  });

  it('recovers a committed fragment even when notification crashes before the next checkpoint', async () => {
    const f = fixture(1); let calls = 0;
    await expect(analyzeCapture({ ...options(f), onProgress: () => { throw Error('synthetic crash after commit'); }, fetch: async (_url, request) => {
      calls++; const sent = input(request); return response({ candidates: [candidate(sent.units[0]!.id, sent.units[0]!.text)] });
    } })).rejects.toThrow('synthetic crash after commit');
    const before = f.repository.snapshot(); expect(before.candidates).toHaveLength(1);
    f.reopen();
    await analyzeCapture({ ...options(f), batch: f.claimRetry(), fetch: async () => { calls++; return response({ candidates: [] }); } });
    expect(calls).toBe(1); expect(f.repository.snapshot().candidates).toEqual(before.candidates);
    expect(f.repository.snapshot().sources).toEqual(before.sources); expect(f.store.batch(f.batch.id)?.status).toBe('applied');
  });

  it.each(['accepted', 'ignored', 'edited'] as const)('respects a candidate %s by the user before the next fragment arrives', async choice => {
    const f = fixture(); let calls = 0; let original: Candidate | undefined;
    let acceptedTask: ReturnType<typeof f.repository.snapshot>['tasks'][number] | undefined;
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      calls++; const sent = input(request);
      if (calls === 1) return response({ candidates: [candidate(sent.units[0]!.id, sent.units[0]!.text)] });
      const saved = f.repository.snapshot().candidates[0]!;
      expect(saved).toMatchObject({ status: 'pending' }); expect(sent.existingCandidates[0]!.id).toBe(saved.id);
      if (choice === 'accepted') {
        const task = f.repository.writeInternal({ operationId: 'synthetic-user-task', changes: [{ entity: 'task', values: {
          title: '用户安排的领取任务', description: '用户亲自填写的执行计划', candidateId: saved.id,
        } }] }).entities[0]!;
        f.repository.writeInternal({ operationId: 'synthetic-user-accept', changes: [{ entity: 'candidate', id: saved.id, expectedVersion: saved.version,
          values: { status: 'accepted', taskId: task.id } }] });
        acceptedTask = f.repository.snapshot().tasks[0];
      } else {
        f.repository.writeInternal({ operationId: `synthetic-user-${choice}`, changes: [{ entity: 'candidate', id: saved.id, expectedVersion: saved.version,
          values: choice === 'ignored' ? { status: 'ignored' } : { title: '用户改好的标题', action: '用户自行核对后的领取安排' } }] });
      }
      original = f.repository.snapshot().candidates.find(item => item.id === saved.id)!;
      return response({ candidates: [candidate(sent.units[0]!.id, sent.units[0]!.text, {
        action: '查看新增名单页', conditions: ['核对名单'], relation: { kind: 'supplement', candidateId: saved.id },
      })] });
    } });
    const snapshot = f.repository.snapshot(); expect(calls).toBe(2);
    const current = snapshot.candidates.find(item => item.id === original!.id)!;
    if (choice === 'accepted') {
      expect(current).toEqual(original); expect(snapshot.tasks).toEqual([acceptedTask]);
      expect(snapshot.candidates).toHaveLength(2);
      expect(snapshot.candidates.find(item => item.id !== current.id)).toMatchObject({ status: 'pending', revisionOfId: current.id });
    } else if (choice === 'ignored') {
      expect(current).toEqual(original); expect(snapshot.candidates).toHaveLength(1); expect(snapshot.sources).toHaveLength(1);
    } else {
      expect(snapshot.candidates).toHaveLength(1); expect(current.title).toBe('用户改好的标题');
      expect(current.action).toContain('用户自行核对后的领取安排'); expect(current.action).toContain('查看新增名单页');
      expect(current.action).not.toContain('获奖同学领取奖品'); expect(current.sourceIds).toHaveLength(2);
    }
  });

  it('persists invalid multi-primary JSON and retries its validation without another paid request', async () => {
    const f = fixture(2); let calls = 0; let paid: unknown;
    await expect(analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      calls++; const sent = input(request);
      paid = { candidates: [candidate(sent.units[0]!.id, sent.units[0]!.text, { sourceIds: sent.units.map(unit => unit.id) })] };
      return response(paid);
    } })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(savedResponse(f).pendingResponse?.value).toEqual(paid);
    expect(savedResponse(f).completed).toEqual([]);
    expect(f.repository.snapshot().candidates).toEqual([]);
    const before = savedResponse(f).pendingResponse;
    f.reopen();
    await expect(analyzeCapture({ ...options(f), batch: f.claimRetry(), fetch: async () => {
      calls++; return response({ candidates: [] });
    } })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(calls).toBe(1); expect(savedResponse(f).pendingResponse).toEqual(before);
    expect(f.repository.snapshot().tokenUsage).toHaveLength(1); expect(f.repository.snapshot().candidates).toEqual([]);
  });

  it('consumes a saved valid paid response after checkpoint promotion fails, with no additional fetch', async () => {
    const f = fixture(1); let calls = 0, hasPersistedPaidResponse = false; let paid: unknown;
    const checkpoint = f.store.checkpointResult.bind(f.store);
    const spy = vi.spyOn(f.store, 'checkpointResult').mockImplementation((id, result, ...rest) => {
      const value = result as { pendingResponse?: unknown; completed?: unknown[] };
      if (!value.pendingResponse && value.completed?.length && savedResponse(f).pendingResponse) {
        hasPersistedPaidResponse = true; throw Error('synthetic checkpoint promotion failure');
      }
      return checkpoint(id, result, ...rest);
    });
    await expect(analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      calls++; const sent = input(request); paid = { candidates: [candidate(sent.units[0]!.id, sent.units[0]!.text)] }; return response(paid);
    } })).rejects.toThrow('synthetic checkpoint promotion failure');
    expect(hasPersistedPaidResponse).toBe(true); expect(savedResponse(f).pendingResponse?.value).toEqual(paid);
    spy.mockRestore(); f.reopen();
    await analyzeCapture({ ...options(f), batch: f.claimRetry(), fetch: async () => { calls++; return response({ candidates: [] }); } });
    const snapshot = f.repository.snapshot();
    expect(calls).toBe(1); expect(snapshot.tokenUsage).toHaveLength(1);
    expect(snapshot.candidates).toHaveLength(1); expect(snapshot.sources).toHaveLength(1);
    expect(savedResponse(f).pendingResponse).toBeUndefined(); expect(f.store.batch(f.batch.id)?.status).toBe('applied');
  });

  it('applies seven legacy completed groups before new work without replaying any paid request', async () => {
    const f = fixture(210), checkpoint = legacyCheckpoint(f, f.batch); let calls = 0;
    expect(checkpoint.completed).toHaveLength(7);
    f.store.startAttempt(f.batch.id, 'synthetic-legacy-paid'); f.store.checkpointResult(f.batch.id, checkpoint);
    await analyzeCapture({ ...options(f), batch: f.store.batch(f.batch.id)!, fetch: async () => { calls++; return response({ candidates: [] }); } });
    expect(calls).toBe(0); expect(f.repository.snapshot().candidates).toHaveLength(7); expect(f.repository.snapshot().sources).toHaveLength(7);
    const before = f.repository.snapshot();
    applyCaptureResult(f.store, f.repository, f.store.batch(f.batch.id)!);
    expect(f.repository.snapshot().candidates).toEqual(before.candidates); expect(f.repository.snapshot().sources).toEqual(before.sources);
  });

  it('resolves a legacy paid checkpoint relation from its old staged ID to one real candidate', async () => {
    const f = fixture(31), checkpoint = legacyCheckpoint(f, f.batch); let calls = 0;
    const first = checkpoint.completed[0]!, second = checkpoint.completed[1]!;
    const oldStageId = `qq-stage:${createHash('sha256').update(JSON.stringify([f.batch.operationId, first.key, 0])).digest('hex')}`;
    second.value.candidates[0]!.relation = { kind: 'supplement', candidateId: oldStageId };
    f.store.startAttempt(f.batch.id, 'synthetic-legacy-staged-paid'); f.store.checkpointResult(f.batch.id, checkpoint);
    await analyzeCapture({ ...options(f), batch: f.store.batch(f.batch.id)!, fetch: async () => { calls++; return response({ candidates: [] }); } });
    const snapshot = f.repository.snapshot();
    expect(calls).toBe(0); expect(snapshot.candidates).toHaveLength(1); expect(snapshot.sources).toHaveLength(2);
    expect(snapshot.candidates[0]!.id).not.toBe(oldStageId); expect(snapshot.candidates[0]!.sourceIds).toHaveLength(2);
    expect(snapshot.candidates[0]!.action).toContain('完成独立活动 1'); expect(snapshot.candidates[0]!.action).toContain('完成独立活动 2');
  });

  it('honors an existing legacy final-batch receipt without creating incremental duplicates', async () => {
    const f = fixture(1), checkpoint = legacyCheckpoint(f, f.batch, true);
    const source = f.repository.writeInternal({ operationId: 'synthetic-legacy-source', changes: [{ entity: 'source', values: {
      kind: 'text', text: '合成旧来源', importedAt: at, sentAt: at,
      captureRef: { accountId: '100', groupId: '200', messageId: 'legacy-message', attachmentId: null, locator: '旧来源', transcribed: false },
    } }] }).entities[0]!;
    f.repository.writeInternal({ operationId: 'synthetic-legacy-candidate', changes: [{ entity: 'candidate', values: {
      title: '用户已修改的旧候选', action: '保留用户当前内容', sourceIds: [source.id], sourceQuote: '合成旧来源', status: 'pending',
    } }] });
    f.repository.transact(state => { state.operations.push({ id: f.batch.operationId, fingerprint: hashInput(checkpoint), result: { entities: [] } }); });
    f.store.saveResult(f.batch.id, checkpoint); const before = f.repository.snapshot(); let calls = 0;
    // A completed legacy receipt needs no document rehydration, even if its cache changed later.
    const attachment = f.store.attachments(f.batch.messageIds[0]!)[0]!;
    f.store.saveExtraction(attachment.id, { extractorVersion: 'synthetic-new-cache', chunks: [{ ordinal: 0, location: '新的缓存', text: '原分片缓存已经变化', imageDataUrl: null, status: 'ready', error: null }] });
    await analyzeCapture({ ...options(f), batch: f.store.batch(f.batch.id)!, fetch: async () => { calls++; return response({ candidates: [] }); } });
    expect(calls).toBe(0); expect(f.repository.snapshot().candidates).toEqual(before.candidates);
    expect(f.repository.snapshot().sources).toEqual(before.sources); expect(f.store.batch(f.batch.id)?.status).toBe('applied');
  });
});
