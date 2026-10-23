import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { SnapshotSchema } from '../shared/contracts';
import { trustedCaller, dispatchRequest } from './ipc';
import { createKeyStore } from './key-store';
import { imageFromBytes, imageDataUrlValid, profileFromArgs } from './files';
import { createRestoreManager } from './restore';
import { createBackup } from '../storage/backups';
import { createReminderScheduler, createReminderSummary } from './notifications';
import { emptyAccountState } from '../shared/account';

const dirs: string[] = [];
async function temporary() { const p = await mkdtemp(join(tmpdir(), 'planner-boundary-')); dirs.push(p); return p; }
afterEach(async () => { for (const p of dirs.splice(0)) await rm(p, { recursive: true, force: true }); });
const caller = { senderId: 7, frameId: 4, url: 'file:///C:/app/dist/index.html' };
describe('desktop trust boundary', () => {
  it('credential recovery only exposes safe status and accepts no file paths or key material', async () => {
    let calls = 0;
    const api = { retryApiKey: async () => { calls++; return { ok: true, data: { configured: false, sessionOnly: false, loadError: 'decrypt' } }; } };
    expect((await dispatchRequest('retryApiKey', { path: 'C:/secret' }, caller, caller, api)).ok).toBe(false);
    expect((await dispatchRequest('retryApiKey', undefined, { ...caller, frameId: 99 }, caller, api)).ok).toBe(false);
    expect(calls).toBe(0);
    expect(await dispatchRequest('retryApiKey', undefined, caller, caller, api)).toEqual({ ok: true, data: { configured: false, sessionOnly: false, loadError: 'decrypt' } });
    const leaked = await dispatchRequest('retryApiKey', undefined, caller, caller, { retryApiKey: async () => ({ ok: true, data: { configured: true, sessionOnly: false, key: 'synthetic-secret' } }) });
    expect(leaked.ok).toBe(false); expect(JSON.stringify(leaked)).not.toContain('synthetic-secret');
  });

  it('account methods reject arbitrary URLs/keys and account responses cannot export credentials', async () => {
    const state = emptyAccountState(); let calls = 0;
    const api = { accountSnapshot: async () => { calls++; return { ok: true, data: state }; }, refreshAccount: async () => ({ ok: true, data: { ...state, apiKey: 'synthetic-secret' } }) };
    expect((await dispatchRequest('accountSnapshot', { url: 'https://other.invalid', key: 'synthetic-secret' }, caller, caller, api)).ok).toBe(false);
    expect((await dispatchRequest('accountSnapshot', undefined, { ...caller, frameId: 99 }, caller, api)).ok).toBe(false);
    expect(calls).toBe(0);
    expect(await dispatchRequest('accountSnapshot', undefined, caller, caller, api)).toEqual({ ok: true, data: state });
    const invalid = await dispatchRequest('refreshAccount', undefined, caller, caller, api);
    expect(invalid.ok).toBe(false); expect(JSON.stringify(invalid)).not.toContain('synthetic-secret');
  });
  it('rejects foreign windows, subframes and changed document URLs', () => {
    expect(trustedCaller(caller, caller)).toBe(true);
    for (const other of [{ ...caller, senderId: 8 }, { ...caller, frameId: 5 }, { ...caller, url: 'https://attacker.invalid/' }, { ...caller, url: caller.url + '?other' }]) expect(trustedCaller(other, caller)).toBe(false);
  });
  it('rejects unauthorized callers and malformed DTOs before a real SQLite mutation', async () => {
    const repository = createRepository(':memory:'); const planner = createPlanner(repository);
    const api = { mutate: async (input: unknown) => ({ ok: true, data: planner.mutate(input as never) }) };
    const input = { operationId: 'boundary', origin: 'manual', mutations: [{ type: 'create', entity: 'task', values: { title: '测试任务' } }] };
    try {
      expect((await dispatchRequest('mutate', input, { ...caller, frameId: 9 }, caller, api)).ok).toBe(false);
      expect((await dispatchRequest('mutate', { ...input, arbitraryFile: 'C:/secret' }, caller, caller, api)).ok).toBe(false);
      expect(repository.snapshot().tasks).toEqual([]);
      expect((await dispatchRequest('mutate', input, caller, caller, api)).ok).toBe(true);
      expect(repository.snapshot().tasks[0]?.title).toBe('测试任务');
      expect((await dispatchRequest('constructor', input, caller, caller, api)).ok).toBe(false);
    } finally { repository.close(); }
  });
  it('valid full snapshots reject secrets and dispatcher sanitizes thrown failures', async () => {
    const repository = createRepository(':memory:');
    try {
      const snapshot = repository.snapshot(); expect(SnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(SnapshotSchema.safeParse({ ...snapshot, apiKey: 'synthetic-do-not-export' }).success).toBe(false);
      const result = await dispatchRequest('snapshot', undefined, caller, caller, { snapshot: async () => { throw Error('synthetic-do-not-export'); } });
      expect(JSON.stringify(result)).not.toContain('synthetic-do-not-export'); expect(result.ok).toBe(false);
    } finally { repository.close(); }
  });
});

describe('selected files and profiles', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  it('requires PNG/JPEG magic matching declared type and bounded bytes', () => {
    expect(imageFromBytes('图.png', png)?.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(() => imageFromBytes('恶意.png', Buffer.from('<svg/>'))).toThrow();
    expect(() => imageFromBytes('图.jpg', png)).toThrow();
    expect(() => imageFromBytes('巨大.png', Buffer.alloc(10 * 1024 * 1024 + 1))).toThrow();
    expect(imageDataUrlValid('data:image/jpeg;base64,' + png.toString('base64'))).toBe(false);
  });
  it('accepts an explicit absolute local profile and rejects roots/relative/duplicate overrides', () => {
    expect(profileFromArgs(['--planner-profile=C:\\Software\\test-profile'])).toBe('C:\\Software\\test-profile');
    expect(profileFromArgs([])).toBeNull();
    for (const args of [['--planner-profile=relative'], ['--planner-profile=C:\\'], ['--planner-profile=\\\\server\\share'], ['--planner-profile=C:\\one', '--planner-profile=C:\\two']]) expect(() => profileFromArgs(args)).toThrow();
  });
});

describe('credential storage', () => {
  // Only the OS encryption boundary is replaced; actual file lifecycle and restart are exercised.
  const encryption = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (s: string) => Buffer.from(s.split('').reverse().join('')), decryptStringAsync: async (b: Buffer) => ({ result: b.toString().split('').reverse().join(''), shouldReEncrypt: false }) };
  it('persists encrypted bytes and reloads without exporting key material', async () => {
    const path = join(await temporary(), 'credential.bin'); const store = createKeyStore(path, encryption); await store.initialize();
    expect(await store.set('synthetic-test-key')).toEqual({ configured: true, sessionOnly: false });
    expect((await readFile(path)).includes(Buffer.from('synthetic-test-key'))).toBe(false);
    const reopened = createKeyStore(path, encryption); await reopened.initialize(); expect(await reopened.get()).toBe('synthetic-test-key');
    expect(JSON.stringify(reopened.status())).not.toContain('synthetic-test-key');
    await reopened.set(null); expect(await reopened.get()).toBeNull(); await expect(readFile(path)).rejects.toThrow();
  });
  it('keeps unavailable encryption session-only and removes an older persisted credential', async () => {
    const path = join(await temporary(), 'credential.bin'); await writeFile(path, 'old encrypted');
    const store = createKeyStore(path, { ...encryption, isAsyncEncryptionAvailable: async () => false }, { retryDelay: async () => {} });
    await expect(store.initialize()).rejects.toMatchObject({ code: 'STORAGE' });
    expect(store.status()).toEqual({ configured: false, sessionOnly: false, loadError: 'unavailable' });
    expect((await readFile(path)).toString()).toBe('old encrypted');
    expect(await store.set('synthetic-session')).toEqual({ configured: true, sessionOnly: true });
    expect(await store.get()).toBe('synthetic-session'); await expect(readFile(path)).rejects.toThrow();
  });
});

