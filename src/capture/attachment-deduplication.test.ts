import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore, type StoredCaptureAttachment, type StoredCaptureMessage } from './store';
import { ANALYSIS_VERSION, analyzeCapture, hashInput, prepareAnalysis, type AnalysisUnit } from './analysis';
import { createAttachmentDeduplicator, attachmentEvidenceUnits } from './attachment-deduplication';
import { locationProfile } from '../ai/prompts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const at = '2026-10-23T12:00:00+08:00', nextAt = '2026-10-23T12:00:01+08:00';
function message(id: string, changes: Partial<StoredCaptureMessage> = {}): StoredCaptureMessage {
  return { id, messageId: id, accountId: '100', groupId: '200', groupName: '合成班级', senderId: '300', senderName: '',
    sentAt: at, importedAt: at, origin: 'live', text: '', segments: [{ type: 'file', data: { name: '合成说明.docx' } }],
    changed: false, deleted: false, ...changes };
}
function attachment(messageId: string, changes: Partial<StoredCaptureAttachment> = {}): StoredCaptureAttachment {
  return { id: `attachment-${messageId}`, messageId, name: '合成说明.docx', kind: 'file', size: 4, locator: null,
    status: 'ready', error: null, hash: 'a'.repeat(64), extractorVersion: 'synthetic-v1', ...changes };
}
function unit(m: StoredCaptureMessage, a: StoredCaptureAttachment, changes: Partial<AnalysisUnit> = {}): AnalysisUnit {
  return { id: `unit-${m.id}`, messageId: m.id, accountId: m.accountId, groupId: m.groupId, attachmentId: a.id,
    locator: `${a.name} · 第 1 页`, sentAt: m.sentAt, label: `QQ · ${m.groupName}`, text: '完成课堂练习并保存结果。', imageDataUrl: null, ...changes };
}
function response(value: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
}
function candidate(source: { id: string; text: string }) {
  return { title: '完成课堂练习', action: '完成课堂练习并保存结果', benefit: '', benefitKind: 'unknown', potentialBenefit: '',
    conditions: [], uncertainties: [], sourceIds: [source.id], sourceQuote: source.text, deadline: null, eventStart: null,
    eventEnd: null, location: '', temporalEvidence: [], relation: { kind: 'new', candidateId: null } };
}
function fixture(chunkCount = 20, interveningMessage = false, companionAttachment = false) {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-attachment-dedupe-')), path = join(directory, 'planner.sqlite');
  let repository = createRepository(path, { automaticBackup: () => {} }), store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200'] });
  const messageIds: string[] = [], attachmentIds: string[] = [];
  for (let index = 0; index < 2; index++) {
    if (index && interveningMessage) store.ingest([{ accountId: '100', groupId: '200', messageId: 'new-assignment',
      senderId: '300', sentAt: at, text: '下一个附件是另一个班的安排。' }]);
    const id = store.ingest([{ accountId: '100', groupId: '200', messageId: `file-event-${index}`, senderId: '300',
      senderName: index ? 'nan' : '', sentAt: index ? nextAt : at, text: '',
      segments: [{ type: 'file', data: index ? { file: 'provider-file', file_id: 'normal-event', file_size: 4, url: 'https://example.test/file' }
        : { id: 'upload-event', name: '合成说明.docx', size: 4, busid: 1, file_id: 'upload-file' } }],
      attachments: [{ kind: 'file', name: '合成说明.docx' }, ...(companionAttachment ? [{ kind: 'file' as const, name: '其他资料.docx' }] : [])],
    }]).ids[0]!;
    messageIds.push(id);
    for (const [attachmentIndex, item] of store.attachments(id).entries()) {
      if (!attachmentIndex) attachmentIds.push(item.id);
      store.putAttachment(item.id, new Uint8Array([1, 2, 3, 4 + attachmentIndex]));
      store.saveExtraction(item.id, { extractorVersion: 'synthetic-v1', chunks: Array.from({ length: chunkCount }, (_, ordinal) => ({
        ordinal, location: `第 ${ordinal + 1} 页`, text: `完成课堂练习并保存结果。合成说明第 ${ordinal + 1} 页。`, imageDataUrl: null,
        status: 'ready' as const, error: null,
      })) });
    }
  }
  store.sealBatches({ force: true }); const batch = store.claimBatch()!;
  return { get repository() { return repository; }, get store() { return store; }, batch, messageIds, attachmentIds,
    reopen() { store.close(); repository.close(); repository = createRepository(path, { automaticBackup: () => {} }); store = createCaptureStore(path); store.recoverInterrupted(); },
    claimRetry() { const status = store.batch(batch.id)!.status; if (status === 'failed' || status === 'uncertain') store.retryBatch(batch.id); return store.claimBatch()!; },
  };
}
const options = (f: ReturnType<typeof fixture>) => ({ store: f.store, repository: f.repository, batch: f.batch,
  getApiKey: async () => 'synthetic', canContinue: () => true });

