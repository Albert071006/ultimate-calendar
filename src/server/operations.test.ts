import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as requestHttp, type IncomingMessage } from 'node:http';
import { createRemoteService } from './service';
import { createRemoteHttpServer } from './http';
import { startRemoteRuntime } from './runtime';
import { RemoteState } from './state';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function folder() { const root = mkdtempSync(join(tmpdir(), 'planner-operations-')); cleanup.push(async () => { rmSync(root, { recursive: true, force: true }); }); return root; }
function call(port: number, path: string, cookie?: string): Promise<{ status: number; data: unknown }> {
  return new Promise((done, reject) => {
    const request = requestHttp({ hostname: '127.0.0.1', port, path, headers: { Host: 'localhost:3210', ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => done({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); request.on('error', reject); request.end();
  });
}
const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"query","reply":"虚构查询","fromDate":"2027-01-01","toDate":"2027-01-02"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });

describe('service operations', () => {
  it('exposes minimal anonymous probes and authenticated backup diagnostics, then recovers a failed backup', async () => {
    const root = folder(), blocked = join(root, 'blocked-backups'); writeFileSync(blocked, 'synthetic-blocking-file');
    const service = createRemoteService({ dataDirectory: join(root, 'data'), backupDirectory: blocked, getApiKey: async () => null });
    const http = createRemoteHttpServer({ service, origin: 'http://localhost:3210' }); const port = await http.listen(0);
    cleanup.push(async () => { await http.close(); await service.close(); });
    expect(await call(port, '/healthz')).toEqual({ status: 200, data: { status: 'ok' } });
    expect(await call(port, '/readyz')).toMatchObject({ status: 200, data: { ready: true, status: 'degraded', checks: { storage: 'ok', backup: 'failed' } } });
    expect((await call(port, '/api/v1/status')).status).toBe(401);
    const probe = () => new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn(process.execPath, [resolve('deploy/check-health.mjs'), '--url', `http://127.0.0.1:${port}/readyz`, '--host', 'localhost:3210'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
      child.stdout.on('data', chunk => { output += chunk.toString(); }); child.stderr.on('data', chunk => { output += chunk.toString(); }); child.on('error', reject); child.on('exit', code => done({ code, output }));
    });
    expect(await probe()).toEqual({ code: 2, output: 'READY_DEGRADED_BACKUP\n' });
    const token = service.state.pair(service.state.createPairingCode(), '虚构设备').token, cookie = `planner_dev_session=${token}`;
    expect(await call(port, '/api/v1/status', cookie)).toMatchObject({ data: { lifecycle: 'running', backup: { status: 'failed', failureCode: 'BACKUP_FAILED', consecutiveFailures: 1 } } });
    expect(JSON.stringify((await call(port, '/api/v1/status', cookie)).data)).not.toContain(root);
    rmSync(blocked); mkdirSync(blocked); service.backup();
    expect(service.status().backup).toMatchObject({ status: 'ok', failureCode: null, consecutiveFailures: 0 });
    expect(service.state.backupStatus()).toEqual(service.status().backup);
    expect((await call(port, '/readyz')).data).toMatchObject({ ready: true, status: 'ready' });
    expect(await probe()).toEqual({ code: 0, output: 'HEALTHY\n' });
    service.beginShutdown(); expect((await call(port, '/readyz')).status).toBe(503);
    expect(await probe()).toEqual({ code: 1, output: 'NOT_READY\n' });
  });
  it('limits admitted requests and event streams while probes remain available', async () => {
    const root = folder(); const service = createRemoteService({ dataDirectory: join(root, 'data'), backupDirectory: join(root, 'backups'), getApiKey: async () => null });
    let release: () => void = () => {}, entered: () => void = () => {};
    const held = new Promise<void>(done => { release = done; }), entry = new Promise<void>(done => { entered = done; });
    const http = createRemoteHttpServer({ service, origin: 'http://localhost:3210', limits: { requests: 2, requestsPerDevice: 2, eventStreams: 1, eventStreamsPerDevice: 1 }, extension: async (request, response) => {
      if (request.url !== '/api/v1/test-hold') return false; entered(); await held; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return true;
    } });
    const port = await http.listen(0); cleanup.push(async () => { release(); await http.close(); await service.close(); });
    const paired = service.state.pair(service.state.createPairingCode(), '虚构设备'), cookie = `planner_dev_session=${paired.token}`;
    let stream: IncomingMessage | undefined;
    const request = requestHttp({ hostname: '127.0.0.1', port, path: '/api/v1/events', headers: { Host: 'localhost:3210', Cookie: cookie } });
    const connected = new Promise<void>((done, reject) => { request.on('response', response => { stream = response; response.once('data', () => done()); }); request.on('error', reject); }); request.end(); await connected;
    expect((await call(port, '/api/v1/events', cookie)).status).toBe(429);
    const pending = call(port, '/api/v1/test-hold', cookie); await entry;
    expect((await call(port, '/api/v1/status', cookie)).status).toBe(429); expect((await call(port, '/readyz')).status).toBe(200);
    release(); expect((await pending).status).toBe(200); stream?.destroy(); request.destroy();
    await http.close(); await http.close(); await service.close();
  });
  it('rejects excess writes before durable admission and drains accepted work before closing', async () => {
    const root = folder(); let release: () => void = () => {}, started: () => void = () => {};
    const entered = new Promise<void>(done => { started = done; }), held = new Promise<void>(done => { release = done; });
    const service = createRemoteService({ dataDirectory: join(root, 'data'), backupDirectory: join(root, 'backups'), maxConcurrentWrites: 1, getApiKey: async () => 'synthetic-key', controller: { fetch: async () => { started(); await held; return reply(); } } });
    cleanup.push(() => service.close()); const identity = service.state.identity();
    const pending = service.rpc('command', { requestId: 'accepted', identity, input: { operationId: 'accepted-ai', text: '虚构查询' } }, 'fake-device'); await entered;
    await expect(service.rpc('command', { requestId: 'overloaded', identity, input: { operationId: 'second-ai', text: '虚构查询' } }, 'fake-device')).rejects.toMatchObject({ status: 429 });
    expect(service.state.operation('overloaded', 'fake-device')).toEqual({ status: 'unknown' });
    const close = service.close(); expect(service.close()).toBe(close);
    await expect(service.rpc('snapshot', { requestId: 'after-stop', identity }, 'fake-device')).rejects.toMatchObject({ status: 503 });
    release(); expect(await pending).toMatchObject({ ok: true }); await close; expect(service.status().lifecycle).toBe('closed');
    const state = new RemoteState(join(root, 'data', 'remote-state.sqlite')); try { expect(state.operation('accepted', 'fake-device')).toMatchObject({ status: 'completed', result: { ok: true } }); } finally { state.close(); }
  });
  it('aborts stalled model transport after the shutdown grace without closing storage early', async () => {
    const root = folder(); let started: () => void = () => {}; const entered = new Promise<void>(done => { started = done; });
    const service = createRemoteService({ dataDirectory: join(root, 'data'), backupDirectory: join(root, 'backups'), getApiKey: async () => 'synthetic-key', controller: { fetch: async () => { started(); return new Promise<Response>(() => {}); } } });
    cleanup.push(() => service.close()); const identity = service.state.identity();
    const work = service.rpc('command', { requestId: 'stalled', identity, input: { operationId: 'stalled-ai', text: '虚构查询' } }, 'fake-device'); await entered;
    await service.close({ graceMs: 0 }); expect(await work).toMatchObject({ ok: false }); expect(existsSync(join(root, 'data', '.remote-service.lock'))).toBe(false);
  });
  it('cleans partially initialized runtimes on config/secret errors and supports idempotent runtime shutdown', async () => {
    const root = folder(), directory = join(root, 'data');
    await expect(startRemoteRuntime({ dataDirectory: directory, backupDirectory: join(root, 'backups'), origin: 'http://public.example', port: 0, getApiKey: async () => null })).rejects.toThrow(/HTTPS/);
    expect(existsSync(join(directory, '.remote-service.lock'))).toBe(false);
    await expect(startRemoteRuntime({ dataDirectory: directory, backupDirectory: join(root, 'backups'), origin: 'http://localhost:3210', port: 0, getApiKey: async () => { throw Error('synthetic-unreadable-secret'); } })).rejects.toMatchObject({ status: 503, message: 'AI 凭据存储暂不可用，请检查服务端私密文件状态' });
    expect(existsSync(join(directory, '.remote-service.lock'))).toBe(false);
    const runtime = await startRemoteRuntime({ dataDirectory: directory, backupDirectory: join(root, 'backups'), origin: 'http://localhost:3210', port: 0, getApiKey: async () => null });
    expect((await call(runtime.port, '/readyz')).status).toBe(200); expect(runtime.close()).toBe(runtime.close()); await runtime.close();
    const persisted = new RemoteState(join(directory, 'remote-state.sqlite')); try { expect(persisted.backupStatus()).toMatchObject({ status: 'ok' }); } finally { persisted.close(); }
    expect(readFileSync(join(directory, 'planner.sqlite')).length).toBeGreaterThan(0);
  });
});
