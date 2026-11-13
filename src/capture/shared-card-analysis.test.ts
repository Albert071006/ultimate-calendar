import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore, type CapturedMessageInput } from './store';
import { ANALYSIS_VERSION, analyzeCapture, hashInput, prepareAnalysis } from './analysis';
import { effectiveMessageText } from './shared-card';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const title = '第八周可用时间表', link = 'https://docs.qq.com/sheet/synthetic-availability';
const card = { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.miniapp_01',
  meta: { detail_1: { title: '腾讯文档', desc: title, qqdocurl: link } } }) } };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-shared-card-analysis-'));
  const path = join(dir, 'planner.sqlite');
  const repository = createRepository(path, { automaticBackup: () => {} }), store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200', '201'] });
  const ingest = (messageId: string, extra: Partial<CapturedMessageInput> = {}) => {
    const id = store.ingest([{ accountId: '100', groupId: '200', messageId, senderId: '300',
      sentAt: '2031-04-16T12:00:00+08:00', ...extra }]).ids[0]!;
    return store.message(id)!;
  };
  const archive = () => {
    store.sealBatches({ force: true });
    for (let batch; (batch = store.claimBatch());) { store.saveResult(batch.id, { synthetic: true }); store.markApplied(batch.id); }
  };
  const current = (extra: Partial<CapturedMessageInput> = {}) => {
    const message = ingest('current', { sentAt: '2031-04-16T12:10:00+08:00', text: '@全体成员 请大家填写刚发的表格，提交本人可用时间。',
      segments: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '请大家填写刚发的表格，提交本人可用时间。' } }], ...extra });
    store.sealBatches({ force: true }); return { message, batch: store.claimBatch()! };
  };
  return { repository, store, ingest, archive, current };
}
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
function input(request?: RequestInit) {
  const messages = JSON.parse(String(request?.body)).messages;
  return { system: messages.find((message: { role: string }) => message.role === 'system').content as string,
    body: JSON.parse(messages.find((message: { role: string }) => message.role === 'user').content[0].text) };
}

