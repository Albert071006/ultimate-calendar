import { constants, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPair, privateDecrypt, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { WorkflowError } from '../ai/deepseek';
import { createNodeRemoteClient, fileCredentialStore, normalizeRemoteOrigin, RemoteClientError, sameRemoteIdentity, type RemoteCredential } from '../remote/node-client';
import { privatePath, readPrivate, writePrivate } from '../remote/private-file';
import { AiKeySyncPlaintextSchema, AiKeySyncResponseSchema, aiKeySyncAad, type AiKeySyncResponse } from '../shared/ai-key-sync';
import { AiConfigurationRevisionSchema } from '../shared/ai-configuration';
import { RemoteIdentitySchema } from '../shared/remote';
import { type KeyStatus, type Settings } from '../shared/contracts';
import type { AsyncEncryption } from './key-store';

const ConfigSchema = z.strictObject({
  version: z.literal(1), origin: z.string().transform(normalizeRemoteOrigin),
  credentialsFile: z.string().refine(value => isAbsolute(value) && resolve(value) !== parse(resolve(value)).root),
  localConnectAddress: z.literal('127.0.0.1').optional(),
});
const PrivateReceiverSchema = z.strictObject({ version: z.literal(1), privateKeyPkcs8: z.string().max(16_384) });
const PublicReceiverSchema = z.strictObject({ version: z.literal(1), keyId: z.string().regex(/^[0-9a-f]{64}$/), publicKeySpki: z.string().max(4096) });
const ReceiptSchema = z.strictObject({ version: z.literal(1), identity: RemoteIdentitySchema, deviceId: z.string().uuid(),
  revision: AiConfigurationRevisionSchema, configured: z.boolean() });
const generate = promisify(generateKeyPair);
type Revision = string | null;
export interface CollectorKeySyncStatus {
  state: 'syncing' | 'ready' | 'error'; revision: Revision; configured: boolean; lastSyncedAt: string | null; message: string | null;
}
export interface CollectorKeyChange {
  previousRevision: Revision | undefined; revision: Revision; configured: boolean; sourceId: string;
}
interface SyncClient {
  syncAiKeyReceiver(input: { keyId: string; nonce: string }, options?: { signal?: AbortSignal }): Promise<AiKeySyncResponse>;
  close(): void;
}
export interface CollectorKeySyncOptions {
  directory: string;
  encryption: AsyncEncryption;
  keys: { get(): Promise<string | null>; set(key: string | null): Promise<KeyStatus>; status(): KeyStatus };
  createClient?(options: Parameters<typeof createNodeRemoteClient>[0]): SyncClient;
  onChanged?(value: CollectorKeyChange): void | Promise<void>;
  onSettings?(settings: Pick<Settings, 'model' | 'reasoningEffort'>): void;
  onStatusChanged?(): void;
  timeoutMs?: number;
  pollMs?: number;
  now?(): number;
}

/** Cloud ownership must never enter KeyStore's optional session-only fallback. */
export function requirePersistentEncryption(encryption: AsyncEncryption): AsyncEncryption {
  return {
    async isAsyncEncryptionAvailable() {
      if (!await encryption.isAsyncEncryptionAvailable()) throw new WorkflowError('STORAGE', '本机密钥加密暂不可用，原凭据保持不变');
      return true;
    },
    async encryptStringAsync(value) {
      const encrypted = await encryption.encryptStringAsync(value);
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > 65_536) throw new WorkflowError('STORAGE', '本机密钥加密暂不可用，原凭据保持不变');
      return encrypted;
    },
    decryptStringAsync: bytes => encryption.decryptStringAsync(bytes),
  };
}

