import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createLedgerService } from '../ledger/service';
import { createRepository } from '../storage/repository';
import { LedgerImportPayloadSchema } from '../shared/ledger';
import { createRemoteService, type RemoteService } from './service';
import { remoteOutputs } from './protocol';

const services: RemoteService[] = [], folders: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  vi.useRealTimers();
  for (const folder of folders.splice(0)) {
    const delta = relative(resolve(tmpdir()), resolve(folder));
    if (!delta || delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw Error('Unsafe test cleanup');
    rmSync(folder, { recursive: true, force: true });
  }
});
it('cloud records and broadcasts the allowance with no connected client or ledgerSnapshot request, then survives restart without duplication', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T15:59:50Z'));
  const root = mkdtempSync(join(tmpdir(), 'calendar-allowance-scheduler-')); folders.push(root);
  const dataDirectory = join(root, 'data'), backupDirectory = join(root, 'backups');
  const repo = createRepository(join(dataDirectory, 'planner.sqlite'), { automaticBackup: () => {} });
  const ledger = createLedgerService(repo.path);
  ledger.mutate({ operationId: 'synthetic-allowance-rule', expectedRevision: 0, changes: [{ type: 'updateRules', rules: {
    ...ledger.snapshot().rules, monthlyAllowance: { enabled: true, amountCents: 100000, accountId: 'alipay', startMonth: '2026-11' },
  }, note: '合成规则' }] });
  ledger.close(); repo.close();
  const fetch = vi.fn(async () => { throw Error('No AI request expected'); });
  const start = () => { const service = createRemoteService({ dataDirectory, backupDirectory, getApiKey: async () => null, controller: { fetch } }); services.push(service); return service; };
  const service = start(), changed = vi.fn(); service.subscribe(changed);
  vi.advanceTimersByTime(30_000);
  expect(changed).toHaveBeenCalledExactlyOnceWith({ reason: 'mutation' });
  const result = remoteOutputs.ledgerExportData.parse(await service.rpc('ledgerExportData', { requestId: 'export', identity: service.state.identity(), input: { format: 'json' } }, 'synthetic-device'));
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error('Export failed');
  const saved = LedgerImportPayloadSchema.parse(JSON.parse(result.data.content));
  expect(saved.entries).toMatchObject([{ ruleKey: 'rule:monthly-allowance:2026-11', cashflows: [{ accountId: 'alipay', deltaCents: 100000 }] }]);
  expect(service.status().backup.lastSuccessAt).toBe('2026-10-31T16:00:20.000Z');
  await service.close();
  const reopened = start();
  const second = await reopened.rpc('ledgerExportData', { requestId: 'export-after-restart', identity: reopened.state.identity(), input: { format: 'json' } }, 'synthetic-device');
  expect(second).toEqual(result);
  expect(fetch).not.toHaveBeenCalled();
});
