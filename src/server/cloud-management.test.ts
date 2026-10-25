import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRemoteService, type RemoteServiceOptions } from './service';
import { createManagedApiKeyConfiguration } from './ai-configuration';
import { createRepository, newEntity } from '../storage/repository';
import { createLedgerService } from '../ledger/service';
import { LedgerEntryDraftSchema, LedgerImportPayloadSchema } from '../shared/ledger';
import { SettingsSchema } from '../shared/contracts';
import { MAX_CLOUD_EXPORT_BYTES, MAX_CLOUD_EXPORT_WIRE_BYTES, LedgerExportDataSchema } from '../shared/cloud-management';
import type { RemoteMethod } from '../shared/remote';
import { ledgerExportData, backupExportData } from './cloud-export';
import { validateSafeBackup } from './backup';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function folder() {
  const root = mkdtempSync(join(tmpdir(), 'calendar-cloud-management-'));
  cleanup.push(async () => {
    const delta = relative(resolve(tmpdir()), resolve(root));
    if (!delta || delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }); return root;
}
function setup(options: Partial<RemoteServiceOptions> = {}) {
  const root = folder();
  const service = createRemoteService({ dataDirectory: join(root, 'data'), backupDirectory: join(root, 'backups'), getApiKey: async () => null,
    controller: { fetch: async () => { throw Error('Unexpected synthetic transport call'); } }, ...options });
  cleanup.push(() => service.close());
  const rpc = (method: RemoteMethod, input?: unknown, requestId: string = randomUUID()) => service.rpc(method, { requestId, identity: service.state.identity(), input }, 'synthetic-device');
  return { root, service, rpc };
}
const cny = readFileSync(new URL('../ai/fixtures/pricing-cny.html', import.meta.url), 'utf8');
const usd = readFileSync(new URL('../ai/fixtures/pricing-usd.html', import.meta.url), 'utf8');
const models = { object: 'list', data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', input_modalities: ['text', 'image'] }] };
function response(url: string, total = '123.45') {
  return new Response(url.endsWith('/models') ? JSON.stringify(models) : url.endsWith('/balance')
    ? JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '0', topped_up_balance: total }] })
    : url.includes('/zh-cn/') ? cny : usd);
}

