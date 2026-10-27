import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateSchema, SourceSchema } from '../shared/contracts';
import type { ExtractedCandidate } from '../ai/schemas';
import { candidateDates } from '../domain/candidate-dates';
import { reconcileCaptureCandidate } from './candidate-batch';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from './store';
import { analyzeCapture, applyCaptureResult } from './analysis';

const quote = '明天中午到示例餐厅集合';
const at = '2026-10-26T19:54:00+08:00';
function source(id: string, sentAt: string | null, text = quote) {
  return SourceSchema.parse({ id, version: 1, createdAt: at, updatedAt: at, importedAt: at, kind: 'text', text, sentAt });
}
const oldSource = source('old-source', at);
const nextSource = source('next-source', '2026-10-27T17:29:00+08:00');
function extracted(sourceId: string, text = quote): ExtractedCandidate {
  return { title: '参加午间集合', action: '到示例餐厅集合', benefit: '', benefitKind: 'unknown', potentialBenefit: '',
    conditions: [], uncertainties: ['具体钟点待确认'], sourceIds: [sourceId], sourceQuote: text, deadline: null,
    eventStart: null, eventEnd: null, location: '示例餐厅', temporalEvidence: [{ field: 'eventStart', basis: 'relative', quote: '明天中午' }],
    relation: { kind: 'new', candidateId: null } };
}
const { relation: _relation, ...originalValues } = extracted(oldSource.id);
const original = CandidateSchema.parse({ ...originalValues, id: 'original', version: 1, createdAt: at, updatedAt: at });

describe('event identity grounded in each message sending day', () => {
  it.each(['new', 'duplicate', 'supplement', 'revision'] as const)('keeps the next day independent despite a model %s relation and null clocks', kind => {
    for (const status of ['pending', 'accepted', 'ignored'] as const) {
      const before = { ...original, status, taskId: status === 'accepted' ? 'old-task' : null };
      const result = reconcileCaptureCandidate({ ...extracted(nextSource.id), relation: { kind, candidateId: kind === 'new' ? null : before.id } },
        nextSource, [nextSource.id], [before], [], [oldSource, nextSource]);
      expect(result).toMatchObject({ kind: 'create', values: { sourceIds: [nextSource.id], revisionOfId: null, duplicateOfId: null, eventStart: null, eventEnd: null, taskId: null } });
      if (result.kind === 'create') expect(candidateDates(result.values, [nextSource])).toEqual({ eventStart: ['2026-10-28'] });
      expect(before.sourceIds).toEqual([oldSource.id]);
    }
  });

  it.each(['same-day', 'today-after-tomorrow'] as const)('still merges references to the same day: %s', mode => {
    const current = mode === 'same-day' ? source('current', '2026-10-26T23:30:00+08:00')
      : source('current', '2026-10-27T09:30:00+08:00', quote.replace('明天', '今天'));
    const item = extracted(current.id, current.text);
    item.temporalEvidence[0]!.quote = mode === 'same-day' ? '明天中午' : '今天中午';
    expect(reconcileCaptureCandidate(item, current, [current.id], [original], [], [oldSource, current])).toMatchObject({ kind: 'update', id: original.id,
      values: { sourceIds: [oldSource.id, current.id] } });
  });

  it('uses a grounded day even when the model marks its missing clock unknown or omits temporal evidence', () => {
    for (const evidence of [[{ field: 'eventStart' as const, basis: 'unknown' as const, quote: '明天中午' }], []]) {
      expect(reconcileCaptureCandidate({ ...extracted(nextSource.id), temporalEvidence: evidence }, nextSource, [nextSource.id],
        [{ ...original, temporalEvidence: evidence }], [], [oldSource, nextSource])).toMatchObject({ kind: 'create', values: { revisionOfId: null } });
    }
  });

  it('preserves an explicit date-only reschedule as a separate review', () => {
    const current = source('reschedule', nextSource.sentAt, '集合改到明天中午');
    const item = { ...extracted(current.id, current.text), relation: { kind: 'supplement' as const, candidateId: original.id } };
    expect(reconcileCaptureCandidate(item, current, [current.id], [original], [], [oldSource, current])).toMatchObject({ kind: 'create', values: {
      revisionOfId: original.id, sourceIds: [oldSource.id, current.id], eventStart: null,
    } });
  });

  it('does not treat unrelated rescheduling words or advance preparation as permission to merge', () => {
    for (const text of [`${quote}。另外一场会议延期`, `请提前准备。${quote}`, `请提前到场，${quote}`]) {
      const current = source('current', nextSource.sentAt, text);
      expect(reconcileCaptureCandidate({ ...extracted(current.id), relation: { kind: 'supplement', candidateId: original.id } },
        current, [current.id], [original], [], [oldSource, current])).toMatchObject({ kind: 'create', values: { revisionOfId: null } });
    }
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-relative-event-'));
  const path = join(directory, 'planner.sqlite');
  const repository = createRepository(path, { automaticBackup: () => {} }), store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200'] });
  for (const [index, sentAt] of [at, nextSource.sentAt!].entries()) store.ingest([{ accountId: '100', groupId: '200', messageId: `message-${index}`, text: quote,
    sentAt, importedAt: `2026-10-27T17:30:0${index}+08:00` }]);
  store.sealBatches({ force: true }); const batch = store.claimBatch()!;
  return { repository, store, batch, getApiKey: async () => 'synthetic', canContinue: () => true };
}
function response(candidates: unknown[]) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
}
function units(request?: RequestInit): { id: string; text: string }[] {
  return JSON.parse(JSON.parse(String(request?.body)).messages.find((message: { role: string }) => message.role === 'user').content[0].text).units;
}
describe('QQ temporal boundaries across saved responses', () => {
  it('overrules a shared event key, stores separate evidence and reapplies without duplicating either occurrence', async () => {
    const f = fixture(); let calls = 0;
    await analyzeCapture({ ...f, fetch: async (_url, request) => {
      calls++; return response(units(request).map(unit => ({ ...extracted(unit.id), eventKey: 'midday-meeting' })));
    } });
    const saved = f.repository.snapshot();
    expect(saved.candidates).toHaveLength(2);
    expect(saved.candidates.map(candidate => candidateDates(candidate, saved.sources).eventStart?.[0]).sort()).toEqual(['2026-10-27', '2026-10-28']);
    for (const candidate of saved.candidates) expect(candidate).toMatchObject({ sourceIds: expect.any(Array), revisionOfId: null, duplicateOfId: null, eventStart: null });
    expect(saved.candidates.every(candidate => candidate.sourceIds.length === 1)).toBe(true);
    applyCaptureResult(f.store, f.repository, f.store.batch(f.batch.id)!);
    expect(f.repository.snapshot().candidates).toEqual(saved.candidates); expect(calls).toBe(1);
  });

  it('retains an invalid cross-day supporting-source response for correction without creating a merged card or charging again', async () => {
    const f = fixture(); let calls = 0;
    const options = { ...f, fetch: async (_url: unknown, request?: RequestInit) => {
      calls++; const items = units(request); return response([{ ...extracted(items[0]!.id), supportingSources: [{ sourceId: items[1]!.id, quote }] }]);
    } };
    await expect(analyzeCapture(options)).rejects.toMatchObject({ code: 'AI_RESPONSE', message: expect.stringContaining('不同日期') });
    expect(f.repository.snapshot().candidates).toEqual([]);
    expect(f.store.batch(f.batch.id)!.result).toHaveProperty('pendingResponse');
    await expect(analyzeCapture({ ...options, batch: f.store.batch(f.batch.id)! })).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(calls).toBe(1);
  });
});
