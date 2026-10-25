import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AiConfigurationClearSchema, AiConfigurationStatusSchema, AiConfigurationUpdateSchema } from '../shared/ai-configuration';
import { createExternalApiKeyConfiguration, createManagedApiKeyConfiguration } from './ai-configuration';

const KEY_A = 'synthetic-deepseek-key-aaaaaaaa';
const KEY_B = 'synthetic-deepseek-key-bbbbbbbb';
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) {
    if (!resolve(folder).startsWith(resolve(join(tmpdir(), 'planner-ai-config-')))) throw Error('Unexpected test cleanup path');
    rmSync(folder, { recursive: true, force: true });
  }
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'planner-ai-config-'));
  folders.push(directory);
  const file = join(directory, 'private', 'ai-credentials.json');
  return { directory, file, configuration: createManagedApiKeyConfiguration(file) };
}

describe('managed AI credentials', () => {
  it('persists keys across recreation while all public status results omit key contents and hints', async () => {
    const { file, configuration } = setup();
    expect(await configuration.status()).toEqual({ provider: 'deepseek', configured: false, editable: true, source: 'none', revision: null });
    expect(await configuration.getApiKey()).toBeNull();
    expect(await configuration.readForReceiver()).toEqual({ apiKey: null, revision: null });
    const saved = await configuration.set(null, ` \t${KEY_A}\r\n`);
    expect(saved).toEqual({ provider: 'deepseek', configured: true, editable: true, source: 'managed', revision: expect.any(String) });
    expect(AiConfigurationStatusSchema.parse(saved)).toEqual(saved);
    const restarted = createManagedApiKeyConfiguration(file);
    expect(await restarted.getApiKey()).toBe(KEY_A);
    expect(await restarted.readForReceiver()).toEqual({ apiKey: KEY_A, revision: saved.revision });
    expect(await restarted.status()).toEqual(saved);
    expect(Object.keys(saved).sort()).toEqual(['configured', 'editable', 'provider', 'revision', 'source']);
    expect(JSON.stringify(saved)).not.toContain(KEY_A);
    const replacement = await restarted.set(saved.revision, KEY_B);
    expect(replacement.revision).not.toBe(saved.revision);
    expect(await configuration.getApiKey()).toBe(KEY_B);
  });

  it('allows only one concurrent update of the same revision, including from a second store object', async () => {
    const { file, configuration } = setup();
    const second = createManagedApiKeyConfiguration(file);
    const results = await Promise.allSettled([configuration.set(null, KEY_A), second.set(null, KEY_B)]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(await second.getApiKey()).toBe(KEY_A);
    await expect(second.clear(null)).rejects.toMatchObject({ status: 409 });
  });

  it('keeps a revision tombstone when cleared so stale initial writes cannot revive a deleted key', async () => {
    const { file, configuration } = setup();
    const initial = await configuration.set(null, KEY_A);
    const cleared = await configuration.clear(initial.revision);
    expect(cleared).toMatchObject({ configured: false, editable: true, source: 'none' });
    expect(cleared.revision).not.toBeNull();
    expect(cleared.revision).not.toBe(initial.revision);
    const restarted = createManagedApiKeyConfiguration(file);
    expect(await restarted.getApiKey()).toBeNull();
    expect(await restarted.readForReceiver()).toEqual({ apiKey: null, revision: cleared.revision });
    expect(await restarted.status()).toEqual(cleared);
    expect(readFileSync(file, 'utf8')).not.toContain(KEY_A);
    await expect(restarted.set(null, KEY_A)).rejects.toMatchObject({ status: 409 });
    await expect(restarted.set(initial.revision, KEY_A)).rejects.toMatchObject({ status: 409 });
    expect(await restarted.set(cleared.revision, KEY_B)).toMatchObject({ configured: true });
  });

  it.each(['short', '', 'x'.repeat(513), 'synthetic key with spaces', 'synthetic-key\nHeader:injection', 'synthetic-key\u0000control', 'synthetic-key-汉字'])('rejects malformed token %j without changing a valid configuration', async invalid => {
    const { file, configuration } = setup();
    const initial = await configuration.set(null, KEY_A), before = readFileSync(file);
    await expect(configuration.set(initial.revision, invalid)).rejects.toMatchObject({ status: 400, message: 'API Key 格式不正确' });
    expect(readFileSync(file)).toEqual(before);
    expect(await configuration.getApiKey()).toBe(KEY_A);
  });

  it('rejects malformed revisions without writing a file or exposing their contents', async () => {
    const { configuration } = setup();
    await expect(configuration.set(KEY_A, KEY_B)).rejects.toMatchObject({ status: 400, message: 'AI 配置版本格式不正确' });
    expect(await configuration.status()).toMatchObject({ revision: null, configured: false });
  });

  it.each(['not-json', JSON.stringify({ version: 1, revision: randomUUID(), apiKey: KEY_A, unexpected: true }), 'x'.repeat(4097)])('fails closed on malformed stored credentials without leaking file contents', async contents => {
    const { file, configuration } = setup();
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, contents, { mode: 0o600 });
    for (const operation of [() => configuration.getApiKey(), () => configuration.status(), () => configuration.set(null, KEY_B), () => configuration.clear(null)]) {
      await expect(operation()).rejects.toMatchObject({ status: 503, message: 'AI 凭据存储暂不可用，请检查服务端私密文件状态' });
    }
    expect(readFileSync(file, 'utf8')).toBe(contents);
  });

  it('rejects hard-linked files instead of replacing or reading either link', async () => {
    const { file, directory, configuration } = setup();
    const saved = await configuration.set(null, KEY_A), linked = join(directory, 'other.json');
    linkSync(file, linked);
    await expect(configuration.getApiKey()).rejects.toMatchObject({ status: 503 });
    await expect(configuration.set(saved.revision, KEY_B)).rejects.toMatchObject({ status: 503 });
    expect(readFileSync(linked, 'utf8')).toContain(KEY_A);
  });

  it.skipIf(process.platform === 'win32')('uses 0600 files and refuses broadened file permissions', async () => {
    const { file, configuration } = setup();
    const saved = await configuration.set(null, KEY_A);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(file, '..')).mode & 0o777).toBe(0o700);
    chmodSync(file, 0o644);
    await expect(configuration.status()).rejects.toMatchObject({ status: 503 });
    await expect(configuration.set(saved.revision, KEY_B)).rejects.toMatchObject({ status: 503 });
  });

  it.skipIf(process.platform === 'win32')('rejects live and dangling symlinks, including linked parent directories', async () => {
    const { directory, file, configuration } = setup();
    mkdirSync(join(file, '..'), { recursive: true });
    const target = join(directory, 'target.json');
    symlinkSync(target, file);
    await expect(configuration.set(null, KEY_A)).rejects.toMatchObject({ status: 503 });
    writeFileSync(target, JSON.stringify({ version: 1, revision: randomUUID(), apiKey: KEY_A }), { mode: 0o600 });
    await expect(configuration.getApiKey()).rejects.toMatchObject({ status: 503 });
    const linkedDirectory = join(directory, 'linked');
    symlinkSync(join(file, '..'), linkedDirectory);
    await expect(createManagedApiKeyConfiguration(join(linkedDirectory, 'new.json')).set(null, KEY_B)).rejects.toMatchObject({ status: 503 });
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
  });
});

