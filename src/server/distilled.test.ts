import { describe, expect, it } from 'vitest';
import { createRepository } from '../storage/repository';
import { importDistilled } from './distilled';
import { DistilledRequestSchema } from '../shared/distilled';

const identity = { protocolVersion: 1 as const, dataInstanceId: 'e7028f3d-072b-4ab2-bfd2-b915956318d3', generation: 1 };
function request(requestId = 'batch-one', title = '提交虚构报告') { return DistilledRequestSchema.parse({ requestId, identity, items: [{ distilledId: 'synthetic-stable-id-001', title, deadline: { date: '2027-01-02', time: '20:10' } }] }); }
describe('strict distilled imports', () => {
  it('retains actionable fields with placeholder provenance and deduplicates across batches', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      const first = importDistilled(repository, request()); expect(first.created).toBe(1);
      expect(importDistilled(repository, request())).toEqual(first);
      expect(importDistilled(repository, request('other-batch')).created).toBe(0);
      const snapshot = repository.snapshot(); expect(snapshot.candidates).toHaveLength(1); expect(snapshot.sources).toHaveLength(1);
      expect(snapshot.candidates[0]).toMatchObject({ title: '提交虚构报告', deadline: { date: '2027-01-02', time: '20:10' }, sourceQuote: '', temporalEvidence: [] });
      expect(snapshot.sources[0]).toMatchObject({ kind: 'text', imageDataUrl: null, label: '采集电脑提炼' });
      expect(JSON.stringify(snapshot)).not.toContain('captureRef');
      expect(() => importDistilled(repository, request('changed', '编号相同但内容不同'))).toThrow(/内容不同/);
      expect(repository.snapshot().candidates).toHaveLength(1);
    } finally { repository.close(); }
  });
  it('rejects raw evidence, group identifiers, paths and attachments instead of silently dropping them', () => {
    const base = request();
    for (const field of ['sourceQuote', 'captureRef', 'groupId', 'path', 'imageDataUrl', 'text', 'attachments']) {
      expect(() => DistilledRequestSchema.parse({ ...base, items: [{ ...base.items[0], [field]: 'synthetic-private-value' }] })).toThrow();
    }
  });
  it('rolls the whole batch back on a later conflicting extraction', () => {
    const repository = createRepository(':memory:', { automaticBackup: () => {} });
    try {
      importDistilled(repository, request());
      const batch = request('conflicting-batch');
      batch.items.unshift({ ...batch.items[0]!, distilledId: 'synthetic-second-id-002' }); batch.items[1]!.title = 'changed';
      expect(() => importDistilled(repository, batch)).toThrow(); expect(repository.snapshot().candidates).toHaveLength(1);
    } finally { repository.close(); }
  });
});
