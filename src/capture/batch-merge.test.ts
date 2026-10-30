import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from './store';
import { analyzeCapture, applyCaptureResult, prepareAnalysis } from './analysis';
import type { ExtractedCandidate } from '../ai/schemas';

type CaptureCandidate = ExtractedCandidate & { supportingSources?: { sourceId: string; quote: string }[]; eventKey?: string };
type Input = { units: { id: string; text: string; messageId: string; attachmentId: string | null }[]; existingCandidates: { id: string; title: string; action: string }[] };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const at = '2026-10-23T12:00:00+08:00';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-batch-merge-'));
  const path = join(directory, 'planner.sqlite');
  let repository = createRepository(path, { automaticBackup: () => {} });
  let store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200'] });
  return {
    get repository() { return repository; }, get store() { return store; },
    reopen() { store.close(); repository.close(); repository = createRepository(path, { automaticBackup: () => {} }); store = createCaptureStore(path); },
    message(messageId: string, text: string, minute = 0) {
      return store.ingest([{ accountId: '100', groupId: '200', messageId, text, sentAt: at,
        importedAt: `2026-10-23T12:${String(minute).padStart(2, '0')}:00+08:00` }]).ids[0]!;
    },
    seal() { store.sealBatches({ force: true }); return store.claimBatch()!; },
  };
}
function extracted(sourceId: string, quote: string, changes: Partial<CaptureCandidate> = {}): CaptureCandidate {
  return { title: '领取安全知识活动奖品', action: '获奖同学领取奖品', benefit: '', benefitKind: 'unknown', potentialBenefit: '',
    conditions: [], uncertainties: [], sourceIds: [sourceId], sourceQuote: quote, deadline: null, eventStart: null, eventEnd: null,
    location: '', temporalEvidence: [], relation: { kind: 'new', candidateId: null }, ...changes };
}
function response(candidates: CaptureCandidate[]) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
}
function input(request?: RequestInit): Input {
  return JSON.parse(JSON.parse(String(request?.body)).messages.find((message: { role: string }) => message.role === 'user').content[0].text);
}
function options(f: ReturnType<typeof fixture>) { return { store: f.store, repository: f.repository, getApiKey: async () => 'synthetic', canContinue: () => true }; }

function tableBatch(f: ReturnType<typeof fixture>) {
  const message = f.store.ingest([{ accountId: '100', groupId: '200', messageId: 'award-table', text: '', sentAt: at, importedAt: at,
    attachments: [{ kind: 'file', name: '合成获奖名单.xlsx' }] }]).ids[0]!;
  const attachment = f.store.attachments(message)[0]!;
  f.store.saveExtraction(attachment.id, { extractorVersion: 'synthetic', chunks: Array.from({ length: 31 }, (_, ordinal) => ({
    ordinal, location: `表格第 ${ordinal + 1} 页`, text: `安全知识活动获奖名单第 ${ordinal + 1} 页：示例同学${ordinal + 1}；请领取奖品`,
    imageDataUrl: null, status: 'ready' as const, error: null,
  })) });
  const followup = f.message('award-followup', '获奖名单中的同学请携带校园卡领取奖品', 1);
  return { batch: f.seal(), message, followup };
}

