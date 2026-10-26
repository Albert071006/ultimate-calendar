import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository, type Repository } from '../storage/repository';
import { createEvidenceIndex, distilledSourceId, evidenceIndexPath } from '../bridge/evidence-index';
import { projectDistilledFields } from '../bridge/projection';
import { createLocalEvidenceResolver } from './local-evidence';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uc-evidence-')); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const repo = createRepository(join(directory, 'planner.sqlite'), { automaticBackup: () => {} }); cleanups.push(() => repo.close());
  const source = repo.writeInternal({ operationId: crypto.randomUUID(), changes: [{ entity: 'source', values: { kind: 'text', text: 'PRIVATE_SYNTHETIC_EVIDENCE', label: 'LOCAL_ONLY_GROUP_LABEL', importedAt: '2026-01-01T00:00:00+08:00', captureRef: { messageId: 'synthetic-message', accountId: '90001111', groupId: '90002222', attachmentId: null, locator: 'synthetic-locator', transcribed: false } } }] }).entities[0]!;
  return { directory, repo, source, resolve: createLocalEvidenceResolver(repo) };
}
describe('Windows local evidence resolver', () => {
  it('uses preserved migration source IDs in the collector-owned repository', () => {
    const f = fixture(), result = f.resolve({ sourceId: f.source.id });
    expect(result).toMatchObject({ match: 'legacy-id', sources: [{ id: f.source.id, text: 'PRIVATE_SYNTHETIC_EVIDENCE' }] });
    expect(result.sources[0]!.captureRef?.messageId).toBe('synthetic-message');
  });
  it('retains local links for a distilled source even when the candidate changes later', () => {
    const f = fixture(), projected = projectDistilledFields({ title: '合成待判断' }); if (!projected.ok) throw Error('fixture invalid');
    const index = createEvidenceIndex(evidenceIndexPath(f.repo.path));
    index.remember([{ distilledId: projected.value.item.distilledId, candidateId: 'local-candidate', sourceIds: [f.source.id] }]); index.close();
    const result = f.resolve({ sourceId: distilledSourceId(projected.value.item.distilledId) });
    expect(result).toMatchObject({ match: 'distilled-index', sources: [{ id: f.source.id }] });
    const content = readFileSync(evidenceIndexPath(f.repo.path)).toString('utf8');
    for (const raw of ['PRIVATE_SYNTHETIC_EVIDENCE', 'LOCAL_ONLY_GROUP_LABEL', '90001111', '90002222', 'synthetic-message', '合成待判断']) expect(content).not.toContain(raw);
  });
  it('returns all locally linked sources and never guesses a missing source by title', () => {
    const f = fixture();
    expect(() => f.resolve({ sourceId: 'distilled-source:' + 'a'.repeat(64) })).toThrow(/没有找到/);
    expect(() => f.resolve({ sourceId: 'unknown-local-id' })).toThrow(/没有找到/);
    const other = f.repo.writeInternal({ operationId: crypto.randomUUID(), changes: [{ entity: 'source', values: { kind: 'text', text: 'SECOND_SYNTHETIC_EVIDENCE', importedAt: '2026-01-01T00:00:00+08:00' } }] }).entities[0]!;
    const distilledId = 'qqd_' + 'b'.repeat(64), index = createEvidenceIndex(evidenceIndexPath(f.repo.path));
    index.remember([{ distilledId, candidateId: 'one', sourceIds: [f.source.id] }, { distilledId, candidateId: 'two', sourceIds: [other.id] }]); index.close();
    expect(new Set(f.resolve({ sourceId: distilledSourceId(distilledId) }).sources.map(value => value.id))).toEqual(new Set([f.source.id, other.id]));
  });
  it('does not open or instantiate a repository of its own', () => {
    const f = fixture(); let reads = 0;
    const resolver = createLocalEvidenceResolver({ path: f.repo.path, read() { reads++; return f.repo.read(); } } satisfies Pick<Repository, 'path' | 'read'>);
    resolver({ sourceId: f.source.id }); expect(reads).toBe(1);
  });
});