it('restoration requires its exact preview and preserves a safety backup', async () => {
  const dir = await temporary(); const repository = createRepository(join(dir, 'live.sqlite')); const planner = createPlanner(repository);
  try {
    const backup = join(dir, 'chosen.sqlite'); createBackup(repository, backup);
    const created = await dispatchRequest('mutate', { operationId: 'new-task', origin: 'manual', mutations: [{ type: 'create', entity: 'task', values: { title: '恢复前任务' } }] }, caller, caller, { mutate: async input => ({ ok: true, data: planner.mutate(input) }) }); expect(created.ok).toBe(true);
    const manager = createRestoreManager(repository); const preview = await manager.preview(backup);
    expect(preview.counts.task).toBe(0); expect(repository.snapshot().tasks).toHaveLength(1);
    await expect(manager.confirm('wrong-token')).rejects.toThrow();
    const restored = await manager.confirm(preview.confirmationToken); expect(repository.snapshot().tasks).toEqual([]);
    const safety = createRepository(restored.safetyBackupPath); try { expect(safety.snapshot().tasks[0]?.title).toBe('恢复前任务'); } finally { safety.close(); }
    await expect(manager.confirm(preview.confirmationToken)).rejects.toThrow();
  } finally { repository.close(); }
});

it('restoration cannot replace data while a model workflow is still running', async () => {
  const dir = await temporary(); const repository = createRepository(join(dir, 'live.sqlite'));
  try {
    const backup = join(dir, 'chosen.sqlite'); createBackup(repository, backup); let active = true;
    const manager = createRestoreManager(repository, () => !active); const preview = await manager.preview(backup);
    await expect(manager.confirm(preview.confirmationToken)).rejects.toThrow();
    active = false; expect((await manager.confirm(preview.confirmationToken)).status).toBe('restored');
  } finally { repository.close(); }
});