describe('external AI credentials', () => {
  it('uses configured external credentials but never makes them writable or returns them in status', async () => {
    const configuration = createExternalApiKeyConfiguration(async () => KEY_A);
    expect(await configuration.getApiKey()).toBe(KEY_A);
    expect(await configuration.status()).toEqual({ provider: 'deepseek', configured: true, editable: false, source: 'external', revision: null });
    await expect(configuration.set(null, KEY_B)).rejects.toMatchObject({ status: 403 });
    await expect(configuration.clear(null)).rejects.toMatchObject({ status: 403 });
    await expect(configuration.readForReceiver()).rejects.toMatchObject({ status: 403 });
    expect(await configuration.getApiKey()).toBe(KEY_A);
    expect(await createExternalApiKeyConfiguration(async () => null).status()).toMatchObject({ configured: false, editable: false, source: 'none' });
  });

  it('does not expose credentials contained in a source error', async () => {
    const configuration = createExternalApiKeyConfiguration(async () => { throw Error(KEY_A); });
    await expect(configuration.status()).rejects.toMatchObject({ status: 503, message: 'AI 凭据存储暂不可用，请检查服务端私密文件状态' });
    await expect(configuration.getApiKey()).rejects.toMatchObject({ status: 503, message: 'AI 凭据存储暂不可用，请检查服务端私密文件状态' });
  });
});

describe('AI configuration wire schemas', () => {
  const identity = { protocolVersion: 1, dataInstanceId: randomUUID(), generation: 1 };
  it('requires explicit identity and revision, forbids unrelated settings, and trims pasted tokens', () => {
    expect(AiConfigurationUpdateSchema.parse({ identity, expectedRevision: null, apiKey: ` ${KEY_A} ` }).apiKey).toBe(KEY_A);
    expect(AiConfigurationUpdateSchema.safeParse({ identity, apiKey: KEY_A }).success).toBe(false);
    expect(AiConfigurationUpdateSchema.safeParse({ identity, expectedRevision: null, apiKey: KEY_A, endpoint: 'https://invalid.example' }).success).toBe(false);
    expect(AiConfigurationClearSchema.safeParse({ expectedRevision: null }).success).toBe(false);
    expect(AiConfigurationClearSchema.safeParse({ identity, expectedRevision: null, apiKey: KEY_A }).success).toBe(false);
    expect(AiConfigurationClearSchema.parse({ identity, expectedRevision: null })).toEqual({ identity, expectedRevision: null });
  });
});
