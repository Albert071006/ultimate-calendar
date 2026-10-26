import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { createCollectorControlClient, createCollectorControlServer, type CollectorControlAPI, type CollectorControlMethod } from './collector-control';
import type { AsyncEncryption } from './key-store';
import { SourceSchema } from '../shared/contracts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
function encryption(): AsyncEncryption {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptStringAsync: async bytes => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'collector-control-'));
  cleanups.push(() => { const delta = relative(tmpdir(), directory); if (!delta || delta.startsWith('..') || isAbsolute(delta)) throw Error('Unsafe synthetic cleanup'); rmSync(directory, { recursive: true, force: true }); });
  const source = SourceSchema.parse({ id: 'synthetic-source', version: 1, createdAt: '2026-01-01T00:00:00+08:00', updatedAt: '2026-01-01T00:00:00+08:00', importedAt: '2026-01-01T00:00:00+08:00', kind: 'text', text: '合成本机依据' });
  const codec = encryption(), invoke = vi.fn(async (method: CollectorControlMethod) => method === 'localSourceEvidence' ? { ok: true, data: { sourceId: 'synthetic-source', match: 'legacy-id', sources: [source] } } : { ok: true, data: [{ id: 'synthetic-group', name: '合成测试群' }] });
  const options = { directory, encryption: codec, descriptorCodec: { seal: codec.encryptStringAsync, open: async (bytes: Buffer) => (await codec.decryptStringAsync(bytes)).result }, api: { invoke } satisfies CollectorControlAPI, timeoutMs: 1000 };
  const file = join(directory, 'credentials', 'collector-control.bin');
  return { options, file, directory, codec, invoke };
}
async function start(f: ReturnType<typeof fixture>, overrides: Partial<Parameters<typeof createCollectorControlServer>[0]> = {}) {
  const server = await createCollectorControlServer({ ...f.options, ...overrides }); cleanups.push(() => server.close());
  const client = createCollectorControlClient(f.options); cleanups.push(() => client.close()); return { server, client };
}
async function raw(pipe: string, content: string) {
  return new Promise<string>(done => {
    const socket = createConnection(pipe), chunks: Buffer[] = []; let settled = false, greeted = false;
    const finish = () => { if (settled) return; settled = true; socket.destroy(); done(Buffer.concat(chunks).toString('utf8')); };
    socket.setTimeout(2000, finish); socket.on('error', finish); socket.on('data', chunk => { if (!greeted) { greeted = true; socket.write(content); } else chunks.push(chunk); }); socket.on('close', finish); socket.on('connect', () => socket.write(JSON.stringify({ version: 1, hello: randomBytes(32).toString('base64url') }) + '\n'));
  });
}