describe('cloud desktop management RPCs', () => {
  it('compares shared settings atomically, preserves device fields and durably replays the accepted write', async () => {
    const { service, rpc } = setup(), initial = service.snapshot().settings;
    const expectedSettings = { ...initial, closeToTray: !initial.closeToTray, autoLaunch: !initial.autoLaunch };
    const first = { settings: { ...expectedSettings, campus: '虚构甲校区' }, expectedSettings };
    const competing = { settings: { ...initial, campus: '虚构乙校区' }, expectedSettings: initial };
    const results = await Promise.all([rpc('saveSettings', first, 'first-settings'), rpc('saveSettings', competing, 'second-settings')]);
    expect(results[0]).toMatchObject({ ok: true, data: { campus: '虚构甲校区', closeToTray: initial.closeToTray, autoLaunch: initial.autoLaunch } });
    expect(results[1]).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(service.snapshot().settings.campus).toBe('虚构甲校区');
    expect(await rpc('saveSettings', first, 'first-settings')).toEqual(results[0]);
    expect(service.state.operation('first-settings', 'synthetic-device')).toMatchObject({ status: 'completed', result: results[0] });
    await expect(rpc('saveSettings', competing, 'first-settings')).rejects.toMatchObject({ status: 409 });
    await expect(service.rpc('saveSettings', { requestId: 'stale-generation', identity: { ...service.state.identity(), generation: 2 }, input: first }, 'synthetic-device')).rejects.toMatchObject({ status: 409 });
    expect(service.state.operation('stale-generation', 'synthetic-device')).toEqual({ status: 'unknown' });
  });

  it('parses selected CSV text into a preview, rejects server file dialogs, and replays without importing twice', async () => {
    const { service, rpc } = setup(); const expectedSettings = service.snapshot().settings;
    expect(await rpc('saveSettings', { settings: { ...expectedSettings, termStart: '2026-09-07' }, expectedSettings })).toMatchObject({ ok: true });
    const input = { operationId: 'synthetic-csv-preview', kind: 'text', text: '课程,星期,开始,结束,起始周,结束周,单双周,地点\n虚构数学,1,08:00,09:30,1,16,全,A101' };
    const result = await rpc('importCourses', input, 'course-preview');
    expect(result).toMatchObject({ ok: true, data: { courses: [{ title: '虚构数学' }] } });
    expect(service.snapshot().courses).toEqual([]);
    expect(await rpc('importCourses', input, 'course-preview')).toEqual(result);
    await expect(rpc('importCourses', { operationId: 'file-refused', kind: 'file' }, 'file-refused')).rejects.toThrow();
    expect(service.state.operation('file-refused', 'synthetic-device')).toEqual({ status: 'unknown' });
  });

  it('fetches real account shapes only on demand, clears old-key data and never journals read results', async () => {
    const root = folder(), configuration = createManagedApiKeyConfiguration(join(root, 'credentials', 'synthetic-ai.json'));
    const calls: { url: string; authorization: string | null }[] = [];
    const { service, rpc } = setup({ apiKeyConfiguration: configuration, controller: { fetch: async (url, init) => {
      const authorization = new Headers(init?.headers).get('authorization'); calls.push({ url: String(url), authorization });
      return response(String(url), authorization?.includes('second') ? '22.00' : '11.00');
    } } });
    const identity = service.state.identity();
    const first = await service.setAiConfiguration({ identity, expectedRevision: null, apiKey: 'synthetic-first-private-key' });
    expect(calls).toEqual([]);
    const account = await rpc('accountSnapshot', undefined, 'account-read');
    expect(account).toMatchObject({ ok: true, data: { configured: true, models: { data: [{ id: 'deepseek-flash', inputModalities: ['text', 'image'] }] }, balance: { data: { balances: [{ total: '11.00' }] } } } });
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(account)).not.toContain('synthetic-first-private-key');
    for (const call of calls) expect(call.authorization).toBe(call.url.startsWith('https://api.deepseek.com/') ? 'Bearer synthetic-first-private-key' : null);
    const next = await service.setAiConfiguration({ identity, expectedRevision: first.configuration.revision, apiKey: 'synthetic-second-private-key' });
    expect(await rpc('refreshAccount', undefined, 'account-read')).toMatchObject({ ok: true, data: { balance: { data: { balances: [{ total: '22.00' }] } } } });
    await service.clearAiConfiguration({ identity, expectedRevision: next.configuration.revision });
    expect(await rpc('accountSnapshot', undefined, 'account-read')).toMatchObject({ ok: true, data: { configured: false, models: { data: null }, balance: { data: null } } });
    expect(service.state.operation('account-read', 'synthetic-device')).toEqual({ status: 'unknown' });
    const storedPrices = readFileSync(join(service.dataDirectory, 'cache', 'deepseek-prices.json'), 'utf8');
    expect(storedPrices).not.toContain('private-key'); expect(storedPrices).not.toContain('11.00');
  });

  it('injects official prices and model modalities, then refreshes balance after an AI request', async () => {
    let balanceCalls = 0;
    const { service, rpc } = setup({ getApiKey: async () => 'synthetic-model-key', controller: { fetch: async url => {
      const value = String(url); if (value.endsWith('/balance')) balanceCalls++;
      if (value.endsWith('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows: [['虚构数学', '1', '08:00', '09:30', '1', '16', '全', 'A101']], uncertainties: [] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      return response(value);
    } } });
    await rpc('accountSnapshot'); const expectedSettings = service.snapshot().settings;
    await rpc('saveSettings', { settings: { ...expectedSettings, model: 'deepseek-flash', termStart: '2026-09-07' }, expectedSettings });
    const result = await rpc('importCourses', { operationId: 'synthetic-image-preview', kind: 'image', imageDataUrl: 'data:image/png;base64,aGVsbG8=' });
    expect(result).toMatchObject({ ok: true, data: { courses: [{ title: '虚构数学' }] } });
    expect(service.snapshot().tokenUsage[0]).toMatchObject({ pricingSource: 'official', estimatedCost: expect.any(Number) });
    expect(service.snapshot().sources[0]).toMatchObject({ kind: 'text', imageDataUrl: null });
    await vi.waitFor(() => expect(balanceCalls).toBe(2));
  });

  it('exports complete ledger history and safe restore envelopes without exposing original evidence or paths', async () => {
    const root = folder(), data = join(root, 'data'); mkdirSync(data);
    const repository = createRepository(join(data, 'planner.sqlite'), { automaticBackup: () => {} }), ledger = createLedgerService(repository.path);
    const raw = 'SYNTHETIC-PRIVATE-ORIGINAL-TEXT', image = 'data:image/png;base64,c3ludGhldGlj';
    try {
      repository.saveSettings(SettingsSchema.parse({ campus: '虚构校区' }));
      repository.transact(state => { newEntity(state, 'source', { kind: 'image', text: raw, imageDataUrl: image, importedAt: '2026-10-24T10:00:00+08:00', status: 'needs-review' }); });
      const entry = LedgerEntryDraftSchema.parse({ id: 'synthetic-entry', kind: 'expense', date: '2026-09-23', month: '2026-09', title: '虚构九月午餐', category: '餐饮', amountCents: 1200, personalCents: 1200, originalText: raw, cashflows: [{ accountId: 'alipay', deltaCents: -1200 }] });
      ledger.mutate({ operationId: 'seed-ledger', expectedRevision: 0, changes: [{ type: 'putEntry', entry, expectedVersion: null, confirmDuplicate: false, note: '' }] });
      ledger.mutate({ operationId: 'amend-ledger', expectedRevision: 1, changes: [{ type: 'putEntry', entry: { ...entry, title: '虚构修订午餐' }, expectedVersion: 1, confirmDuplicate: false, note: '' }] });
    } finally { ledger.close(); repository.close(); }
    const { service, rpc } = setup({ dataDirectory: data, backupDirectory: join(root, 'backups') });
    const full = await rpc('ledgerExportData', { format: 'json', month: '2026-10' }, 'reused-read-id') as { ok: true; data: { content: string; format: string } };
    expect(full).toMatchObject({ ok: true, data: { format: 'json' } });
    const parsed = LedgerImportPayloadSchema.parse(JSON.parse(full.data.content));
    expect(parsed.entries).toHaveLength(1); expect(parsed.audit).toHaveLength(2); expect(parsed).toHaveProperty('rules'); expect(parsed).toHaveProperty('balanceSnapshots');
    const csv = await rpc('ledgerExportData', { format: 'csv', month: '2026-09' }, 'reused-read-id') as typeof full;
    expect(csv.data.content).toContain('虚构修订午餐');
    const excluded = await rpc('ledgerExportData', { format: 'csv', month: '2026-10' }, 'reused-read-id') as typeof full;
    expect(excluded.data.content).not.toContain('虚构修订午餐');
    const backup = await rpc('backupExportData', undefined, 'reused-read-id') as { ok: true; data: { content: string } };
    expect(backup.ok).toBe(true); expect(Object.keys(backup.data)).toEqual(['content']);
    for (const forbidden of [raw, image, root, 'apiKey', 'csrfToken']) expect(backup.data.content).not.toContain(forbidden);
    const validated = validateSafeBackup(JSON.parse(backup.data.content));
    expect(validated.ledger.entries).toHaveLength(1); expect(validated.ledger.audit).toHaveLength(2); expect(validated.planner.settings.campus).toBe('虚构校区');
    expect(service.state.operation('reused-read-id', 'synthetic-device')).toEqual({ status: 'unknown' });
  });

  it('rejects oversized UTF-8 or JSON-escaped exports without truncating', () => {
    const valid = 'x'.repeat(MAX_CLOUD_EXPORT_BYTES);
    expect(ledgerExportData(valid, 'csv').content.length).toBe(MAX_CLOUD_EXPORT_BYTES);
    for (const content of ['x'.repeat(MAX_CLOUD_EXPORT_BYTES + 1), '界'.repeat(Math.floor(MAX_CLOUD_EXPORT_BYTES / 3) + 1), '\u0000'.repeat(Math.ceil(MAX_CLOUD_EXPORT_WIRE_BYTES / 6))]) {
      expect(LedgerExportDataSchema.safeParse({ content, format: 'json' }).success).toBe(false);
      expect(() => ledgerExportData(content, 'json')).toThrow(/未截断/);
    }
    const root = folder(), path = join(root, 'oversize.json'); writeFileSync(path, valid + 'x');
    expect(() => backupExportData(path)).toThrow(/未截断/);
  });
});
