import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { constants, createCipheriv, createDecipheriv, createHash, generateKeyPairSync, publicEncrypt, randomBytes, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCollectorKeySync, requirePersistentEncryption } from './collector-key-sync';
import { createKeyStore, type AsyncEncryption } from './key-store';
import { writePrivate } from '../remote/private-file';
import { aiKeySyncAad, type AiKeySyncResponse } from '../shared/ai-key-sync';

const identity = { protocolVersion: 1 as const, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 };
const deviceId = '22222222-2222-4222-8222-222222222222', revisionA = '33333333-3333-4333-8333-333333333333', revisionB = '44444444-4444-4444-8444-444444444444';
const oldKey = 'synthetic-old-private-api-key', newKey = 'synthetic-new-private-api-key';
let privateKey: KeyObject, publicKey: KeyObject;
const roots: string[] = [], workers: Array<{ close(): Promise<void> }> = [];
beforeAll(() => { ({ privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 })); });
afterEach(async () => { for (const worker of workers.splice(0)) await worker.close(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); vi.useRealTimers(); vi.unstubAllGlobals(); });

function encryption() {
  const secret = randomBytes(32);
  const value: AsyncEncryption = {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async text => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv);
      return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    }),
    decryptStringAsync: vi.fn(async bytes => {
      const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16));
      return { result: Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    }),
  };
  return value;
}
function seal(input: { keyId: string; nonce: string }, key: string | null, revision: string | null, receiver: KeyObject = publicKey): AiKeySyncResponse {
  const symmetric = randomBytes(32), iv = randomBytes(12);
  const envelope = { version: 1 as const, deviceId, ...input, revision, wrappedKey: publicEncrypt({ key: receiver, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, symmetric).toString('base64url'), iv: iv.toString('base64url'), ciphertext: '', tag: '' };
  const cipher = createCipheriv('aes-256-gcm', symmetric, iv); cipher.setAAD(Buffer.from(aiKeySyncAad(identity, envelope)));
  envelope.ciphertext = Buffer.concat([cipher.update(JSON.stringify({ apiKey: key, revision })), cipher.final()]).toString('base64url'); envelope.tag = cipher.getAuthTag().toString('base64url');
  return { ok: true, identity, envelope };
}
async function fixture(initialReceiver = true) {
  const root = mkdtempSync(join(tmpdir(), 'collector-cloud-key-')); roots.push(root);
  const folder = join(root, 'credentials'), credentialsFile = join(root, 'bridge', 'device.json');
  writePrivate(credentialsFile, JSON.stringify({ version: 1, origin: 'https://synthetic.invalid', cookie: '__Host-planner_session=synthetic-secret-cookie', identity, deviceId }));
  const configFile = join(folder, 'cloud-key-sync.json');
  writePrivate(configFile, JSON.stringify({ version: 1, origin: 'https://synthetic.invalid', credentialsFile }));
  const encrypted = encryption(), privateFile = join(folder, 'cloud-key-receiver.bin'), publicFile = join(folder, 'cloud-key-receiver-public.json'), keyFile = join(folder, 'deepseek.bin');
  if (initialReceiver) writePrivate(privateFile, await encrypted.encryptStringAsync(JSON.stringify({ version: 1, privateKeyPkcs8: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })));
  const keys = createKeyStore(keyFile, requirePersistentEncryption(encrypted), { retryDelay: async () => {} });
  await keys.set(oldKey); const set = vi.spyOn(keys, 'set');
  let cloudKey: string | null = newKey, cloudRevision: string | null = revisionA;
  const sync = vi.fn(async (input: { keyId: string; nonce: string }, _options?: { signal?: AbortSignal }) => seal(input, cloudKey, cloudRevision));
  const close = vi.fn(), onChanged = vi.fn(), onStatusChanged = vi.fn();
  const createClient = vi.fn(() => ({ syncAiKeyReceiver: sync, close }));
  const make = (store = keys, callback = onChanged, timeoutMs = 8000) => {
    const worker = createCollectorKeySync({ directory: root, keys: store, encryption: encrypted, createClient, onChanged: callback, onStatusChanged, timeoutMs })!;
    workers.push(worker); return worker;
  };
  return { root, configFile, privateFile, publicFile, keyFile, keys, set, encrypted, sync, close, createClient, onChanged, onStatusChanged, make,
    cloud(key: string | null, revision: string | null) { cloudKey = key; cloudRevision = revision; } };
}

describe('collector cloud-key receiver', () => {
  it('decrypts only the bound envelope, writes changes once and never exposes a key or cookie in status/public output', async () => {
    const f = await fixture(), worker = f.make();
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('Real network forbidden'); }));
    expect(await worker.getApiKey()).toBe(newKey);
    expect(await worker.getApiKey()).toBe(newKey);
    expect(f.sync).toHaveBeenCalledTimes(2); expect(f.set).toHaveBeenCalledExactlyOnceWith(newKey);
    expect(f.onChanged).toHaveBeenCalledExactlyOnceWith({ previousRevision: undefined, revision: revisionA, configured: true, sourceId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(worker.status()).toMatchObject({ state: 'ready', revision: revisionA, configured: true, message: null });
    const publicInfo = JSON.parse(readFileSync(f.publicFile, 'utf8'));
    expect(publicInfo.keyId).toBe(createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'));
    const visible = JSON.stringify(worker.status()) + readFileSync(f.publicFile, 'utf8') + f.onChanged.mock.calls.map(call => JSON.stringify(call)).join();
    for (const value of [oldKey, newKey, 'synthetic-secret-cookie', 'PRIVATE KEY']) expect(visible).not.toContain(value);
    for (const name of readdirSync(join(f.root, 'credentials'))) if (name.endsWith('.bin')) {
      const text = readFileSync(join(f.root, 'credentials', name)).toString('utf8'); expect(text).not.toContain(newKey); expect(text).not.toContain('PRIVATE KEY');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('persists a clear and its receipt across restart without repeatedly resuming the same AUTH-failed revision', async () => {
    const f = await fixture(), first = f.make(); await first.refresh(); await first.close();
    const keys = createKeyStore(f.keyFile, requirePersistentEncryption(f.encrypted), { retryDelay: async () => {} }); await keys.initialize();
    const changed = vi.fn(), second = f.make(keys, changed); expect(await second.getApiKey()).toBe(newKey); expect(changed).not.toHaveBeenCalled();
    f.cloud(null, revisionB); expect(await second.getApiKey()).toBe(null); expect(existsSync(f.keyFile)).toBe(false);
    expect(changed).toHaveBeenCalledExactlyOnceWith({ previousRevision: revisionA, revision: revisionB, configured: false, sourceId: expect.stringMatching(/^[0-9a-f]{64}$/) }); await second.close();
    const reopened = createKeyStore(f.keyFile, requirePersistentEncryption(f.encrypted), { retryDelay: async () => {} }); await reopened.initialize();
    const afterRestart = vi.fn(); expect(await f.make(reopened, afterRestart).getApiKey()).toBe(null); expect(afterRestart).not.toHaveBeenCalled();
  });
  it('keeps the last file but refuses its value after network/auth/protocol failure', async () => {
    const f = await fixture(), worker = f.make(); await worker.refresh();
    const bytes = readFileSync(f.keyFile); f.sync.mockRejectedValueOnce(Error(`Network echo ${newKey} synthetic-secret-cookie`));
    await expect(worker.getApiKey()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(worker.status()).toMatchObject({ state: 'error' }); expect(readFileSync(f.keyFile)).toEqual(bytes); expect(f.set).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(worker.status())).not.toContain(newKey); expect(JSON.stringify(worker.status())).not.toContain('synthetic-secret-cookie');
  });
  it('replays the same notification identity after receipt persistence fails without returning a key or rewriting it', async () => {
    const f = await fixture(), worker = f.make(), receiptFile = join(f.root, 'credentials', 'cloud-key-receiver-receipt.bin');
    f.onChanged.mockImplementationOnce(() => { mkdirSync(receiptFile); });
    await expect(worker.getApiKey()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.set).toHaveBeenCalledExactlyOnceWith(newKey); expect(f.onChanged).toHaveBeenCalledOnce(); expect(worker.status().state).toBe('error');
    rmSync(receiptFile, { recursive: true }); await worker.refresh();
    expect(f.onChanged).toHaveBeenCalledTimes(2); expect(f.onChanged.mock.calls[1]).toEqual(f.onChanged.mock.calls[0]);
    expect(f.set).toHaveBeenCalledTimes(1); expect(await worker.getApiKey()).toBe(newKey); expect(f.onChanged).toHaveBeenCalledTimes(2);
  });
  it('rejects mismatched bindings, tampered ciphertext and repeated-revision key changes before writing', async () => {
    const f = await fixture(), worker = f.make(); await worker.refresh(); const bytes = readFileSync(f.keyFile);
    const mutations: Array<(value: AiKeySyncResponse) => void> = [
      value => { value.identity = { ...identity, generation: 2 }; }, value => { value.envelope.deviceId = revisionB; },
      value => { value.envelope.keyId = '0'.repeat(64); }, value => { value.envelope.nonce = randomBytes(32).toString('base64url'); },
      value => { value.envelope.revision = revisionA; }, value => { value.envelope.tag = randomBytes(16).toString('base64url'); },
      value => { value.envelope.ciphertext = Buffer.from('synthetic tampering').toString('base64url'); },
    ];
    for (const mutate of mutations) {
      f.sync.mockImplementationOnce(async input => { const value = seal(input, oldKey, revisionB); mutate(value); return value; });
      await expect(worker.refresh()).rejects.toThrow(/校验/); expect(readFileSync(f.keyFile)).toEqual(bytes); expect(f.set).toHaveBeenCalledTimes(1);
    }
    f.cloud(oldKey, revisionA); await expect(worker.refresh()).rejects.toThrow(/校验/); expect(f.set).toHaveBeenCalledTimes(1);
    f.cloud(null, revisionB); await worker.refresh(); f.cloud(newKey, revisionA); await expect(worker.refresh()).rejects.toThrow(/校验/); expect(existsSync(f.keyFile)).toBe(false);
  });
  it('fails closed if encryption becomes unavailable between preflight and KeyStore.set, preserving ciphertext', async () => {
    const f = await fixture(), worker = f.make(); await worker.refresh(); const bytes = readFileSync(f.keyFile);
    f.cloud(oldKey, revisionB);
    vi.mocked(f.encrypted.isAsyncEncryptionAvailable).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(worker.refresh()).rejects.toThrow(/安全保存/); expect(readFileSync(f.keyFile)).toEqual(bytes); expect(await f.keys.get()).toBe(newKey);
    expect(f.keys.status()).toEqual({ configured: true, sessionOnly: false }); expect(f.onChanged).toHaveBeenCalledTimes(1);
    vi.mocked(f.encrypted.isAsyncEncryptionAvailable).mockResolvedValue(false); f.cloud(null, revisionB);
    await expect(worker.getApiKey()).rejects.toMatchObject({ code: 'CANCELLED' }); expect(readFileSync(f.keyFile)).toEqual(bytes);
  });
  it('coalesces requests and cancels close without accepting a late response or logging a response body', async () => {
    const f = await fixture(), worker = f.make(); await worker.refresh(); f.set.mockClear();
    let resolve: (response: AiKeySyncResponse) => void = () => {}, input: { keyId: string; nonce: string } | undefined, signal: AbortSignal | undefined;
    f.sync.mockImplementation(async (value, options) => { input = value; signal = options?.signal; return new Promise(done => { resolve = done; }); });
    const first = worker.getApiKey(), second = worker.getApiKey();
    await vi.waitFor(() => expect(input).toBeDefined()); expect(f.sync).toHaveBeenCalledTimes(2);
    const rejection = Promise.all([expect(first).rejects.toMatchObject({ code: 'CANCELLED' }), expect(second).rejects.toMatchObject({ code: 'CANCELLED' })]);
    await worker.close(); await rejection; expect(signal?.aborted).toBe(true); expect(f.close).toHaveBeenCalledOnce();
    resolve(seal(input!, oldKey, revisionB)); await Promise.resolve(); expect(f.set).not.toHaveBeenCalled();
  });
  it('bounds a non-cooperative transport and retries background work with backoff', async () => {
    const f = await fixture(), worker = f.make(undefined, undefined, 100); await worker.refresh();
    vi.useFakeTimers(); f.sync.mockImplementation(async () => new Promise(() => {}));
    worker.start(); await Promise.resolve(); const request = expect(worker.getApiKey()).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(100); await request;
    expect(worker.status().state).toBe('error'); const count = f.sync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(19_999); expect(f.sync).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1); expect(f.sync).toHaveBeenCalledTimes(count + 1);
    await worker.close(); await vi.advanceTimersByTimeAsync(60_000); expect(f.sync).toHaveBeenCalledTimes(count + 1);
  });
  it('generates the receiver once, writes only an encrypted private key and preserves unreadable or orphaned receivers', async () => {
    const f = await fixture(false), worker = f.make();
    // The first request is deliberately refused; receiver setup must still be available for an administrator to bind.
    f.sync.mockRejectedValue(Error('synthetic-unbound')); await expect(worker.refresh()).rejects.toThrow();
    expect(existsSync(f.publicFile)).toBe(true); const bytes = readFileSync(f.privateFile); expect(bytes.toString()).not.toContain('PRIVATE KEY'); await worker.close();
    writeFileSync(f.privateFile, 'synthetic-unreadable', { mode: 0o600 });
    const before = f.sync.mock.calls.length; await expect(f.make().refresh()).rejects.toThrow(/原文件已保留/); expect(readFileSync(f.privateFile, 'utf8')).toBe('synthetic-unreadable'); expect(f.sync).toHaveBeenCalledTimes(before);
    rmSync(f.privateFile); await expect(f.make().refresh()).rejects.toThrow(/原文件已保留/); expect(existsSync(f.privateFile)).toBe(false);
    rmSync(f.publicFile); writePrivate(join(f.root, 'credentials', 'cloud-key-receiver-receipt.bin'), await f.encrypted.encryptStringAsync(JSON.stringify({ version: 1, identity, deviceId, revision: revisionA, configured: true })));
    await expect(f.make().refresh()).rejects.toThrow(/原文件已保留/); expect(existsSync(f.privateFile)).toBe(false); expect(existsSync(f.publicFile)).toBe(false);
  });
  it('requires a strict existing configuration and never falls back to a local key', async () => {
    const f = await fixture(); writePrivate(f.configFile, JSON.stringify({ version: 1, origin: 'https://synthetic.invalid', credentialsFile: 'relative.json' }));
    const worker = f.make(); await expect(worker.getApiKey()).rejects.toMatchObject({ code: 'CANCELLED' }); expect(f.createClient).not.toHaveBeenCalled(); expect(f.set).not.toHaveBeenCalled();
    writePrivate(f.configFile, JSON.stringify({ version: 1, origin: 'https://synthetic.invalid', credentialsFile: join(f.root, 'missing.json'), extra: true }));
    await expect(worker.refresh()).rejects.toThrow(/同步配置无效/); expect(f.set).not.toHaveBeenCalled();
    rmSync(f.configFile); expect(createCollectorKeySync({ directory: f.root, keys: f.keys, encryption: f.encrypted })).toBeUndefined();
  });
});
