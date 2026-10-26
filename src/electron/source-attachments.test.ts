import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepository } from '../storage/repository';
import { createCaptureStore } from '../capture/store';
import { createEvidenceIndex, distilledSourceId, evidenceIndexPath } from '../bridge/evidence-index';
import { createLocalEvidenceResolver } from './local-evidence';
import { createSourceAttachmentHost } from './source-attachments';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const at = '2026-01-01T12:00:00+08:00', accountId = 'synthetic-account', groupId = 'synthetic-group';
function fixture(names = ['操作教程.docx']) {
  const directory = mkdtempSync(join(tmpdir(), 'uc-source-attachments-'));
  cleanups.push(() => { const rel = relative(tmpdir(), directory); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Unsafe cleanup'); rmSync(directory, { recursive: true, force: true }); });
  const repo = createRepository(join(directory, 'planner.sqlite'), { automaticBackup: () => {} }); cleanups.push(() => repo.close());
  const store = createCaptureStore(repo.path); cleanups.push(() => store.close());
  store.saveConfig({ ...store.config(), enabled: true, accountId, groupIds: [groupId] });
  const messageId = store.ingest([{ accountId, groupId, messageId: 'synthetic-message', sentAt: at, importedAt: at, text: '合成通知', attachments: names.map(name => ({ name, kind: 'file' as const })) }]).ids[0]!;
  const contents = Buffer.from('SYNTHETIC_ORIGINAL_DOCUMENT_BYTES');
  const attachments = store.attachments(messageId).map(item => store.putAttachment(item.id, contents));
  function source(attachmentId: string | null, overrides = {}) {
    return repo.writeInternal({ operationId: crypto.randomUUID(), changes: [{ entity: 'source', values: { kind: 'text', text: 'SYNTHETIC_PRIVATE_CHUNK', importedAt: at, captureRef: { accountId, groupId, messageId, attachmentId, locator: 'synthetic:original', transcribed: false, ...overrides } } }] }).entities[0]!;
  }
  const openPath = vi.fn<(path: string) => Promise<string>>().mockResolvedValue('');
  const options = { directory, store, resolveEvidence: createLocalEvidenceResolver(repo), openPath };
  const host = createSourceAttachmentHost(options);
  return { directory, repo, store, messageId, attachments, contents, source, openPath, options, host };
}

describe('source attachment native host', () => {
  it('resolves cloud source chunks to one durable original without sending private content or paths', async () => {
    const f = fixture(), attachment = f.attachments[0]!;
    const sources = Array.from({ length: 69 }, () => f.source(attachment.id));
    const distilledId = 'qqd_' + 'b'.repeat(64), sourceId = distilledSourceId(distilledId);
    const index = createEvidenceIndex(evidenceIndexPath(f.repo.path));
    index.remember([{ distilledId, candidateId: 'synthetic-candidate', sourceIds: sources.map(item => item.id) }]); index.close();
    const before = f.store.fingerprint();
    const listed = await f.host.list({ sourceIds: [sourceId] });
    expect(listed).toEqual({ attachments: [{ id: `attachment-sha256:${attachment.hash}`, name: attachment.name, status: 'available' }], unavailableSources: 0 });
    expect(f.store.fingerprint()).toBe(before); expect(f.openPath).not.toHaveBeenCalled();
    for (const privateValue of [f.directory, 'SYNTHETIC_PRIVATE_CHUNK', f.contents.toString(), 'synthetic:original']) expect(JSON.stringify(listed)).not.toContain(privateValue);
    const restarted = createSourceAttachmentHost(f.options);
    expect(await restarted.open({ sourceIds: [sourceId], attachmentId: listed.attachments[0]!.id })).toEqual({ opened: true });
    const path = f.openPath.mock.calls[0]![0];
    expect(path).toBe(join(f.directory, 'source-attachments', attachment.hash!, attachment.name));
    expect(readFileSync(path)).toEqual(f.contents);
  });

  it('keeps an original and every duplicate ID usable after automatic cache cleanup', async () => {
    const f = fixture(['教程.docx', '教程副本.docx']), sources = f.attachments.map(item => f.source(item.id));
    expect((await f.host.list({ sourceIds: sources.map(item => item.id) })).attachments).toHaveLength(1);
    const separateBatches = await Promise.all(sources.map(source => f.host.list({ sourceIds: [source.id] })));
    expect(new Set(separateBatches.map(result => result.attachments[0]!.id)).size).toBe(1);
    for (const attachment of f.attachments) f.store.saveExtraction(attachment.id, { extractorVersion: 'synthetic-v1', chunks: [{ ordinal: 0, location: '第1段', text: '合成内容', imageDataUrl: null, status: 'ready', error: null }] });
    f.store.sealBatches({ now: at, force: true }); const batch = f.store.claimBatch(at)!;
    f.store.saveResult(batch.id, { final: true }, at); f.store.markApplied(batch.id, at);
    expect(f.store.cleanAttachments({ retentionDays: 30, maxBytes: 1024 ** 3, now: '2026-03-01T12:00:00+08:00' }).selectedAttachments).toBe(2);
    expect(f.store.readAttachmentBytes(f.attachments[0]!.id)).toBeNull();
    const restarted = createSourceAttachmentHost(f.options);
    expect((await restarted.list({ sourceIds: sources.map(item => item.id) })).attachments).toHaveLength(1);
    for (const [i, source] of sources.entries()) {
      const listed = (await restarted.list({ sourceIds: [source.id] })).attachments[0]!;
      expect(listed.status).toBe('available'); expect(listed.id).toBe(separateBatches[i]!.attachments[0]!.id);
      await restarted.open({ sourceIds: [source.id], attachmentId: listed.id });
    }
    expect(new Set(f.openPath.mock.calls.map(call => call[0])).size).toBe(1);
  });

  it('requires current source, message and attachment ownership even when a durable copy exists', async () => {
    const f = fixture(), attachment = f.attachments[0]!, source = f.source(attachment.id);
    const publicId = (await f.host.list({ sourceIds: [source.id] })).attachments[0]!.id;
    const wrongAccount = f.source(attachment.id, { accountId: 'another-account' });
    await expect(f.host.open({ sourceIds: [wrongAccount.id], attachmentId: attachment.id })).rejects.toThrow(/有效来源/);
    await expect(f.host.open({ sourceIds: [wrongAccount.id], attachmentId: publicId })).rejects.toThrow(/有效来源/);
    await expect(f.host.open({ sourceIds: [source.id], attachmentId: 'forged-id' })).rejects.toThrow(/有效来源/);
    f.repo.writeInternal({ operationId: crypto.randomUUID(), changes: [{ entity: 'source', id: source.id, expectedVersion: source.version, delete: true }] });
    await expect(f.host.open({ sourceIds: [source.id], attachmentId: attachment.id })).rejects.toThrow(/有效来源/);
    const current = f.source(attachment.id);
    f.store.cleanup({ accountId, groupId });
    expect(await f.host.list({ sourceIds: [current.id] })).toEqual({ attachments: [], unavailableSources: 1 });
    await expect(f.host.open({ sourceIds: [current.id], attachmentId: attachment.id })).rejects.toThrow(/有效来源/);
    await expect(f.host.open({ sourceIds: [current.id], attachmentId: publicId })).rejects.toThrow(/有效来源/);
    expect(f.openPath).not.toHaveBeenCalled();
  });

  it('prefers an available alias when the first reference cannot read its original bytes', async () => {
    const f = fixture(['第一份.docx', '完整副本.docx']), sourceIds = f.attachments.map(item => f.source(item.id).id);
    const store = { ...f.store, readAttachmentBytes: (id: string) => id === f.attachments[0]!.id ? null : f.store.readAttachmentBytes(id) };
    const host = createSourceAttachmentHost({ ...f.options, store });
    const result = await host.list({ sourceIds });
    expect(result.attachments).toHaveLength(1); expect(result.attachments[0]!.status).toBe('available');
    await expect(host.open({ sourceIds, attachmentId: result.attachments[0]!.id })).resolves.toEqual({ opened: true });
    expect(readFileSync(f.openPath.mock.calls[0]![0])).toEqual(f.contents);
  });

  it('preserves user edits and never opens or overwrites a copy whose hash changed', async () => {
    const f = fixture(), attachment = f.attachments[0]!, source = f.source(attachment.id), request = { sourceIds: [source.id] };
    await f.host.list(request);
    const path = join(f.directory, 'source-attachments', attachment.hash!, attachment.name); writeFileSync(path, 'USER_EDIT');
    expect((await f.host.list(request)).attachments[0]).toMatchObject({ status: 'missing', message: expect.stringMatching(/已被修改/) });
    await expect(f.host.open({ ...request, attachmentId: attachment.id })).rejects.toThrow(/已被修改/);
    expect(readFileSync(path, 'utf8')).toBe('USER_EDIT'); expect(f.openPath).not.toHaveBeenCalled();
  });

  it('rejects executable, shortcut and path-like names without copying or opening them', async () => {
    const names = ['script.ps1', 'launch.exe', 'link.url', 'shortcut.lnk', 'script.cmd', '../escape.docx', 'C:\\secret\\private.docx', '\\\\server\\share\\private.pdf', 'document.pdf:payload'];
    const f = fixture(names), source = f.source(null), request = { sourceIds: [source.id] };
    const result = await f.host.list(request);
    expect(result.attachments).toHaveLength(names.length);
    expect(result.attachments.every(item => item.status === 'unsupported')).toBe(true);
    expect(existsSync(join(f.directory, 'source-attachments'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain('C:'); expect(JSON.stringify(result)).not.toContain('server');
    for (const item of f.attachments) await expect(f.host.open({ ...request, attachmentId: item.id })).rejects.toThrow(/不能直接打开/);
    expect(f.openPath).not.toHaveBeenCalled();
  });

  it('reports uncached or mismatched bytes without downloading and counts unavailable source requests once', async () => {
    const f = fixture(), attachment = f.attachments[0]!, source = f.source(attachment.id);
    const store = { ...f.store, readAttachmentBytes: vi.fn(() => Buffer.from('WRONG_BYTES')) };
    const host = createSourceAttachmentHost({ ...f.options, store });
    expect(await host.list({ sourceIds: [source.id, 'missing-source'] })).toMatchObject({ attachments: [{ status: 'missing' }], unavailableSources: 1 });
    expect(existsSync(join(f.directory, 'source-attachments', attachment.hash!))).toBe(false);
    await expect(host.open({ sourceIds: [source.id], attachmentId: attachment.id })).rejects.toThrow(/完整的原附件/);
    expect(f.openPath).not.toHaveBeenCalled();
  });

  it('rejects a redirected durable directory and hides operating-system error details', async () => {
    const f = fixture(), attachment = f.attachments[0]!, source = f.source(attachment.id), request = { sourceIds: [source.id], attachmentId: attachment.id };
    const outside = join(f.directory, 'other-directory'); mkdirSync(outside);
    symlinkSync(outside, join(f.directory, 'source-attachments'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.host.list({ sourceIds: request.sourceIds })).rejects.toThrow(/无法安全读取/);
    await expect(f.host.open(request)).rejects.toThrow(/无法安全读取/);
    expect(f.openPath).not.toHaveBeenCalled();
    const g = fixture(), other = g.attachments[0]!, otherSource = g.source(other.id);
    g.openPath.mockResolvedValue('PRIVATE_SYSTEM_PATH_FAILED');
    await expect(g.host.open({ sourceIds: [otherSource.id], attachmentId: other.id })).rejects.toThrow('系统未能打开附件，请检查默认应用；附件资料已保留');
  });
});