describe('batch-local attachment deduplication', () => {
  const unsafe: { name: string; message?: Partial<StoredCaptureMessage>; attachment?: Partial<StoredCaptureAttachment>; unit?: Partial<AnalysisUnit>; previous?: string }[] = [
    { name: 'another account', message: { accountId: '101' } },
    { name: 'another group', message: { groupId: '201' } },
    { name: 'another sender', message: { senderId: '301' } },
    { name: 'unknown sender', message: { senderId: null } },
    { name: 'another recipient', message: { segments: [{ type: 'at', data: { qq: '999' } }] } },
    { name: 'the current recipient', message: { segments: [{ type: 'at', data: { qq: '100' } }] } },
    { name: 'a reply context', message: { segments: [{ type: 'reply', data: { id: 'synthetic-context' } }] } },
    { name: 'a message instruction', message: { text: '这份资料明天再做。' } },
    { name: 'a segmented instruction', message: { segments: [{ type: 'text', data: { text: '用于另一项作业' } }] } },
    { name: 'a modified message', message: { changed: true } },
    { name: 'an intervening message', previous: 'another-message' },
    { name: 'a later instruction', message: { sentAt: '2026-10-23T12:00:03+08:00' } },
    { name: 'another day', message: { sentAt: '2026-10-24T12:00:01+08:00' } },
    { name: 'different content bytes', attachment: { hash: 'b'.repeat(64) } },
    { name: 'unverified content', attachment: { hash: null } },
    { name: 'a different filename', attachment: { name: '另一份说明.docx' } },
    { name: 'another parser version', attachment: { extractorVersion: 'synthetic-v2' } },
    { name: 'incomplete extraction', attachment: { status: 'failed', error: '合成解析失败' } },
    { name: 'a different parsed result', unit: { text: '完成另一项练习。' } },
    { name: 'a different page locator', unit: { locator: '合成说明.docx · 第 2 页' } },
    { name: 'a different image', unit: { imageDataUrl: 'data:image/png;base64,synthetic' } },
    { name: 'a quoted timestamp', unit: { sentAt: '2026-10-22T12:00:00+08:00' } },
  ];
  it.each(unsafe)('keeps $name separate', changes => {
    const dedupe = createAttachmentDeduplicator(), first = message('first'), firstAttachment = attachment(first.id), firstUnit = unit(first, firstAttachment);
    expect(dedupe(firstAttachment, first, [firstUnit], null)).toHaveLength(1);
    const second = message('second', { sentAt: nextAt, ...changes.message }), secondAttachment = attachment(second.id, changes.attachment);
    expect(dedupe(secondAttachment, second, [unit(second, secondAttachment, changes.unit)], changes.previous ?? first.id)).toHaveLength(1);
    expect(firstUnit.attachmentAliases).toBeUndefined();
  });

  it('analyzes duplicate file events once and saves every original attachment source', async () => {
    const f = fixture(), prepared = prepareAnalysis(f.store, f.batch);
    expect(prepared).toMatchObject({ attachmentDedupe: 1, documentGrouping: 1 });
    expect(prepared.units).toHaveLength(20);
    expect(attachmentEvidenceUnits(prepared.units[0]!).map(source => source.messageId)).toEqual(f.messageIds);
    let calls = 0;
    await analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      calls++;
      const input = JSON.parse(JSON.parse(String(request?.body)).messages.find((item: { role: string }) => item.role === 'user').content[0].text);
      expect(input.units).toHaveLength(20);
      expect(input.allowedSourceIds).toEqual(prepared.units.map(item => item.id));
      expect(input.units.every((item: AnalysisUnit) => !('attachmentAliases' in item))).toBe(true);
      return response({ candidates: [candidate(input.units[0])] });
    } });
    expect(calls).toBe(1);
    const state = f.repository.snapshot();
    expect(state.candidates).toHaveLength(1);
    expect(state.candidates[0]!.sourceIds).toHaveLength(2);
    expect(state.sources.map(source => source.captureRef?.messageId)).toEqual(f.messageIds);
    expect(state.sources.map(source => source.captureRef?.attachmentId)).toEqual(f.attachmentIds);
    expect(state.sources.map(source => source.sentAt)).toEqual([at, nextAt]);
    expect(new Set(state.sources.map(source => source.text)).size).toBe(1);
    expect(state.sources[0]!.text).toContain(prepared.units[0]!.text);
    expect(f.store.batch(f.batch.id)!.attempts).toHaveLength(1);
  });

  it.each([{ intervening: true, companion: false, count: 41 }, { intervening: false, companion: true, count: 80 }])(
    'does not deduplicate changed message context ($intervening/$companion)', ({ intervening, companion, count }) => {
      const f = fixture(20, intervening, companion), prepared = prepareAnalysis(f.store, f.batch);
      expect(prepared.units).toHaveLength(count);
      expect(prepared.units.every(item => !item.attachmentAliases)).toBe(true);
    });

  it('resumes a legacy duplicate checkpoint with the original grouping and zero new requests', async () => {
    const f = fixture(), prepared = prepareAnalysis(f.store, f.batch, { deduplicateAttachments: false, documentGrouping: false, passiveQuestionFilter: false });
    expect(prepared.units).toHaveLength(40);
    expect(prepared.attachmentDedupe).toBeUndefined(); expect(prepared.documentGrouping).toBeUndefined();
    const units = prepared.units.map(({ text, imageDataUrl, ...identity }) => ({ ...identity, textHash: hashInput(text), imageHash: imageDataUrl ? hashInput(imageDataUrl) : null }));
    const profile = locationProfile(f.repository.snapshot().settings);
    const profileFingerprint = profile.campus || profile.locationContext ? { userProfile: profile } : {};
    const completed = [prepared.units.slice(0, 30), prepared.units.slice(30)].map(group => ({
      key: hashInput(group.map(item => item.id)), value: { candidates: [candidate(group[0]!)] },
    }));
    const checkpoint = { ...prepared, units, planFingerprint: hashInput({ version: ANALYSIS_VERSION, model: f.repository.snapshot().settings.model,
      ...profileFingerprint, units, context: prepared.context, warnings: prepared.warnings }), completed, final: false };
    f.store.startAttempt(f.batch.id, 'already-paid-synthetic-request'); f.store.checkpointResult(f.batch.id, checkpoint);
    f.reopen(); let calls = 0;
    await analyzeCapture({ ...options(f), batch: f.claimRetry(), fetch: async () => { calls++; return response({ candidates: [] }); } });
    expect(calls).toBe(0);
    const saved = f.store.batch(f.batch.id)!;
    expect(saved.attempts).toHaveLength(1);
    expect(saved.result).toMatchObject({ planFingerprint: checkpoint.planFingerprint, completed });
    expect(saved.result).not.toHaveProperty('attachmentDedupe'); expect(saved.result).not.toHaveProperty('documentGrouping');
    expect(f.repository.snapshot().sources.map(source => source.captureRef?.messageId)).toEqual(f.messageIds);
  });

  it('restores alias sources after a restart without another model call', async () => {
    const f = fixture(); let calls = 0;
    await expect(analyzeCapture({ ...options(f), onProgress: () => { throw Error('synthetic crash after saving sources'); },
      fetch: async (_url, request) => { calls++; const input = JSON.parse(JSON.parse(String(request?.body)).messages.find((item: { role: string }) => item.role === 'user').content[0].text);
        return response({ candidates: [candidate(input.units[0])] }); },
    })).rejects.toThrow('synthetic crash');
    f.reopen();
    await analyzeCapture({ ...options(f), batch: f.claimRetry(), fetch: async () => { calls++; return response({ candidates: [] }); } });
    expect(calls).toBe(1);
    expect(f.repository.snapshot().candidates).toHaveLength(1);
    expect(f.repository.snapshot().sources.map(source => source.captureRef?.attachmentId)).toEqual(f.attachmentIds);
    expect(f.store.batch(f.batch.id)!.result).toMatchObject({ attachmentDedupe: 1, documentGrouping: 1 });
  });

  it('stops without paying again if an alias extraction changes after the checkpoint', async () => {
    const f = fixture(); let calls = 0;
    await expect(analyzeCapture({ ...options(f), onProgress: () => { throw Error('synthetic crash'); }, fetch: async (_url, request) => {
      calls++; const input = JSON.parse(JSON.parse(String(request?.body)).messages.find((item: { role: string }) => item.role === 'user').content[0].text);
      return response({ candidates: [candidate(input.units[0])] });
    } })).rejects.toThrow('synthetic crash');
    f.store.saveExtraction(f.attachmentIds[1]!, { extractorVersion: 'synthetic-v1', chunks: [{ ordinal: 0, location: '第 1 页', text: '已变化的合成说明',
      imageDataUrl: null, status: 'ready', error: null }] });
    await expect(analyzeCapture({ ...options(f), batch: f.store.batch(f.batch.id)!, fetch: async () => { calls++; return response({ candidates: [] }); } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(calls).toBe(1);
  });

  it('retains the paid response when expanded sources exceed the limit and never charges again on retry', async () => {
    const f = fixture(51); let calls = 0;
    expect(prepareAnalysis(f.store, f.batch).units).toHaveLength(51);
    await expect(analyzeCapture({ ...options(f), fetch: async (_url, request) => {
      calls++;
      const input: { units: { id: string; text: string }[]; existingCandidates: { id: string }[] } =
        JSON.parse(JSON.parse(String(request?.body)).messages.find((item: { role: string }) => item.role === 'user').content[0].text);
      expect(input.units).toHaveLength(calls === 1 ? 30 : 21);
      return response({ candidates: [{ ...candidate(input.units[0]!),
        supportingSources: input.units.slice(1).map(source => ({ sourceId: source.id, quote: source.text })),
        ...(calls === 2 ? { relation: { kind: 'supplement', candidateId: input.existingCandidates[0]!.id } } : {}),
      }] });
    } })).rejects.toMatchObject({ code: 'VALIDATION' });
    const before = f.repository.snapshot(), checkpoint = f.store.batch(f.batch.id)!.result;
    expect(calls).toBe(2);
    expect(before.candidates).toHaveLength(1); expect(before.candidates[0]!.sourceIds).toHaveLength(60);
    expect(before.sources).toHaveLength(60);
    expect(checkpoint).toHaveProperty('pendingResponse');
    expect(checkpoint).toMatchObject({ completed: [expect.anything()], final: false });
    f.reopen();
    await expect(analyzeCapture({ ...options(f), batch: f.claimRetry(), fetch: async () => { calls++; return response({ candidates: [] }); } }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(calls).toBe(2);
    expect(f.repository.snapshot().candidates).toEqual(before.candidates);
    expect(f.repository.snapshot().sources).toEqual(before.sources);
    expect(f.store.batch(f.batch.id)!.result).toEqual(checkpoint);
    expect(f.store.batch(f.batch.id)!.attempts).toHaveLength(2);
  });
});
