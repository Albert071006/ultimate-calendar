import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository, type Repository } from '../storage/repository';
import { createCaptureStore, type CaptureStore } from './store';
import { analyzeCapture, applyCaptureResult, prepareAnalysis } from './analysis';
import type { ExtractedCandidate } from '../ai/schemas';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup(text = '明天18点提交报告') {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-capture-ai-')); const path = join(dir, 'planner.sqlite');
  const repository = createRepository(path); const store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200'] });
  const message = store.ingest([{ accountId: '100', groupId: '200', messageId: '1', sentAt: '2026-10-23T12:00:00+08:00', text }]).ids[0]!;
  const batch = () => { store.sealBatches({ force: true }); return store.claimBatch()!; };
  return { store, repository, message, batch };
}
function candidate(sourceId: string): ExtractedCandidate {
  return { title: '提交报告', action: '提交报告', benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: [], uncertainties: [], sourceIds: [sourceId], sourceQuote: '明天18点提交报告', deadline: { date: '2026-10-24', time: '18:00' }, eventStart: null, eventEnd: null, location: '', temporalEvidence: [{ field: 'deadline', basis: 'relative', quote: '明天18点提交报告' }], relation: { kind: 'new', candidateId: null } };
}
function response(value: unknown) { return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); }
const options = (store: CaptureStore, repository: Repository) => ({ store, repository, getApiKey: async () => 'synthetic', canContinue: () => true });
describe('capture analysis and durable candidate application', () => {
  it('includes campus background in QQ analysis and refuses to mix changed context into paid checkpoints', async () => {
    const { store, repository, batch } = setup('a'.repeat(100_000));
    repository.saveSettings({ campus: '示例大学北校区', locationContext: '校内地点保留原名' });
    const saved = batch(); let calls = 0;
    await expect(analyzeCapture({ ...options(store, repository), batch: saved, fetch: async (_url, request) => {
      calls++;
      const sent = JSON.parse(String(request?.body));
      const user = sent.messages.find((message: { role: string }) => message.role === 'user');
      expect(JSON.parse(user.content[0].text).userProfile).toEqual({ campus: '示例大学北校区', locationContext: '校内地点保留原名' });
      if (calls === 2) throw Error('network');
      return response({ candidates: [] });
    } })).rejects.toMatchObject({ code: 'NETWORK' });
    store.recoverInterrupted(); store.retryBatch(saved.id);
    repository.saveSettings({ campus: '另一校区' });
    await expect(analyzeCapture({ ...options(store, repository), batch: store.claimBatch()!, fetch: async () => { calls++; return response({ candidates: [] }); } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(calls).toBe(2); expect(repository.snapshot().tokenUsage).toHaveLength(1);
  });
  it('keeps each message timestamp and creates only pending candidates; replay never pays or duplicates', async () => {
    const { store, repository, batch } = setup(); const saved = batch(); const unit = prepareAnalysis(store, saved).units[0]!;
    let calls = 0;
    await analyzeCapture({ ...options(store, repository), batch: saved, fetch: async () => { calls++; return response({ candidates: [candidate(unit.id)] }); } });
    expect(calls).toBe(1); expect(store.batch(saved.id)?.status).toBe('applied');
    let snapshot = repository.snapshot(); expect(snapshot.tasks).toEqual([]); expect(snapshot.candidates[0]).toMatchObject({ status: 'pending', deadline: { date: '2026-10-24', time: '18:00' } });
    expect(snapshot.sources[0]?.captureRef?.messageId).toBe(unit.messageId);
    applyCaptureResult(store, repository, store.batch(saved.id)!); snapshot = repository.snapshot(); expect(snapshot.candidates).toHaveLength(1); expect(snapshot.sources).toHaveLength(1);
  });
  it('rejects invented or cross-part source IDs before creating any candidates', async () => {
    const { store, repository, batch } = setup(); const saved = batch();
    await expect(analyzeCapture({ ...options(store, repository), batch: saved, fetch: async () => response({ candidates: [candidate('unselected-source')] }) })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(repository.snapshot().candidates).toEqual([]); expect(store.batch(saved.id)?.status).toBe('requesting');
  });
  it('does not automatically retry a paid request whose network outcome is unknown', async () => {
    const { store, repository, batch } = setup(); let calls = 0; const saved = batch();
    await expect(analyzeCapture({ ...options(store, repository), batch: saved, fetch: async () => { calls++; throw Error('network'); } })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(calls).toBe(1); store.recoverInterrupted(); expect(store.batch(saved.id)?.status).toBe('uncertain'); expect(store.claimBatch()).toBeNull();
  });
  it('resumes later document fragments without reissuing already checkpointed paid requests', async () => {
    const { store, repository, batch } = setup('a'.repeat(100_000)); const saved = batch(); let calls = 0;
    await expect(analyzeCapture({ ...options(store, repository), batch: saved, fetch: async () => { calls++; if (calls === 2) throw Error('network'); return response({ candidates: [] }); } })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(calls).toBe(2); store.recoverInterrupted(); store.retryBatch(saved.id);
    await analyzeCapture({ ...options(store, repository), batch: store.claimBatch()!, fetch: async () => { calls++; return response({ candidates: [] }); } });
    expect(calls).toBe(4); expect(store.batch(saved.id)?.status).toBe('applied'); expect(repository.snapshot().tokenUsage).toHaveLength(3);
  });
  it('preserves original referenced-message time, and unknown reference time stays unknown', () => {
    const { store, batch } = setup();
    const ids = store.ingest([{ accountId: '100', groupId: '200', messageId: '2', sentAt: '2026-10-23T12:00:00+08:00', text: '引用', attachments: [{ kind: 'other', name: '引用消息' }] }]).ids;
    const a = store.attachments(ids[0]!)[0]!;
    store.saveExtraction(a.id, { extractorVersion: 'test', chunks: [{ ordinal: 0, location: '引用', text: '明天交', status: 'ready', error: null, imageDataUrl: null, sentAt: '2026-10-20T08:00:00+08:00' }, { ordinal: 1, location: '未知引用', text: '明天去', status: 'ready', error: null, imageDataUrl: null }] });
    const units = prepareAnalysis(store, batch()).units;
    expect(units.find(u => u.text === '明天交')?.sentAt).toBe('2026-10-20T08:00:00+08:00'); expect(units.find(u => u.text === '明天去')?.sentAt).toBe('');
  });
  it('keeps image data out of durable checkpoints and splits requests below the encoded-image cap', async () => {
    const { store, repository, batch } = setup('');
    const ids = store.ingest([{ accountId: '100', groupId: '200', messageId: 'pictures', sentAt: '2026-10-23T12:00:00+08:00', attachments: [{ kind: 'image', name: '合成扫描页.png' }] }]).ids;
    const attachment = store.attachments(ids[0]!)[0]!;
    const image = 'data:image/png;base64,' + 'A'.repeat(13 * 1024 * 1024);
    store.saveExtraction(attachment.id, { extractorVersion: 'synthetic', chunks: [0, 1].map(ordinal => ({ ordinal, location: `第 ${ordinal + 1} 页`, text: '', imageDataUrl: image, status: 'ready', error: null })) });
    const saved = batch(); let calls = 0;
    await analyzeCapture({ ...options(store, repository), batch: saved, fetch: async (_url, request) => {
      calls++; expect(String(request?.body).length).toBeLessThan(24 * 1024 * 1024 + 100_000);
      const persisted = JSON.stringify(store.batch(saved.id)?.result); expect(persisted.length).toBeLessThan(10_000); expect(persisted).not.toContain('base64');
      return response({ candidates: [] });
    } });
    expect(calls).toBe(2); expect(JSON.stringify(store.batch(saved.id)?.result).length).toBeLessThan(10_000);
  });
  it('rechecks a pause after async credential recovery before starting a paid request', async () => {
    const { store, repository, batch } = setup(); let allowed = true, calls = 0;
    const saved = batch();
    await expect(analyzeCapture({ ...options(store, repository), batch: saved, canContinue: () => allowed, getApiKey: async () => { allowed = false; return 'synthetic'; }, fetch: async () => { calls++; return response({ candidates: [] }); } })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toBe(0); expect(store.batch(saved.id)?.attempts).toEqual([]);
  });
  it('does not mark queued work requesting until its global model turn is available', async () => {
    const { store, repository, batch } = setup(); const saved = batch(); let allowed = true, calls = 0;
    await expect(analyzeCapture({ ...options(store, repository), batch: saved, canContinue: () => allowed, runModel: async work => {
      expect(store.batch(saved.id)?.status).toBe('preparing'); expect(store.batch(saved.id)?.attempts).toEqual([]); allowed = false; return work();
    }, fetch: async () => { calls++; return response({ candidates: [] }); } })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls).toBe(0);
  });
  it('stops before charging a known text-only model for image input', async () => {
    const { store, repository, batch } = setup();
    const ids = store.ingest([{ accountId: '100', groupId: '200', messageId: 'image', sentAt: '2026-10-23T12:00:00+08:00', attachments: [{ kind: 'image', name: '合成.png' }] }]).ids;
    store.saveExtraction(store.attachments(ids[0]!)[0]!.id, { extractorVersion: 'synthetic', chunks: [{ ordinal: 0, location: '图片', text: '', imageDataUrl: 'data:image/png;base64,AAAA', status: 'ready', error: null }] });
    const saved = batch(); let calls = 0;
    await expect(analyzeCapture({ ...options(store, repository), batch: saved, getModelInputModalities: () => ['text'], fetch: async () => { calls++; return response({ candidates: [] }); } })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(calls).toBe(0); expect(store.batch(saved.id)?.result).toBeNull();
  });
  it('reports an oversized batch before any paid request instead of dropping document text', async () => {
    const { store, repository, batch } = setup('a'.repeat(210_000)); const saved = batch(); let calls = 0;
    await expect(analyzeCapture({ ...options(store, repository), batch: saved, fetch: async () => { calls++; return response({ candidates: [] }); } })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(calls).toBe(0); expect(store.batch(saved.id)?.result).toBeNull();
  });
  it('does not use an old model if the selected model changes while queued', async () => {
    const { store, repository, batch } = setup(); const saved = batch(); let calls = 0;
    await expect(analyzeCapture({ ...options(store, repository), batch: saved, runModel: async work => { repository.saveSettings({ ...repository.snapshot().settings, model: 'changed-model' }); return work(); }, fetch: async () => { calls++; return response({ candidates: [] }); } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(calls).toBe(0); expect(store.batch(saved.id)?.attempts).toEqual([]);
  });
});