describe('local collector named-pipe control', () => {
  it('routes attachment capabilities using source IDs and rejects caller paths before invoking the host', async () => {
    const f = fixture();
    const listed = { attachments: [{ id: 'synthetic-attachment', name: '合成教程.docx', status: 'available' }], unavailableSources: 0 };
    const invoke = vi.fn(async (method: CollectorControlMethod) => ({ ok: true, data: method === 'sourceAttachments' ? listed : { opened: true } }));
    const { client } = await start(f, { api: { invoke } });
    const sourceIds = ['synthetic-source'];
    expect(await client.invoke('sourceAttachments', { sourceIds })).toEqual({ ok: true, data: listed });
    expect(await client.invoke('sourceAttachmentOpen', { sourceIds, attachmentId: 'synthetic-attachment' })).toEqual({ ok: true, data: { opened: true } });
    for (const input of [{ sourceIds: [] }, { sourceIds: Array(101).fill('synthetic-source') }, { sourceIds, path: 'C:/arbitrary.exe' }]) {
      expect(await client.invoke('sourceAttachments', input)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
    expect(await client.invoke('sourceAttachmentOpen', { sourceIds, attachmentId: 'synthetic-attachment', url: 'https://other.invalid/file' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(invoke).toHaveBeenCalledTimes(2);
    invoke.mockResolvedValueOnce({ ok: true, data: { ...listed, path: 'synthetic-private-path' } } as never);
    const invalid = await client.invoke('sourceAttachments', { sourceIds });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'STORAGE' } });
    expect(JSON.stringify(invalid)).not.toContain('synthetic-private-path');
  });
  it('keeps authenticated tray leases separate from renderer operations', async () => {
    const f = fixture(), onTrayOwner = vi.fn(), { client } = await start(f, { onTrayOwner });
    const owner = randomUUID();
    expect(await client.setTrayOwner(owner, true)).toEqual({ ok: true, data: { accepted: true } });
    expect(onTrayOwner).toHaveBeenLastCalledWith({ owner, active: true });
    expect(await client.setTrayOwner(owner, false)).toMatchObject({ ok: true });
    expect(onTrayOwner).toHaveBeenLastCalledWith({ owner, active: false });
    expect(await client.setTrayOwner('not-an-owner', true)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await client.invoke('$tray-owner' as CollectorControlMethod, { owner, active: true })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(onTrayOwner).toHaveBeenCalledTimes(2); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('validates private key repair requests and never returns credentials to the caller', async () => {
    const f = fixture();
    const invoke = vi.fn(async () => ({ ok: true, data: { configured: true, sessionOnly: false } }));
    const { client } = await start(f, { api: { invoke } });
    const key = 'synthetic-repaired-capture-key';
    expect(await client.invoke('captureSetApiKey', { key })).toEqual({ ok: true, data: { configured: true, sessionOnly: false } });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('captureSetApiKey', { key });
    expect(await client.invoke('captureSetApiKey', { key: 123 })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.file).includes(Buffer.from(key))).toBe(false);
  });
  it('waits for both the original process and descriptor to disappear before allowing installation', async () => {
    const f = fixture(); let ownerAlive = true; let stop: (() => Promise<void>) | undefined;
    const { server } = await start(f, { onShutdown: async () => { await stop?.(); ownerAlive = false; } }); stop = () => server.close();
    const client = createCollectorControlClient({ ...f.options, processAlive: () => ownerAlive }); cleanups.push(() => client.close());
    expect(await client.shutdownAndWait(1000)).toEqual({ ok: true, data: { stopped: true } }); expect(existsSync(f.file)).toBe(false);
    expect(await client.processState()).toBe('stopped');
    expect(await client.shutdownAndWait(1000)).toEqual({ ok: true, data: { stopped: true } });
    ownerAlive = true;
    expect(await client.shutdownAndWait(1000)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });
  it('does not mistake an absent endpoint for a stopped owner or reuse a stop after a replacement appears', async () => {
    const f = fixture(); let ownerAlive = true; let stop: (() => Promise<void>) | undefined;
    const { server } = await start(f, { onShutdown: async () => { await stop?.(); ownerAlive = false; } }); stop = () => server.close();
    const client = createCollectorControlClient({ ...f.options, processAlive: () => ownerAlive }); cleanups.push(() => client.close());
    expect(await client.processState()).toBe('running'); await server.close();
    expect(await client.processState()).toBe('running');
    expect(await client.shutdownAndWait(1000)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const next = await createCollectorControlServer({ ...f.options, onShutdown: async () => { await next.close(); ownerAlive = false; } }); cleanups.push(() => next.close());
    expect(await client.shutdownAndWait(1000)).toMatchObject({ ok: true });
    const replacement = await createCollectorControlServer(f.options); cleanups.push(() => replacement.close());
    ownerAlive = true;
    expect(await client.shutdownAndWait(1000)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await client.processState()).toBe('running');
  });
  it('does not treat endpoint closure or an acknowledgement as proof of process exit', async () => {
    const f = fixture(); let stop: (() => Promise<void>) | undefined;
    const { server } = await start(f, { onShutdown: async () => { await stop?.(); } }); stop = () => server.close();
    const client = createCollectorControlClient({ ...f.options, processAlive: () => true }); cleanups.push(() => client.close());
    expect(await client.shutdownAndWait(50)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } }); expect(existsSync(f.file)).toBe(false);
  });
  it('aborts installation when the descriptor is replaced during shutdown', async () => {
    const f = fixture(); let stop: (() => Promise<void>) | undefined;
    const { server } = await start(f, { onShutdown: async () => { await stop?.(); writeFileSync(f.file, await f.codec.encryptStringAsync('new-instance'), { mode: 0o600 }); } }); stop = () => server.close();
    const client = createCollectorControlClient({ ...f.options, processAlive: () => false }); cleanups.push(() => client.close());
    expect(await client.shutdownAndWait(1000)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } }); expect(existsSync(f.file)).toBe(true);
  });
  it('encrypts the descriptor and returns only validated local operations', async () => {
    const f = fixture(), { client } = await start(f);
    const stored = readFileSync(f.file), descriptor = JSON.parse((await f.codec.decryptStringAsync(stored)).result);
    expect(stored.includes(Buffer.from(descriptor.token))).toBe(false); expect(stored.includes(Buffer.from(descriptor.pipe))).toBe(false);
    if (process.platform === 'win32') expect(descriptor.pipe).toMatch(/^\\\\\.\\pipe\\ultimate-calendar-collector-[0-9a-f-]{36}$/);
    expect(await client.invoke('captureGroups')).toEqual({ ok: true, data: [{ id: 'synthetic-group', name: '合成测试群' }] });
    expect(await client.invoke('localSourceEvidence', { sourceId: 'synthetic-source' })).toMatchObject({ ok: true, data: { sourceId: 'synthetic-source', match: 'legacy-id' } });
    expect(await client.invoke('captureGroups', { illegal: true })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await client.invoke('snapshot' as CollectorControlMethod)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('rejects missing or wrong authentication, unknown methods, multiple frames and oversized requests', async () => {
    const f = fixture(); await start(f); const descriptor = JSON.parse((await f.codec.decryptStringAsync(readFileSync(f.file))).result);
    const valid = { version: 1, id: randomUUID(), token: descriptor.token, method: 'captureGroups' };
    for (const frame of [
      JSON.stringify({ ...valid, token: 'a'.repeat(43) }) + '\n',
      JSON.stringify({ ...valid, token: undefined }) + '\n',
      JSON.stringify({ ...valid, method: 'mutate', input: {} }) + '\n',
      JSON.stringify(valid) + '\n' + JSON.stringify(valid) + '\n',
      'x'.repeat(65_537),
    ]) expect(await raw(descriptor.pipe, frame)).toBe('');
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('does not replace an active endpoint and removes only its own descriptor', async () => {
    const f = fixture(), { server, client } = await start(f), original = readFileSync(f.file);
    await expect(createCollectorControlServer(f.options)).rejects.toThrow('COLLECTOR_ALREADY_RUNNING');
    expect(readFileSync(f.file)).toEqual(original); expect(await client.invoke('captureGroups')).toMatchObject({ ok: true });
    const replacement = await f.codec.encryptStringAsync('synthetic-replacement'); writeFileSync(f.file, replacement);
    await server.close(); expect(readFileSync(f.file)).toEqual(replacement);
  });
  it('recovers a validated stale descriptor without using TCP and survives client reuse after restart', async () => {
    const f = fixture(), { server, client } = await start(f), stale = readFileSync(f.file);
    await server.close(); expect(existsSync(f.file)).toBe(false); writeFileSync(f.file, stale, { mode: 0o600 });
    const next = await createCollectorControlServer(f.options); cleanups.push(() => next.close());
    expect(readFileSync(f.file)).not.toEqual(stale); expect(await client.invoke('captureGroups')).toMatchObject({ ok: true });
  });
  it('recovers only a startup lock whose owner is definitely gone', async () => {
    const f = fixture(); mkdirSync(join(f.directory, 'credentials'));
    const lock = f.file + '.starting', record = JSON.stringify({ pid: 123456789, owner: randomUUID() }); writeFileSync(lock, record, { mode: 0o600 });
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(Error('synthetic gone'), { code: 'ESRCH' }); });
    const { server } = await start(f); expect(existsSync(lock)).toBe(false); await server.close();
    writeFileSync(lock, record, { mode: 0o600 }); probe.mockImplementation(() => { throw Object.assign(Error('synthetic protected'), { code: 'EPERM' }); });
    await expect(createCollectorControlServer(f.options)).rejects.toThrow('COLLECTOR_START_IN_PROGRESS'); expect(readFileSync(lock, 'utf8')).toBe(record);
  });
  it('authenticates the server before sending a user token to a potentially replaced pipe', async () => {
    const f = fixture(), { server, client } = await start(f), stale = readFileSync(f.file), descriptor = JSON.parse((await f.codec.decryptStringAsync(stale)).result);
    await server.close(); writeFileSync(f.file, stale, { mode: 0o600 }); let observed = '';
    const fake = createServer(socket => { socket.on('error', () => {}); socket.on('data', bytes => { observed += bytes.toString('utf8'); const hello = JSON.parse(bytes.toString('utf8')); socket.end(JSON.stringify({ version: 1, hello: hello.hello, proof: 'a'.repeat(43) }) + '\n'); }); });
    await new Promise<void>(done => fake.listen(descriptor.pipe, done)); cleanups.push(() => new Promise<void>(done => fake.close(() => done())));
    expect(await client.invoke('captureConnect', { token: 'SYNTHETIC_QQ_SECRET' })).toMatchObject({ ok: false });
    expect(observed).not.toContain('SYNTHETIC_QQ_SECRET'); expect(observed).not.toContain(descriptor.token);
  });
  it('rejects endpoint tampering and unavailable encryption without calling the API', async () => {
    const f = fixture(), { client } = await start(f);
    const descriptor = JSON.parse((await f.codec.decryptStringAsync(readFileSync(f.file))).result); descriptor.pipe = '127.0.0.1:43131';
    writeFileSync(f.file, await f.codec.encryptStringAsync(JSON.stringify(descriptor)));
    expect(await client.invoke('captureGroups')).toMatchObject({ ok: false }); expect(f.invoke).not.toHaveBeenCalled();
    const inaccessible = createCollectorControlClient({ ...f.options, descriptorCodec: { ...f.options.descriptorCodec, open: async () => { throw Error('synthetic unavailable'); } } }); cleanups.push(() => inaccessible.close());
    expect(await inaccessible.invoke('captureGroups')).toMatchObject({ ok: false });
    const missing = fixture(); await expect(createCollectorControlServer({ ...missing.options, descriptorCodec: { ...missing.options.descriptorCodec, seal: async () => { throw Error('COLLECTOR_ENCRYPTION_UNAVAILABLE'); } } })).rejects.toThrow('COLLECTOR_ENCRYPTION_UNAVAILABLE');
    expect(existsSync(missing.file)).toBe(false);
  });
  it('caches decoded capabilities only while the exact descriptor bytes are unchanged', async () => {
    const f = fixture(); const open = vi.fn(f.options.descriptorCodec.open);
    const { server } = await start(f);
    const client = createCollectorControlClient({ ...f.options, descriptorCodec: { ...f.options.descriptorCodec, open } }); cleanups.push(() => client.close());
    expect(await client.invoke('captureGroups')).toMatchObject({ ok: true });
    expect(await client.invoke('captureGroups')).toMatchObject({ ok: true }); expect(open).toHaveBeenCalledTimes(1);
    await server.close(); const next = await createCollectorControlServer(f.options); cleanups.push(() => next.close());
    expect(await client.invoke('captureGroups')).toMatchObject({ ok: true }); expect(open).toHaveBeenCalledTimes(2);
  });
  it('returns fixed errors for exceptions or invalid results and never retries a timed-out operation', async () => {
    const f = fixture(); let release: (() => void) | undefined;
    f.invoke.mockRejectedValueOnce(Error('SYNTHETIC_PRIVATE_EXCEPTION'));
    const { client } = await start(f);
    expect(JSON.stringify(await client.invoke('captureGroups'))).not.toContain('SYNTHETIC_PRIVATE_EXCEPTION');
    f.invoke.mockResolvedValueOnce({ ok: true, data: 'SYNTHETIC_PRIVATE_RESULT' } as never);
    expect(await client.invoke('captureGroups')).toMatchObject({ ok: false, error: { code: 'STORAGE' } });
    f.invoke.mockImplementationOnce(async () => { await new Promise<void>(done => { release = done; }); return { ok: true, data: [] }; });
    const brief = createCollectorControlClient({ ...f.options, timeoutMs: 50 }); cleanups.push(() => brief.close());
    expect(await brief.invoke('captureGroups')).toMatchObject({ ok: false, error: { code: 'NETWORK' } });
    expect(f.invoke).toHaveBeenCalledTimes(3); release?.();
  });
  it('drains an active operation before close resolves and closes client sockets without retry', async () => {
    const f = fixture(); let release: (() => void) | undefined, entered: (() => void) | undefined;
    const began = new Promise<void>(done => { entered = done; });
    f.invoke.mockImplementationOnce(async () => { entered?.(); await new Promise<void>(done => { release = done; }); return { ok: true, data: [] }; });
    const { server, client } = await start(f); const request = client.invoke('captureGroups'); await began;
    let finished = false; const closing = server.close().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false); client.close(); expect(await request).toMatchObject({ ok: false });
    release?.(); await closing; expect(existsSync(f.file)).toBe(false); expect(f.invoke).toHaveBeenCalledOnce();
  });
  it('allows authenticated main-process shutdown only after acknowledging it', async () => {
    const f = fixture(); let stop: (() => Promise<void>) | undefined; let shutdown: (() => void) | undefined;
    const stopped = new Promise<void>(done => { shutdown = done; });
    const { server, client } = await start(f, { onShutdown: async () => { await stop?.(); shutdown?.(); } }); stop = () => server.close();
    expect(await client.invoke('$shutdown' as CollectorControlMethod)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(await client.invokeControl('shutdown')).toEqual({ ok: true, data: { accepted: true } });
    await stopped; expect(existsSync(f.file)).toBe(false); expect(f.invoke).not.toHaveBeenCalled();
  });
});
