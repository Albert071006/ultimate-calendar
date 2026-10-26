import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createEvidenceIndex, distilledSourceId, readEvidenceSourceIds } from './evidence-index';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), 'uc-evidence-index-')); roots.push(root); return join(root, 'links.sqlite'); }
describe('private local distilled source index', () => {
  it('uses exactly the service source ID derivation and merges duplicate local provenance', () => {
    const file = path(), id = 'qqd_' + 'a'.repeat(64), source = 'distilled-source:' + createHash('sha256').update(JSON.stringify(id)).digest('hex');
    expect(distilledSourceId(id)).toBe(source);
    const index = createEvidenceIndex(file); index.remember([{ distilledId: id, candidateId: 'c1', sourceIds: ['s1', 's2'] }, { distilledId: id, candidateId: 'c2', sourceIds: ['s2'] }]); index.close();
    expect(readEvidenceSourceIds(file, source)).toEqual(['s1', 's2']);
    const reopened = createEvidenceIndex(file); reopened.remember([{ distilledId: id, candidateId: 'c1', sourceIds: ['s3'] }]); reopened.close();
    expect(readEvidenceSourceIds(file, source)).toEqual(['s1', 's2', 's3']);
  });
  it('does not create an index for read-only missing lookup and refuses unrelated files', () => {
    const file = path(); expect(readEvidenceSourceIds(file, 'distilled-source:' + 'b'.repeat(64))).toEqual([]);
    writeFileSync(file, 'unrelated-private-file'); const before = readFileSync(file);
    expect(() => createEvidenceIndex(file)).toThrow(); expect(readFileSync(file)).toEqual(before);
  });
  it('upgrades an old private index and keeps event generations stable across reopen and ancestor reads', () => {
    const file = path(), id = 'qqd_' + 'a'.repeat(64), eventId = 'qqe_' + 'b'.repeat(64);
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE qq_evidence_links (cloud_source_id TEXT NOT NULL, distilled_id TEXT NOT NULL, candidate_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(cloud_source_id,candidate_id,source_id)); PRAGMA user_version=1;');
    old.prepare('INSERT INTO qq_evidence_links VALUES(?,?,?,?)').run(distilledSourceId(id), id, 'root', 'source-one'); old.close();
    expect(readEvidenceSourceIds(file, distilledSourceId(id))).toEqual(['source-one']);
    const index = createEvidenceIndex(file); expect(index.legacyIds(['root'])).toEqual([id]);
    expect(index.generation(eventId, ['review', 'root'])).toBe(2); expect(index.generation(eventId, ['root'])).toBe(1); index.close();
    const reopened = createEvidenceIndex(file); expect(reopened.generation(eventId, ['review', 'root'])).toBe(2); expect(reopened.generation(eventId, ['second-review', 'root'])).toBe(3); reopened.close();
    expect(readEvidenceSourceIds(file, distilledSourceId(id))).toEqual(['source-one']);
  });
});
