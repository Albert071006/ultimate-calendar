import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from './store';
import { ANALYSIS_VERSION, analyzeCapture, applyCaptureResult, hashInput, prepareAnalysis } from './analysis';
import { locationProfile } from '../ai/prompts';
import type { ExtractedCandidate } from '../ai/schemas';
import type { Candidate } from '../shared/contracts';

type Extracted = ExtractedCandidate & { eventKey: string; supportingSources: { sourceId: string; quote: string }[] };
type Input = { units: { id: string; text: string }[]; existingCandidates: { id: string; title: string; action: string }[] };
const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });
const at = '2030-04-20T12:00:00+08:00';
const quotes = ['练习1：在给定程序中增加求平均值的功能。', '思考：编写测试代码验证未赋值元素。', '练习：课件中的排序法；教材例6.1和例6.2。'];
const steps = ['在给定程序中增加平均值计算', '编写测试代码验证未赋值元素', '完成课件排序练习和教材例6.1、例6.2'];
const title = '完成线性表练习';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-document-practice-')), path = join(directory, 'planner.sqlite');
  let repository = createRepository(path, { automaticBackup: () => {} }), store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200'] });
  const message = store.ingest([{ accountId: '100', groupId: '200', messageId: 'synthetic-course', text: '', sentAt: at, importedAt: at,
    attachments: [{ kind: 'file', name: '合成课堂资料.doc' }] }]).ids[0]!;
  const attachmentId = store.attachments(message)[0]!.id;
  store.saveExtraction(attachmentId, { extractorVersion: 'synthetic', chunks: Array.from({ length: 61 }, (_, ordinal) => ({
    ordinal, location: `段落 ${ordinal + 1}`, text: ordinal % 30 === 0
      ? `${ordinal === 0 ? '第六章 线性表\n教材配套课堂练习\n' : ''}${quotes[ordinal / 30]!}` : `课件说明第 ${ordinal + 1} 段：参考示例代码和教材。`,
    imageDataUrl: null, status: 'ready' as const, error: null,
  })) });
  store.sealBatches({ force: true }); const batch = store.claimBatch()!;
  return { batch, attachmentId, get repository() { return repository; }, get store() { return store; },
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
function extracted(sent: Input, index: number, relation: ExtractedCandidate['relation'] = { kind: 'new', candidateId: null }): Extracted {
  return { title: `完成第 ${index + 1} 个具体练习`, action: steps[index]!, benefit: '', benefitKind: 'unknown', potentialBenefit: '',
    conditions: [], uncertainties: [], sourceIds: [sent.units[0]!.id], sourceQuote: quotes[index]!, deadline: null, eventStart: null, eventEnd: null,
    location: '', temporalEvidence: [], relation, eventKey: `different-exercise-${index}`,
    supportingSources: sent.units.slice(1, 2).map(unit => ({ sourceId: unit.id, quote: unit.text })),
  };
}
function response(value: Extracted) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [value] }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
}
function checkpoint(f: ReturnType<typeof fixture>) {
  return f.store.batch(f.batch.id)!.result as unknown as { documentGrouping?: number; pendingResponse?: { value: unknown }; completed: unknown[] };
}

