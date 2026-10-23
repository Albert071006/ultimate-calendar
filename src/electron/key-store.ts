import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SetApiKeyRequestSchema, type KeyStatus } from '../shared/contracts';
import { WorkflowError } from '../ai/deepseek';
export interface AsyncEncryption {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(bytes: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
export interface KeyStoreOptions {
  onStatusChanged?(): void;
  retryDelay?(milliseconds: number): Promise<void>;
  now?(): number;
}
type LoadError = 'unavailable' | 'read' | 'decrypt' | 'invalid';
const RETRY_DELAYS = [250, 750];
const RETRY_COOLDOWN = 30_000;

export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export function createKeyStore(path: string, encryption: AsyncEncryption, options: KeyStoreOptions = {}) {
  let key: string | null = null;
  let sessionOnly = false;
  let loadError: LoadError | undefined;
  let nextRetryAt = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const now = options.now ?? Date.now;
  const delay = options.retryDelay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const status = (): KeyStatus => ({
    configured: key !== null,
    sessionOnly: key !== null && sessionOnly,
    ...(loadError ? { loadError } : {}),
  });
  let lastNotified = JSON.stringify(status());

  function notify() {
    const current = JSON.stringify(status());
    if (current === lastNotified) return;
    lastNotified = current;
    // A UI listener must never turn a successful credential operation into a failure.
    try { options.onStatusChanged?.(); } catch { /* The next snapshot still has the current status. */ }
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = queue.then(job);
    queue = next.catch(() => {});
    return next;
  }

  async function loadAttempt(): Promise<LoadError | null> {
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'read';
      key = null;
      sessionOnly = false;
      return null;
    }
    if (bytes.length === 0 || bytes.length > 65536) return 'invalid';

    try { if (!await encryption.isAsyncEncryptionAvailable()) return 'unavailable'; }
    catch { return 'unavailable'; }
    let decrypted: Awaited<ReturnType<AsyncEncryption['decryptStringAsync']>>;
    try { decrypted = await encryption.decryptStringAsync(bytes); }
    catch { return 'decrypt'; }
    const parsed = SetApiKeyRequestSchema.safeParse({ key: decrypted?.result });
    if (!parsed.success || parsed.data.key === null) return 'invalid';

    key = parsed.data.key;
    sessionOnly = false;
    if (decrypted.shouldReEncrypt) {
      try { await atomicWrite(path, await encryption.encryptStringAsync(key)); }
      catch {
        // Rotation is maintenance: the decrypted key and original ciphertext remain usable.
      }
    }
    return null;
  }

  async function load(): Promise<boolean> {
    let failure: LoadError | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      if (attempt > 0) await delay(RETRY_DELAYS[attempt - 1]!);
      failure = await loadAttempt();
      if (!failure || failure === 'invalid') break;
    }
    loadError = failure ?? undefined;
    nextRetryAt = failure || key === null ? now() + RETRY_COOLDOWN : 0;
    notify();
    return failure === null;
  }

  async function persist(value: string | null): Promise<KeyStatus> {
    const parsed = SetApiKeyRequestSchema.parse({ key: value }).key;
    try {
      const available = parsed !== null && await encryption.isAsyncEncryptionAvailable();
      if (parsed && available) await atomicWrite(path, await encryption.encryptStringAsync(parsed));
      else await rm(path, { force: true });
      key = parsed;
      sessionOnly = !!parsed && !available;
      loadError = undefined;
      nextRetryAt = parsed === null ? now() + RETRY_COOLDOWN : 0;
      notify();
      return status();
    } catch { throw new WorkflowError('STORAGE', '密钥未能安全保存，请检查数据目录权限后重试'); }
  }
  return {
    initialize(): Promise<void> {
      return enqueue(async () => {
        if (!await load()) throw new WorkflowError('STORAGE', '已保存密钥暂未载入，原文件已保留；请在设置中重试加载，本地日历仍可使用');
      });
    },
    get(): Promise<string | null> {
      return enqueue(async () => {
        if (key === null && now() >= nextRetryAt) await load();
        return key;
      });
    },
    retry(): Promise<KeyStatus> {
      return enqueue(async () => {
        if (loadError || key === null) await load();
        return status();
      });
    },
    status,
    set(value: string | null): Promise<KeyStatus> { return enqueue(() => persist(value)); },
  };
}