export function hasCollectorKeySyncConfiguration(directory: string) {
  try { lstatSync(join(directory, 'credentials', 'cloud-key-sync.json')); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

/** Commit a first receiver without ever replacing an existing key, including concurrent creation. */
async function writeNewPrivate(file: string, value: Buffer | string) {
  privatePath(file); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await link(temp, file);
  } finally { await rm(temp, { force: true }); }
}

function failure(code: 'configuration' | 'receiver' | 'network' | 'identity' | 'protocol' | 'storage' | 'closed') {
  return new WorkflowError(code === 'storage' || code === 'receiver' ? 'STORAGE' : code === 'closed' ? 'CANCELLED' : 'AUTH', {
    configuration: '云端密钥同步配置无效，未使用旧密钥；请核对本机同步配置',
    receiver: '本机密钥接收凭据暂不可用，原文件已保留；请核对后重试',
    network: '云端密钥同步暂未完成，未使用旧密钥；连接恢复后会自动重试',
    identity: '云端密钥同步授权或资料身份已变化，未使用旧密钥；请核对设备授权',
    protocol: '云端密钥同步校验未通过，未使用旧密钥；请核对后重试',
    storage: '云端密钥同步未能安全保存，未继续使用密钥；请核对本机存储后重试',
    closed: '采集模式正在退出，密钥同步已停止',
  }[code]);
}

/** The configured cloud remains authoritative even when configuration, transport or storage fails. */
export function createCollectorKeySync(options: CollectorKeySyncOptions) {
  if (!hasCollectorKeySyncConfiguration(options.directory)) return undefined;
  const folder = join(options.directory, 'credentials');
  const receiptFile = join(folder, 'cloud-key-receiver-receipt.bin');
  const now = options.now ?? Date.now;
  let client: SyncClient | undefined, credential: RemoteCredential | undefined, privateKey: KeyObject | undefined, keyId: string | undefined;
  let closed = false, started = false, timer: ReturnType<typeof setTimeout> | undefined, attemptAbort: AbortController | undefined;
  let inFlight: Promise<void> | undefined, closePromise: Promise<void> | undefined, failures = 0, applied = false;
  let appliedKey: string | null = null;
  let receipt: z.infer<typeof ReceiptSchema> | undefined;
  let current: CollectorKeySyncStatus = { state: 'syncing', revision: null, configured: false, lastSyncedAt: null, message: null };
  const retiredRevisions = new Set<Revision>();
  const checkOpen = (signal?: AbortSignal) => { if (closed || signal?.aborted) throw failure(closed ? 'closed' : 'network'); };
  function publish(value: Partial<CollectorKeySyncStatus>) {
    current = { ...current, ...value };
    try { options.onStatusChanged?.(); } catch { /* Metadata observers do not own the credential. */ }
  }
  async function initialize(signal: AbortSignal) {
    if (client && credential && privateKey && keyId) return;
    let config: z.infer<typeof ConfigSchema>, saved: RemoteCredential;
    try {
      const bytes = readPrivate(join(folder, 'cloud-key-sync.json'), 16_384);
      config = ConfigSchema.parse(JSON.parse(bytes!.toString('utf8')));
      const found = fileCredentialStore(config.credentialsFile).read();
      if (!found || found.origin !== config.origin) throw Error();
      saved = found;
    } catch { throw failure('configuration'); }
    try {
      if (!await options.encryption.isAsyncEncryptionAvailable()) throw Error();
      checkOpen(signal);
      const privateFile = join(folder, 'cloud-key-receiver.bin'), publicFile = join(folder, 'cloud-key-receiver-public.json');
      const existingPrivate = readPrivate(privateFile, 65_536), existingPublic = readPrivate(publicFile, 8192), existingReceipt = readPrivate(receiptFile, 8192);
      let receiver: KeyObject;
      if (existingPrivate) {
        if (!existingPrivate.length) throw Error();
        const decoded = await options.encryption.decryptStringAsync(existingPrivate);
        const checked = PrivateReceiverSchema.parse(JSON.parse(decoded.result));
        receiver = createPrivateKey(checked.privateKeyPkcs8);
      } else {
        if (existingPublic || existingReceipt) throw Error();
        receiver = (await generate('rsa', { modulusLength: 3072, publicExponent: 0x10001 })).privateKey;
        checkOpen(signal);
        const encoded = JSON.stringify({ version: 1, privateKeyPkcs8: receiver.export({ type: 'pkcs8', format: 'pem' }).toString() });
        const encrypted = await options.encryption.encryptStringAsync(encoded);
        checkOpen(signal);
        if (!encrypted.length) throw Error();
        await writeNewPrivate(privateFile, encrypted);
      }
      if (receiver.asymmetricKeyType !== 'rsa' || receiver.asymmetricKeyDetails?.modulusLength !== 3072 || receiver.asymmetricKeyDetails?.publicExponent !== 65537n) throw Error();
      checkOpen(signal);
      const publicKey = createPublicKey(receiver), publicKeySpki = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const id = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      if (existingPublic) {
        const checked = PublicReceiverSchema.parse(JSON.parse(existingPublic.toString('utf8')));
        if (checked.keyId !== id || checked.publicKeySpki !== publicKeySpki) throw Error();
      } else await writeNewPrivate(publicFile, JSON.stringify({ version: 1, keyId: id, publicKeySpki }));
      if (existingReceipt) {
        const decoded = await options.encryption.decryptStringAsync(existingReceipt);
        receipt = ReceiptSchema.parse(JSON.parse(decoded.result));
        if (!sameRemoteIdentity(receipt.identity, saved.identity) || receipt.deviceId !== saved.deviceId) throw Error();
      }
      checkOpen(signal);
      const created = (options.createClient ?? createNodeRemoteClient)({ origin: config.origin, credentialsFile: config.credentialsFile,
        localConnectAddress: config.localConnectAddress, timeoutMs: options.timeoutMs ?? 8000 });
      credential = saved; privateKey = receiver; keyId = id; client = created;
    } catch (error) { if (closed || signal.aborted) checkOpen(signal); if (error instanceof RemoteClientError) throw failure('configuration'); throw failure('receiver'); }
  }
  async function perform(signal: AbortSignal) {
    await initialize(signal); checkOpen(signal);
    const nonce = randomBytes(32).toString('base64url');
    let response: AiKeySyncResponse;
    let cancel: () => void = () => {};
    try {
      response = await Promise.race([client!.syncAiKeyReceiver({ keyId: keyId!, nonce }, { signal }), new Promise<never>((_resolve, reject) => {
        cancel = () => reject(failure(closed ? 'closed' : 'network'));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      })]);
    }
    catch (error) {
      checkOpen(signal);
      throw failure(error instanceof RemoteClientError && [401, 403, 409].includes(error.status) ? 'identity' : 'network');
    } finally { signal.removeEventListener('abort', cancel); }
    checkOpen(signal);
    let key: string | null, revision: Revision, settings: Pick<Settings, 'model' | 'reasoningEffort'> | undefined;
    try {
      const checked = AiKeySyncResponseSchema.parse(response), envelope = checked.envelope;
      if (!sameRemoteIdentity(checked.identity, credential!.identity) || envelope.deviceId !== credential!.deviceId || envelope.keyId !== keyId || envelope.nonce !== nonce) throw Error();
      if (applied && envelope.revision !== current.revision && retiredRevisions.has(envelope.revision)) throw Error();
      const symmetric = privateDecrypt({ key: privateKey!, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64url'));
      let plaintext: Buffer | undefined;
      try {
        if (symmetric.length !== 32) throw Error();
        const decipher = createDecipheriv('aes-256-gcm', symmetric, Buffer.from(envelope.iv, 'base64url'));
        decipher.setAAD(Buffer.from(aiKeySyncAad(checked.identity, envelope), 'utf8'));
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
        plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
        const decoded = AiKeySyncPlaintextSchema.parse(JSON.parse(plaintext.toString('utf8')));
        if (decoded.revision !== envelope.revision) throw Error();
        key = decoded.apiKey; revision = decoded.revision; settings = decoded.settings;
      } finally { symmetric.fill(0); plaintext?.fill(0); }
    } catch { throw failure('protocol'); }
    checkOpen(signal);
    // Check the revision/key relationship before touching either credential file or memory.
    if (applied && revision === current.revision && key !== appliedKey) throw failure('protocol');
    if (settings) options.onSettings?.(settings);
    try {
      if (!await options.encryption.isAsyncEncryptionAvailable()) throw Error();
      checkOpen(signal);
      const previous = await options.keys.get(), status = options.keys.status();
      checkOpen(signal);
      if (previous !== key || status.sessionOnly || status.loadError) {
        const saved = await options.keys.set(key);
        if (saved.sessionOnly || saved.loadError || saved.configured !== (key !== null)) throw Error();
      }
    } catch { throw failure('storage'); }
    checkOpen(signal);
    const previousRevision = receipt?.revision;
    const changed = !receipt || revision !== receipt.revision || receipt.configured !== (key !== null);
    const sourceId = createHash('sha256').update(JSON.stringify({ origin: credential!.origin, deviceId: credential!.deviceId,
      identity: { protocolVersion: credential!.identity.protocolVersion, dataInstanceId: credential!.identity.dataInstanceId, generation: credential!.identity.generation } })).digest('hex');
    if (changed) try { await options.onChanged?.({ previousRevision, revision, configured: key !== null, sourceId }); } catch { throw failure('protocol'); }
    checkOpen(signal);
    if (changed) {
      const next = ReceiptSchema.parse({ version: 1, identity: credential!.identity, deviceId: credential!.deviceId, revision, configured: key !== null });
      try {
        if (!await options.encryption.isAsyncEncryptionAvailable()) throw Error();
        const encrypted = await options.encryption.encryptStringAsync(JSON.stringify(next));
        checkOpen(signal);
        if (!encrypted.length) throw Error();
        writePrivate(receiptFile, encrypted); receipt = next;
      } catch { throw failure('storage'); }
    }
    if (applied && revision !== current.revision) retiredRevisions.add(current.revision);
    applied = true; appliedKey = key; failures = 0;
    publish({ state: 'ready', revision, configured: key !== null, lastSyncedAt: new Date(now()).toISOString(), message: null });
  }
  function schedule() {
    if (!started || closed) return;
    const base = Math.max(10, options.pollMs ?? 10_000);
    timer = setTimeout(() => { timer = undefined; void refresh().catch(() => {}); }, Math.min(60_000, base * 2 ** Math.min(failures, 3)));
    timer.unref();
  }
  function refresh(): Promise<void> {
    if (closed) return Promise.reject(failure('closed'));
    if (inFlight) return inFlight;
    if (timer) { clearTimeout(timer); timer = undefined; }
    const controller = new AbortController(); attemptAbort = controller;
    const timeout = setTimeout(() => controller.abort(), Math.max(100, Math.min(30_000, options.timeoutMs ?? 8000))); timeout.unref();
    const pending = perform(controller.signal).catch(error => {
      failures++;
      const safe = error instanceof WorkflowError ? error : failure('protocol');
      if (!closed) publish({ state: 'error', message: safe.message });
      throw safe;
    }).finally(() => {
      clearTimeout(timeout);
      if (attemptAbort === controller) attemptAbort = undefined;
      if (inFlight === pending) inFlight = undefined;
      schedule();
    });
    inFlight = pending; publish({ state: 'syncing', message: null }); return pending;
  }
  return {
    start() { if (closed || started) return; started = true; void refresh().catch(() => {}); },
    refresh,
    async getApiKey() {
      try { await refresh(); checkOpen(); if (current.state !== 'ready') throw failure('network'); return appliedKey; }
      catch { throw new WorkflowError('CANCELLED', closed ? '采集模式正在退出' : '等待云端密钥同步，连接恢复后会自动重试'); }
    },
    status(): CollectorKeySyncStatus { return { ...current }; },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true; started = false;
      if (timer) clearTimeout(timer);
      attemptAbort?.abort(); client?.close();
      closePromise = (inFlight ?? Promise.resolve()).catch(() => {}).then(() => { appliedKey = null; privateKey = undefined; });
      return closePromise;
    },
  };
}
export type CollectorKeySync = NonNullable<ReturnType<typeof createCollectorKeySync>>;