describe('document practice grouping across durable incremental responses', () => {
  it.each(['new', 'supplement', 'duplicate'] as const)('keeps three %s exercise results as one card with every step and source, and reapplies idempotently', async kind => {
    const f = fixture(); let calls = 0, rootId = '';
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      const sent = input(request), index = calls++;
      expect(sent.units).toHaveLength(index < 2 ? 30 : 1);
      if (index) {
        const saved = f.repository.snapshot().candidates;
        expect(saved).toHaveLength(1); expect(saved[0]!.title).toBe(title);
        rootId ||= saved[0]!.id; expect(saved[0]!.id).toBe(rootId);
      }
      return response(extracted(sent, index, index && kind !== 'new' ? { kind, candidateId: rootId } : undefined));
    } });
    const before = f.repository.snapshot(), card = before.candidates[0]!;
    expect(checkpoint(f).documentGrouping).toBe(1); expect(calls).toBe(3); expect(before.candidates).toHaveLength(1);
    expect(card).toMatchObject({ id: rootId, title, status: 'pending', sourceQuote: quotes[0] });
    expect(card.action).toBe(`完成线性表相关练习。\n${steps.map(step => `• ${step}`).join('\n')}`);
    expect(card.sourceIds).toHaveLength(5); expect(before.sources).toHaveLength(5);
    expect(new Set(card.sourceIds)).toEqual(new Set(before.sources.map(source => source.id)));
    for (const quote of quotes) expect(before.sources.some(source => source.text.includes(quote))).toBe(true);
    expect(before.sources.every(source => source.captureRef?.attachmentId === f.attachmentId)).toBe(true);
    applyCaptureResult(f.store, f.repository, f.store.batch(f.batch.id)!);
    expect(f.repository.snapshot().candidates).toEqual(before.candidates); expect(f.repository.snapshot().sources).toEqual(before.sources);
  });

  it('appends later exercises without restoring a title or first step edited by the user', async () => {
    const f = fixture(); let calls = 0;
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      const sent = input(request), index = calls++;
      if (index === 1) {
        const saved = f.repository.snapshot().candidates[0]!;
        f.repository.writeInternal({ operationId: 'synthetic-user-edit', changes: [{ entity: 'candidate', id: saved.id, expectedVersion: saved.version,
          values: { title: '我的课堂练习安排', action: '我已经核对第一题，只保留自己的做法' } }] });
      }
      return response(extracted(sent, index));
    } });
    const cards = f.repository.snapshot().candidates;
    expect(cards).toHaveLength(1); expect(cards[0]!.title).toBe('我的课堂练习安排');
    expect(cards[0]!.action).toBe(`我已经核对第一题，只保留自己的做法\n• ${steps[1]}\n• ${steps[2]}`);
    expect(cards[0]!.sourceIds).toHaveLength(5);
  });

  it('does not revive an ignored assignment when later exercises arrive', async () => {
    const f = fixture(); let calls = 0, ignored: Candidate | undefined;
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      const sent = input(request), index = calls++;
      if (index === 1) {
        const saved = f.repository.snapshot().candidates[0]!;
        f.repository.writeInternal({ operationId: 'synthetic-user-ignore', changes: [{ entity: 'candidate', id: saved.id, expectedVersion: saved.version, values: { status: 'ignored' } }] });
        ignored = f.repository.snapshot().candidates[0]!;
      }
      return response(extracted(sent, index));
    } });
    expect(calls).toBe(3); expect(f.repository.snapshot().candidates).toEqual([ignored]); expect(f.repository.snapshot().sources).toHaveLength(2);
  });

  it('keeps an accepted task intact and groups the two later exercises into one revision of the original card', async () => {
    const f = fixture(); let calls = 0, accepted: Candidate | undefined;
    let tasks: ReturnType<typeof f.repository.snapshot>['tasks'] = [];
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      const sent = input(request), index = calls++;
      if (index === 1) {
        const saved = f.repository.snapshot().candidates[0]!;
        const task = f.repository.writeInternal({ operationId: 'synthetic-user-task', changes: [{ entity: 'task', values: {
          title: '我安排好的课堂练习', description: '用户已决定的执行方法', candidateId: saved.id,
        } }] }).entities[0]!;
        f.repository.writeInternal({ operationId: 'synthetic-user-accept', changes: [{ entity: 'candidate', id: saved.id, expectedVersion: saved.version,
          values: { status: 'accepted', taskId: task.id } }] });
        accepted = f.repository.snapshot().candidates[0]!; tasks = f.repository.snapshot().tasks;
      }
      return response(extracted(sent, index));
    } });
    const snapshot = f.repository.snapshot(); expect(calls).toBe(3); expect(snapshot.tasks).toEqual(tasks); expect(snapshot.candidates).toHaveLength(2);
    expect(snapshot.candidates.find(card => card.id === accepted!.id)).toEqual(accepted);
    const revision = snapshot.candidates.find(card => card.id !== accepted!.id)!;
    expect(revision).toMatchObject({ status: 'pending', revisionOfId: accepted!.id, taskId: null });
    for (const step of steps) expect(revision.action).toContain(step);
    expect(revision.sourceIds).toHaveLength(5);
  });

  it('does not recreate a deleted first card or repeat its later paid response after restart', async () => {
    const f = fixture(); let calls = 0;
    await expect(analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      const sent = input(request), index = calls++;
      if (index === 1) {
        const saved = f.repository.snapshot().candidates[0]!;
        f.repository.writeInternal({ operationId: 'synthetic-user-delete', changes: [{ entity: 'candidate', id: saved.id, expectedVersion: saved.version, delete: true }] });
      }
      return response(extracted(sent, index));
    } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.repository.snapshot().candidates).toEqual([]); const paid = checkpoint(f).pendingResponse;
    expect(paid).toBeDefined(); f.reopen();
    await expect(analyzeCapture({ ...options(f), batch: f.retry(), fetch: async () => { calls++; throw Error('must not repeat paid request'); } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(calls).toBe(2); expect(checkpoint(f).pendingResponse).toEqual(paid); expect(f.repository.snapshot().candidates).toEqual([]);
  });

  it('reuses the second durable paid response after a crash and finishes the same assignment on restart', async () => {
    const f = fixture(); let calls = 0;
    const save = f.store.checkpointResult.bind(f.store);
    const spy = vi.spyOn(f.store, 'checkpointResult').mockImplementation((id, result, ...rest) => {
      const value = result as { pendingResponse?: unknown; completed?: unknown[] };
      if (!value.pendingResponse && value.completed?.length === 2 && checkpoint(f).pendingResponse) throw Error('synthetic promotion crash');
      return save(id, result, ...rest);
    });
    await expect(analyzeCapture({ ...options(f), fetch: async (_url, request) => response(extracted(input(request), calls++)) })).rejects.toThrow('synthetic promotion crash');
    expect(calls).toBe(2); expect(checkpoint(f).pendingResponse).toBeDefined(); const rootId = f.repository.snapshot().candidates[0]!.id;
    spy.mockRestore(); f.reopen();
    await analyzeCapture({ ...options(f), batch: f.retry(), fetch: async (_url, request) => {
      const sent = input(request); expect(sent.units).toHaveLength(1); return response(extracted(sent, calls++));
    } });
    const snapshot = f.repository.snapshot(); expect(calls).toBe(3); expect(snapshot.tokenUsage).toHaveLength(3); expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]!.id).toBe(rootId); for (const step of steps) expect(snapshot.candidates[0]!.action).toContain(step);
    expect(snapshot.sources).toHaveLength(5); expect(checkpoint(f).pendingResponse).toBeUndefined(); expect(f.store.batch(f.batch.id)!.status).toBe('applied');
  });

  it('leaves a legacy checkpoint without the strategy marker unchanged', async () => {
    const f = fixture(), prepared = prepareAnalysis(f.store, f.batch, { deduplicateAttachments: false, documentGrouping: false, passiveQuestionFilter: false, noticeFirst: false });
    const units = prepared.units.map(({ text, imageDataUrl, ...unit }) => ({ ...unit, textHash: hashInput(text), imageHash: imageDataUrl ? hashInput(imageDataUrl) : null }));
    const profile = locationProfile(f.repository.snapshot().settings), profileFingerprint = profile.campus || profile.locationContext ? { userProfile: profile } : {};
    const completed = [0, 30, 60].map((offset, index) => {
      const group = prepared.units.slice(offset, offset + 30);
      return { key: hashInput(group.map(unit => unit.id)), value: { candidates: [extracted({ units: group, existingCandidates: [] }, index)] } };
    });
    f.store.startAttempt(f.batch.id, 'synthetic-legacy-practice');
    f.store.checkpointResult(f.batch.id, { ...prepared, units, planFingerprint: hashInput({ version: ANALYSIS_VERSION, model: f.repository.snapshot().settings.model,
      ...profileFingerprint, units, context: prepared.context, warnings: prepared.warnings }), completed, final: false });
    let calls = 0;
    await analyzeCapture({ ...options(f), batch: f.store.batch(f.batch.id)!, fetch: async () => { calls++; throw Error('must reuse legacy paid results'); } });
    expect(calls).toBe(0); expect(checkpoint(f).documentGrouping).toBeUndefined(); expect(f.repository.snapshot().candidates).toHaveLength(3);
    expect(new Set(f.repository.snapshot().candidates.map(card => card.action))).toEqual(new Set(steps));
  });
});
