import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createLoopbackHttpsTransport } from './loopback-https';

// Public synthetic fixture; never a deployment certificate or provider credential.
const cert = readFileSync(new URL('./test-fixtures/loopback-test-cert.pem', import.meta.url));
const key = readFileSync(new URL('./test-fixtures/loopback-test-key.pem', import.meta.url));
const servers: Array<{ server: Server; sockets: Set<Duplex> }> = [], transports: ReturnType<typeof createLoopbackHttpsTransport>[] = [];
async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer({ cert, key }, handler), sockets = new Set<Duplex>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  servers.push({ server, sockets });
  const port = (server.address() as { port: number }).port;
  return { server, port, origin: `https://calendar.synthetic.invalid:${port}` };
}
function transport(origin: string, dependencies: Parameters<typeof createLoopbackHttpsTransport>[1] = { ca: cert }) {
  const value = createLoopbackHttpsTransport({ origin, localConnectAddress: '127.0.0.1' }, dependencies); transports.push(value); return value;
}
afterEach(async () => {
  for (const value of transports.splice(0)) value.close();
  for (const { server, sockets } of servers.splice(0)) { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())); }
});

describe('strict original-authority HTTPS through the approved loopback connection', () => {
  it('allows the bounded two-stage AI timeout while keeping ordinary reads capped at 30 seconds',async()=>{
    const f=await serve((_request,response)=>response.end('{}')),value=transport(f.origin);
    const timers=vi.spyOn(globalThis,'setTimeout');
    try{
      await value.fetch(f.origin+'/api/v1/rpc/command',{method:'POST',body:'{}'});
      expect(timers.mock.calls.some(([,ms])=>ms===510_000)).toBe(true);
      timers.mockClear();
      await value.fetch(f.origin+'/api/v1/session');
      expect(timers.mock.calls.some(([,ms])=>ms===30_000)).toBe(true);
      expect(timers.mock.calls.some(([,ms])=>ms===510_000)).toBe(false);
    }finally{timers.mockRestore();}
  });
  it('connects to loopback without DNS while retaining Host, Origin, SNI, body and separate Set-Cookie headers', async () => {
    const seen: Array<{ host?: string; origin?: string; sni?: string | false; cookie?: string; csrf?: string | string[]; body: string }> = [];
    const f = await serve((request, response) => {
      const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        seen.push({ host: request.headers.host, origin: request.headers.origin, sni: (request.socket as TLSSocket & { servername?: string | false }).servername,
          cookie: request.headers.cookie, csrf: request.headers['x-csrf-token'], body: Buffer.concat(chunks).toString('utf8') });
        response.setHeader('Content-Type', 'application/json'); response.setHeader('Set-Cookie', ['__Host-planner_session=synthetic; Secure; HttpOnly; Path=/', 'unrelated=synthetic; Secure']); response.end('{"ok":true}');
      });
    });
    const value = transport(f.origin);
    const result = await value.fetch(f.origin + '/api/v1/ai/config', { method: 'PUT', redirect: 'error', headers: { Origin: f.origin, Cookie: '__Host-planner_session=synthetic', 'X-CSRF-Token': 'synthetic-csrf', 'Content-Type': 'application/json' }, body: '{"apiKey":"synthetic-only-key"}' });
    expect(await result.json()).toEqual({ ok: true }); expect(result.url).toBe(f.origin + '/api/v1/ai/config'); expect(result.redirected).toBe(false);
    expect(result.headers.getSetCookie()).toHaveLength(2);
    expect(seen).toEqual([{ host: `calendar.synthetic.invalid:${f.port}`, origin: f.origin, sni: 'calendar.synthetic.invalid', cookie: '__Host-planner_session=synthetic', csrf: 'synthetic-csrf', body: '{"apiKey":"synthetic-only-key"}' }]);
  });

  it('rejects an untrusted certificate before sending cookies or JSON', async () => {
    const receive = vi.fn((_request: IncomingMessage, response: ServerResponse) => response.end('{}'));
    const f = await serve(receive), value = transport(f.origin, {});
    const error = await value.fetch(f.origin + '/api/v1/pair', { method: 'POST', headers: { Cookie: 'synthetic-cookie' }, body: '{"code":"synthetic-pairing"}' }).catch(error => error);
    expect(error).toBeInstanceOf(TypeError); expect(receive).not.toHaveBeenCalled();
    expect(String(error)).not.toMatch(/synthetic-cookie|synthetic-pairing|BEGIN/);
  });

  it('checks the original DNS certificate name rather than accepting localhost or a trusted wrong hostname', async () => {
    const receive = vi.fn((_request: IncomingMessage, response: ServerResponse) => response.end('{}'));
    const f = await serve(receive), origin = `https://wrong.synthetic.invalid:${f.port}`, value = transport(origin);
    await expect(value.fetch(origin + '/api/v1/session', { headers: { Cookie: 'synthetic-cookie' } })).rejects.toBeInstanceOf(TypeError);
    expect(receive).not.toHaveBeenCalled();
  });

  it.each([302, 307])('never follows HTTP %s or forwards credentials to its target', async status => {
    const stolen = vi.fn((_request: IncomingMessage, response: ServerResponse) => response.end('{}'));
    const other = await serve(stolen);
    const source = vi.fn((_request: IncomingMessage, response: ServerResponse) => { response.writeHead(status, { Location: other.origin + '/api/v1/stolen' }); response.end(); });
    const f = await serve(source), value = transport(f.origin);
    await expect(value.fetch(f.origin + '/api/v1/session', { redirect: 'error', headers: { Cookie: 'synthetic-cookie' } })).rejects.toThrow(/重定向/);
    expect(source).toHaveBeenCalledOnce(); expect(stolen).not.toHaveBeenCalled();
  });

  it('rejects alternate authorities, userinfo, forged Host/Origin and other connect addresses before network activity', async () => {
    const receive = vi.fn((_request: IncomingMessage, response: ServerResponse) => response.end('{}'));
    const f = await serve(receive), value = transport(f.origin);
    for (const url of ['https://elsewhere.synthetic.invalid/api/v1/session', f.origin.replace('https:', 'http:') + '/api/v1/session', f.origin.replace('https://', 'https://synthetic:password@') + '/api/v1/session', f.origin + '/outside']) {
      await expect(value.fetch(url, { headers: { Cookie: 'synthetic-cookie' } })).rejects.toThrow();
    }
    const forgedHeaders: Array<Record<string, string>> = [{ Host: 'elsewhere.synthetic.invalid' }, { Origin: 'https://elsewhere.synthetic.invalid' }];
    for (const headers of forgedHeaders) await expect(value.fetch(f.origin + '/api/v1/session', { headers })).rejects.toThrow(/身份/);
    await expect(value.fetch(f.origin + '/api/v1/session', { redirect: 'follow' })).rejects.toThrow(/重定向/);
    for (const localConnectAddress of ['127.0.0.2', 'localhost', '100.116.94.0', '::1']) expect(() => createLoopbackHttpsTransport({ origin: f.origin, localConnectAddress: localConnectAddress as never })).toThrow();
    expect(() => createLoopbackHttpsTransport({ origin: 'http://127.0.0.1', localConnectAddress: '127.0.0.1' })).toThrow();
    expect(receive).not.toHaveBeenCalled();
  });

  it('honors abort before connection and during a pending TLS response', async () => {
    let received!: () => void; const arrived = new Promise<void>(done => { received = done; });
    const receive = vi.fn(() => received()), f = await serve(receive), value = transport(f.origin);
    const before = new AbortController(); before.abort();
    await expect(value.fetch(f.origin + '/api/v1/session', { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(receive).not.toHaveBeenCalled();
    const during = new AbortController(), result = value.fetch(f.origin + '/api/v1/session', { signal: during.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await arrived; during.abort(); await rejected;
  });

  it.each([true, false])('bounds response bytes for declared-size=%s', async declared => {
    const f = await serve((_request, response) => { response.writeHead(200, declared ? { 'Content-Length': '64' } : { 'Transfer-Encoding': 'chunked' }); response.end('x'.repeat(64)); });
    const value = transport(f.origin, { ca: cert, maxResponseBytes: 32 });
    await expect(value.fetch(f.origin + '/api/v1/session')).rejects.toBeInstanceOf(TypeError);
  });

  it('bounds request UTF-8 bytes before creating a connection', async () => {
    const receive = vi.fn((_request: IncomingMessage, response: ServerResponse) => response.end('{}'));
    const f = await serve(receive), value = transport(f.origin, { ca: cert, maxRequestBytes: 32 });
    await expect(value.fetch(f.origin + '/api/v1/ai/config', { method: 'PUT', body: '€'.repeat(11) })).rejects.toThrow(/大小限制/);
    expect(receive).not.toHaveBeenCalled();
  });

  it('enforces a deadline and closes outstanding requests without retrying', async () => {
    const receive = vi.fn(() => {}), f = await serve(receive), value = transport(f.origin, { ca: cert, timeoutMs: 50 });
    await expect(value.fetch(f.origin + '/api/v1/session')).rejects.toBeInstanceOf(TypeError);
    expect(receive).toHaveBeenCalledOnce();
    const next = transport(f.origin), pending = next.fetch(f.origin + '/api/v1/session');
    const rejected = expect(pending).rejects.toBeInstanceOf(TypeError); next.close(); await rejected;
    await expect(next.fetch(f.origin + '/api/v1/session')).rejects.toBeInstanceOf(TypeError);
  });
});
