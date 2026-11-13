import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from './store';
import { analyzeCapture, applyCaptureResult } from './analysis';
import { expandCaptureTable } from './request-wire';
import type { Candidate } from '../shared/contracts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const at = '2031-04-16T12:00:00+08:00';
const eligibility = '合成展览的观摩名额优先给已登记的成员，剩余名额才向未登记的成员开放。';

function fixture(status: Candidate['status'] = 'pending') {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-eligibility-followup-'));
  const path = join(dir, 'planner.sqlite');
  const repository = createRepository(path, { automaticBackup: () => {} });
  const store = createCaptureStore(path);
  cleanups.push(() => { store.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200'] });
  const source = repository.writeInternal({ operationId: 'synthetic-notice', changes: [{ entity: 'source', values: {
    kind: 'text', text: '欢迎报名参加合成展览，携带登记证。', importedAt: at, sentAt: at,
    captureRef: { accountId: '100', groupId: '200', messageId: 'original', attachmentId: null, locator: '合成通知', transcribed: false },
  } }] }).entities[0]!;
  repository.writeInternal({ operationId: 'synthetic-event', changes: [{ entity: 'candidate', values: {
    title: '报名参加合成展览', action: '报名后参加合成展览', sourceIds: [source.id], sourceQuote: '欢迎报名参加合成展览，携带登记证。', status,
    conditions: ['携带登记证'], deadline: { date: '2031-04-17', time: '18:00' },
    eventStart: '2031-04-18T14:00:00+08:00', eventEnd: '2031-04-18T16:00:00+08:00', location: '合成展厅',
  } }] });
  const original = repository.snapshot().candidates[0]!;
  store.ingest([{ accountId: '100', groupId: '200', messageId: 'eligibility-followup',
    sentAt: '2031-04-16T12:15:00+08:00', text: eligibility }]);
  store.sealBatches({ force: true });
  const batch = store.claimBatch()!;
  const fetch: typeof globalThis.fetch = async (_url, request) => {
    const messages = JSON.parse(String(request?.body)).messages;
    const system = messages.find((message: { role: string }) => message.role === 'system').content;
    const input = JSON.parse(messages.find((message: { role: string }) => message.role === 'user').content[0].text);
    // Verify the actual model wire contains the exception to the new-action gate,
    // a scoped target with its existing conditions, and unabridged current evidence.
    expect(system).toContain('补充无需再次要求用户行动');
    expect(system).toContain('relation.kind=supplement');
    expect(system).toContain('不能把“优先”改成“仅限”');
    expect(system).toContain('ignored 仍只用于防重复');
    const existing = expandCaptureTable(input.existingCandidates);
    expect(existing).toHaveLength(1);
    expect(existing[0]).toMatchObject({ status, conditions: ['携带登记证'], title: original.title });
    expect(input.units).toHaveLength(1);
    expect(input.units[0].text).toBe(eligibility);
    const candidate = { title: original.title, action: '', benefit: '', benefitKind: 'unknown', potentialBenefit: '',
      conditions: ['已登记成员优先；有剩余名额时未登记成员才可参加'], uncertainties: [],
      sourceIds: [input.units[0].id], sourceQuote: eligibility, deadline: null, eventStart: null, eventEnd: null,
      location: '', temporalEvidence: [], relation: { kind: 'supplement', candidateId: existing[0]!.id } };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [candidate] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  };
  return { repository, store, batch, original, options: { repository, store, batch, fetch, getApiKey: async () => 'synthetic', canContinue: () => true } };
}

describe('eligibility-only follow-ups without a new action', () => {
  it('adds a qualified availability rule to the pending event without another task or losing timing', async () => {
    const f = fixture();
    await analyzeCapture(f.options);
    const snapshot = f.repository.snapshot(), current = snapshot.candidates[0]!;
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.tasks).toHaveLength(0);
    expect(current).toMatchObject({ id: f.original.id, status: 'pending', title: f.original.title, action: f.original.action,
      deadline: f.original.deadline, eventStart: f.original.eventStart, eventEnd: f.original.eventEnd,
      location: f.original.location, sourceQuote: f.original.sourceQuote });
    expect(current.conditions).toEqual(['携带登记证', '已登记成员优先；有剩余名额时未登记成员才可参加']);
    expect(current.sourceIds).toHaveLength(2);
    expect(snapshot.sources.find(source => source.id !== f.original.sourceIds[0])?.text).toContain(eligibility);
    applyCaptureResult(f.store, f.repository, f.store.batch(f.batch.id)!);
    expect(f.repository.snapshot().candidates).toEqual(snapshot.candidates);
  });

  it('keeps an ignored event ignored even if a model proposes the eligibility supplement', async () => {
    const f = fixture('ignored');
    const before = f.repository.snapshot();
    await analyzeCapture(f.options);
    const after = f.repository.snapshot();
    expect(after.candidates).toEqual(before.candidates);
    expect(after.sources).toEqual(before.sources);
    expect(after.tasks).toEqual(before.tasks);
    expect(f.store.batch(f.batch.id)?.status).toBe('applied');
  });
});
