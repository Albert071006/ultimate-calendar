import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepository } from './repository';
import { createCaptureStore } from '../capture/store';
import { createSpaceManager } from './space-management';
import { saveSpacePolicy, readSpaceState } from './space-policy';
import { SpacePolicySchema } from '../shared/space';
import { openDatabase } from './database';

const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); vi.useRealTimers(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'calendar-space-manager-'));
  close.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'planner.sqlite'), repo = createRepository(path), capture = createCaptureStore(path);
  close.push(() => repo.close(), () => capture.close());
  repo.writeInternal({ operationId: 'synthetic-task', changes: [{ entity: 'task', values: { title: '保留的任务' } }] });
  const clearCache = vi.fn(async () => {}), isBusy = vi.fn(() => false);
  const manager = createSpaceManager({ directory, attachments: capture, clearCache, isBusy }); close.push(manager.stop);
  return { directory, path, repo, capture, manager, clearCache, isBusy };
}
describe('space manager integration', () => {
  it('cleans old attachment pages, compacts in place and preserves formal records and open connections', async () => {
    const x = setup(), at = '2020-01-01T12:00:00+08:00';
    x.capture.saveConfig({ ...x.capture.config(), enabled: true, accountId: 'test-account', groupIds: ['test-group'] });
    const messageId = x.capture.ingest([{ accountId: 'test-account', groupId: 'test-group', messageId: 'file', sentAt: at, importedAt: at, text: '保留的原文', attachments: [{ name: 'synthetic.pdf', kind: 'file' }] }]).ids[0]!;
    const attachment = x.capture.attachments(messageId)[0]!;
    x.capture.putAttachment(attachment.id, Buffer.alloc(18 * 1024 * 1024, 7));
    x.capture.saveExtraction(attachment.id, { extractorVersion: 'test', chunks: [{ ordinal: 0, location: 'p1', text: '已处理的附件文本', imageDataUrl: null, status: 'ready', error: null }] });
    x.capture.sealBatches({ now: at, force: true });
    const batch = x.capture.claimBatch(at)!;
    x.capture.saveResult(batch.id, { completed: [], final: true }, at); x.capture.markApplied(batch.id, at);
    const before = x.repo.read(), bytes = x.manager.snapshot().databaseBytes;
    const result = await x.manager.cleanup({ clearCache: true });
    expect(result.databaseBytes).toBeLessThan(bytes - 16 * 1024 * 1024);
    expect(result.lastResult).toContain('1 个 QQ 附件');
    expect(x.repo.read()).toEqual(before); expect(x.capture.message(messageId)?.text).toBe('保留的原文');
    expect(x.capture.readAttachmentBytes(attachment.id)).toBeNull(); expect(x.clearCache).toHaveBeenCalledOnce();
    const check = openDatabase(x.path, true);
    try { expect(check.prepare('PRAGMA integrity_check').get()?.['integrity_check']).toBe('ok'); } finally { check.close(); }
    x.repo.writeInternal({ operationId: 'after-compaction', changes: [{ entity: 'task', values: { title: '压缩后仍可写入' } }] });
    expect(x.repo.snapshot().tasks).toHaveLength(2);
  });
  it('saves settings without cleanup and rejects cleanup during active work', async () => {
    const x = setup(), clean = vi.spyOn(x.capture, 'cleanAttachments');
    x.manager.configure(SpacePolicySchema.parse({ enabled: false, autoBackupKeep: 5 }));
    expect(clean).not.toHaveBeenCalled(); expect(readSpaceState(x.directory).policy.autoBackupKeep).toBe(5);
    x.isBusy.mockReturnValue(true);
    await expect(x.manager.cleanup()).rejects.toThrow('等待'); expect(clean).not.toHaveBeenCalled();
  });
  it('runs automatically only while enabled and idle and stops timers on exit', async () => {
    vi.useFakeTimers(); const x = setup(), clean = vi.spyOn(x.capture, 'cleanAttachments');
    saveSpacePolicy(x.directory, SpacePolicySchema.parse({ enabled: false })); x.manager.start();
    await vi.advanceTimersByTimeAsync(60_000); expect(clean).not.toHaveBeenCalled();
    saveSpacePolicy(x.directory, SpacePolicySchema.parse({})); x.isBusy.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(60_000); expect(clean).not.toHaveBeenCalled();
    x.isBusy.mockReturnValue(false); await vi.advanceTimersByTimeAsync(60_000); expect(clean).toHaveBeenCalledOnce();
    expect(existsSync(join(x.directory, 'space-management.json'))).toBe(true);
    x.manager.stop(); await vi.advanceTimersByTimeAsync(3600_000); expect(clean).toHaveBeenCalledOnce();
  });
});
