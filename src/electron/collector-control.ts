import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { apiResultSchema, KeyStatusSchema, SetApiKeyRequestSchema, LocalSourceEvidenceRequestSchema, LocalSourceEvidenceSchema, type ApiResult } from '../shared/contracts';
import { readPrivate, writePrivate, privatePath } from '../remote/private-file';
import type { AsyncEncryption } from './key-store';
import { requests, responses } from './protocol';
import { CaptureSnapshotSchema } from '../shared/capture';

export const COLLECTOR_CONTROL_METHODS = ['wechatCaptureSnapshot', 'wechatCaptureConfigure', 'wechatCaptureConnect', 'wechatCaptureGroups', 'wechatCaptureMessages', 'wechatCaptureBatches', 'wechatCaptureAction', 'wechatCaptureChunks', 'wechatCaptureCleanup', 'captureSnapshot', 'captureConfigure', 'captureConnect', 'captureGroups', 'captureMessages', 'captureBatches', 'captureAction', 'captureChunks', 'captureCleanup', 'captureSetApiKey', 'captureRefreshApiKey', 'localSourceEvidence', 'sourceAttachments', 'sourceAttachmentOpen', 'spaceSnapshot', 'spaceConfigure', 'spaceCleanup'] as const;
export type CollectorControlMethod = typeof COLLECTOR_CONTROL_METHODS[number];
export interface CollectorControlAPI { invoke(method: CollectorControlMethod, input?: unknown): Promise<unknown> }
const methodSchema = z.enum(COLLECTOR_CONTROL_METHODS);
const shutdownResult = apiResultSchema(z.strictObject({ accepted: z.literal(true) }));
const evidenceResponse = apiResultSchema(LocalSourceEvidenceSchema);
const keyResponse = apiResultSchema(KeyStatusSchema);
const captureResponse = apiResultSchema(CaptureSnapshotSchema);
const trayOwnerSchema = z.strictObject({ owner: z.string().uuid(), active: z.boolean() });
type ControlMethod = CollectorControlMethod | '$shutdown' | '$tray-owner';
const requestSchema = z.strictObject({ version: z.literal(1), id: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), method: z.union([methodSchema, z.literal('$shutdown'), z.literal('$tray-owner')]), input: z.unknown().optional() });
const envelopeSchema = z.strictObject({ version: z.literal(1), id: z.string().uuid(), result: z.unknown() });
const descriptorSchema = z.strictObject({ version: z.literal(1), pid: z.number().int().positive(), instance: z.string().uuid(), pipe: z.string(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const helloSchema = z.strictObject({ version: z.literal(1), hello: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const readySchema = z.strictObject({ version: z.literal(1), hello: z.string().regex(/^[A-Za-z0-9_-]{43}$/), proof: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
type Descriptor = z.infer<typeof descriptorSchema>;
interface DescriptorCodec { seal(value: string): Promise<Buffer>; open(value: Buffer): Promise<string> }
const DPAPI_PREFIX = Buffer.from('UC-COLLECTOR-DPAPI-2\n', 'ascii');
/** Fixed PowerShell program. Neither source text nor capabilities are placed in command arguments or environment. */
function windowsDataProtection(value: Buffer, decrypt: boolean): Promise<Buffer> {
  const program = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes('ultimate-calendar/collector-control/v2'); $outputBytes=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($inputBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($outputBytes))`;
  return new Promise((done, reject) => {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', program], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = Buffer.alloc(0), settled = false;
    const finish = (result?: Buffer) => { if (settled) return; settled = true; clearTimeout(timer); result ? done(result) : reject(Error('COLLECTOR_DPAPI_UNAVAILABLE')); };
    const timer = setTimeout(() => { child.kill(); finish(); }, 10_000);
    child.on('error', () => finish()); child.stdin.on('error', () => finish());
    child.stdout.on('data', chunk => { if (output.length + chunk.length > 65_536) { child.kill(); finish(); } else output = Buffer.concat([output, chunk]); });
    child.on('close', code => {
      if (code !== 0) { finish(); return; }
      const encoded = output.toString('ascii').trim();
      if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) { finish(); return; }
      finish(Buffer.from(encoded, 'base64'));
    });
    child.stdin.end(value.toString('base64'));
  });
}
function descriptorCodec(encryption: AsyncEncryption): DescriptorCodec {
  return {
    async seal(value) {
      // Chromium OSCrypt's profile key differs between capture-only and the independent cloud profile.
      if (process.platform === 'win32') return Buffer.concat([DPAPI_PREFIX, await windowsDataProtection(Buffer.from(value, 'utf8'), false)]);
      if (!await encryption.isAsyncEncryptionAvailable()) throw Error('COLLECTOR_ENCRYPTION_UNAVAILABLE');
      return encryption.encryptStringAsync(value);
    },
    async open(value) {
      if (value.subarray(0, DPAPI_PREFIX.length).equals(DPAPI_PREFIX)) {
        if (process.platform !== 'win32') throw Error('COLLECTOR_ENCRYPTION_UNAVAILABLE');
        return (await windowsDataProtection(value.subarray(DPAPI_PREFIX.length), true)).toString('utf8');
      }
      // Legacy descriptors can be recovered by their original collector profile after a normal stop.
      if (!await encryption.isAsyncEncryptionAvailable()) throw Error('COLLECTOR_ENCRYPTION_UNAVAILABLE');
      return (await encryption.decryptStringAsync(value)).result;
    },
  };
}
const MAX_REQUEST = 64 * 1024, MAX_RESPONSE = 64 * 1024 * 1024;
const failure = (code: 'VALIDATION' | 'NETWORK' | 'CONFLICT' | 'STORAGE' | 'AUTH', message: string): ApiResult<never> => ({ ok: false, error: { code, message, retryable: false } });
const unavailable = () => failure('NETWORK', '本机采集服务暂不可用；请确认采集服务已启动后重试');
function inputSchema(method: ControlMethod) { return method === '$tray-owner' ? trayOwnerSchema : method === '$shutdown' || method === 'captureRefreshApiKey' ? z.undefined() : method === 'captureSetApiKey' ? SetApiKeyRequestSchema : method === 'localSourceEvidence' ? LocalSourceEvidenceRequestSchema : requests[method]; }
function outputSchema(method: ControlMethod) { return method === '$shutdown' || method === '$tray-owner' ? shutdownResult : method === 'captureRefreshApiKey' ? captureResponse : method === 'captureSetApiKey' ? keyResponse : method === 'localSourceEvidence' ? evidenceResponse : responses[method]; }
function endpointFile(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) === parse(resolve(directory)).root) throw Error('COLLECTOR_DIRECTORY_INVALID');
  return privatePath(join(directory, 'credentials', 'collector-control.bin'));
}
function pipeName(directory: string, instance: string) { return process.platform === 'win32' ? `\\\\.\\pipe\\ultimate-calendar-collector-${instance}` : join(directory, 'credentials', `collector-${instance}.sock`); }
function validateDescriptor(value: unknown, directory: string) {
  const descriptor = descriptorSchema.parse(value);
  if (descriptor.pipe !== pipeName(directory, descriptor.instance)) throw Error('COLLECTOR_ENDPOINT_INVALID');
  return descriptor;
}
async function decode(bytes: Buffer, directory: string, codec: DescriptorCodec) {
  return validateDescriptor(JSON.parse(await codec.open(bytes)), directory);
}
function sameToken(actual: string, expected: string) { const a = Buffer.from(actual), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }
function proof(token: string, nonce: string) { return createHmac('sha256', token).update('collector-server-ready:' + nonce).digest('base64url'); }
function reachable(pipe: string): Promise<boolean> {
  return new Promise(done => {
    const socket = createConnection(pipe); let settled = false;
    const finish = (active: boolean) => { if (settled) return; settled = true; socket.destroy(); done(active); };
    socket.setTimeout(750, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')));
  });
}

/** A capability-protected local IPC endpoint. No TCP listener, QQ connection, or database is opened here. */
export async function createCollectorControlServer(options: {
  directory: string; api: CollectorControlAPI; encryption: AsyncEncryption;
  onShutdown?: () => void | Promise<void>; timeoutMs?: number;
  onTrayOwner?(request: z.infer<typeof trayOwnerSchema>): void;
  /** Isolated tests only; production uses current-user Windows DPAPI or the platform key store. */
  descriptorCodec?: DescriptorCodec;
}) {
  const directory = resolve(options.directory), file = endpointFile(options.directory), lock = file + '.starting';
  const codec = options.descriptorCodec ?? descriptorCodec(options.encryption);
  const timeout = Math.max(50, Math.min(options.timeoutMs ?? 30_000, 60_000));
  mkdirSync(join(directory, 'credentials'), { recursive: true, mode: 0o700 });
  const lockOwner = JSON.stringify({ pid: process.pid, owner: randomUUID() });
  try { writeFileSync(lock, lockOwner, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw Error('COLLECTOR_START_IN_PROGRESS');
    try {
      const previous = readPrivate(lock, 2048); if (!previous) throw Error();
      const owner = z.strictObject({ pid: z.number().int().positive(), owner: z.string().uuid() }).parse(JSON.parse(previous.toString('utf8')));
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw Error();
      const current = readPrivate(lock, 2048); if (!current?.equals(previous)) throw Error();
      unlinkSync(lock); writeFileSync(lock, lockOwner, { flag: 'wx', mode: 0o600 });
    } catch { throw Error('COLLECTOR_START_IN_PROGRESS'); }
  }
  const instance = randomUUID(), descriptor: Descriptor = { version: 1, pid: process.pid, instance, pipe: pipeName(directory, instance), token: randomBytes(32).toString('base64url') };
  const sockets = new Set<Socket>(), active = new Set<Promise<void>>();
  let closing = false, shutdownRequested = false, closed: Promise<void> | undefined, encrypted: Buffer | undefined;
  const server = createServer(socket => {
    if (closing || sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket); socket.on('error', () => {});
    const deadline = setTimeout(() => socket.destroy(), timeout);
    socket.once('close', () => { clearTimeout(deadline); sockets.delete(socket); });
    socket.setTimeout(timeout, () => socket.destroy());
    let buffer = Buffer.alloc(0), used = false, greeted = false;
    socket.on('data', chunk => {
      if (used || buffer.length + chunk.length > MAX_REQUEST) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]); const newline = buffer.indexOf(10);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) { socket.destroy(); return; }
      if (!greeted) {
        try {
          const hello = helloSchema.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
          greeted = true; buffer = Buffer.alloc(0);
          socket.write(JSON.stringify({ version: 1, hello: hello.hello, proof: proof(descriptor.token, hello.hello) }) + '\n');
        } catch { socket.destroy(); }
        return;
      }
      used = true;
      let request: z.infer<typeof requestSchema>;
      try { request = requestSchema.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8'))); }
      catch { socket.destroy(); return; }
      buffer = Buffer.alloc(0);
      if (!sameToken(request.token, descriptor.token)) { socket.destroy(); return; }
      const checked = inputSchema(request.method).safeParse(request.input);
      let wantsShutdown = false;
      const job = (async () => {
        let result: unknown;
        if (!checked.success) result = failure('VALIDATION', '本机采集请求格式无效');
        else if (closing || active.size >= 8) result = failure('CONFLICT', '本机采集服务正在处理其他请求，请稍后重试');
        else if (request.method === '$shutdown') {
          wantsShutdown = !!options.onShutdown && !shutdownRequested;
          if (wantsShutdown) shutdownRequested = true;
          result = options.onShutdown ? { ok: true, data: { accepted: true } } : failure('VALIDATION', '当前采集服务未开放退出控制');
        } else if (request.method === '$tray-owner') {
          if (options.onTrayOwner) { options.onTrayOwner(trayOwnerSchema.parse(checked.data)); result = { ok: true, data: { accepted: true } }; }
          else result = failure('VALIDATION', '当前采集服务未开放托盘控制');
        } else {
          try { result = await options.api.invoke(request.method, checked.data); }
          catch { result = failure('STORAGE', '本机采集操作未完成，请核对当前状态后重试'); }
        }
        const parsed = outputSchema(request.method).safeParse(result);
        if (!parsed.success) result = failure('STORAGE', '本机采集服务响应无效'); else result = parsed.data;
        let bytes = Buffer.from(JSON.stringify({ version: 1, id: request.id, result }) + '\n');
        if (bytes.length > MAX_RESPONSE) bytes = Buffer.from(JSON.stringify({ version: 1, id: request.id, result: failure('VALIDATION', '本机资料过大，请减少一次读取的记录数量') }) + '\n');
        if (!socket.destroyed) await new Promise<void>(done => { socket.once('close', done); socket.end(bytes, done); });
      })().catch(() => { socket.destroy(); }).finally(() => {
        active.delete(job);
        // The authenticated acknowledgement is completed before quitting can initiate close().
        if (wantsShutdown) setImmediate(() => { void Promise.resolve().then(() => options.onShutdown?.()).catch(() => {}); });
      });
      active.add(job);
    });
  });
  try {
    const previous = readPrivate(file, 16_384);
    if (previous) {
      const old = await decode(previous, directory, codec);
      if (await reachable(old.pipe)) throw Error('COLLECTOR_ALREADY_RUNNING');
      const current = readPrivate(file, 16_384);
      if (!current || !current.equals(previous)) throw Error('COLLECTOR_ENDPOINT_CHANGED');
    }
    encrypted = await codec.seal(JSON.stringify(descriptor));
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(descriptor.pipe, () => { server.off('error', reject); done(); }); });
    server.on('error', () => {});
    writePrivate(file, encrypted);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    throw error instanceof Error && /^COLLECTOR_[A-Z_]+$/.test(error.message) ? error : Error('COLLECTOR_START_FAILED');
  } finally {
    try { const current = readPrivate(lock, 2048); if (current?.toString('utf8') === lockOwner) unlinkSync(lock); } catch { /* Never delete an unreadable or replaced startup lock. */ }
  }
  return {
    close(): Promise<void> {
      if (closed) return closed;
      closing = true;
      closed = (async () => {
        const stopped = new Promise<void>(done => server.close(() => done()));
        await Promise.allSettled([...active]);
        for (const socket of sockets) socket.destroy();
        await stopped;
        try { const current = readPrivate(file, 16_384); if (current && encrypted && current.equals(encrypted)) unlinkSync(file); } catch { /* Never delete a replacement, damaged, or unreadable descriptor. */ }
      })();
      return closed;
    },
  };
}

export function createCollectorControlClient(options: {
  directory: string; encryption: AsyncEncryption; timeoutMs?: number;
  /** Isolated tests only; never configure this from renderer input. */
  descriptorCodec?: DescriptorCodec;
  /** Lifecycle probes are injected only by isolated tests; never issue a termination signal. */
  processAlive?(pid: number): boolean; wait?(milliseconds: number): Promise<void>; now?(): number;
}) {
  const directory = resolve(options.directory), file = endpointFile(options.directory);
  const codec = options.descriptorCodec ?? descriptorCodec(options.encryption);
  let cachedDescriptor: { bytes: Buffer; value: Descriptor } | undefined;
  let lastStopped: Descriptor | undefined;
  const alive = options.processAlive ?? ((pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  });
  async function decodeCurrent(bytes: Buffer) {
    if (cachedDescriptor?.bytes.equals(bytes)) return cachedDescriptor.value;
    const value = await decode(bytes, directory, codec);
    cachedDescriptor = { bytes: Buffer.from(bytes), value }; return value;
  }
  const sockets = new Set<Socket>(); let closed = false;
  const timeout = Math.max(50, Math.min(options.timeoutMs ?? 30_000, 60_000));
  async function call(method: ControlMethod, input?: unknown, expectedInstance?: string, expectedBytes?: Buffer, requestTimeout = timeout): Promise<ApiResult<unknown>> {
    const checked = inputSchema(method).safeParse(input);
    if (!checked.success) return failure('VALIDATION', '本机采集请求格式无效');
    if (closed) return unavailable();
    let descriptor: Descriptor;
    try {
      const bytes = readPrivate(file, 16_384); if (!bytes) return unavailable();
      if (expectedBytes && !bytes.equals(expectedBytes)) return failure('CONFLICT', '本机采集服务身份文件发生变化，未发送退出请求');
      descriptor = await decodeCurrent(bytes);
    }
    catch { return unavailable(); }
    if (expectedInstance && descriptor.instance !== expectedInstance) return failure('CONFLICT', '本机采集服务已更换实例，未向新的服务发送退出请求');
    if (closed) return unavailable();
    const id = randomUUID(), payload = Buffer.from(JSON.stringify({ version: 1, id, token: descriptor.token, method, input: checked.data }) + '\n');
    if (payload.length > MAX_REQUEST) return failure('VALIDATION', '本机采集请求过大');
    return new Promise(done => {
      const socket = createConnection(descriptor.pipe); sockets.add(socket);
      let buffer = Buffer.alloc(0), settled = false, authenticatedServer = false;
      const nonce = randomBytes(32).toString('base64url');
      const deadline = setTimeout(() => finish(unavailable()), requestTimeout);
      const finish = (result: ApiResult<unknown>) => { if (settled) return; settled = true; clearTimeout(deadline); sockets.delete(socket); socket.destroy(); done(result); };
      socket.setTimeout(requestTimeout, () => finish(unavailable()));
      socket.once('error', () => finish(unavailable())); socket.once('close', () => finish(unavailable()));
      // Prove endpoint ownership before sending a capability or a user-supplied QQ token.
      socket.once('connect', () => socket.write(JSON.stringify({ version: 1, hello: nonce }) + '\n'));
      socket.on('data', chunk => {
        if (buffer.length + chunk.length > MAX_RESPONSE) { finish(failure('VALIDATION', '本机采集响应过大')); return; }
        buffer = Buffer.concat([buffer, chunk]); const newline = buffer.indexOf(10); if (newline < 0) return;
        try {
          if (newline !== buffer.length - 1) throw Error();
          if (!authenticatedServer) {
            const ready = readySchema.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
            if (ready.hello !== nonce || !sameToken(ready.proof, proof(descriptor.token, nonce))) throw Error();
            authenticatedServer = true; buffer = Buffer.alloc(0); socket.write(payload); return;
          }
          const envelope = envelopeSchema.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
          if (envelope.id !== id) throw Error();
          const result = outputSchema(method).parse(envelope.result) as ApiResult<unknown>; finish(result);
        } catch { finish(failure('STORAGE', '本机采集服务响应无效')); }
      });
    });
  }
  return {
    invoke(method: CollectorControlMethod, input?: unknown): Promise<ApiResult<unknown>> {
      if (!methodSchema.safeParse(method).success) return Promise.resolve(failure('VALIDATION', '不支持的本机采集操作'));
      return call(method, input);
    },
    /** Main-process maintenance only. Do not expose this method through renderer/preload IPC. */
    invokeControl(method: 'shutdown'): Promise<ApiResult<unknown>> {
      return method === 'shutdown' ? call('$shutdown') : Promise.resolve(failure('VALIDATION', '不支持的本机维护操作'));
    },
    /** Main-process shell ownership only; deliberately excluded from renderer/preload methods. */
    setTrayOwner(owner: string, active: boolean): Promise<ApiResult<unknown>> {
      return call('$tray-owner', { owner, active }, undefined, undefined, 2000);
    },
    /** A missing pipe alone is not proof of exit: it can disappear while the owner drains its work. */
    async processState(): Promise<'running' | 'stopped' | 'unknown'> {
      if (closed) return 'unknown';
      try {
        const stored = readPrivate(file, 16_384);
        const descriptor = stored ? await decodeCurrent(stored) : cachedDescriptor?.value;
        return descriptor ? alive(descriptor.pid) ? 'running' : 'stopped' : 'unknown';
      } catch { return 'unknown'; }
    },
    /** Main-process installer coordination: acknowledgement alone is not proof that the owner released its databases. */
    async shutdownAndWait(timeoutMs = 30_000): Promise<ApiResult<{ stopped: true }>> {
      if (closed) return unavailable();
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return failure('VALIDATION', '退出等待时限无效');
      const now = options.now ?? Date.now, wait = options.wait ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
      const budget = Math.max(50, Math.min(timeoutMs, 60_000)), deadline = now() + budget;
      let expected: Buffer, descriptor: Descriptor;
      try {
        const stored = readPrivate(file, 16_384);
        if (!stored) return lastStopped && !alive(lastStopped.pid) ? { ok: true, data: { stopped: true } } : failure('CONFLICT', '无法确认采集进程身份，未开始安装');
        expected = stored; descriptor = await decodeCurrent(stored);
      } catch { return failure('STORAGE', '无法核验采集进程身份，未开始安装'); }
      const response = await call('$shutdown', undefined, descriptor.instance, expected);
      if (!response.ok) return response;
      while (!closed) {
        try {
          const current = readPrivate(file, 16_384);
          if (current && !current.equals(expected)) return failure('CONFLICT', '等待退出期间采集服务发生变化，未开始安装');
          if (!alive(descriptor.pid) && !current) { lastStopped = descriptor; return { ok: true, data: { stopped: true } }; }
        } catch { return failure('STORAGE', '无法确认采集进程已经退出，未开始安装'); }
        if (now() >= deadline) return failure('CONFLICT', '采集进程尚未完全退出，请等待正在处理的任务结束后重试安装');
        await wait(Math.min(100, Math.max(1, deadline - now())));
      }
      return unavailable();
    },
    close() { closed = true; cachedDescriptor = undefined; lastStopped = undefined; for (const socket of sockets) socket.destroy(); sockets.clear(); },
  };
}
