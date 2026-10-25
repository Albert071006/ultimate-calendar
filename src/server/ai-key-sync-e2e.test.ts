import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCollectorKeySync, requirePersistentEncryption, type CollectorKeyChange } from '../electron/collector-key-sync';
import { createKeyStore, type AsyncEncryption } from '../electron/key-store';
import { createCaptureStore } from '../capture/store';
import { createNodeRemoteClient } from '../remote/node-client';
import { writePrivate } from '../remote/private-file';
import { createManagedApiKeyConfiguration } from './ai-configuration';
import { AiKeyReceiverConfigurationSchema } from './ai-key-receiver';
import { createRemoteHttpServer } from './http';
import { createRemoteService } from './service';

const origin = 'http://localhost:3210';
const keyA = 'sk-e2e-fictional-key-aaaaaaaa', keyB = 'sk-e2e-fictional-key-bbbbbbbb';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** Emulates safeStorage only; HTTP, envelope cryptography, KeyStore and SQLite are real. */
function testEncryption(): AsyncEncryption {
  const secret = randomBytes(32);
  return {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    async decryptStringAsync(value) {
      const decipher = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return { result: Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
  };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'planner-key-sync-e2e-'));
  cleanup.push(async () => {
    if (!resolve(root).startsWith(resolve(join(tmpdir(), 'planner-key-sync-e2e-')))) throw Error('Unexpected fixture path');
    rmSync(root, { recursive: true, force: true });
  });
  const serverDirectory = join(root, 'server'), collectorDirectory = join(root, 'collector');
  const modelFetch = vi.fn(async () => { throw Error('Real AI calls forbidden'); });
  const service = createRemoteService({ dataDirectory: serverDirectory,
    apiKeyConfiguration: createManagedApiKeyConfiguration(join(serverDirectory, 'ai-credentials.json')),
    getApiKey: async () => null, controller: { fetch: modelFetch }, startupBackup: false });
  const http = createRemoteHttpServer({ service, origin, secureCookie: false });
  const port = await http.listen(0);
  cleanup.push(async () => { await http.close(); await service.close(); });
  const responseTexts: string[] = [];
  const transport: typeof fetch = (url, init = {}) => new Promise((done, reject) => {
    const target = new URL(String(url));
    if (target.origin !== origin) { reject(Error('Non-fixture destination forbidden')); return; }
    const headers = new Headers(init.headers); headers.set('Host', target.host);
    if (typeof init.body === 'string') headers.set('Content-Length', String(Buffer.byteLength(init.body)));
    const request = httpRequest(`http://127.0.0.1:${port}${target.pathname}`, {
      method: init.method, headers: Object.fromEntries(headers.entries()), signal: init.signal ?? undefined,
    }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const bytes = Buffer.concat(chunks); responseTexts.push(bytes.toString('utf8'));
        done(new Response(bytes, { status: response.statusCode, headers: responseHeaders }));
      });
    });
    request.on('error', reject); if (init.body) request.write(init.body); request.end();
  });
  const phone = createNodeRemoteClient({ origin, credentialsFile: join(root, 'phone-session.json'), fetch: transport });
  const collectorSessionFile = join(collectorDirectory, 'credentials', 'cloud-session.json');
  const pairing = createNodeRemoteClient({ origin, credentialsFile: collectorSessionFile, fetch: transport });
  cleanup.push(async () => { phone.close(); pairing.close(); });
  await phone.pair(service.state.createPairingCode(), '虚构手机');
  const collectorSession = await pairing.pair(service.state.createPairingCode(), '虚构采集电脑');
  writePrivate(join(collectorDirectory, 'credentials', 'cloud-key-sync.json'), JSON.stringify({ version: 1, origin, credentialsFile: collectorSessionFile }));
  const encryption = testEncryption(), keyFile = join(collectorDirectory, 'credentials', 'deepseek.bin');
  let capture = createCaptureStore(join(collectorDirectory, 'planner.sqlite'));
  cleanup.push(async () => { capture.close(); });
  capture.saveConfig({ ...capture.config(), enabled: true, analysisEnabled: true, accountId: '800000001', groupIds: ['900000001'] });
  const appliedChanges: { changed: boolean; resumed: boolean; paused: boolean }[] = [];
  const onChanged = vi.fn(async (value: CollectorKeyChange) => {
    appliedChanges.push(capture.applyCredentialChange({ configured: value.configured, revision: value.revision, sourceId: value.sourceId }));
  });
  const makeWorker = async () => {
    const keys = createKeyStore(keyFile, requirePersistentEncryption(encryption), { retryDelay: async () => {} });
    await keys.initialize();
    const set = vi.spyOn(keys, 'set');
    const worker = createCollectorKeySync({ directory: collectorDirectory, encryption, keys, onChanged,
      createClient: options => createNodeRemoteClient({ ...options, fetch: transport }), timeoutMs: 5000 })!;
    cleanup.push(() => worker.close());
    return { worker, keys, set };
  };
  const bind = () => {
    const publicInfo = JSON.parse(readFileSync(join(collectorDirectory, 'credentials', 'cloud-key-receiver-public.json'), 'utf8'));
    writePrivate(join(serverDirectory, 'ai-key-receivers.json'), JSON.stringify(AiKeyReceiverConfigurationSchema.parse({ version: 1,
      receivers: [{ deviceId: collectorSession.deviceId, publicKeySpki: publicInfo.publicKeySpki, keyId: publicInfo.keyId, revoked: false }],
    })));
    return publicInfo;
  };
  const rejectedBatch = () => {
    const now = '2026-10-25T20:00:00+08:00';
    capture.ingest([{ accountId: '800000001', groupId: '900000001', messageId: 'synthetic-message-1', sentAt: now, importedAt: now, text: '虚构安排：下周提交测试报告' }]);
    const batch = capture.sealBatches({ force: true })[0]!; expect(batch).toBeDefined();
    capture.claimBatch(); capture.failBatch(batch.id, '合成 AUTH 拒绝'); capture.pauseForCredentials('AUTH', batch.id);
    return batch.id;
  };
  return { root, collectorDirectory, service, phone, pairing, collectorSession, encryption, keyFile, get capture() { return capture; },
    restartCapture() { capture.close(); capture = createCaptureStore(join(collectorDirectory, 'planner.sqlite')); },
    onChanged, appliedChanges, makeWorker, bind, rejectedBatch, modelFetch, responseTexts };
}

