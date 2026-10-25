import { afterEach, describe, expect, it, vi } from 'vitest';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AiKeySyncPlaintextSchema, AiKeySyncResponseSchema, aiKeySyncAad, type AiKeySyncResponse } from '../shared/ai-key-sync';
import type { AiConfigurationStatus } from '../shared/ai-configuration';
import { RemoteSessionSchema } from '../shared/remote';
import { writePrivate } from '../remote/private-file';
import { createManagedApiKeyConfiguration, type ApiKeyConfiguration } from './ai-configuration';
import { AiKeyReceiverConfigurationSchema, aiKeyReceiverPublicKey, type AiKeyReceiver } from './ai-key-receiver';
import { createRemoteHttpServer } from './http';
import { createRemoteService } from './service';
import { RemoteState } from './state';

const origin = 'http://localhost:3210', endpoint = '/api/v1/ai/receiver/sync';
const keyA = 'sk-fictional-key-sync-first-aaaaaaaa', keyB = 'sk-fictional-key-sync-second-bbbbbbbb';
const keyPair = generateKeyPairSync('rsa', { modulusLength: 3072 });
const wrongPair = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKeySpki = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = aiKeyReceiverPublicKey(publicKeySpki).keyId;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(options: { directory?: string; external?: boolean; configuration?: ApiKeyConfiguration; now?: () => number } = {}) {
  const folder = options.directory ?? mkdtempSync(join(tmpdir(), 'planner-ai-receiver-'));
  if (!options.directory) cleanup.push(async () => {
    if (!resolve(folder).startsWith(resolve(join(tmpdir(), 'planner-ai-receiver-')))) throw Error('Unexpected fixture path');
    rmSync(folder, { recursive: true, force: true });
  });
  const credentials = createManagedApiKeyConfiguration(join(folder, 'ai-credentials.json'));
  const receiverFile = join(folder, 'ai-key-receivers.json');
  const state = options.now ? new RemoteState(join(folder, 'remote-state.sqlite'), options.now) : undefined;
  const transport = vi.fn(async () => { throw Error('No real model requests in receiver tests'); });
  const service = createRemoteService({
    dataDirectory: folder, backupDirectory: join(folder, 'safe-exports'), state,
    apiKeyConfiguration: options.external ? undefined : options.configuration ?? credentials,
    getApiKey: async () => keyA, controller: { fetch: transport },
  });
  const http = createRemoteHttpServer({ service, origin, secureCookie: false });
  const port = await http.listen(0);
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await http.close(); await service.close(); state?.close(); };
  cleanup.push(close);
  const call = (path: string, init: RequestInit = {}): Promise<Response> => new Promise((done, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method: init.method, headers: {
      Host: 'localhost:3210', ...(typeof init.body === 'string' ? { 'Content-Length': String(Buffer.byteLength(init.body)) } : {}), ...init.headers as Record<string, string>,
    } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => {
        const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        done(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on('error', reject); if (init.body) request.write(init.body); request.end();
  });
  const pair = async () => {
    const response = await call('/api/v1/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: service.state.createPairingCode(), name: '虚构密钥接收设备' }) });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const session = RemoteSessionSchema.parse(await response.json());
    if (!session.paired) throw Error('Fixture pairing failed');
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken };
    const input = () => ({ identity: session.identity, keyId, nonce: randomBytes(32).toString('base64url') });
    return { session, cookie, headers, input };
  };
  const bind = (deviceId: string, overrides: Partial<AiKeyReceiver> = {}) => {
    const value = { version: 1 as const, receivers: [{ deviceId, publicKeySpki, keyId, revoked: false, ...overrides }] };
    writePrivate(receiverFile, JSON.stringify(AiKeyReceiverConfigurationSchema.parse(value))); return value;
  };
  return { folder, credentials, service, receiverFile, transport, call, pair, bind, close };
}

function decrypt(response: AiKeySyncResponse, privateKey: KeyObject = keyPair.privateKey) {
  const envelope = response.envelope;
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrappedKey, 'base64url'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(Buffer.from(aiKeySyncAad(response.identity, envelope), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
    return AiKeySyncPlaintextSchema.parse(JSON.parse(plaintext.toString('utf8')));
  } finally { key.fill(0); }
}

describe('locally authorized encrypted AI key receivers', () => {
  it('requires pairing, exact origin, CSRF, explicit device binding and POST', async () => {
    const fixture = await setup(); const { call } = fixture;
    expect((await call(endpoint)).status).toBe(401);
    expect((await call(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    const device = await fixture.pair(), body = JSON.stringify(device.input());
    expect((await call(endpoint, { method: 'POST', headers: device.headers, body })).status).toBe(403);
    fixture.bind(device.session.device.id);
    for (const headers of [
      { ...device.headers, 'x-csrf-token': '' }, { ...device.headers, Origin: '' },
      { ...device.headers, Origin: 'https://untrusted.example' }, { ...device.headers, Host: 'untrusted.example' },
      { ...device.headers, 'Sec-Fetch-Site': 'cross-site' },
    ]) expect((await call(endpoint, { method: 'POST', headers, body })).status).toBe(403);
    const get = await call(endpoint, { headers: device.headers });
    expect(get.status).toBe(405); expect(get.headers.get('allow')).toBe('POST');
    const other = await fixture.pair();
    expect((await call(endpoint, { method: 'POST', headers: other.headers, body: JSON.stringify(other.input()) })).status).toBe(403);
    expect((await call('/api/v1/ai/receiver/register', { method: 'POST', headers: device.headers, body })).status).toBe(404);
    const response = await call(endpoint, { method: 'POST', headers: device.headers, body });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(decrypt(AiKeySyncResponseSchema.parse(await response.json()))).toEqual({ apiKey: null, revision: null });
    expect(fixture.transport).not.toHaveBeenCalled();
  });

  it('sends current key changes and clear tombstones across restart without plaintext in responses or business storage', async () => {
    const fixture = await setup(), device = await fixture.pair(); fixture.bind(device.session.device.id);
    const outputs: string[] = [], events: unknown[] = [];
    fixture.service.subscribe(event => events.push(event));
    let revision: string | null = null;
    for (const apiKey of [keyA, keyB, null]) {
      const change: { configuration: AiConfigurationStatus } = apiKey === null
        ? await fixture.service.clearAiConfiguration({ identity: device.session.identity, expectedRevision: revision })
        : await fixture.service.setAiConfiguration({ identity: device.session.identity, expectedRevision: revision, apiKey });
      expect(change.configuration.revision).not.toBe(revision); revision = change.configuration.revision;
      const input = device.input();
      const response = await fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(input) });
      expect(response.status).toBe(200);
      const text = await response.text(); outputs.push(text);
      const encrypted = AiKeySyncResponseSchema.parse(JSON.parse(text));
      expect(encrypted.envelope).toMatchObject({ deviceId: device.session.device.id, keyId, nonce: input.nonce, revision });
      expect(decrypt(encrypted)).toEqual({ apiKey, revision });
      const repeated = AiKeySyncResponseSchema.parse(await (await fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(input) })).json());
      expect(repeated.envelope.ciphertext).not.toBe(encrypted.envelope.ciphertext);
      expect(decrypt(repeated)).toEqual({ apiKey, revision });
    }
    outputs.push(JSON.stringify(events), JSON.stringify(fixture.service.snapshot()));
    outputs.push(await (await fixture.call('/api/v1/ai/config', { headers: device.headers })).text());
    outputs.push(await (await fixture.call('/api/v1/operations/key-sync', { headers: device.headers })).text());
    fixture.service.backup(); await fixture.close();
    const restarted = await setup({ directory: fixture.folder });
    const response = await restarted.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(device.input()) });
    expect(response.status).toBe(200);
    expect(decrypt(AiKeySyncResponseSchema.parse(await response.json()))).toEqual({ apiKey: null, revision });
    await restarted.close();
    const walk = (folder: string): string[] => readdirSync(folder).flatMap(name => { const file = join(folder, name); return statSync(file).isDirectory() ? walk(file) : [file]; });
    for (const file of walk(fixture.folder)) for (const key of [keyA, keyB]) expect(readFileSync(file).includes(Buffer.from(key))).toBe(false);
    for (const output of outputs) for (const key of [keyA, keyB]) expect(output).not.toContain(key);
    expect(events).toEqual([{ reason: 'key' }, { reason: 'key' }, { reason: 'key' }]);
  });

  it('binds encryption to identity, device, public key, revision and challenge, and rejects the wrong private key', async () => {
    const fixture = await setup(), device = await fixture.pair(); fixture.bind(device.session.device.id);
    const status = await fixture.credentials.set(null, keyA);
    const response = AiKeySyncResponseSchema.parse(await (await fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(device.input()) })).json());
    expect(decrypt(response)).toEqual({ apiKey: keyA, revision: status.revision });
    expect(() => decrypt(response, wrongPair.privateKey)).toThrow();
    for (const altered of [
      { ...response, identity: { ...response.identity, generation: response.identity.generation + 1 } },
      ...[
        { deviceId: randomUUID() }, { keyId: '0'.repeat(64) }, { nonce: randomBytes(32).toString('base64url') },
        { revision: randomUUID() }, { version: 2 },
      ].map(value => ({ ...response, envelope: { ...response.envelope, ...value } })),
    ]) expect(() => decrypt(altered as AiKeySyncResponse)).toThrow();
  });

  it('preserves the accepted managed key and receiver binding when the service restarts', async () => {
    const fixture = await setup(), device = await fixture.pair(); fixture.bind(device.session.device.id);
    const saved = await fixture.credentials.set(null, keyA);
    await fixture.close();
    const restarted = await setup({ directory: fixture.folder });
    const response = await restarted.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(device.input()) });
    expect(response.status).toBe(200);
    expect(decrypt(AiKeySyncResponseSchema.parse(await response.json()))).toEqual({ apiKey: keyA, revision: saved.revision });
  });

  it('rejects malformed challenges, altered key bindings, oversized bodies and stale identities', async () => {
    const fixture = await setup(), device = await fixture.pair(); fixture.bind(device.session.device.id);
    const initial = device.input();
    for (const [input, status] of [
      [{ ...initial, nonce: 'x'.repeat(43) }, 400], [{ ...initial, nonce: `${initial.nonce}=` }, 400],
      [{ ...initial, nonce: randomBytes(31).toString('base64url') }, 400], [{ ...initial, keyId: '0'.repeat(64) }, 403],
      [{ ...initial, publicKeySpki }, 400], [{ ...initial, identity: { ...initial.identity, dataInstanceId: randomUUID() } }, 409],
      [{ ...initial, nonce: 'x'.repeat(33 * 1024) }, 413],
    ] as const) {
      const response = await fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(input) });
      expect(response.status).toBe(status); expect(await response.text()).not.toContain(keyA);
    }
    fixture.service.state.advanceGeneration();
    expect((await fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(initial) })).status).toBe(409);
  });

  it('honors local receiver revocation, expiry and pairing revocation immediately', async () => {
    const fixture = await setup(), device = await fixture.pair();
    const sync = () => fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(device.input()) });
    fixture.bind(device.session.device.id, { revoked: true }); expect((await sync()).status).toBe(403);
    fixture.bind(device.session.device.id, { expiresAt: '2000-01-01T00:00:00.000Z' }); expect((await sync()).status).toBe(403);
    fixture.bind(device.session.device.id, { expiresAt: null }); expect((await sync()).status).toBe(200);
    fixture.service.state.revoke(device.session.device.id); expect((await sync()).status).toBe(401);
  });

  it('rejects expired paired sessions even while a long-lived receiver binding remains', async () => {
    let now = Date.now(); const fixture = await setup({ now: () => now }), device = await fixture.pair();
    fixture.bind(device.session.device.id);
    now += 31 * 86400_000;
    expect((await fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(device.input()) })).status).toBe(401);
  });

  it('fails closed on broken, duplicate, mismatched or hard-linked authorization files', async () => {
    const fixture = await setup(), device = await fixture.pair();
    const config = fixture.bind(device.session.device.id);
    const sync = () => fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(device.input()) });
    for (const contents of [
      'broken-json', JSON.stringify({ ...config, unexpected: true }),
      JSON.stringify({ ...config, receivers: [config.receivers[0], { ...config.receivers[0], deviceId: randomUUID() }] }),
      JSON.stringify({ ...config, receivers: [{ ...config.receivers[0], keyId: '0'.repeat(64) }] }),
      JSON.stringify({ ...config, receivers: [{ ...config.receivers[0], publicKeySpki: 'invalid-key' }] }),
    ]) {
      writePrivate(fixture.receiverFile, contents); expect((await sync()).status).toBe(503);
    }
    fixture.bind(device.session.device.id); linkSync(fixture.receiverFile, join(fixture.folder, 'linked.json'));
    expect((await sync()).status).toBe(503);
  });

  it.skipIf(process.platform === 'win32')('rejects broad file permissions and dangling symlinks', async () => {
    const fixture = await setup(), device = await fixture.pair(); fixture.bind(device.session.device.id);
    const sync = () => fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(device.input()) });
    chmodSync(fixture.receiverFile, 0o644); expect((await sync()).status).toBe(503);
    rmSync(fixture.receiverFile); symlinkSync(join(fixture.folder, 'missing.json'), fixture.receiverFile);
    expect((await sync()).status).toBe(503);
  });

  it('rejects external credentials and refuses requests while draining', async () => {
    const fixture = await setup({ external: true }), device = await fixture.pair(); fixture.bind(device.session.device.id);
    const response = await fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(device.input()) });
    expect(response.status).toBe(403); expect(await response.text()).not.toContain(keyA);
    fixture.service.beginShutdown();
    expect((await fixture.call(endpoint, { method: 'POST', headers: device.headers, body: JSON.stringify(device.input()) })).status).toBe(503);
  });

  it('rechecks receiver and session revocation after awaiting the atomic key snapshot', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const readForReceiver = vi.fn(async () => { await pending; return { apiKey: keyA, revision: randomUUID() }; });
    const configuration: ApiKeyConfiguration = { getApiKey: async () => null, readForReceiver,
      status: vi.fn(), set: vi.fn(), clear: vi.fn() };
    const fixture = await setup({ configuration }), device = await fixture.pair(); fixture.bind(device.session.device.id);
    const response = fixture.service.syncAiKeyReceiver(device.input(), device.session.device.id);
    expect(readForReceiver).toHaveBeenCalledOnce();
    fixture.bind(device.session.device.id, { revoked: true }); release();
    await expect(response).rejects.toMatchObject({ status: 403 });
    fixture.bind(device.session.device.id);
    const second = fixture.service.syncAiKeyReceiver(device.input(), device.session.device.id);
    fixture.service.state.revoke(device.session.device.id);
    await expect(second).rejects.toMatchObject({ status: 401 });
  });
});
