import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository, newEntity } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createController } from '../application/controller';
import { createLedgerService } from '../ledger/service';
import { LedgerEntryDraftSchema } from '../shared/ledger';
import { GoalInputSchema, TaskInputSchema } from '../shared/contracts';
import { createSafeBackup } from './backup';
import { createRemoteService } from './service';

describe('sanitized server backups and backup injection compatibility', () => {
  it('exports formal planner and complete ledger fields without raw sources, quotes, hidden fingerprints or credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-safe-backup-')); const data = join(root, 'data'); mkdirSync(data);
    const repository = createRepository(join(data, 'planner.sqlite'), { automaticBackup: () => {} }); const planner = createPlanner(repository, { automaticBackup: () => {} }); const ledger = createLedgerService(repository.path);
    try {
      const raw = 'SYNTHETIC-RAW-PRIVATE-NOTICE', image = 'data:image/png;base64,c3ludGhldGljLWltYWdl';
      const source = repository.writeInternal({ operationId: 'seed-raw-source', changes: [{ entity: 'source', values: { kind: 'image', text: raw, imageDataUrl: image, importedAt: '2026-10-24T10:00:00+08:00', captureRef: { messageId: 'private-message', groupId: 'private-group', accountId: 'private-account', attachmentId: null, locator: 'C:/private/notice.png', transcribed: false } } }] }).entities[0]!;
      repository.transact(state => { newEntity(state, 'candidate', { title: '虚构报告提炼', sourceIds: [source.id], sourceQuote: raw, temporalEvidence: [{ field: 'deadline', basis: 'explicit', quote: raw }] }); });
      planner.mutate({ operationId: 'formal-task', origin: 'manual', confirmed: false, mutations: [{ type: 'create', entity: 'task', values: TaskInputSchema.parse({ title: '保留正式任务' }) }] });
      const entry = LedgerEntryDraftSchema.parse({ id: 'synthetic-lunch', kind: 'expense', date: '2026-10-23', month: '2026-10', title: '虚构午餐', category: '餐饮', amountCents: 1200, personalCents: 600, cashflows: [{ accountId: 'alipay', deltaCents: -1200 }] });
      ledger.mutate({ operationId: 'formal-ledger', expectedRevision: 0, changes: [{ type: 'putEntry', entry, expectedVersion: null, confirmDuplicate: false, note: '虚构AA记录' }] });
      const payload = ledger.exportJson(); payload.sources.push({ id: 'ledger-source', label: 'private-bank-export.csv', importedAt: '2026-10-24T10:00:00Z', content: raw, checksum: raw }); ledger.import(payload, 'ledger-source-import');
      const exports = join(root, 'exports'), path = createSafeBackup({ repository, ledger, directory: exports }); const serialized = readFileSync(path, 'utf8'), backup = JSON.parse(serialized);
      for (const forbidden of [raw, image, 'private-group', 'private-account', 'private-message', 'C:/private', 'private-bank-export', 'csrfToken', 'VAPID', 'apiKey']) expect(serialized).not.toContain(forbidden);
      expect(backup.planner.entities.task).toEqual(repository.read().entities.task);
      expect(backup.planner.entities.candidate[0].title).toBe('虚构报告提炼'); expect(backup.planner.entities.source[0]).toMatchObject({ kind: 'text', imageDataUrl: null });
      expect(backup.ledger.entries).toEqual(ledger.exportJson().entries); expect(backup.ledger.rules).toEqual(ledger.exportJson().rules); expect(backup.ledger.audit).toEqual(ledger.exportJson().audit); expect(backup.ledger.balanceSnapshots).toEqual(ledger.exportJson().balanceSnapshots);
      expect(repository.read().entities.source[0]).toHaveProperty('imageDataUrl', image);
      if (process.platform !== 'win32') { expect(statSync(exports).mode & 0o777).toBe(0o700); expect(statSync(path).mode & 0o777).toBe(0o600); }
      const unknown = join(exports, 'do-not-delete.txt'); writeFileSync(unknown, 'unknown');
      for (let index = 0; index < 9; index++) createSafeBackup({ repository, ledger, directory: exports, now: new Date(Date.UTC(2027, 0, index + 1)) });
      expect(readdirSync(exports).filter(name => name.startsWith('safe-auto-'))).toHaveLength(7); expect(readFileSync(unknown, 'utf8')).toBe('unknown');
    } finally { ledger.close(); repository.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('preserves desktop default backups while allowing all three layers to override them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-backup-options-'));
    const repository = createRepository(join(root, 'default.sqlite'));
    const overrideRepo = vi.fn(), overridePlanner = vi.fn(), overrideController = vi.fn();
    const overridden = createRepository(join(root, 'overridden.sqlite'), { automaticBackup: overrideRepo });
    try {
      repository.saveSettings({}); expect(repository.read().lastBackupAt).not.toBeNull();
      repository.transact(state => { state.lastBackupAt = null; });
      createPlanner(repository).mutate({ operationId: 'default-mutate', origin: 'manual', confirmed: false, mutations: [{ type: 'create', entity: 'goal', values: GoalInputSchema.parse({ title: '虚构默认目标' }) }] });
      expect(repository.read().lastBackupAt).not.toBeNull(); repository.transact(state => { state.lastBackupAt = null; });
      await createController({ repository, planner: createPlanner(repository), getApiKey: async () => null }).importSource({ operationId: 'default-import', source: { kind: 'text', text: '虚构消息' } });
      expect(repository.read().lastBackupAt).not.toBeNull();
      overridden.saveSettings({}); expect(overrideRepo).toHaveBeenCalledOnce(); expect(overridden.read().lastBackupAt).toBeNull();
      const planner = createPlanner(overridden, { automaticBackup: overridePlanner });
      planner.mutate({ operationId: 'override-mutate', origin: 'manual', confirmed: false, mutations: [{ type: 'create', entity: 'goal', values: GoalInputSchema.parse({ title: '虚构覆盖目标' }) }] }); expect(overridePlanner).toHaveBeenCalledOnce();
      await createController({ repository: overridden, planner, getApiKey: async () => null, automaticBackup: overrideController }).importSource({ operationId: 'override-import', source: { kind: 'text', text: '虚构消息' } }); expect(overrideController).toHaveBeenCalledOnce(); expect(overridden.read().lastBackupAt).toBeNull();
    } finally { repository.close(); overridden.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps uploaded input out of remote receipts and safe backups, then cleans it after analysis', async () => {
    const root = mkdtempSync(join(tmpdir(), 'calendar-remote-privacy-')); const backupDirectory = join(root, 'exports');
    const service = createRemoteService({ dataDirectory: join(root, 'data'), backupDirectory, getApiKey: async () => 'synthetic-key', controller: { fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"candidates":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 }) } });
    try {
      const imageDataUrl = 'data:image/png;base64,c3ludGhldGljLWltYWdl';
      const result = await service.rpc('importSource', { requestId: 'image-upload', identity: service.state.identity(), input: { operationId: 'image-source', source: { kind: 'image', imageDataUrl, text: 'RAW-UPLOADED-SYNTHETIC-TEXT' } } }, 'synthetic-device') as { ok: true; data: { id: string } };
      expect(JSON.stringify(result)).not.toContain(imageDataUrl); expect(JSON.stringify(service.state.operation('image-upload', 'synthetic-device'))).not.toContain(imageDataUrl);
      expect(service.snapshot().sources[0]?.imageDataUrl).toBe(imageDataUrl);
      const analyzed = await service.rpc('analyzeSource', { requestId: 'image-analysis', identity: service.state.identity(), input: { operationId: 'analyze-image-source', sourceId: result.data.id } }, 'synthetic-device'); expect(analyzed).toMatchObject({ ok: true });
      expect(service.snapshot().sources[0]).toMatchObject({ kind: 'text', imageDataUrl: null });
      for (const name of readdirSync(backupDirectory)) { const content = readFileSync(join(backupDirectory, name), 'utf8'); expect(content).not.toContain(imageDataUrl); expect(content).not.toContain('RAW-UPLOADED-SYNTHETIC-TEXT'); }
      expect(() => createRemoteService({ dataDirectory: join(root, 'data'), getApiKey: async () => null })).toThrow(/已有服务/);
    } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
