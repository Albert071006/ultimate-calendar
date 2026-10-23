import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeyStore, type AsyncEncryption } from './key-store';

const directories: string[] = [];
const syntheticKey = 'synthetic-saved-credential';
const encode = (value: string) => Buffer.from(value.split('').reverse().join(''));
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'planner-key-test-'));
  directories.push(directory);
  const path = join(directory, 'credential.bin');
  const ciphertext = encode(syntheticKey);
  await writeFile(path, ciphertext);
  const encryption = {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async (value: string) => encode(value)),
    decryptStringAsync: vi.fn(async (bytes: Buffer) => ({ result: bytes.toString().split('').reverse().join(''), shouldReEncrypt: false })),
  } satisfies AsyncEncryption;
  const retryDelay = vi.fn(async (_milliseconds: number) => {});
  return { directory, path, ciphertext, encryption, retryDelay };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'planner-key-test-'))) throw Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('credential loading recovery', () => {
  it.each(['availability', 'decryption'] as const)('recovers a transient startup %s failure without rewriting the credential', async failure => {
    const f = await fixture();
    if (failure === 'availability') f.encryption.isAsyncEncryptionAvailable.mockResolvedValueOnce(false);
    else f.encryption.decryptStringAsync.mockRejectedValueOnce(Error('temporary provider failure'));
    const store = createKeyStore(f.path, f.encryption, { retryDelay: f.retryDelay });
    await store.initialize();
    expect(store.status()).toEqual({ configured: true, sessionOnly: false });
    expect(await store.get()).toBe(syntheticKey);
    expect(f.retryDelay.mock.calls).toEqual([[250]]);
    expect(await readFile(f.path)).toEqual(f.ciphertext);
    expect(f.encryption.encryptStringAsync).not.toHaveBeenCalled();
  });

  it('retries a failed file read and distinguishes it from a missing credential', async () => {
    const f = await fixture();
    const path = join(f.directory, 'temporarily-unreadable');
    await mkdir(path);
    const retryDelay = vi.fn(async () => { await rmdir(path); await writeFile(path, f.ciphertext); });
    const store = createKeyStore(path, f.encryption, { retryDelay });
    await store.initialize();
    expect(await store.get()).toBe(syntheticKey);
    expect(retryDelay).toHaveBeenCalledTimes(1);
    const missing = createKeyStore(join(f.directory, 'missing'), f.encryption, { retryDelay });
    await missing.initialize();
    expect(missing.status()).toEqual({ configured: false, sessionOnly: false });
    expect(retryDelay).toHaveBeenCalledTimes(1);
  });

  it('retains failed state through the cooldown, retries get without throwing, and notifies on recovery without credentials', async () => {
    const f = await fixture();
    let currentTime = 0;
    const changes: unknown[] = [];
    f.encryption.decryptStringAsync.mockRejectedValue(Error(`private diagnostic ${syntheticKey}`));
    const store = createKeyStore(f.path, f.encryption, {
      retryDelay: f.retryDelay, now: () => currentTime,
      onStatusChanged: () => changes.push(store.status()),
    });
    await expect(store.initialize()).rejects.toThrow('原文件已保留');
    expect(store.status()).toEqual({ configured: false, sessionOnly: false, loadError: 'decrypt' });
    expect(f.retryDelay.mock.calls).toEqual([[250], [750]]);
    expect(f.encryption.decryptStringAsync).toHaveBeenCalledTimes(3);
    expect(await store.get()).toBeNull();
    currentTime = 30_000;
    expect(await store.get()).toBeNull();
    expect(f.encryption.decryptStringAsync).toHaveBeenCalledTimes(6);
    expect(changes).toHaveLength(1);
    f.encryption.decryptStringAsync.mockResolvedValue({ result: syntheticKey, shouldReEncrypt: false });
    currentTime = 59_999;
    expect(await store.get()).toBeNull();
    currentTime = 60_000;
    expect(await store.get()).toBe(syntheticKey);
    expect(store.status()).toEqual({ configured: true, sessionOnly: false });
    expect(changes).toEqual([
      { configured: false, sessionOnly: false, loadError: 'decrypt' },
      { configured: true, sessionOnly: false },
    ]);
    expect(JSON.stringify(changes)).not.toContain(syntheticKey);
    expect(await readFile(f.path)).toEqual(f.ciphertext);
  });

  it('explicit retry bypasses the cooldown and returns a sanitized status on failure', async () => {
    const f = await fixture();
    f.encryption.isAsyncEncryptionAvailable.mockRejectedValue(Error(`private diagnostic ${syntheticKey}`));
    const store = createKeyStore(f.path, f.encryption, { retryDelay: f.retryDelay, now: () => 0 });
    await expect(store.initialize()).rejects.toThrow('原文件已保留');
    const failure = await store.retry();
    expect(failure).toEqual({ configured: false, sessionOnly: false, loadError: 'unavailable' });
    expect(f.encryption.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(failure)).not.toContain(syntheticKey);
    expect(await readFile(f.path)).toEqual(f.ciphertext);
    f.encryption.isAsyncEncryptionAvailable.mockResolvedValue(true);
    expect(await store.retry()).toEqual({ configured: true, sessionOnly: false });
    expect(await store.get()).toBe(syntheticKey);
  });

  it('reports a persistent file read error without overwriting the path', async () => {
    const f = await fixture();
    const store = createKeyStore(f.directory, f.encryption, { retryDelay: f.retryDelay });
    await expect(store.initialize()).rejects.toThrow('原文件已保留');
    expect(store.status()).toEqual({ configured: false, sessionOnly: false, loadError: 'read' });
    expect(f.retryDelay.mock.calls).toEqual([[250], [750]]);
    expect(await readFile(f.path)).toEqual(f.ciphertext);
  });

  it('recovers a credential that appears after startup without polling a missing file on every get', async () => {
    const f = await fixture();
    const path = join(f.directory, 'later-credential.bin');
    let currentTime = 0;
    const store = createKeyStore(path, f.encryption, { retryDelay: f.retryDelay, now: () => currentTime });
    await store.initialize();
    expect(store.status()).toEqual({ configured: false, sessionOnly: false });
    await writeFile(path, f.ciphertext);
    expect(await store.get()).toBeNull();
    currentTime = 29_999;
    expect(await store.get()).toBeNull();
    expect(f.encryption.decryptStringAsync).not.toHaveBeenCalled();
    currentTime = 30_000;
    expect(await store.get()).toBe(syntheticKey);
    expect(store.status()).toEqual({ configured: true, sessionOnly: false });
    currentTime = 60_000;
    expect(await store.get()).toBe(syntheticKey);
    expect(f.encryption.decryptStringAsync).toHaveBeenCalledTimes(1);
  });

  it('clears an unreadable credential even when the encryption provider throws', async () => {
    const f = await fixture();
    let currentTime = 0;
    f.encryption.isAsyncEncryptionAvailable.mockRejectedValue(Error('provider unavailable'));
    const store = createKeyStore(f.path, f.encryption, { retryDelay: f.retryDelay, now: () => currentTime });
    await expect(store.initialize()).rejects.toThrow('原文件已保留');
    expect(await store.set(null)).toEqual({ configured: false, sessionOnly: false });
    expect(f.encryption.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(3);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(f.path, f.ciphertext);
    currentTime = 29_999;
    expect(await store.get()).toBeNull();
    expect(f.encryption.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(3);
  });

  it.each(['empty', 'oversized', 'invalid plaintext'] as const)('preserves %s data and reports invalid without repeated decryption attempts', async kind => {
    const f = await fixture();
    const ciphertext = kind === 'empty' ? Buffer.alloc(0) : kind === 'oversized' ? Buffer.alloc(65_537) : f.ciphertext;
    await writeFile(f.path, ciphertext);
    if (kind === 'invalid plaintext') f.encryption.decryptStringAsync.mockResolvedValue({ result: '   ', shouldReEncrypt: false });
    const store = createKeyStore(f.path, f.encryption, { retryDelay: f.retryDelay });
    await expect(store.initialize()).rejects.toThrow('原文件已保留');
    expect(store.status()).toEqual({ configured: false, sessionOnly: false, loadError: 'invalid' });
    expect(await readFile(f.path)).toEqual(ciphertext);
    expect(f.retryDelay).not.toHaveBeenCalled();
    expect(f.encryption.encryptStringAsync).not.toHaveBeenCalled();
  });

  it('keeps a decrypted key usable when rotation fails and retains the original ciphertext', async () => {
    const f = await fixture();
    f.encryption.decryptStringAsync.mockResolvedValue({ result: syntheticKey, shouldReEncrypt: true });
    f.encryption.encryptStringAsync.mockRejectedValue(Error('rotation failed'));
    const store = createKeyStore(f.path, f.encryption, { retryDelay: f.retryDelay });
    await store.initialize();
    expect(store.status()).toEqual({ configured: true, sessionOnly: false });
    expect(await store.get()).toBe(syntheticKey);
    expect(await readFile(f.path)).toEqual(f.ciphertext);
    expect(f.retryDelay).not.toHaveBeenCalled();
  });

  it.each([null, 'synthetic-replacement'])('serializes an in-flight load before a queued save or clear (%s)', async replacement => {
    const f = await fixture();
    let started!: () => void;
    let finish!: (value: { result: string; shouldReEncrypt: boolean }) => void;
    const loading = new Promise<void>(resolve => { started = resolve; });
    f.encryption.decryptStringAsync.mockImplementationOnce(async () => {
      started();
      return new Promise(resolve => { finish = resolve; });
    });
    const store = createKeyStore(f.path, f.encryption, { retryDelay: f.retryDelay });
    const initialized = store.initialize();
    await loading;
    const saved = store.set(replacement);
    const latest = store.get();
    finish({ result: syntheticKey, shouldReEncrypt: false });
    await initialized;
    expect(await saved).toEqual({ configured: replacement !== null, sessionOnly: false });
    expect(await latest).toBe(replacement);
    if (replacement === null) await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(f.path)).toEqual(encode(replacement));
  });

  it('does not lose a session-only key when retry is requested', async () => {
    const f = await fixture();
    f.encryption.isAsyncEncryptionAvailable.mockResolvedValue(false);
    const store = createKeyStore(f.path, f.encryption, { retryDelay: f.retryDelay });
    expect(await store.set('synthetic-session')).toEqual({ configured: true, sessionOnly: true });
    expect(await store.retry()).toEqual({ configured: true, sessionOnly: true });
    expect(await store.get()).toBe('synthetic-session');
    expect(f.encryption.decryptStringAsync).not.toHaveBeenCalled();
  });
});
