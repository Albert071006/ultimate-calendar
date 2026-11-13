import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore, type CapturedMessageInput, type CaptureChunkInput } from './store';
import { ANALYSIS_VERSION, analyzeCapture, batchMessages, hashInput, prepareAnalysis } from './analysis';
import { cachedAttachmentContext, MAX_ATTACHMENT_CONTEXT_CHARACTERS } from './attachment-context';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const accountId = 'wechat:synthetic-self', groupId = 'wechat:synthetic-class', at = '2026-11-01T12:00:00+08:00';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'calendar-attachment-context-')), path = join(root, 'planner.sqlite');
  const repository = createRepository(path), store = createCaptureStore(path, { platform: 'wechat' });
  cleanup.push(() => { store.close(); repository.close(); rmSync(root, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId, groupIds: [groupId, 'wechat:other-group'] });
  const message = (messageId: string, options: Partial<CapturedMessageInput> = {}) => {
    const id = store.ingest([{ accountId, groupId, messageId, sentAt: at, ...options }]).ids[0]!;
    return store.message(id)!;
  };
  const file = (messageId: string, options: Partial<CapturedMessageInput> = {}, chunks: CaptureChunkInput[] = [
    { ordinal: 0, location: '工作表「缺勤名单」/A1:C1', text: 'A1=姓名 | B1=班级 | C1=学号', status: 'ready', error: null, imageDataUrl: null },
    { ordinal: 1, location: '工作表「缺勤名单」/A2:C2', text: 'A2=林澈 | B2=计算机301班 | C2=S20260001', status: 'ready', error: null, imageDataUrl: null },
  ]) => {
    const value = message(messageId, { sentAt: '2026-11-01T11:00:00+08:00', attachments: [{ name: 'C:\\合成下载\\缺勤名单.xlsx', kind: 'file' }], ...options });
    const attachment = store.attachments(value.id)[0]!;
    store.saveExtraction(attachment.id, { extractorVersion: 'synthetic-xlsx-v1', chunks });
    return { message: value, attachment: store.attachment(attachment.id)! };
  };
  const archive = () => { store.sealBatches({ force: true }); for (let batch; (batch = store.claimBatch());) { store.saveResult(batch.id, { synthetic: true }); store.markApplied(batch.id); } };
  const notice = (text = '名单中的同学明天18点前提交情况说明') => { const value = message('followup', { text }); store.sealBatches({ force: true }); return { message: value, batch: store.claimBatch()! }; };
  return { store, repository, message, file, archive, notice };
}
function payload(plan: ReturnType<typeof prepareAnalysis>, textOnly = false) {
  const messages = batchMessages(textOnly ? plan.units.filter(unit => !unit.attachmentId) : plan.units, plan.context, [], []);
  const content = messages[1]!.content; if (typeof content === 'string' || content[0]?.type !== 'text') throw Error('Expected capture context');
  return JSON.parse(content[0].text);
}