describe('shared cards in fresh analysis and immutable paid checkpoints', () => {
  it('restores a legacy card from the preceding batch and keeps the outer all-member request distinct from an organizer role', async () => {
    const f = fixture();
    const original = f.ingest('prior-card', { text: '', segments: [card] });
    f.ingest('unrelated-card', { groupId: '201', text: '', segments: [{ type: 'json', data: { data: JSON.stringify({
      app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '外群表单不应进入本群', qqdocurl: 'https://example.test/other-group' } },
    }) } }] });
    const image = f.ingest('organizer-image', { sentAt: '2031-04-16T12:01:00+08:00', text: '图片说明：请各小组负责人收集成员的可用时间并汇总。',
      attachments: [{ name: '合成原通知.png', kind: 'image' }] });
    f.store.saveExtraction(f.store.attachments(image.id)[0]!.id, { extractorVersion: 'synthetic', chunks: [{ ordinal: 0,
      location: '图片1', text: '请各小组负责人收集成员的可用时间并汇总。', imageDataUrl: null, status: 'ready', error: null }] });
    f.archive(); const current = f.current();
    expect(f.store.contextMessagesBefore(current.batch.id)).not.toContainEqual(original);
    expect(f.store.contextMessagesBefore(current.batch.id, { includeSharedCards: true })).toContainEqual(original);
    let captured: ReturnType<typeof input> | undefined;
    await analyzeCapture({ ...f, batch: current.batch, getApiKey: async () => 'synthetic', canContinue: () => true, fetch: async (_url, request) => {
      captured = input(request); const { body } = captured;
      return response({ candidates: [{ title: `填写${title}`, action: '填写并提交本人可用时间', benefit: '', benefitKind: 'unknown',
        potentialBenefit: '', conditions: [], uncertainties: [], sourceIds: [body.units[0].id], sourceQuote: body.units[0].text,
        deadline: null, eventStart: null, eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'new', candidateId: null } }] });
    } });
    const { system, body } = captured!, context = JSON.stringify(body.context);
    expect(context).toContain(title); expect(context).toContain(link);
    expect(context).toContain('负责人'); expect(context).not.toContain('外群表单');
    expect(system).toContain('不因用户不是负责人而漏掉外层要求');
    expect(body.units).toHaveLength(1);
    expect(body.units[0].recipient).toMatchObject({ audience: 'all', sender: 'other' });
    expect(f.repository.snapshot().candidates).toHaveLength(1);
    expect(f.repository.snapshot().candidates[0]!.title).toBe(`填写${title}`);
    expect(f.repository.snapshot().sources).toHaveLength(1);
    expect(f.repository.snapshot().sources[0]!.captureRef?.messageId).toBe(current.message.id);
    expect(f.store.message(original.id)).toEqual(original);
    expect(f.store.batch(current.batch.id)!.result).toMatchObject({ sharedCards: 1 });
    expect(f.store.claimBatch()).toBeNull();
  });

  it('recovers current card evidence without duplicating newly normalized text or treating embedded mentions as recipients', () => {
    const f = fixture(), current = f.current({ text: '', segments: [card, { type: 'reply', data: { content: [{ type: 'at', data: { qq: 'all' } }] } }] });
    const plan = prepareAnalysis(f.store, current.batch);
    expect(plan.units).toHaveLength(1); expect(plan.units[0]!.text).toContain(title); expect(plan.units[0]!.text).toContain(link);
    expect(plan.context.find(message => message.id === current.message.id)?.recipient?.audience).toBe('unspecified');
    expect(effectiveMessageText({ text: plan.units[0]!.text, segments: [card, card] })).toBe(plan.units[0]!.text);
    expect(prepareAnalysis(f.store, current.batch, { sharedCards: false }).units).toEqual([]);
    expect(f.store.message(current.message.id)?.text).toBe('');
  });

  it('uses the same recovered text when a paid detail request asks to reread the preceding card', async () => {
    const f = fixture(), original = f.ingest('prior-card', { text: '', segments: [card] });
    f.archive(); const current = f.current(); let calls = 0;
    await analyzeCapture({ ...f, batch: current.batch, getApiKey: async () => 'synthetic', canContinue: () => true, fetch: async (_url, request) => {
      calls++; const { body } = input(request);
      const prior = body.context.find((message: { text?: string }) => message.text?.includes(title));
      expect(prior.text).toContain(link);
      if (calls === 1) return response({ needsDetails: { context: [prior.id], candidates: [] } });
      expect(body.detailsExpanded).toBe(true);
      expect(prior.text).toBe(effectiveMessageText(original));
      return response({ candidates: [] });
    } });
    expect(calls).toBe(2); expect(f.store.message(original.id)).toEqual(original);
  });

  it('hydrates an old paid response with the old text and fingerprint, without a new key or request', async () => {
    const f = fixture(), current = f.current({ text: '请大家填写本人可用时间', segments: [card] });
    const prepared = prepareAnalysis(f.store, current.batch, { sharedCards: false });
    const units = prepared.units.map(({ text, imageDataUrl, ...unit }) => ({ ...unit, textHash: hashInput(text), imageHash: imageDataUrl ? hashInput(imageDataUrl) : null }));
    const planFingerprint = hashInput({ version: ANALYSIS_VERSION, model: f.repository.snapshot().settings.model,
      attachmentDedupe: 1, documentGrouping: 1, passiveQuestionFilter: 1, noticeFirst: 1, attachmentContext: 1,
      units, context: prepared.context, warnings: prepared.warnings });
    f.store.startAttempt(current.batch.id, 'synthetic-legacy-paid');
    f.store.savePendingResponse(current.batch.id, { ...prepared, units, planFingerprint, completed: [], final: false,
      pendingResponse: { key: hashInput(prepared.units.map(unit => unit.id)), value: { candidates: [] }, candidateIds: [] } });
    const fetch = vi.fn(async () => { throw Error('Must not repeat a paid request'); });
    const getApiKey = vi.fn(async () => { throw Error('Saved response needs no key'); });
    await analyzeCapture({ ...f, batch: f.store.batch(current.batch.id)!, getApiKey, canContinue: () => true, fetch });
    expect(fetch).not.toHaveBeenCalled(); expect(getApiKey).not.toHaveBeenCalled();
    const checkpoint = f.store.batch(current.batch.id)!.result as Record<string, unknown>;
    expect(checkpoint.planFingerprint).toBe(planFingerprint); expect(checkpoint.sharedCards).toBeUndefined();
    expect(JSON.stringify(checkpoint.context)).not.toContain(title);
    expect(f.store.batch(current.batch.id)!.attempts).toHaveLength(1);
    expect(f.store.batch(current.batch.id)!.status).toBe('applied');
    expect(f.repository.snapshot().candidates).toEqual([]);
    expect(f.store.message(current.message.id)).toEqual(current.message);
  });
});
