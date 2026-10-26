import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, renameSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createResourceHost } from './resources';
import { ResourceReferenceSchema, type ResourceReference } from '../shared/resources';
import { readLocalResources } from '../storage/local-resources';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { const rel = relative(tmpdir(), root); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Unsafe test cleanup'); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-resources-')); roots.push(directory);
  const pick = vi.fn<(...args: unknown[]) => Promise<string[]>>().mockResolvedValue([]), openPath = vi.fn().mockResolvedValue(''), openWeb = vi.fn().mockResolvedValue(undefined);
  return { directory, pick, openPath, openWeb, host: createResourceHost({ directory, pick, openPath, openWeb }) };
}
async function register(f: ReturnType<typeof fixture>, ...paths: string[]): Promise<ResourceReference[]> {
  return ResourceReferenceSchema.array().parse((await f.host.handle('resourceRegister', { paths }))?.data);
}
describe('owning computer resource references', () => {
  it('keeps paths local, reuses identities and opens a registered document after restart', async () => {
    const f = fixture(), path = join(f.directory, 'synthetic-answers.pdf'); writeFileSync(path, 'synthetic file contents');
    const [resource] = await register(f, path); expect(resource).toMatchObject({ name: 'synthetic-answers.pdf', kind: 'file' });
    expect(JSON.stringify(resource)).not.toContain(f.directory); expect(JSON.stringify(resource)).not.toContain('contents');
    expect((await register(f, path))[0]!.id).toBe(resource!.id);
    const restarted = createResourceHost({ directory: f.directory, pick: f.pick, openPath: f.openPath, openWeb: f.openWeb });
    expect(await restarted.handle('resourceOpen', { resource })).toEqual({ ok: true, data: { opened: true } });
    // Windows runner TEMP can use an 8.3 alias; the host opens the canonical path.
    expect(f.openPath).toHaveBeenCalledExactlyOnceWith(realpathSync.native(path)); expect(readLocalResources(f.directory)?.locations).toHaveLength(1);
  });
  it('reports moved files, relocates without changing identity and never removes originals', async () => {
    const f = fixture(), oldPath = join(f.directory, 'old.txt'), newPath = join(f.directory, 'new.txt'); writeFileSync(oldPath, 'synthetic');
    const [resource] = await register(f, oldPath); renameSync(oldPath, newPath);
    expect(await f.host.handle('resourceStatus', { resources: [resource] })).toMatchObject({ data: [{ status: 'missing' }] });
    await expect(f.host.handle('resourceOpen', { resource })).rejects.toThrow(/移动|改名/); expect(f.openPath).not.toHaveBeenCalled();
    f.pick.mockResolvedValue([newPath]); expect(await f.host.handle('resourceRelocate', { resource })).toEqual({ ok: true, data: resource });
    await f.host.handle('resourceOpen', { resource }); expect(f.openPath).toHaveBeenCalledWith(realpathSync.native(newPath)); expect(existsSync(newPath)).toBe(true);
  });
  it('supports folders and web links without allowing arbitrary schemes, scripts or shortcuts', async () => {
    const f = fixture(), [folder] = await register(f, f.directory); expect(folder?.kind).toBe('folder');
    await f.host.handle('resourceOpen', { resource: folder }); expect(f.openPath).toHaveBeenCalledWith(realpathSync.native(f.directory));
    const web = { kind: 'web', id: 'synthetic-web', name: '练习网页', url: 'https://example.test/lesson?one=1&two=2' };
    await f.host.handle('resourceOpen', { resource: web }); expect(f.openWeb).toHaveBeenCalledExactlyOnceWith(web.url);
    for (const url of ['file:///C:/private.txt', 'javascript:alert(1)', 'microsoft-edge:https://example.test', 'https://user:password@example.test']) {
      await expect(f.host.handle('resourceOpen', { resource: { ...web, url } })).rejects.toThrow();
    }
    for (const name of ['script.ps1', 'launch.exe', 'shortcut.lnk', 'link.url', 'script.cmd']) {
      const path = join(f.directory, name); writeFileSync(path, 'synthetic'); await expect(register(f, path)).rejects.toThrow(/不支持打开/);
    }
    for (const path of ['relative.pdf', '\\\\server\\share\\file.pdf', '\\\\?\\C:\\file.pdf', 'C:\\doc.pdf:payload.exe']) await expect(register(f, path)).rejects.toThrow();
  });
  it('refuses another device and unregistered IDs, and publishes no partial invalid selection', async () => {
    const f = fixture(), valid = join(f.directory, 'valid.txt'), invalid = join(f.directory, 'invalid.exe'); writeFileSync(valid, 'a'); writeFileSync(invalid, 'b');
    await expect(register(f, valid, invalid)).rejects.toThrow(); expect(readLocalResources(f.directory)).toBeNull();
    const [resource] = await register(f, valid);
    await expect(f.host.handle('resourceOpen', { resource: { ...resource!, deviceId: 'another-device' } })).rejects.toThrow(/需在/);
    await expect(f.host.handle('resourceOpen', { resource: { ...resource!, id: 'not-registered' } })).rejects.toThrow(/没有/);
    expect(f.openPath).not.toHaveBeenCalled();
  });
});