describe('QQ batch event evidence and incremental candidate application', () => {
  it('keeps a fire-safety image and its following text as two actual sources of one candidate', async () => {
    const f = fixture();
    const imageMessage = f.store.ingest([{ accountId: '100', groupId: '200', messageId: 'safety-image', sentAt: at, importedAt: at,
      attachments: [{ kind: 'image', name: '合成消防通知.png' }] }]).ids[0]!;
    f.store.saveExtraction(f.store.attachments(imageMessage)[0]!.id, { extractorVersion: 'synthetic', chunks: [{ ordinal: 0, location: '图片',
      text: '', imageDataUrl: 'data:image/png;base64,AAAA', status: 'ready', error: null }] });
    const textMessage = f.message('safety-text', '请遵守上图电动车及宿舍消防安全规定', 1);
    const batch = f.seal(); let calls = 0;
    await analyzeCapture({ ...options(f), batch, fetch: async (_url, request) => {
      calls++; const sent = input(request);
      expect(sent.units).toHaveLength(1);
      if (calls === 1) {
        const text = sent.units[0]!;
        expect(text).toMatchObject({ messageId: textMessage, attachmentId: null });
        return response([extracted(text.id, text.text, { title: '遵守电动车及宿舍消防安全规定', action: '遵守通知中的消防安全规定' })]);
      }
      const image = sent.units[0]!;
      expect(image.messageId).toBe(imageMessage); expect(image.attachmentId).not.toBeNull();
      expect(sent.existingCandidates[0]!.id).toBe(f.repository.snapshot().candidates[0]!.id);
      return response([extracted(image.id, '禁止电动车进入宿舍充电', { title: '遵守电动车及宿舍消防安全规定', action: '禁止电动车进入宿舍充电',
        relation: { kind: 'supplement', candidateId: sent.existingCandidates[0]!.id } })]);
    } });
    const snapshot = f.repository.snapshot();
    expect(calls).toBe(2);
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]!.sourceIds).toHaveLength(2);
    expect(new Set(snapshot.sources.map(source => source.captureRef?.messageId))).toEqual(new Set([imageMessage, textMessage]));
    expect(snapshot.sources.find(source => source.captureRef?.messageId === imageMessage)).toMatchObject({
      text: expect.stringContaining('禁止电动车进入宿舍充电'), captureRef: { transcribed: true },
    });
    expect(snapshot.sources.find(source => source.captureRef?.messageId === textMessage)?.text).toContain('请遵守上图');
  });

  it('merges explicit same-response event keys and applies a saved result only once', async () => {
    const f = fixture();
    f.message('award-summary', '安全知识活动获奖同学领取奖品');
    f.message('award-detail', '领取时请携带校园卡', 1);
    const batch = f.seal(); let calls = 0;
    await analyzeCapture({ ...options(f), batch, fetch: async (_url, request) => {
      calls++; const sent = input(request);
      return response(sent.units.map((unit, index) => extracted(unit.id, unit.text, { eventKey: 'award-collection',
        action: index ? '携带校园卡领取奖品' : '获奖同学领取奖品', conditions: index ? ['携带校园卡'] : [] })));
    } });
    const snapshot = f.repository.snapshot();
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]).toMatchObject({ sourceIds: expect.arrayContaining(snapshot.sources.map(source => source.id)), conditions: ['携带校园卡'] });
    expect(snapshot.candidates[0]!.action).toContain('获奖同学领取奖品');
    expect(snapshot.candidates[0]!.action).toContain('携带校园卡领取奖品');
    applyCaptureResult(f.store, f.repository, f.store.batch(batch.id)!);
    expect(f.repository.snapshot().candidates).toEqual(snapshot.candidates);
    expect(f.repository.snapshot().sources).toEqual(snapshot.sources); expect(calls).toBe(1);
  });

  it.each(['supplement', 'duplicate'] as const)('lets later attachment %s see the saved notice and retains all 32 referenced sources', async kind => {
    const f = fixture(); const { batch, followup } = tableBatch(f); let calls = 0;
    await analyzeCapture({ ...options(f), batch, fetch: async (_url, request) => {
      calls++; const sent = input(request);
      if (calls === 1) {
        expect(sent.units).toHaveLength(1);
        expect(sent.units[0]).toMatchObject({ messageId: followup, attachmentId: null });
        return response([extracted(sent.units[0]!.id, sent.units[0]!.text, {
          action: '携带校园卡领取奖品', conditions: ['携带校园卡'],
        })]);
      }
      expect(f.repository.snapshot().candidates).toHaveLength(1);
      expect(sent.existingCandidates).toHaveLength(1);
      expect(sent.existingCandidates[0]!.id).toBe(f.repository.snapshot().candidates[0]!.id);
      expect(sent.existingCandidates[0]!.id).not.toMatch(/^qq-stage:/);
      expect(sent.units).toHaveLength(calls === 2 ? 30 : 1);
      expect(sent.units.every(unit => unit.attachmentId !== null && unit.messageId !== followup)).toBe(true);
      const primary = sent.units[0]!;
      return response([extracted(primary.id, primary.text, { title: '名单中的获奖同学领取奖品', action: '获奖名单中的同学领取奖品',
        relation: { kind, candidateId: sent.existingCandidates[0]!.id },
        supportingSources: sent.units.slice(1).map(unit => ({ sourceId: unit.id, quote: unit.text })),
      })]);
    } });
    expect(calls).toBe(3);
    const snapshot = f.repository.snapshot();
    expect(snapshot.candidates).toHaveLength(1); expect(snapshot.sources).toHaveLength(32);
    expect(snapshot.candidates[0]!.sourceIds).toHaveLength(32);
    expect(snapshot.candidates[0]!.conditions).toContain('携带校园卡');
    expect(snapshot.candidates[0]!.sourceIds.some(id => id.startsWith('qq-stage:'))).toBe(false);
  });

  it('reopens the checkpoint with the same saved ID and never repeats its successful paid requests', async () => {
    const f = fixture(); const { batch, followup } = tableBatch(f); let calls = 0, savedId = '';
    await expect(analyzeCapture({ ...options(f), batch, fetch: async (_url, request) => {
      calls++; const sent = input(request);
      if (calls === 1) {
        expect(sent.units).toHaveLength(1); expect(sent.units[0]).toMatchObject({ messageId: followup, attachmentId: null });
        return response([extracted(sent.units[0]!.id, sent.units[0]!.text, { action: '携带校园卡领取奖品', conditions: ['携带校园卡'] })]);
      }
      savedId = sent.existingCandidates[0]!.id;
      expect(savedId).toBe(f.repository.snapshot().candidates[0]!.id);
      expect(savedId).not.toMatch(/^qq-stage:/);
      expect(sent.units.every(unit => unit.attachmentId !== null)).toBe(true);
      if (calls === 2) {
        expect(sent.units).toHaveLength(30);
        return response([extracted(sent.units[0]!.id, sent.units[0]!.text, { relation: { kind: 'supplement', candidateId: savedId },
          supportingSources: sent.units.slice(1).map(unit => ({ sourceId: unit.id, quote: unit.text })),
        })]);
      }
      expect(sent.units).toHaveLength(1); throw Error('synthetic interrupted connection');
    } })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(calls).toBe(3); expect(f.repository.snapshot().candidates).toHaveLength(1);
    expect(f.repository.snapshot().candidates[0]).toMatchObject({ id: savedId, status: 'pending' });
    expect(f.repository.snapshot().candidates[0]!.sourceIds).toHaveLength(31);
    f.reopen(); f.store.retryBatch(batch.id);
    await analyzeCapture({ ...options(f), batch: f.store.claimBatch()!, fetch: async (_url, request) => {
      calls++; const sent = input(request);
      expect(sent.units).toHaveLength(1); expect(sent.existingCandidates[0]!.id).toBe(savedId);
      const page = sent.units[0]!;
      expect(page.attachmentId).not.toBeNull(); expect(page.text).toContain('第 31 页'); expect(page.messageId).not.toBe(followup);
      return response([extracted(page.id, page.text, { relation: { kind: 'supplement', candidateId: savedId } })]);
    } });
    const snapshot = f.repository.snapshot();
    expect(calls).toBe(4); expect(snapshot.tokenUsage).toHaveLength(3);
    expect(snapshot.candidates).toHaveLength(1); expect(snapshot.candidates[0]!.sourceIds).toHaveLength(32);
    expect(snapshot.sources).toHaveLength(32); expect(snapshot.candidates[0]!.conditions).toContain('携带校园卡');
    expect(f.store.batch(batch.id)?.status).toBe('applied');
    applyCaptureResult(f.store, f.repository, f.store.batch(batch.id)!);
    expect(f.repository.snapshot().candidates).toEqual(snapshot.candidates); expect(f.repository.snapshot().sources).toEqual(snapshot.sources);
  });

  it('does not merge unrelated same-title new events with different times', async () => {
    const f = fixture();
    f.message('reading-one', '2026年10月24日19:00参加第一小组读书会');
    f.message('reading-two', '2026年10月25日19:00参加第二小组读书会', 1);
    await analyzeCapture({ ...options(f), batch: f.seal(), fetch: async (_url, request) => response(input(request).units.map((unit, index) =>
      extracted(unit.id, unit.text, { title: '参加读书会', action: index ? '参加第二小组读书会' : '参加第一小组读书会',
        eventStart: `2026-10-${index ? '25' : '24'}T19:00:00+08:00`, temporalEvidence: [{ field: 'eventStart', basis: 'explicit', quote: unit.text }] }))) });
    const candidates = f.repository.snapshot().candidates;
    expect(candidates).toHaveLength(2); expect(new Set(candidates.map(candidate => candidate.eventStart)).size).toBe(2);
    expect(candidates.every(candidate => candidate.revisionOfId === null && candidate.sourceIds.length === 1)).toBe(true);
  });

  it('retains a conflicting same-event time as a linked review instead of overwriting the first event', async () => {
    const f = fixture();
    f.message('reading-original', '2026年10月24日19:00参加读书会');
    f.message('reading-correction', '读书会改到2026年10月25日19:00', 1);
    await analyzeCapture({ ...options(f), batch: f.seal(), fetch: async (_url, request) => response(input(request).units.map((unit, index) =>
      extracted(unit.id, unit.text, { title: '参加读书会', action: '参加读书会', eventKey: 'reading-meeting',
        eventStart: `2026-10-${index ? '25' : '24'}T19:00:00+08:00`, temporalEvidence: [{ field: 'eventStart', basis: 'explicit', quote: unit.text }] }))) });
    const candidates = f.repository.snapshot().candidates;
    expect(candidates).toHaveLength(2);
    const original = candidates.find(candidate => candidate.revisionOfId === null)!;
    const revision = candidates.find(candidate => candidate.revisionOfId === original.id)!;
    expect(original.eventStart).toBe('2026-10-24T19:00:00+08:00');
    expect(revision).toMatchObject({ eventStart: '2026-10-25T19:00:00+08:00', status: 'pending' });
    expect(revision.sourceIds).toHaveLength(2);
  });

  it.each(['unknown-source', 'other-recipient', 'invented-quote'] as const)('rejects %s supporting evidence without writing any candidate', async invalid => {
    const f = fixture(); f.message('ordinary', '获奖同学领取奖品');
    const other = f.store.ingest([{ accountId: '100', groupId: '200', messageId: 'other-only', sentAt: at, importedAt: '2026-10-23T12:01:00+08:00',
      text: '@其他同学 请代领奖品', segments: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: ' 请代领奖品' } }] }]).ids[0]!;
    f.message('valid-detail', '领取时请携带校园卡', 2);
    const batch = f.seal(); const excluded = prepareAnalysis(f.store, batch).units.find(unit => unit.messageId === other)!;
    await expect(analyzeCapture({ ...options(f), batch, fetch: async (_url, request) => {
      const sent = input(request); expect(sent.units.some(unit => unit.id === excluded.id)).toBe(false);
      return response([extracted(sent.units[0]!.id, sent.units[0]!.text, { supportingSources: [{
        sourceId: invalid === 'unknown-source' ? 'unprovided-source' : invalid === 'other-recipient' ? excluded.id : sent.units[1]!.id,
        quote: invalid === 'other-recipient' ? excluded.text : '凭空编造的附件内容',
      }] })]);
    } })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(f.repository.snapshot().candidates).toEqual([]); expect(f.repository.snapshot().sources).toEqual([]);
  });
});
