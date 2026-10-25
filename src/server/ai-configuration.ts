import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { privatePath, readPrivate, writePrivate } from '../remote/private-file';
import { AiApiKeySchema, AiConfigurationRevisionSchema, type AiConfigurationStatus } from '../shared/ai-configuration';
import { RemoteFault } from './state';

export interface ApiKeyConfiguration {
  getApiKey(): Promise<string | null>;
  status(): Promise<AiConfigurationStatus>;
  set(expectedRevision: string | null, apiKey: string): Promise<AiConfigurationStatus>;
  clear(expectedRevision: string | null): Promise<AiConfigurationStatus>;
}

const StoredConfigurationSchema = z.strictObject({
  version: z.literal(1),
  revision: z.string().uuid(),
  apiKey: z.string().min(16).max(512).regex(/^[\x21-\x7e]+$/).nullable(),
});
type StoredConfiguration = z.infer<typeof StoredConfigurationSchema>;

function storageFailure(): RemoteFault {
  return new RemoteFault(503, 'AI 凭据存储暂不可用，请检查服务端私密文件状态');
}

/** Uses the service directory's single-writer lock. Never put this file in business-data backups. */
export function createManagedApiKeyConfiguration(file: string): ApiKeyConfiguration {
  function checkedPath(): string {
    const result = privatePath(file);
    // existsSync follows links, so explicitly reject dangling links as well as live links.
    for (let path = result; ; path = dirname(path)) {
      try { if (lstatSync(path).isSymbolicLink()) throw storageFailure(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (dirname(path) === path) break;
    }
    return result;
  }

  function read(): StoredConfiguration | null {
    try {
      const bytes = readPrivate(checkedPath(), 4096);
      return bytes === null ? null : StoredConfigurationSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch { throw storageFailure(); }
  }

  function status(value: StoredConfiguration | null): AiConfigurationStatus {
    return { provider: 'deepseek', configured: !!value?.apiKey, editable: true,
      source: value?.apiKey ? 'managed' : 'none', revision: value?.revision ?? null };
  }

  function change(expectedRevision: string | null, apiKey: string | null): AiConfigurationStatus {
    if (!AiConfigurationRevisionSchema.safeParse(expectedRevision).success) throw new RemoteFault(400, 'AI 配置版本格式不正确');
    const current = read();
    if ((current?.revision ?? null) !== expectedRevision) throw new RemoteFault(409, 'AI 配置已变化，请重新读取配置状态');
    const next: StoredConfiguration = { version: 1, revision: randomUUID(), apiKey };
    try { writePrivate(checkedPath(), JSON.stringify(next)); }
    catch { throw storageFailure(); }
    return status(next);
  }

  return {
    async getApiKey() { return read()?.apiKey ?? null; },
    async status() { return status(read()); },
    async set(expectedRevision, apiKey) {
      const parsed = AiApiKeySchema.safeParse(apiKey);
      if (!parsed.success) throw new RemoteFault(400, 'API Key 格式不正确');
      return change(expectedRevision, parsed.data);
    },
    async clear(expectedRevision) { return change(expectedRevision, null); },
  };
}

/** Explicit CLI/environment credentials remain administrator-managed, with no implicit fallback. */
export function createExternalApiKeyConfiguration(getApiKey: () => Promise<string | null>): ApiKeyConfiguration {
  async function read(): Promise<string | null> {
    try { return (await getApiKey())?.trim() || null; }
    catch { throw storageFailure(); }
  }
  function readOnly(): never { throw new RemoteFault(403, 'API Key 由服务器配置管理，不能通过手机修改'); }
  return {
    getApiKey: read,
    async status() {
      const configured = !!await read();
      return { provider: 'deepseek', configured, editable: false, source: configured ? 'external' : 'none', revision: null };
    },
    async set() { return readOnly(); },
    async clear() { return readOnly(); },
  };
}
