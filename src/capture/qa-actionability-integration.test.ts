import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from './store';
import { ANALYSIS_VERSION, analyzeCapture, applyCaptureResult, hashInput, prepareAnalysis } from './analysis';
import { locationProfile } from '../ai/prompts';
import type { ExtractedCandidate } from '../ai/schemas';

type Extracted = ExtractedCandidate & { supportingSources: { sourceId: string; quote: string }[]; eventKey?: string };
type Unit = { id: string; text: string; messageId: string; recipient: { sender: string; audience: string } };
type Input = { units: Unit[] };
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });
const at = '2030-04-20T12:00:00+08:00';
const ruleDialogue = ['短片四分钟可以参赛吗', '可以', '谢谢'];
const benefitDialogue = ['上传作品就有奖励吗', '参加选拔就有参与奖励，获奖还有额外奖励。'];
function fixture(texts: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-qa-actionability-')), path = join(directory, 'planner.sqlite');
  let repository = createRepository(path, { automaticBackup: () => {} }), store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200'] });
  const ids = store.ingest(texts.map((text, index) => ({ accountId: '100', groupId: '200', messageId: `synthetic-dialogue-${index}`,
    senderId: index % 2 ? '400' : '300', text, sentAt: at, importedAt: at,
    segments: [{ type: 'text', data: { text } }],
  }))).ids;
  store.sealBatches({ force: true }); const batch = store.claimBatch()!;
  return { batch, ids, get repository() { return repository; }, get store() { return store; },
    reopen() { store.close(); repository.close(); repository = createRepository(path, { automaticBackup: () => {} }); store = createCaptureStore(path); },
    retry() { const status = store.batch(batch.id)!.status; if (status === 'failed' || status === 'uncertain') store.retryBatch(batch.id); return store.claimBatch()!; },
  };
}
function options(f: ReturnType<typeof fixture>) {
  return { store: f.store, repository: f.repository, batch: f.batch, getApiKey: async () => 'synthetic', canContinue: () => true };
}
function input(request?: RequestInit): Input {
  return JSON.parse(JSON.parse(String(request?.body)).messages.find((message: { role: string }) => message.role === 'user').content[0].text);
}
function extracted(unit: Pick<Unit, 'id' | 'text'>, support: Pick<Unit, 'id' | 'text'>[] = [], changes: Partial<ExtractedCandidate> = {}): Extracted {
  return { title: '确认作品参赛要求', action: '确认四分钟短片是否符合参赛时长要求', benefit: '', benefitKind: 'unknown', potentialBenefit: '',
    conditions: [], uncertainties: [], sourceIds: [unit.id], sourceQuote: unit.text, deadline: null, eventStart: null, eventEnd: null,
    location: '', temporalEvidence: [], relation: { kind: 'new', candidateId: null },
    supportingSources: support.map(item => ({ sourceId: item.id, quote: item.text })), ...changes,
  };
}
function response(candidates: Extracted[]) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
}
function checkpoint(f: ReturnType<typeof fixture>) {
  return f.store.batch(f.batch.id)!.result as unknown as { passiveQuestionFilter?: number; pendingResponse?: { value: unknown };
    completed: { value: { candidates: Extracted[] } }[] };
}

