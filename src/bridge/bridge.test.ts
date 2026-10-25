import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRepository, type Repository } from '../storage/repository';
import { createCandidateReader } from './source-reader';
import { createBridgeOutbox } from './outbox';
import { containsPrivateMaterial, distilledHash, projectDistilledFields } from './projection';
import { BridgeFault, loadBridgeConfig, parseBridgeConfig, type BridgeConfig } from './config';
import { createQQCloudBridge, type BridgeTransport } from './service';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const identity = { protocolVersion: 1 as const, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 };
const deviceId = '22222222-2222-4222-8222-222222222222';
const fields = { title: '提交合成报告', action: '整理后提交报告', benefit: '', benefitKind: 'unknown', potentialBenefit: '', conditions: [], uncertainties: [], deadline: null, eventStart: null, eventEnd: null, location: '合成教学楼' };
function folder() { const path = mkdtempSync(join(tmpdir(), 'uc-bridge-')); cleanups.push(() => { const rel = relative(tmpdir(), path); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Unsafe test cleanup'); rmSync(path, { recursive: true, force: true }); }); return path; }
function repository(path: string) { const value = createRepository(path, { automaticBackup: () => {} }); cleanups.push(() => value.close()); return value; }
function outbox(path = ':memory:') { const value = createBridgeOutbox(path); cleanups.push(() => value.close()); return value; }
function safeValue(value = fields) { const parsed = projectDistilledFields(value); if (!parsed.ok) throw Error('Invalid synthetic fields'); return parsed.value; }
function seed(repo: Repository, overrides = {}, capture = true) {
  const source = repo.writeInternal({ operationId: crypto.randomUUID(), changes: [{ entity: 'source', values: { kind: 'text', text: 'RAW_ONLY_IN_LOCAL_SOURCE · 900010001 · 900020002 · C:\\private\\raw.pdf', label: 'PRIVATE_QQ_GROUP_LABEL', importedAt: '2020-01-01T00:00:00+08:00', status: 'needs-review', ...(capture ? { captureRef: { accountId: '900010001', groupId: '900020002', messageId: 'PRIVATE_MESSAGE_ID', attachmentId: null, locator: 'PRIVATE_ATTACHMENT_LOCATOR', transcribed: false } } : {}) } }] }).entities[0]!;
  return repo.writeInternal({ operationId: crypto.randomUUID(), changes: [{ entity: 'candidate', values: { ...fields, sourceIds: [source.id], sourceQuote: 'RAW_ONLY_IN_LOCAL_SOURCE', temporalEvidence: [], ...overrides } }] }).entities[0]!;
}
function config(path: string): BridgeConfig {
  return parseBridgeConfig({ version: 1, enabled: true, sourceDatabase: join(path, 'source.sqlite'), outboxDatabase: join(path, 'outbox.sqlite'), credentialsFile: join(path, 'credential.json'), origin: 'https://calendar.example', identity, deviceId, scanBatchSize: 2 });
}
const remote = (): BridgeTransport => ({ origin: 'https://calendar.example', getSession: async () => ({ identity, deviceId }), sendDistilled: async () => ({ candidateIds: ['distilled-candidate:' + 'a'.repeat(64)], created: 1 }) });

describe('strict local QQ candidate projection', () => {
  it('hashes canonical extracted fields and rejects unexpected or private material without truncation', () => {
    const first = safeValue(); const reordered = projectDistilledFields({ ...Object.fromEntries(Object.entries(fields).reverse()), title: ' 提交合成报告 ' });
    expect(reordered.ok && reordered.value).toEqual(first); expect(first.item.distilledId).toBe('qqd_' + first.hash);
    const changed = safeValue({ ...fields, title: '提交另一份合成报告' }); expect(changed.hash).not.toBe(first.hash);
    for (const extra of [{ text: 'raw' }, { sourceQuote: 'raw' }, { attachments: [] }, { groupId: '900020002' }]) expect(projectDistilledFields({ ...fields, ...extra }).ok).toBe(false);
    for (const text of ['C:\\private\\raw.pdf', '\\\\host\\share', 'file:///private', 'data:image/png;base64,AABB', 'https://qq.example/attachment', '[CQ:at,qq=900010001]', '群号：900020002']) expect(projectDistilledFields({ ...fields, action: text }).ok).toBe(false);
    expect(projectDistilledFields({ ...fields, action: '请交给900010001处理' }, ['900010001']).ok).toBe(false);
    expect(projectDistilledFields({ ...fields, conditions: Array(31).fill('条件') }).ok).toBe(false);
    expect(containsPrivateMaterial(fields, ['900010001'])).toBe(false);
  });

  it('reads only pending QQ-derived candidates and never copies evidence, labels, IDs or paths', () => {
    const path = folder(); const repo = repository(join(path, 'source.sqlite'));
    seed(repo); seed(repo, { title: '手动来源候选' }, false); seed(repo, { status: 'ignored', title: '已忽略' });
    seed(repo, { action: '900020002' }); seed(repo, { conditions: ['C:\\private\\raw.pdf'] });
    const reader = createCandidateReader(repo.path); cleanups.push(() => reader.close());
    const page = reader.scan(0, 100); expect(page.items).toHaveLength(1); expect(page.privacyRejected).toBe(2); expect(page.done).toBe(true);
    const serialized = JSON.stringify(page);
    for (const forbidden of ['RAW_ONLY_IN_LOCAL_SOURCE', 'PRIVATE_QQ_GROUP_LABEL', 'PRIVATE_MESSAGE_ID', 'PRIVATE_ATTACHMENT_LOCATOR', '900010001', '900020002', 'captureRef', 'sourceQuote', repo.path]) expect(serialized).not.toContain(forbidden);
    expect(page.items[0]!.item.title).toBe(fields.title);
    expect(repo.snapshot().sources[0]!.text).toContain('RAW_ONLY_IN_LOCAL_SOURCE');
  });
});

describe('durable sanitized distilled outbox', () => {
  it('deduplicates by content hash and preserves the same request across retry and restart', () => {
    const path = join(folder(), 'outbox.sqlite'); const first = outbox(path); first.bind(distilledHash('binding'));
    expect(first.enqueue([safeValue(), safeValue()], identity, 1000, 9)).toEqual({ inserted: 1, duplicates: 1 });
    const attempt = first.claim(1000)!; expect(first.claim(1000)).toBeNull(); first.retry(attempt, 6000, 'network'); first.close();
    const reopened = outbox(path); reopened.bind(distilledHash('binding')); expect(reopened.cursor()).toBe(9); expect(reopened.claim(5999)).toBeNull();
    const retry = reopened.claim(6000)!; expect(retry.request).toEqual(attempt.request); expect(retry.attempts).toBe(2);
    reopened.accepted(retry, 6000); reopened.enqueue([safeValue()], identity, 7000, 0); expect(reopened.claim(7000)).toBeNull(); expect(reopened.stats().accepted).toBe(1);
  });

  it('recovers abandoned leases without permitting stale receipts to acknowledge a new lease', () => {
    const store = outbox(); store.bind(distilledHash('binding')); store.enqueue([safeValue()], identity, 1000, 0);
    const old = store.claim(1000, 1000)!; const fresh = store.claim(2000, 1000)!;
    expect(fresh.request.requestId).toBe(old.request.requestId); expect(store.accepted(old, 2000)).toBe(false); expect(store.accepted(fresh, 2000)).toBe(true);
  });

  it('refuses changed bindings and existing planner files without mutating them', () => {
    const path = folder(); const repo = repository(join(path, 'planner.sqlite')); seed(repo);
    expect(() => createBridgeOutbox(repo.path)).toThrow(BridgeFault);
    const inspect = new DatabaseSync(repo.path, { readOnly: true });
    try { expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'bridge_%'").all()).toEqual([]); } finally { inspect.close(); }
    const store = outbox(join(path, 'outbox.sqlite')); store.bind(distilledHash('one')); expect(() => store.bind(distilledHash('two'))).toThrow('身份');
    expect(repo.snapshot().candidates).toHaveLength(1);
  });
});

describe('explicit bridge lifecycle', () => {
  it('requires an explicit source and configuration and sanitizes configuration errors', () => {
    const path = folder(); const file = join(path, 'config.json'); writeFileSync(file, '{invalid RAW_PRIVATE_PATH');
    expect(() => loadBridgeConfig(file)).toThrow('配置无效'); expect(() => parseBridgeConfig({})).toThrow('配置无效');
    expect(() => createCandidateReader(join(path, 'does-not-exist.sqlite'))).toThrow('只读检查');
    expect(() => createQQCloudBridge({ ...config(path), enabled: false }, remote())).toThrow('配置无效');
  });

  it('closes partially initialized databases on rejected rebind and can immediately reopen the original binding', async () => {
    const path = folder(); repository(join(path, 'source.sqlite')); const settings = config(path);
    const first = createQQCloudBridge(settings, remote()); await first.close();
    expect(() => createQQCloudBridge({ ...settings, identity: { ...identity, generation: 2 } }, remote())).toThrow('身份');
    const renamed = join(path, 'temporarily-renamed.sqlite'); renameSync(settings.outboxDatabase, renamed); renameSync(renamed, settings.outboxDatabase);
    const reopened = createQQCloudBridge(settings, remote()); await reopened.close();
  });

  it('retries transient failures with a stable request and blocks identity changes without any send', async () => {
    const path = folder(); const repo = repository(join(path, 'source.sqlite')); seed(repo); let now = 1000; let sent = 0;
    const client = remote(); client.sendDistilled = async () => { sent++; throw { status: 503, retryAfterMs: 20_000, message: 'RAW_PROVIDER_BODY C:\\private' }; };
    const bridge = createQQCloudBridge(config(path), client, { now: () => now }); cleanups.push(() => bridge.close());
    expect(await bridge.once()).toMatchObject({ issue: 'network', queued: 1, outbox: { pending: 1 } }); now = 15_000; await bridge.once(); expect(sent).toBe(1);
    client.getSession = async () => ({ identity: { ...identity, generation: 2 }, deviceId }); now = 30_000;
    expect((await bridge.once()).issue).toBe('identity'); expect(sent).toBe(1);
    const bytes = readdirSync(path).filter(name => name.startsWith('outbox.sqlite')).map(name => readFileSync(join(path, name)).toString('utf8')).join('');
    for (const forbidden of ['RAW_PROVIDER_BODY', 'RAW_ONLY_IN_LOCAL_SOURCE', '900010001', '900020002', 'C:\\private', repo.path]) expect(bytes).not.toContain(forbidden);
  });
});