describe('bounded cached attachment context', () => {
  it('provides a prior attachment-only spreadsheet to a later WeChat notice without adding historical source IDs or reading bytes', async () => {
    const f = fixture(), previous = f.file('roster'); f.archive(); const current = f.notice();
    const readBytes = vi.spyOn(f.store, 'readAttachmentBytes').mockImplementation(() => { throw Error('No download or parsing'); });
    expect(f.store.contextMessagesBefore(current.batch.id)).toEqual([]);
    expect(f.store.contextMessagesBefore(current.batch.id, { includeAttachments: true }).map(value => value.id)).toEqual([previous.message.id]);
    const plan = prepareAnalysis(f.store, current.batch), input = payload(plan);
    expect(input.context.find((value: { id: string }) => value.id === previous.message.id)).toMatchObject({ contextOnly: true, attachments: {
      complete: true, omitted: 0, items: [{ name: '缺勤名单.xlsx', completeness: 'complete', chunks: [
        { locator: '工作表「缺勤名单」/A1:C1' }, { locator: '工作表「缺勤名单」/A2:C2', text: expect.stringContaining('林澈') },
      ] }],
    } });
    expect(input.allowedSourceIds).toEqual(plan.units.map(unit => unit.id));
    expect(input.allowedSourceIds).not.toContain(previous.attachment.id);
    expect(plan.units.every(unit => unit.messageId === current.message.id)).toBe(true);
    expect(JSON.stringify(input)).not.toContain('合成下载');
    let calls = 0;
    await analyzeCapture({ store: f.store, repository: f.repository, batch: current.batch, canContinue: () => true, getApiKey: async () => 'synthetic', fetch: async () => {
      calls++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"candidates":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    } });
    expect(calls).toBe(1); expect(readBytes).not.toHaveBeenCalled();
    expect(f.repository.snapshot()).toMatchObject({ candidates: [], sources: [] });
    expect(f.store.batch(current.batch.id)!.result).toMatchObject({ attachmentContext: 1 });
  });

  it('makes an already extracted same-batch table available to the notice-first request as context only', () => {
    const f = fixture(), file = f.file('same-batch-roster', { sentAt: at }); const current = f.notice();
    const plan = prepareAnalysis(f.store, current.batch), input = payload(plan, true);
    expect(input.context.find((value: { id: string }) => value.id === file.message.id).attachments.items[0].completeness).toBe('complete');
    expect(input.allowedSourceIds).toEqual(plan.units.filter(unit => !unit.attachmentId).map(unit => unit.id));
    expect(input.allowedSourceIds.some((id: string) => plan.units.find(unit => unit.id === id)?.attachmentId)).toBe(false);
  });

  it('excludes other groups, accounts, older, changed, deleted and explicitly other-addressed attachments', () => {
    const f = fixture();
    const removed = f.file('deleted', { sentAt: '2026-11-01T09:00:00+08:00' }); f.archive();
    f.store.cleanup({ accountId, groupId, before: '2026-11-01T09:01:00+08:00' });
    const otherGroup = f.file('other-group', { groupId: 'wechat:other-group' });
    const old = f.file('expired', { sentAt: '2026-10-31T11:59:59+08:00' });
    const changed = f.file('changed'); f.store.markMessageChanged(changed.message.id);
    const otherRecipient = f.file('other-person', { segments: [{ type: 'at', data: { wechat: 'synthetic-other' } }] });
    f.store.saveConfig({ ...f.store.config(), accountId: 'wechat:other-account' });
    const otherAccount = f.file('other-account', { accountId: 'wechat:other-account' });
    f.store.saveConfig({ ...f.store.config(), accountId });
    const good = f.file('matching'); f.archive(); const current = f.notice();
    const all = [removed, otherGroup, old, changed, otherRecipient, otherAccount, good].map(value => f.store.message(value.message.id)!).filter(Boolean);
    const contexts = cachedAttachmentContext(f.store, current.batch, [...all, current.message]);
    expect([...contexts.keys()]).toEqual([good.message.id]);
    const plan = prepareAnalysis(f.store, current.batch);
    expect(plan.context.filter(value => value.attachments).map(value => value.id)).toEqual([good.message.id]);
  });

  it.each(['image', 'failed', 'missing', 'chunk-failed'] as const)('marks %s evidence partial so absence is never conclusive', kind => {
    const f = fixture();
    const file = f.file('incomplete', kind === 'image' ? { attachments: [{ name: '名单图片.png', kind: 'image' }] } : {}, kind === 'missing' ? [] : [
      { ordinal: 0, location: '工作表「名单」/A1', text: 'A1=合成同学', status: kind === 'chunk-failed' ? 'failed' : 'ready', error: null, imageDataUrl: null },
    ]);
    if (kind === 'failed') f.store.setAttachmentStatus(file.attachment.id, 'failed', '合成解析异常');
    f.archive(); const current = f.notice(), context = prepareAnalysis(f.store, current.batch).context.find(value => value.id === file.message.id)!.attachments!;
    expect(context.complete).toBe(false); expect(context.items[0]!.completeness).toBe('partial');
    expect(context.items[0]!.reason).toContain('不能据此认定名单没有本人');
  });

  it('bounds attachment count and the combined text, filename and locator budget with explicit omission/truncation', () => {
    const f = fixture();
    const many = f.message('many', { sentAt: '2026-11-01T11:00:00+08:00', attachments: Array.from({ length: 4 }, (_, index) => ({ name: `合成名单${index}.xlsx`, kind: 'file' as const })) });
    for (const attachment of f.store.attachments(many.id)) f.store.saveExtraction(attachment.id, { extractorVersion: 'synthetic-v1', chunks: [
      { ordinal: 0, location: '工作表「名单」/A1:A900', text: '人'.repeat(7000), status: 'ready', error: null, imageDataUrl: null },
    ] });
    f.archive(); const current = f.notice(), context = prepareAnalysis(f.store, current.batch).context.find(value => value.id === many.id)!.attachments!;
    expect(context.items).toHaveLength(3); expect(context.omitted).toBe(1); expect(context.complete).toBe(false);
    expect(context.items[2]!.completeness).toBe('partial');
    expect(context.items.reduce((sum, item) => sum + item.name.length + item.chunks.reduce((count, chunk) => count + chunk.locator.length + chunk.text.length, 0), 0)).toBeLessThanOrEqual(MAX_ATTACHMENT_CONTEXT_CHARACTERS);
  });

  it('marks more than one hundred cached row chunks as incomplete and only includes the most recent twenty messages', () => {
    const f = fixture(), long = f.file('long', {}, Array.from({ length: 101 }, (_, ordinal) => ({ ordinal, location: `工作表「名单」/A${ordinal + 1}`, text: '合成同学', status: 'ready' as const, error: null, imageDataUrl: null })));
    f.archive(); const first = f.notice(), context = prepareAnalysis(f.store, first.batch).context.find(value => value.id === long.message.id)!.attachments!;
    expect(context.items[0]!.chunks).toHaveLength(100); expect(context.items[0]!.completeness).toBe('partial');
    const recentMessages = Array.from({ length: 20 }, (_, index) => f.message(`recent-${index}`, { sentAt: `2026-11-01T11:${String(index + 10).padStart(2, '0')}:00+08:00`, text: '合成讨论' }));
    expect(cachedAttachmentContext(f.store, first.batch, [long.message, ...recentMessages, first.message]).size).toBe(0);
  });

  it('replays a legacy paid checkpoint without adding new attachment context, changing its fingerprint or charging again', async () => {
    const f = fixture(); f.file('historical-roster'); f.archive(); const current = f.notice();
    const prepared = prepareAnalysis(f.store, current.batch, { deduplicateAttachments: false, documentGrouping: false, passiveQuestionFilter: false, noticeFirst: false, attachmentContext: false, sharedCards: false });
    const units = prepared.units.map(({ text, imageDataUrl, ...unit }) => ({ ...unit, textHash: hashInput(text), imageHash: imageDataUrl ? hashInput(imageDataUrl) : null }));
    const planFingerprint = hashInput({ version: ANALYSIS_VERSION, model: f.repository.snapshot().settings.model, units, context: prepared.context, warnings: prepared.warnings });
    f.store.startAttempt(current.batch.id, 'synthetic-old-paid');
    f.store.checkpointResult(current.batch.id, { ...prepared, units, planFingerprint, completed: [{ key: hashInput(prepared.units.map(unit => unit.id)), value: { candidates: [] } }], final: false });
    const fetch = vi.fn(async () => { throw Error('No repeat charge'); }), getApiKey = vi.fn(async () => { throw Error('No key needed'); });
    await analyzeCapture({ store: f.store, repository: f.repository, batch: f.store.batch(current.batch.id)!, canContinue: () => true, fetch, getApiKey });
    expect(fetch).not.toHaveBeenCalled(); expect(getApiKey).not.toHaveBeenCalled();
    const checkpoint = f.store.batch(current.batch.id)!.result as Record<string, unknown>;
    expect(checkpoint.planFingerprint).toBe(planFingerprint); expect(checkpoint.attachmentContext).toBeUndefined();
    expect(JSON.stringify(checkpoint.context)).not.toContain('缺勤名单'); expect(f.store.batch(current.batch.id)!.attempts).toHaveLength(1);
  });
});