describe('passive group questions in durable capture analysis', () => {
  it.each(['new', 'uncertain'] as const)('suppresses an invented %s confirmation from a rules question and keeps the raw conversation and paid answer', async kind => {
    const f = fixture(ruleDialogue); let calls = 0, paid: Extracted | undefined;
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      calls++; const sent = input(request);
      expect(sent.units).toHaveLength(3);
      expect(sent.units.every(unit => unit.recipient.sender === 'other' && unit.recipient.audience === 'unspecified')).toBe(true);
      paid = extracted(sent.units[0]!, sent.units.slice(1), { relation: { kind, candidateId: null } });
      return response([paid]);
    } });
    expect(calls).toBe(1); expect(checkpoint(f).passiveQuestionFilter).toBe(1);
    expect(f.repository.snapshot()).toMatchObject({ candidates: [], sources: [] });
    expect(f.repository.snapshot().tokenUsage).toHaveLength(1);
    expect(f.store.batchMessages(f.batch.id).map(message => message.text)).toEqual(ruleDialogue);
    expect(checkpoint(f).completed[0]!.value.candidates).toEqual([paid]);
    expect(f.store.batch(f.batch.id)!.status).toBe('applied');
    f.reopen();
    applyCaptureResult(f.store, f.repository, f.store.batch(f.batch.id)!);
    await analyzeCapture({ ...options(f), batch: f.store.batch(f.batch.id)!, getApiKey: async () => { throw Error('must not request a key'); },
      fetch: async () => { calls++; throw Error('must not repeat paid answer'); } });
    expect(calls).toBe(1); expect(f.repository.snapshot()).toMatchObject({ candidates: [], sources: [] });
    expect(f.repository.snapshot().tokenUsage).toHaveLength(1); expect(checkpoint(f).completed[0]!.value.candidates).toEqual([paid]);
  });

  it('also suppresses a confirmation whose primary source is an answer and whose support is the rules question', async () => {
    const f = fixture(benefitDialogue);
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      const sent = input(request);
      return response([extracted(sent.units[1]!, [sent.units[0]!], { title: '核实作品参与奖励', action: '核实上传作品后能否获得参与奖励' })]);
    } });
    expect(f.repository.snapshot()).toMatchObject({ candidates: [], sources: [] });
    expect(checkpoint(f).completed[0]!.value.candidates).toHaveLength(1);
    expect(f.store.batchMessages(f.batch.id).map(message => message.text)).toEqual(benefitDialogue);
  });

  it('keeps public submission notices and requests for help even when the model phrases them as confirmation tasks', async () => {
    const texts = ['请各位周五提交表格', '能帮忙交材料吗'], f = fixture(texts);
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      const sent = input(request);
      return response([
        extracted(sent.units[0]!, [], { title: '确认并提交表格', action: '确认表格内容并按通知提交' }),
        extracted(sent.units[1]!, [], { title: '确认材料并协助递交', action: '确认材料后帮忙递交' }),
      ]);
    } });
    const snapshot = f.repository.snapshot(); expect(snapshot.candidates).toHaveLength(2); expect(snapshot.sources).toHaveLength(2);
    expect(new Set(snapshot.candidates.map(candidate => candidate.sourceQuote))).toEqual(new Set(texts));
    expect(snapshot.candidates.every(candidate => candidate.status === 'pending')).toBe(true);
  });

  it('keeps a paid response for review when a later same-event entry points at a suppressed question', async () => {
    const f = fixture(ruleDialogue); let calls = 0;
    await expect(analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      calls++; const sent = input(request);
      return response([
        { ...extracted(sent.units[0]!, sent.units.slice(1)), eventKey: 'synthetic-rule-dialogue' },
        { ...extracted(sent.units[1]!, [], { title: '了解参赛规则', action: '了解短片可以参赛' }), eventKey: 'synthetic-rule-dialogue' },
      ]);
    } })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    const paid = checkpoint(f).pendingResponse;
    expect(paid).toBeDefined(); expect(f.repository.snapshot()).toMatchObject({ candidates: [], sources: [] });
    f.reopen();
    await expect(analyzeCapture({ ...options(f), batch: f.retry(), fetch: async () => {
      calls++; throw Error('must not repeat a paid response');
    } })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(calls).toBe(1); expect(checkpoint(f).pendingResponse).toEqual(paid);
    expect(f.repository.snapshot()).toMatchObject({ candidates: [], sources: [] });
  });

  it('reuses a persisted paid response after a checkpoint crash and suppresses it without another request', async () => {
    const f = fixture(ruleDialogue); let calls = 0;
    const save = f.store.checkpointResult.bind(f.store);
    const spy = vi.spyOn(f.store, 'checkpointResult').mockImplementation((id, result, ...rest) => {
      const value = result as { pendingResponse?: unknown; completed?: unknown[] };
      if (!value.pendingResponse && value.completed?.length === 1 && checkpoint(f).pendingResponse) throw Error('synthetic promotion crash');
      return save(id, result, ...rest);
    });
    await expect(analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      calls++; const sent = input(request); return response([extracted(sent.units[0]!, sent.units.slice(1))]);
    } })).rejects.toThrow('synthetic promotion crash');
    const paid = checkpoint(f).pendingResponse!.value; expect(calls).toBe(1); expect(paid).toBeDefined();
    spy.mockRestore(); f.reopen();
    await analyzeCapture({ ...options(f), batch: f.retry(), getApiKey: async () => { throw Error('must reuse paid response before key lookup'); },
      fetch: async () => { calls++; throw Error('must not repeat paid answer'); } });
    expect(calls).toBe(1); expect(checkpoint(f).pendingResponse).toBeUndefined();
    expect(checkpoint(f).completed[0]!.value).toEqual(paid); expect(f.repository.snapshot()).toMatchObject({ candidates: [], sources: [] });
    expect(f.repository.snapshot().tokenUsage).toHaveLength(1); expect(f.store.batch(f.batch.id)!.status).toBe('applied');
  });

  it('reuses an unmarked legacy question checkpoint without newly suppressing its stored candidate', async () => {
    const f = fixture(ruleDialogue), prepared = prepareAnalysis(f.store, f.batch, {
      deduplicateAttachments: false, documentGrouping: false, passiveQuestionFilter: false, noticeFirst: false,
    });
    const units = prepared.units.map(({ text, imageDataUrl, ...unit }) => ({ ...unit, textHash: hashInput(text), imageHash: imageDataUrl ? hashInput(imageDataUrl) : null }));
    const profile = locationProfile(f.repository.snapshot().settings), profileFingerprint = profile.campus || profile.locationContext ? { userProfile: profile } : {};
    const paid = extracted(prepared.units[0]!, prepared.units.slice(1));
    f.store.startAttempt(f.batch.id, 'synthetic-legacy-question');
    f.store.checkpointResult(f.batch.id, { ...prepared, units, planFingerprint: hashInput({ version: ANALYSIS_VERSION, model: f.repository.snapshot().settings.model,
      ...profileFingerprint, units, context: prepared.context, warnings: prepared.warnings }),
      completed: [{ key: hashInput(prepared.units.map(unit => unit.id)), value: { candidates: [paid] } }], final: false });
    let calls = 0;
    await analyzeCapture({ ...options(f), batch: f.store.batch(f.batch.id)!, fetch: async () => { calls++; throw Error('must reuse legacy answer'); } });
    expect(calls).toBe(0); expect(checkpoint(f).passiveQuestionFilter).toBeUndefined();
    const before = f.repository.snapshot(); expect(before.candidates).toHaveLength(1); expect(before.sources).toHaveLength(3);
    expect(before.candidates[0]!).toMatchObject({ title: paid.title, action: paid.action, sourceQuote: ruleDialogue[0], status: 'pending' });
    f.reopen(); applyCaptureResult(f.store, f.repository, f.store.batch(f.batch.id)!);
    expect(f.repository.snapshot().candidates).toEqual(before.candidates); expect(f.repository.snapshot().sources).toEqual(before.sources);
  });
});