it('reminder restart cursor and receipts prevent replay and aggregate catch-up', async () => {
  const dir = await temporary(); const repository = createRepository(join(dir, 'reminders.sqlite'));
  try {
    repository.writeInternal({ operationId: 'fixture', changes: [{ entity: 'task', values: { title: '合成提醒', deadline: { date: '2026-10-23', time: '10:00' } } }] });
    // Set explicit synthetic creation time so the hand-calculated reminder is eligible.
    repository.transact(s => { s.entities.task[0]!.createdAt = '2026-10-20T09:00:00+08:00'; });
    const path = join(dir, 'cursor.json'); await writeFile(path, JSON.stringify({ lastCheck: '2026-10-22T09:00:00+08:00' }));
    const scheduler = createReminderScheduler(repository, path); await scheduler.initialize();
    const first = await scheduler.check('2026-10-22T11:00:00+08:00'); expect(first.map(r => r.title)).toEqual(['合成提醒']);
    const interruptedDelivery = createReminderScheduler(repository, path); await interruptedDelivery.initialize();
    expect((await interruptedDelivery.check('2026-10-22T11:00:00+08:00')).map(r => r.title)).toEqual(['合成提醒']);
    expect(repository.read().receipts).toEqual([]);
    await scheduler.acknowledge(first.map(r => r.id));
    const restarted = createReminderScheduler(repository, path); await restarted.initialize(); expect(await restarted.check('2026-10-22T11:01:00+08:00')).toEqual([]);
  } finally { repository.close(); }
});

it('failed cursor persistence cannot consume undelivered reminders and recovery returns them', async () => {
  const dir = await temporary(); const repository = createRepository(join(dir, 'reminders.sqlite'));
  try {
    repository.writeInternal({ operationId: 'fixture', changes: [{ entity: 'task', values: { title: '不能丢失的合成提醒', deadline: { date: '2026-10-23', time: '10:00' } } }] });
    repository.transact(s => { s.entities.task[0]!.createdAt = '2026-10-20T09:00:00+08:00'; });
    const path = join(dir, 'cursor.json'); await writeFile(path, JSON.stringify({ lastCheck: '2026-10-22T09:00:00+08:00' }));
    const scheduler = createReminderScheduler(repository, path); await scheduler.initialize();
    await rm(path); const { mkdir } = await import('node:fs/promises'); await mkdir(path);
    await expect(scheduler.check('2026-10-22T11:00:00+08:00')).rejects.toThrow();
    expect(repository.read().receipts).toEqual([]);
    await rm(path, { recursive: true });
    const recovered = await scheduler.check('2026-10-22T11:00:00+08:00'); expect(recovered.map(r => r.title)).toEqual(['不能丢失的合成提醒']);
    // Delivery is acknowledged only after the consumer presents it, never before cursor persistence.
    await scheduler.acknowledge(recovered.map(r => r.id));
    const reopened = createReminderScheduler(repository, path); await reopened.initialize(); expect(await reopened.check('2026-10-22T11:01:00+08:00')).toEqual([]);
  } finally { repository.close(); }
});

it('deferred summaries remain available for explicit tray opening without automatic reopen', () => {
  const summary = createReminderSummary();
  const reminder = { id: 'synthetic-reminder', refId: 'task', refKind: 'task' as const, title: '稍后查看的提醒', dueAt: '2026-10-23T10:00:00+08:00', scheduledAt: '2026-10-22T10:00:00+08:00', dateOnly: false, message: '合成' };
  summary.enqueue([reminder]); expect(summary.begin()).toEqual([reminder]);
  summary.finish([reminder.id], true);
  summary.enqueue([reminder]); expect(summary.begin()).toEqual([]);
  expect(summary.begin(true)).toEqual([reminder]);
  summary.finish([reminder.id], false); expect(summary.begin(true)).toEqual([]);
});