describe('phone → HTTP server → authorized encrypted collector synchronization', () => {
  it('saves, rotates and clears keys through real HTTP and resumes each accepted revision only once across worker restart', async () => {
    const fixture = await setup(), first = await fixture.makeWorker();
    await expect(first.worker.refresh()).rejects.toThrow(/授权|身份/); // Generates an unbound receiver for local administrator enrollment.
    fixture.bind();
    const batchId = fixture.rejectedBatch();
    const saved = await fixture.phone.updateAiConfiguration(keyA, null);
    expect(saved).toMatchObject({ configured: true, revision: expect.any(String) });
    expect(await first.worker.getApiKey()).toBe(keyA);
    expect(await first.keys.get()).toBe(keyA); expect(first.set).toHaveBeenCalledExactlyOnceWith(keyA);
    expect(fixture.capture.batch(batchId)?.status).toBe('pending'); expect(fixture.capture.config().analysisEnabled).toBe(true);
    expect(fixture.onChanged).toHaveBeenCalledExactlyOnceWith({ previousRevision: undefined, revision: saved.revision, configured: true, sourceId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // This key is now known to fail. Re-reading that same cloud revision must not resume it again.
    fixture.capture.claimBatch(); fixture.capture.failBatch(batchId, '同一版本再次 AUTH 拒绝'); fixture.capture.pauseForCredentials('AUTH', batchId);
    await first.worker.refresh(); await first.worker.close();
    const restarted = await fixture.makeWorker();
    expect(await restarted.worker.getApiKey()).toBe(keyA);
    expect(restarted.set).not.toHaveBeenCalled(); expect(fixture.onChanged).toHaveBeenCalledTimes(1);
    expect(fixture.capture.batch(batchId)?.status).toBe('failed'); expect(fixture.capture.config().analysisEnabled).toBe(false);
    const rotated = await fixture.phone.updateAiConfiguration(keyB, saved.revision);
    expect(await restarted.worker.getApiKey()).toBe(keyB);
    expect(restarted.set).toHaveBeenCalledExactlyOnceWith(keyB);
    expect(fixture.capture.batch(batchId)?.status).toBe('pending'); expect(fixture.capture.config().analysisEnabled).toBe(true);
    expect(fixture.onChanged).toHaveBeenLastCalledWith({ previousRevision: saved.revision, revision: rotated.revision, configured: true, sourceId: fixture.onChanged.mock.calls[0]![0].sourceId });
    const cleared = await fixture.phone.clearAiConfiguration(rotated.revision);
    expect(await restarted.worker.getApiKey()).toBeNull(); expect(await restarted.keys.get()).toBeNull();
    expect(existsSync(fixture.keyFile)).toBe(false); expect(fixture.capture.config().analysisEnabled).toBe(false);
    expect(fixture.capture.credentialPause()?.reason).toBe('NO_API_KEY');
    expect(fixture.onChanged).toHaveBeenLastCalledWith({ previousRevision: rotated.revision, revision: cleared.revision, configured: false, sourceId: fixture.onChanged.mock.calls[0]![0].sourceId });
    await restarted.worker.refresh(); await restarted.worker.close();
    const afterClear = await fixture.makeWorker(); expect(await afterClear.worker.getApiKey()).toBeNull();
    expect(fixture.onChanged).toHaveBeenCalledTimes(3); expect(afterClear.set).not.toHaveBeenCalled();
    const receipt = JSON.parse((await fixture.encryption.decryptStringAsync(readFileSync(join(fixture.collectorDirectory, 'credentials', 'cloud-key-receiver-receipt.bin')))).result);
    expect(receipt).toMatchObject({ revision: cleared.revision, configured: false, deviceId: fixture.collectorSession.deviceId, identity: fixture.collectorSession.identity });
    for (const text of [...fixture.responseTexts, JSON.stringify(afterClear.worker.status())]) for (const key of [keyA, keyB]) expect(text).not.toContain(key);
    for (const name of readdirSync(join(fixture.collectorDirectory, 'credentials'))) {
      const bytes = readFileSync(join(fixture.collectorDirectory, 'credentials', name));
      for (const key of [keyA, keyB]) expect(bytes.includes(Buffer.from(key))).toBe(false);
    }
    expect(fixture.modelFetch).not.toHaveBeenCalled();
  });

  it('keeps local ciphertext but refuses to use it after server-side receiver session revocation', async () => {
    const fixture = await setup(), { worker, keys } = await fixture.makeWorker();
    await expect(worker.refresh()).rejects.toThrow(); fixture.bind();
    await fixture.phone.updateAiConfiguration(keyA, null); expect(await worker.getApiKey()).toBe(keyA);
    const before = readFileSync(fixture.keyFile);
    fixture.service.state.revoke(fixture.collectorSession.deviceId);
    await expect(worker.getApiKey()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(worker.status().state).toBe('error'); expect(readFileSync(fixture.keyFile)).toEqual(before);
    expect(await keys.get()).toBe(keyA); // Durable data remains available for diagnosis, while model access fails closed.
    expect(fixture.onChanged).toHaveBeenCalledTimes(1); expect(fixture.modelFetch).not.toHaveBeenCalled();
  });

  it('does not resume a newly AUTH-rejected revision again when receipt persistence fails after its first resume', async () => {
    const fixture = await setup(), first = await fixture.makeWorker();
    await expect(first.worker.refresh()).rejects.toThrow(); fixture.bind();
    const batchId = fixture.rejectedBatch();
    const saved = await fixture.phone.updateAiConfiguration(keyA, null);
    await first.worker.refresh();
    fixture.capture.claimBatch(); fixture.capture.failBatch(batchId, '合成 A 版本 AUTH 拒绝'); fixture.capture.pauseForCredentials('AUTH', batchId);
    const rotated = await fixture.phone.updateAiConfiguration(keyB, saved.revision);
    const encrypt = fixture.encryption.encryptStringAsync.bind(fixture.encryption);
    let rejectReceipt = true;
    vi.spyOn(fixture.encryption, 'encryptStringAsync').mockImplementation(async value => {
      if (rejectReceipt && value.includes('"revision":') && value.includes('"configured":')) throw Error('Synthetic receipt storage failure');
      return encrypt(value);
    });
    await expect(first.worker.refresh()).rejects.toThrow(/安全保存/);
    expect(fixture.capture.batch(batchId)?.status).toBe('pending'); expect(await first.keys.get()).toBe(keyB);
    fixture.capture.claimBatch(); fixture.capture.failBatch(batchId, '合成 B 版本 AUTH 拒绝'); fixture.capture.pauseForCredentials('AUTH', batchId);
    // Restart with the old encrypted receipt while capture's atomic revision receipt remains durable.
    await first.worker.close(); fixture.restartCapture(); rejectReceipt = false;
    const restarted = await fixture.makeWorker(); await restarted.worker.refresh();
    expect(fixture.capture.batch(batchId)?.status).toBe('failed'); expect(fixture.capture.config().analysisEnabled).toBe(false);
    expect(fixture.capture.credentialPause()?.reason).toBe('AUTH');
    expect(fixture.appliedChanges).toEqual([
      { changed: true, resumed: true, paused: false },
      { changed: true, resumed: true, paused: false },
      { changed: false, resumed: false, paused: false },
    ]);
    expect(restarted.worker.status()).toMatchObject({ state: 'ready', revision: rotated.revision, configured: true });
    expect(fixture.onChanged).toHaveBeenCalledTimes(3); expect(fixture.modelFetch).not.toHaveBeenCalled();
  });
});
