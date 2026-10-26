import { Agent, request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { checkServerIdentity, type SecureContextOptions } from 'node:tls';

const LIMIT = 32 * 1024 * 1024;
const transportFailure = () => new TypeError('本机 HTTPS 连接未完成；请检查已配置的 SSH 连接。');
const aborted = () => new DOMException('本机 HTTPS 请求已取消。', 'AbortError');

/** Pins the TCP destination only. URL authority, HTTP Host, SNI and certificate identity never become localhost. */
export function createLoopbackHttpsTransport(options: { origin: string; localConnectAddress: '127.0.0.1' },
  dependencies: { ca?: SecureContextOptions['ca']; maxResponseBytes?: number; maxRequestBytes?: number; timeoutMs?: number } = {}) {
  const origin = new URL(options.origin);
  if (options.localConnectAddress !== '127.0.0.1' || origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw Error('本机连接仅允许已指定的 HTTPS 根地址和 127.0.0.1。');
  }
  const responseLimit = dependencies.maxResponseBytes ?? LIMIT, requestLimit = dependencies.maxRequestBytes ?? LIMIT;
  if (![responseLimit, requestLimit].every(value => Number.isSafeInteger(value) && value > 0 && value <= LIMIT)) throw Error('本机 HTTPS 传输上限无效。');
  const timeoutMs = Math.max(1, Math.min(dependencies.timeoutMs ?? 30_000, 30_000));
  if (!Number.isFinite(timeoutMs)) throw Error('本机 HTTPS 传输时限无效。');
  // Custom trust is a test dependency only; neither config nor NodeRemoteClient exposes it.
  const agent = new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1, ...(dependencies.ca ? { ca: dependencies.ca } : {}) });
  const active = new Set<ClientRequest>(); let closed = false;
  const fetcher: typeof fetch = async (input, init = {}) => {
    if (closed) throw transportFailure();
    // This private transport accepts the URL + RequestInit form used by NodeRemoteClient, never an inherited Request body.
    if (typeof input !== 'string' && !(input instanceof URL)) throw Error('本机 HTTPS 请求必须提供明确 URL。');
    const url = new URL(input);
    if (url.origin !== origin.origin || url.username || url.password || url.hash || !url.pathname.startsWith('/api/v1/')) throw Error('本机 HTTPS 请求不能离开原资料服务。');
    if (init.redirect !== undefined && init.redirect !== 'error') throw Error('本机 HTTPS 请求不允许重定向。');
    const method = (init.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method)) throw Error('不支持的本机 HTTPS 请求方法。');
    const headers = new Headers(init.headers);
    if (headers.has('host') && headers.get('host') !== url.host || headers.has('origin') && headers.get('origin') !== origin.origin) throw Error('本机 HTTPS 请求身份与原资料服务不符。');
    headers.set('host', url.host);
    let body: Buffer | undefined;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== 'string' || method === 'GET' || method === 'HEAD') throw Error('本机 HTTPS 请求只接受有界 JSON 文本。');
      body = Buffer.from(init.body);
      if (body.length > requestLimit) throw Error('本机 HTTPS 请求超过大小限制。');
    }
    headers.delete('transfer-encoding'); headers.delete('content-length');
    if (body) headers.set('content-length', String(body.length));
    const signal = init.signal;
    if (signal?.aborted) throw aborted();
    return new Promise<Response>((resolve, reject) => {
      let request: ClientRequest | undefined, response: IncomingMessage | undefined, done = false;
      const timer = setTimeout(() => fail(transportFailure()), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (request) active.delete(request); };
      const fail = (error: Error) => {
        if (done) return; done = true; cleanup(); request?.destroy(); response?.destroy(); reject(error);
      };
      const onAbort = () => fail(aborted());
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        request = httpsRequest({
          protocol: 'https:', hostname: '127.0.0.1', port: url.port || 443,
          path: url.pathname + url.search, method, headers: Object.fromEntries(headers), agent,
          servername: url.hostname, rejectUnauthorized: true,
          checkServerIdentity: (_hostname, certificate) => checkServerIdentity(url.hostname, certificate),
        }, incoming => {
          response = incoming;
          const status = incoming.statusCode ?? 0;
          // No redirect target is ever opened, even for the same origin or a method-preserving redirect.
          if (status >= 300 && status < 400) { fail(new TypeError('资料服务发生重定向，未向其他地址发送凭据。')); return; }
          if (status < 200 || status > 599 || Number(incoming.headers['content-length']) > responseLimit) { fail(transportFailure()); return; }
          const chunks: Buffer[] = []; let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > responseLimit) { fail(new TypeError('本机 HTTPS 响应超过大小限制。')); return; }
            chunks.push(chunk);
          });
          incoming.once('aborted', () => fail(transportFailure())); incoming.once('error', () => fail(transportFailure()));
          incoming.once('end', () => {
            if (done) return;
            try {
              const responseHeaders = new Headers();
              for (let i = 0; i < incoming.rawHeaders.length; i += 2) responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
              const result = new Response(method === 'HEAD' || status === 204 || status === 205 ? null : Uint8Array.from(Buffer.concat(chunks)),
                { status, statusText: incoming.statusMessage, headers: responseHeaders });
              Object.defineProperty(result, 'url', { value: url.href });
              done = true; cleanup(); resolve(result);
            } catch { fail(transportFailure()); }
          });
        });
        active.add(request);
        request.once('error', () => fail(transportFailure()));
        request.once('upgrade', (_response, socket) => { socket.destroy(); fail(transportFailure()); });
        request.end(body);
      } catch { fail(transportFailure()); }
    });
  };
  return {
    fetch: fetcher,
    close() { if (closed) return; closed = true; for (const request of active) request.destroy(transportFailure()); active.clear(); agent.destroy(); },
  };
}
