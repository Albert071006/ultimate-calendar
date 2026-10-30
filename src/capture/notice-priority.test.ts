import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from './store';
import { ANALYSIS_VERSION, analyzeCapture, hashInput, prepareAnalysis } from './analysis';
import { locationProfile } from '../ai/prompts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const at = '2032-10-08T10:00:00+08:00';
function fixture(count = 870) {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-notice-priority-'));
  const path = join(directory, 'planner.sqlite'), repository = createRepository(path, { automaticBackup: () => {} }), store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200'] });
  const fileId = store.ingest([{ accountId: '100', groupId: '200', messageId: 'file', text: '', sentAt: at, importedAt: at,
    attachments: [{ kind: 'file', name: '合成课程复习题.docx' }] }]).ids[0]!;
  const paragraphs = Array.from({ length: count }, (_, ordinal) => `第${ordinal + 1}题：请选择正确答案。A.合成选项甲 B.合成选项乙 C.合成选项丙。`);
  store.saveExtraction(store.attachments(fileId)[0]!.id, { extractorVersion: 'synthetic', chunks: paragraphs.map((text, ordinal) => ({
    ordinal, location: `正文/段落 ${ordinal + 1}`, text, imageDataUrl: null, status: 'ready', error: null,
  })) });
  const noticeId = store.ingest([{ accountId: '100', groupId: '200', messageId: 'notice', text: '期中考试安排在第11周，请根据附件复习。', sentAt: '2032-10-08T10:00:04+08:00', importedAt: at }]).ids[0]!;
  store.sealBatches({ force: true }); const batch = store.claimBatch()!;
  return { store, repository, batch, fileId, noticeId, paragraphs };
}
function input(request?: RequestInit) {
  return JSON.parse(JSON.parse(String(request?.body)).messages.find((message: { role: string }) => message.role === 'user').content[0].text) as {
    units: { id: string; messageId: string; text: string; attachmentId: string | null }[];
  };
}
function response(candidates: unknown[] = []) { return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); }
function notice(sourceId: string) {
  return { title: '课程期中考试', action: '按通知准备期中考试', benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: [],
    uncertainties: ['第11周的具体日期待确认'], sourceIds: [sourceId], sourceQuote: '期中考试安排在第11周', deadline: null, eventStart: null,
    eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'new', candidateId: null } };
}
describe('notice first and compact document analysis', () => {
  it('delivers the later notice before its 870-paragraph attachment, preserving all paragraph text', async () => {
    const f = fixture(), plan = prepareAnalysis(f.store, f.batch);
    const document = plan.units.filter(unit => unit.attachmentId);
    expect(document.length).toBeLessThan(5);
    expect(document.every(unit => unit.text.length <= 16_000)).toBe(true);
    expect(document.map(unit => unit.text).join('\n')).toBe(f.paragraphs.join('\n'));
    expect(document[0]!.locator).toContain('正文/段落 1 ～');
    let calls = 0;
    await analyzeCapture({ ...f, getApiKey: async () => 'synthetic', canContinue: () => true, requestBudget: 1, fetch: async (_url, request) => {
      calls++; const sent = input(request);
      expect(sent.units.map(unit => unit.messageId)).toEqual([f.noticeId]);
      return response([notice(sent.units[0]!.id)]);
    } });
    expect(calls).toBe(1);
    expect(f.repository.snapshot().candidates[0]?.title).toBe('课程期中考试');
    expect(f.store.batch(f.batch.id)?.status).toBe('pending');
    await analyzeCapture({ ...f, batch: f.store.claimBatch()!, getApiKey: async () => 'synthetic', canContinue: () => true, fetch: async (_url, request) => {
      calls++; expect(input(request).units.every(unit => unit.attachmentId)).toBe(true); return response();
    } });
    expect(calls).toBeLessThanOrEqual(3);
    expect(f.store.batch(f.batch.id)?.status).toBe('applied');
    expect(f.repository.snapshot().candidates).toHaveLength(1);
  });
  it('resumes a legacy paid answer first, then prioritizes the notice without changing old keys or repaying', async () => {
    const f = fixture(90), prepared = prepareAnalysis(f.store, f.batch, { noticeFirst: false });
    expect(prepared.units).toHaveLength(91);
    const units = prepared.units.map(({ text, imageDataUrl, ...unit }) => ({ ...unit, textHash: hashInput(text), imageHash: imageDataUrl ? hashInput(imageDataUrl) : null }));
    const profile = locationProfile(f.repository.snapshot().settings);
    const groupKey = (start: number, end: number) => hashInput(prepared.units.slice(start, end).map(unit => unit.id));
    const checkpoint = { ...prepared, units, planFingerprint: hashInput({ version: ANALYSIS_VERSION, model: f.repository.snapshot().settings.model,
      ...(profile.campus || profile.locationContext ? { userProfile: profile } : {}), attachmentDedupe: 1, documentGrouping: 1, passiveQuestionFilter: 1,
      units, context: prepared.context, warnings: prepared.warnings }), completed: [{ key: groupKey(0, 30), value: { candidates: [] } }], final: false,
      pendingResponse: { key: groupKey(30, 60), value: { candidates: [] }, candidateIds: [] } };
    f.store.startAttempt(f.batch.id, 'already-paid'); f.store.savePendingResponse(f.batch.id, checkpoint);
    let calls = 0;
    await analyzeCapture({ ...f, batch: f.store.batch(f.batch.id)!, requestBudget: 1, getApiKey: async () => 'synthetic', canContinue: () => true,
      fetch: async (_url, request) => { calls++; const sent = input(request); expect(sent.units.map(unit => unit.messageId)).toEqual([f.noticeId]); return response([notice(sent.units[0]!.id)]); } });
    const saved = f.store.batch(f.batch.id)!.result as unknown as typeof checkpoint;
    expect(calls).toBe(1); expect(saved.units).toEqual(units); expect(saved.planFingerprint).toBe(checkpoint.planFingerprint);
    expect(saved.pendingResponse).toBeUndefined(); expect(saved.completed.map(group => group.key)).toEqual([groupKey(0, 30), groupKey(30, 60), groupKey(90, 91)]);
    expect(f.repository.snapshot().candidates).toHaveLength(1); expect(f.store.batch(f.batch.id)?.status).toBe('pending');
  });
});
