import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SOURCE_TEXT, SourceSchema, type ImportSourceRequest } from '../shared/contracts';
import { createRemoteSourceCache } from './remote-source-cache';

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const instant = '2026-01-01T12:00:00+08:00';
function fixture() {
  const profile = mkdtempSync(join(tmpdir(), 'uc-manual-evidence-')); directories.push(profile);
  const directory = join(profile, 'private', 'manual-source-cache');
  return { profile, directory, cache: createRemoteSourceCache(profile), file: (id: string) => join(directory, createHash('sha256').update(id).digest('hex') + '.json') };
}
function source(id = 'synthetic-source') {
  return SourceSchema.parse({ id, version: 1, createdAt: instant, updatedAt: instant, importedAt: instant, kind: 'text', text: '云端已清理原始内容' });
}
const request: ImportSourceRequest = { operationId: 'synthetic-import', source: { kind: 'text', text: 'PRIVATE_SYNTHETIC_MANUAL_TEXT', label: '合成文字', sentAt: instant } };

describe('Windows manual source evidence cache', () => {
  it('retains submitted text across cloud redaction and profile restart without changing cloud data', () => {
    const f = fixture(), cloud = source(), before = structuredClone(cloud);
    f.cache.remember(request, cloud);
    const restored = createRemoteSourceCache(f.profile).read(cloud.id);
    expect(restored).toMatchObject({ ...request.source, id: cloud.id, importedAt: instant });
    expect(cloud).toEqual(before);
    expect(readdirSync(f.directory)).toEqual([createHash('sha256').update(cloud.id).digest('hex') + '.json']);
    expect(existsSync(join(f.profile, 'planner.sqlite'))).toBe(false);
    restored!.text = 'local caller changed its copy';
    expect(f.cache.read(cloud.id)?.text).toBe(request.source.text);
  });
  it('preserves screenshots even if the returned source is a text placeholder', () => {
    const f = fixture(), image = 'data:image/png;base64,c3ludGhldGlj';
    f.cache.remember({ operationId: 'image-request', source: { kind: 'image', imageDataUrl: image, text: 'synthetic image note' } }, source('image-id'));
    expect(f.cache.read('image-id')).toMatchObject({ kind: 'image', imageDataUrl: image, text: 'synthetic image note' });
  });
  it('does not overwrite an original with newer or older cloud versions or different raw input', () => {
    const f = fixture(), cloud = source(); f.cache.remember(request, cloud);
    const bytes = readFileSync(f.file(cloud.id));
    f.cache.remember({ ...request, operationId: 'retry' }, { ...cloud, version: 8, status: 'succeeded' });
    expect(readFileSync(f.file(cloud.id))).toEqual(bytes);
    expect(() => f.cache.remember({ ...request, source: { kind: 'text', text: 'different synthetic text' } }, { ...cloud, version: 9 })).toThrow(/未覆盖/);
    expect(readFileSync(f.file(cloud.id))).toEqual(bytes);
  });
  it('deletes raw evidence and persists tombstones against late success, including missing-source deletion', () => {
    const f = fixture(), cloud = source(); f.cache.remember(request, cloud); f.cache.forget(cloud.id);
    expect(f.cache.read(cloud.id)).toBeNull();
    expect(readFileSync(f.file(cloud.id), 'utf8')).not.toContain(request.source.text);
    const reopened = createRemoteSourceCache(f.profile);
    expect(() => reopened.remember(request, cloud)).toThrow(/已删除/);
    reopened.forget('not-arrived-yet');
    expect(() => reopened.remember(request, source('not-arrived-yet'))).toThrow(/已删除/);
    reopened.forget(cloud.id);
  });
  it('hashes arbitrary valid IDs and rejects invalid, QQ, oversized and malformed evidence', () => {
    const f = fixture(), id = '../../outside\\source'; f.cache.remember(request, source(id));
    expect(f.cache.read(id)?.id).toBe(id);
    expect(readdirSync(f.directory)).toEqual([createHash('sha256').update(id).digest('hex') + '.json']);
    expect(() => f.cache.read('x'.repeat(201))).toThrow(/格式或大小/);
    expect(() => f.cache.remember(request, source('distilled-source:' + 'a'.repeat(64)))).toThrow(/QQ/);
    expect(f.cache.read('distilled-source:' + 'a'.repeat(64))).toBeNull();
    f.cache.forget('distilled-source:' + 'a'.repeat(64));
    expect(() => f.cache.remember(request, { ...source('qq'), captureRef: { accountId: 'synthetic-account', groupId: 'synthetic-group', messageId: 'synthetic-message', attachmentId: null, locator: '', transcribed: false } })).toThrow(/手动导入/);
    expect(() => f.cache.remember({ ...request, source: { kind: 'text', text: 'x'.repeat(MAX_SOURCE_TEXT + 1) } }, source())).toThrow(/格式或大小/);
    expect(() => f.cache.remember({ ...request, source: { kind: 'image', imageDataUrl: 'data:image/svg+xml;base64,YQ==' } }, source())).toThrow(/格式或大小/);
    expect(() => createRemoteSourceCache('relative-profile')).toThrow(/独立资料目录/);
  });
  it('refuses a corrupt or ID-mismatched cache without wiping it or exposing raw data in errors', () => {
    const f = fixture(), cloud = source(); f.cache.remember(request, cloud);
    const path = f.file(cloud.id), original = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...original, source: { ...original.source, id: 'different-id' } }), { mode: 0o600 });
    expect(() => f.cache.read(cloud.id)).toThrow(/无法核验/);
    expect(() => f.cache.remember(request, cloud)).toThrow(/无法核验/);
    expect(readFileSync(path, 'utf8')).toContain(request.source.text);
    writeFileSync(path, request.source.text!, { mode: 0o600 });
    try { f.cache.read(cloud.id); throw Error('missing rejection'); } catch (error) { expect(String(error)).not.toContain(request.source.text); }
  });
  it('rejects oversized and multiply linked private files before reading their contents', () => {
    const f = fixture(); f.cache.remember(request, source('oversized')); f.cache.remember(request, source('linked'));
    truncateSync(f.file('oversized'), 16 * 1024 * 1024 + 1);
    expect(() => f.cache.read('oversized')).toThrow(/无法核验/);
    linkSync(f.file('linked'), join(f.profile, 'synthetic-hardlink.json'));
    expect(() => f.cache.read('linked')).toThrow(/无法核验/);
    expect(() => f.cache.forget('linked')).toThrow(/无法核验/);
  });
  it('retains course images with a local capture timestamp and no invented message sentAt', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
    const f = fixture(), input = { kind: 'image' as const, operationId: 'course-image', imageDataUrl: 'data:image/png;base64,c3ludGhldGlj' };
    f.cache.rememberCourseImage(input, 'course-source');
    expect(f.cache.read('course-source')).toMatchObject({ kind: 'image', purpose: 'courses', imageDataUrl: input.imageDataUrl, sentAt: null, importedAt: '2026-01-02T11:04:05+08:00' });
    vi.setSystemTime(new Date('2026-02-02T03:04:05Z')); f.cache.rememberCourseImage(input, 'course-source');
    expect(f.cache.read('course-source')?.importedAt).toBe('2026-01-02T11:04:05+08:00');
    f.cache.forget('course-source');
    expect(() => f.cache.rememberCourseImage(input, 'course-source')).toThrow(/已删除/);
  });
});
