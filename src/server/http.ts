import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { resolve, relative, extname, isAbsolute, sep } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { PairRequestSchema, RemoteMethodSchema, RemoteRequestSchema, RemoteSessionSchema, type RemoteDevice } from '../shared/remote';
import type { RemoteService } from './service';
import { RemoteFault } from './state';
import { DistilledRequestSchema } from '../shared/distilled';
import { MAX_CLOUD_EXPORT_WIRE_BYTES } from '../shared/cloud-management';
import { MAX_AI_KEY_SYNC_BYTES } from '../shared/ai-key-sync';

export interface RemoteHttpContext { device: RemoteDevice; csrfToken: string }
export interface RemoteHttpOptions {
  service: RemoteService;
  /** Exact externally visible origin, including HTTPS proxy host and optional port. */
  origin: string;
  /** Optional explicitly approved public hostname; the primary origin stays private. */
  publicOrigin?: string;
  /** Trust a single X-Forwarded-For address only from a loopback proxy which overwrites that header. */
  trustLoopbackProxy?: boolean;
  secureCookie?: boolean;
  staticDirectory?: string;
  maxBodyBytes?: number;
  limits?: { requests?: number; requestsPerDevice?: number; eventStreams?: number; eventStreamsPerDevice?: number };
  publicRateLimits?: { windowMs?: number; requestsPerIp?: number; unauthenticatedPerIp?: number; pairingPerIp?: number; pairingGlobal?: number; maxClients?: number };
  now?(): number;
  onRevokeDevice?(id: string): void | Promise<void>;
  extension?(request: IncomingMessage, response: ServerResponse, context: RemoteHttpContext): Promise<boolean>;
}
export function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new RemoteFault(415, '请求必须使用 application/json');
  if (Number(request.headers['content-length']) > limit) throw new RemoteFault(413, '请求内容过大');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > limit) throw new RemoteFault(413, '请求内容过大'); chunks.push(buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RemoteFault(400, '请求 JSON 无效'); }
}
function normalizedIp(value: string): string | null {
  if (!isIP(value) || value.includes('%')) return null;
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (mapped) { const a = parseInt(mapped[1]!, 16), b = parseInt(mapped[2]!, 16); return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  return canonical;
}
function clientIp(request: IncomingMessage, trustLoopbackProxy: boolean): string {
  const socketIp = normalizedIp(request.socket.remoteAddress ?? '') ?? 'unknown';
  if (!trustLoopbackProxy || !['127.0.0.1', '::1'].includes(socketIp)) return socketIp;
  const header = request.headers['x-forwarded-for'];
  if (header === undefined) return socketIp;
  const forwarded = typeof header === 'string' ? normalizedIp(header.trim()) : null;
  if (!forwarded) throw new RemoteFault(400, '代理客户端地址无效');
  return forwarded;
}
const privatePublicPaths = ['/healthz', '/readyz', '/api/v1/status', '/api/v1/distilled', '/api/v1/ai/receiver/sync'];
export function createRemoteHttpServer(options: RemoteHttpOptions) {
  const limits = { requests: 16, requestsPerDevice: 4, eventStreams: 16, eventStreamsPerDevice: 2, ...options.limits };
  if (!Object.values(limits).every(value => Number.isInteger(value) && value > 0 && value <= 1024)) throw Error('HTTP资源上限必须为1–1024');
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || origin.username || origin.password || origin.hash || origin.search) throw Error('origin 必须是完整且不带路径的来源');
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(localhost && origin.protocol === 'http:')) throw Error('非本机服务必须使用显式 HTTPS origin');
  const secure = options.secureCookie ?? origin.protocol === 'https:';
  if (!secure && !localhost) throw Error('只有本机开发允许非 Secure Cookie');
  const publicOrigin = options.publicOrigin === undefined ? undefined : new URL(options.publicOrigin);
  if (publicOrigin && (publicOrigin.origin !== options.publicOrigin || publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password
    || publicOrigin.hash || publicOrigin.search || publicOrigin.hostname.includes('*') || publicOrigin.host === origin.host || !secure || origin.protocol !== 'https:')) {
    throw Error('publicOrigin 必须是独立、完整的 HTTPS 来源，且主入口必须使用 HTTPS 和 Secure Cookie');
  }
  if (options.trustLoopbackProxy && !publicOrigin) throw Error('受信本机代理仅适用于明确配置的公网入口');
  const rates = { windowMs: 60_000, requestsPerIp: 240, unauthenticatedPerIp: 60, pairingPerIp: 5, pairingGlobal: 30, maxClients: 4096, ...options.publicRateLimits };
  if (!Object.values(rates).every(value => Number.isSafeInteger(value) && value > 0)
    || rates.windowMs > 3600_000 || rates.maxClients > 65_536 || rates.requestsPerIp > 100_000 || rates.unauthenticatedPerIp > 100_000 || rates.pairingPerIp > 1000 || rates.pairingGlobal > 10_000) throw Error('公网频率限制无效');
  const clock = options.now ?? Date.now;
  type RateBucket = { until: number; requests: number; unauthenticated: number; pairing: number };
  const clients = new Map<string, RateBucket>();
  let globalPairing = { until: 0, count: 0 };
  const refuseRate = (response: ServerResponse, until: number): never => {
    response.setHeader('Retry-After', String(Math.max(1, Math.ceil((until - clock()) / 1000))));
    throw new RemoteFault(429, '请求过于频繁，请稍后重试');
  };
  const rateBucket = (request: IncomingMessage, response: ServerResponse): RateBucket => {
    const now = clock(), address = clientIp(request, options.trustLoopbackProxy === true);
    for (const [key, bucket] of clients) if (bucket.until <= now) clients.delete(key);
    let bucket = clients.get(address);
    if (!bucket) {
      if (clients.size >= rates.maxClients) refuseRate(response, now + rates.windowMs);
      bucket = { until: now + rates.windowMs, requests: 0, unauthenticated: 0, pairing: 0 }; clients.set(address, bucket);
    }
    if (++bucket.requests > rates.requestsPerIp) refuseRate(response, bucket.until);
    return bucket;
  };
  if (options.staticDirectory) {
    const data = realpathSync(options.service.dataDirectory), assets = realpathSync(options.staticDirectory);
    const nested = (parent: string, child: string) => { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
    if (nested(data, assets) || nested(assets, data)) throw Error('网页静态目录必须与私有资料目录分开');
    if (!statSync(assets).isDirectory() || !statSync(resolve(assets, 'index.html')).isFile()) throw Error('网页静态目录缺少index.html，请先完成手机网页构建');
  }
  const cookieName = secure ? '__Host-planner_session' : 'planner_dev_session';
  const cookie = (token: string, maxAge = 30 * 86400) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const streams = new Map<ServerResponse, { deviceId: string; timer: ReturnType<typeof setInterval>; token: string }>();
  let sequence = 0, active = 0, closing = false, closePromise: Promise<void> | undefined;
  const deviceRequests = new Map<string, number>();
  const sendEvent = (response: ServerResponse, value: string) => { if (!response.write(value)) response.destroy(); };
  const unsubscribe = options.service.subscribe(event => {
    sequence++;
    for (const [response, stream] of streams) {
      if (!options.service.state.session(stream.token)) { response.end(); continue; }
      sendEvent(response, `id: ${sequence}\nevent: changed\ndata: ${JSON.stringify({ ...event, identity: options.service.state.identity() })}\n\n`);
    }
  });
  const server = createServer((request, response) => { void handle(request, response); });
  server.headersTimeout = 15_000; server.requestTimeout = 60_000;
  server.maxRequestsPerSocket = 100; server.maxConnections = 64; server.keepAliveTimeout = 5_000;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    let deviceId: string | undefined, counted = false, released = false, credentialRequest = false;
    const release = () => { if (released) return; released = true; if (counted) active--; if (deviceId) { const count = (deviceRequests.get(deviceId) ?? 1) - 1; if (count) deviceRequests.set(deviceId, count); else deviceRequests.delete(deviceId); } };
    response.once('finish', release); response.once('close', release);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const incomingOrigin = request.headers.host === origin.host ? origin : publicOrigin && request.headers.host === publicOrigin.host ? publicOrigin : undefined;
      if (!incomingOrigin) throw new RemoteFault(403, '服务地址不匹配');
      if (request.headers.origin && request.headers.origin !== incomingOrigin.origin) throw new RemoteFault(403, '请求来源不匹配');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new RemoteFault(403, '不接受跨站请求');
      const method = request.method ?? 'GET', url = new URL(request.url ?? '/', incomingOrigin);
      const publicRequest = incomingOrigin === publicOrigin;
      const bucket = publicRequest ? rateBucket(request, response) : undefined;
      credentialRequest = url.pathname === '/api/v1/ai/config' || url.pathname === '/api/v1/ai/receiver/sync';
      if (publicRequest && privatePublicPaths.some(path => url.pathname === path || url.pathname.startsWith(`${path}/`))) throw new RemoteFault(404, '资源不存在');
      if (url.pathname === '/healthz' && method === 'GET') { sendJson(response, 200, { status: 'ok' }); return; }
      if (url.pathname === '/readyz' && method === 'GET') { const status = options.service.readiness(); sendJson(response, status.ready && !closing ? 200 : 503, status); return; }
      if (closing) throw new RemoteFault(503, '服务正在退出，请稍后重试原请求');
      if (active >= limits.requests) throw new RemoteFault(429, '服务请求过多，请稍后重试');
      active++; counted = true;
      const write = !['GET', 'HEAD'].includes(method);
      if (write && request.headers.origin !== incomingOrigin.origin) throw new RemoteFault(403, '写操作必须提供可信来源');
      const token = (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const session = options.service.state.session(token);
      if (bucket && !session && ++bucket.unauthenticated > rates.unauthenticatedPerIp) refuseRate(response, bucket.until);
      if (url.pathname === '/api/v1/session' && method === 'GET') {
        const data = session ? { paired: true, identity: options.service.state.identity(), device: session.device, csrfToken: session.csrfToken, aiConfigured: await options.service.aiConfigured() } : { paired: false };
        sendJson(response, 200, RemoteSessionSchema.parse(data)); return;
      }
      if (url.pathname === '/api/v1/pair' && method === 'POST') {
        if (bucket) {
          if (++bucket.pairing > rates.pairingPerIp) refuseRate(response, bucket.until);
          const now = clock(); if (globalPairing.until <= now) globalPairing = { until: now + rates.windowMs, count: 0 };
          if (++globalPairing.count > rates.pairingGlobal) refuseRate(response, globalPairing.until);
        }
        const input = PairRequestSchema.parse(await body(request, 1024));
        const result = options.service.state.pair(input.code, input.name, { countAttempt: !publicRequest });
        response.setHeader('Set-Cookie', cookie(result.token));
        sendJson(response, 200, RemoteSessionSchema.parse({ paired: true, identity: options.service.state.identity(), device: result.device, csrfToken: result.csrfToken, aiConfigured: await options.service.aiConfigured() })); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!session) throw new RemoteFault(401, '请先配对此设备');
        const count = deviceRequests.get(session.device.id) ?? 0;
        if (count >= limits.requestsPerDevice) throw new RemoteFault(429, '此设备请求过多，请稍后重试');
        deviceId = session.device.id; deviceRequests.set(deviceId, count + 1);
        if (write && request.headers['x-csrf-token'] !== session.csrfToken) throw new RemoteFault(403, '请求保护凭据无效，请重新读取会话');
        if (url.pathname === '/api/v1/session/renew') {
          if (method !== 'POST') { response.setHeader('Allow', 'POST'); throw new RemoteFault(405, '此接口只接受 POST'); }
          if (request.headers['content-length'] && request.headers['content-length'] !== '0' || request.headers['transfer-encoding']) throw new RemoteFault(400, '会话续期不接受请求内容');
          const renewed = options.service.state.renewSession(token);
          if (!renewed) throw new RemoteFault(401, '设备授权已失效，请重新配对');
          const payload = RemoteSessionSchema.parse({ paired: true, identity: options.service.state.identity(), device: renewed.device, csrfToken: renewed.csrfToken, aiConfigured: await options.service.aiConfigured() });
          // Re-send the actual remaining lifetime even when a prior renewal committed but its response was lost.
          // Do not grant a fresh 30-day cookie when the database expiry was not extended.
          const remaining = Math.min(30 * 86400, Math.floor((Date.parse(renewed.expiresAt) - clock()) / 1000));
          if (!Number.isFinite(remaining) || remaining <= 0 || !options.service.state.session(token)) throw new RemoteFault(401, '设备授权已失效，请重新配对');
          response.setHeader('Set-Cookie', cookie(token!, remaining));
          sendJson(response, 200, payload); return;
        }
        if (url.pathname === '/api/v1/ai/receiver/sync') {
          if (method === 'POST') { sendJson(response, 200, await options.service.syncAiKeyReceiver(await body(request, MAX_AI_KEY_SYNC_BYTES), session.device.id)); return; }
          response.setHeader('Allow', 'POST');
          throw new RemoteFault(405, '此接口只接受 POST');
        }
        if (url.pathname === '/api/v1/ai/config') {
          if (method === 'GET') { sendJson(response, 200, await options.service.aiConfigurationStatus()); return; }
          if (method === 'PUT') { sendJson(response, 200, await options.service.setAiConfiguration(await body(request, 4096))); return; }
          if (method === 'DELETE') { sendJson(response, 200, await options.service.clearAiConfiguration(await body(request, 4096))); return; }
          response.setHeader('Allow', 'GET, PUT, DELETE');
          throw new RemoteFault(405, '此接口只接受 GET、PUT 或 DELETE');
        }
        if (url.pathname === '/api/v1/status' && method === 'GET') { sendJson(response, 200, options.service.status()); return; }
        if (url.pathname === '/api/v1/logout' && method === 'POST') {
          options.service.state.revoke(session.device.id); await options.onRevokeDevice?.(session.device.id);
          response.setHeader('Set-Cookie', cookie('', 0)); sendJson(response, 200, { ok: true }); return;
        }
        if (url.pathname === '/api/v1/devices' && method === 'GET') { sendJson(response, 200, { devices: options.service.state.devices() }); return; }
        const deviceMatch = /^\/api\/v1\/devices\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (deviceMatch && method === 'DELETE') {
          const id = z.string().uuid().parse(deviceMatch[1]); options.service.state.revoke(id); await options.onRevokeDevice?.(id);
          for (const [stream, details] of streams) if (details.deviceId === id) stream.end();
          sendJson(response, 200, { ok: true }); return;
        }
        if (url.pathname === '/api/v1/events' && method === 'GET') {
          if (streams.size >= limits.eventStreams || [...streams.values()].filter(value => value.deviceId === session.device.id).length >= limits.eventStreamsPerDevice) throw new RemoteFault(429, '变更连接过多，请关闭多余页面后重试');
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.write(`event: ready\ndata: ${JSON.stringify({ identity: options.service.state.identity(), sequence })}\n\n`);
          const timer = setInterval(() => { if (!options.service.state.session(token)) response.end(); else sendEvent(response, ': heartbeat\n\n'); }, 20_000);
          timer.unref(); streams.set(response, { deviceId: session.device.id, timer, token: token! });
          response.on('close', () => { clearInterval(timer); streams.delete(response); }); return;
        }
        if (url.pathname === '/api/v1/distilled' && method === 'POST') {
          const input = DistilledRequestSchema.parse(await body(request, 1024 * 1024));
          sendJson(response, 200, { ok: true, data: options.service.importDistilled(input) }); return;
        }
        const rpcMatch = /^\/api\/v1\/rpc\/([A-Za-z]+)$/.exec(url.pathname);
        if (rpcMatch && method === 'POST') {
          const rpcMethod = RemoteMethodSchema.parse(rpcMatch[1]);
          const input = RemoteRequestSchema.parse(await body(request, options.maxBodyBytes ?? (rpcMethod === 'restorePreview' ? MAX_CLOUD_EXPORT_WIRE_BYTES + 64 * 1024 : 15 * 1024 * 1024)));
          sendJson(response, 200, await options.service.rpc(rpcMethod, input, session.device.id)); return;
        }
        const operationMatch = /^\/api\/v1\/operations\/([^/]+)$/.exec(url.pathname);
        if (operationMatch && method === 'GET') {
          const id = z.string().min(1).max(200).parse(decodeURIComponent(operationMatch[1]!));
          sendJson(response, 200, options.service.state.operation(id, session.device.id)); return;
        }
        if (await options.extension?.(request, response, session)) return;
        throw new RemoteFault(404, '接口不存在');
      }
      if (options.staticDirectory && ['GET', 'HEAD'].includes(method)) {
        const root = resolve(options.staticDirectory), decoded = decodeURIComponent(url.pathname);
        const file = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`), rel = relative(root, file);
        if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || decoded.includes('\\') || decoded.includes('\0')) throw new RemoteFault(404, '资源不存在');
        try {
          if (!(await stat(file)).isFile()) throw Error();
          const actual = relative(await realpath(root), await realpath(file));
          if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw Error();
          const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
          if (!types[extname(file)]) throw Error();
          response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
          if (method === 'HEAD') response.end(); else await pipeline(createReadStream(file), response); return;
        } catch { throw new RemoteFault(404, '资源不存在'); }
      }
      throw new RemoteFault(404, '资源不存在');
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof RemoteFault ? error.status : error instanceof z.ZodError ? 400 : 500;
      if ((status === 429 || status === 503) && !response.hasHeader('Retry-After')) response.setHeader('Retry-After', '1');
      if (!request.complete) response.setHeader('Connection', 'close');
      sendJson(response, status, { ok: false, error: { code: status === 409 ? 'CONFLICT' : status === 400 ? 'VALIDATION' : status === 401 ? 'UNAUTHORIZED' : 'REMOTE', message: error instanceof RemoteFault ? error.message : status === 400 ? '请求格式不正确' : credentialRequest ? '配置结果待核对，请重新读取配置状态' : '服务未完成请求，请查询原操作结果' } });
    }
  }
  return {
    server,
    listen(port: number, host = '127.0.0.1'): Promise<number> { return new Promise((done, reject) => { const fail = (error: Error) => reject(error); server.once('error', fail); server.listen(port, host, () => { server.off('error', fail); const address = server.address(); done(typeof address === 'object' && address ? address.port : port); }); }); },
    close(config: { graceMs?: number } = {}): Promise<void> {
      if (closePromise) return closePromise;
      closing = true; options.service.beginShutdown(); unsubscribe();
      for (const [response, stream] of streams) { clearInterval(stream.timer); response.end(); }
      closePromise = new Promise((done, reject) => {
        const timer = setTimeout(() => server.closeAllConnections(), Math.max(0, config.graceMs ?? 30_000)); timer.unref();
        server.close(error => { clearTimeout(timer); if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else done(); }); server.closeIdleConnections();
      }); return closePromise;
    },
  };
}
