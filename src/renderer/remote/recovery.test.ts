import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRequestSchema, SnapshotSchema, type ApiError, type ApiResult, type CommandResult } from '../../shared/contracts';
import { createRemoteClient } from './client';
import { createMemoryStorage, emptyPartition, partitionKey } from './storage';
import type { PairedSession } from './types';

const origin = 'https://synthetic-recovery.example';
const session: PairedSession = {
  paired: true, identity: { protocolVersion: 1, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 },
  device: { id: '22222222-2222-4222-8222-222222222222', name: 'Synthetic recovery phone' }, csrfToken: 'synthetic-csrf', aiConfigured: true,
};
const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: true, sessionOnly: false } });
const commandInput = () => CommandRequestSchema.parse({ operationId: crypto.randomUUID(), text: '合成查询：明天有哪些安排' });
const commandResult: ApiResult<CommandResult> = { ok: true, data: { reply: '合成查询结果', mutationResult: null, items: [] } };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function fixture() {
  let online = true, revoked = false, loseCommand = false, sessionStatus = 200;
  let nextCommandResult = commandResult;
  const calls: Array<{ path: string; body: Record<string, unknown> | undefined }> = [], receipts = new Map<string, unknown>();
  const sources: Array<{ close: ReturnType<typeof vi.fn>; onerror: ((event: Event) => unknown) | null; addEventListener: ReturnType<typeof vi.fn> }> = [];
  const storage = createMemoryStorage(), saved = emptyPartition(session); saved.snapshot = snapshot;
  await storage.write(partitionKey(origin, session), saved); await storage.write('active:' + origin, partitionKey(origin, session));
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); expect(url.origin).toBe(origin);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ path: url.pathname, body });
    if (!online) throw TypeError('Synthetic private network unavailable while Wi-Fi stays online');
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/v1/session') return sessionStatus === 200 ? json(revoked ? { paired: false } : session) : json({ error: { message: 'Synthetic temporary rate limit' } }, sessionStatus);
    if (url.pathname === '/api/v1/session/renew') return json(session);
    if (url.pathname === '/api/v1/rpc/snapshot') return json({ ok: true, data: snapshot });
    if (url.pathname === '/api/v1/rpc/command') {
      receipts.set(String(body?.requestId), nextCommandResult);
      if (loseCommand) { loseCommand = false; online = false; throw TypeError('Synthetic lost response after execution'); }
      return json(nextCommandResult);
    }
    if (url.pathname.startsWith('/api/v1/operations/')) {
      const requestId = url.pathname.split('/').at(-1)!;
      return json(receipts.has(requestId) ? { status: 'completed', requestId, method: 'command', result: receipts.get(requestId) } : { status: 'unknown' });
    }
    throw Error('Unexpected synthetic request: ' + url.pathname);
  };
  const controller = createRemoteClient({ origin, storage, fetch: fetcher, events: () => {
    const source = { close: vi.fn(), onerror: null, addEventListener: vi.fn() }; sources.push(source); return source as unknown as EventSource;
  } });
  cleanup.push(() => controller.dispose());
  return { controller, calls, sources, setCommandResult(value: ApiResult<CommandResult>) { nextCommandResult = value; }, setOnline(value: boolean) { online = value; }, setSessionStatus(value: number) { sessionStatus = value; }, revoke() { revoked = true; }, loseNextCommand() { loseCommand = true; } };
}

describe('mobile connection recovery without a browser online event', () => {
  it.each([
    { code: 'AI_RESPONSE', delivery: undefined, sendsAgain: true },
    { code: 'AI_RESPONSE', delivery: 'unknown', sendsAgain: false },
    { code: 'NETWORK', delivery: undefined, sendsAgain: false },
    { code: 'INTERNAL', delivery: undefined, sendsAgain: false },
  ] satisfies Array<{ code: ApiError['code']; delivery: ApiError['delivery']; sendsAgain: boolean }>)
  ('keeps selected-resource dependencies safe after $code / $delivery (resend=$sendsAgain)', async ({ code, delivery, sendsAgain }) => {
    const f = await fixture(); await f.controller.initialize();
    const failed: ApiResult<CommandResult> = { ok: false, error: { code, message: '合成失败回执', retryable: false, ...(delivery ? { delivery } : {}) } };
    f.setCommandResult(failed);
    const original = CommandRequestSchema.parse({ ...commandInput(),
      selected: [{ entity: 'task', id: 'synthetic-task' }],
      resources: [{ id: 'synthetic-resource', kind: 'web', name: '合成资料', url: 'https://example.invalid/' }] });
    expect(await f.controller.client.command(original)).toMatchObject(failed);
    const prior = f.controller.getState().pending[0]!;
    expect(prior.targets).toEqual(expect.arrayContaining(['synthetic-task', 'synthetic-resource']));
    f.setCommandResult(commandResult);
    const reanalysis = { ...original, operationId: crypto.randomUUID() };
    const result = await f.controller.client.command(reanalysis);
    if (sendsAgain) {
      expect(result).toMatchObject(commandResult);
      expect(f.controller.getState().pending).toEqual([prior]);
      const writes = f.calls.filter(call => call.path === '/api/v1/rpc/command');
      expect(writes).toHaveLength(2);
      expect(writes[1]?.body?.input).toEqual(reanalysis);
      expect(writes[1]?.body?.requestId).not.toBe(writes[0]?.body?.requestId);
    } else {
      expect(result).toMatchObject({ ok: false, error: { delivery: 'unknown' } });
      expect(f.calls.filter(call => call.path === '/api/v1/rpc/command')).toHaveLength(1);
      expect(f.controller.getState().pending[1]).toMatchObject({ status: 'blocked', dependencies: [prior.id] });
    }
    expect(f.controller.getState().pending[0]).toEqual(prior);
    expect(await f.controller.client.command(original)).toMatchObject(failed);
  });

  it('keeps retrying after the first SSE reconnect fails, with backoff and no business request', async () => {
    vi.useFakeTimers(); const f = await fixture(); await f.controller.initialize();
    f.setOnline(false); f.sources[0]!.onerror?.(new Event('error'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.controller.getState().status).toBe('offline');
    expect(f.calls.filter(call => call.path === '/api/v1/session')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.calls.filter(call => call.path === '/api/v1/session')).toHaveLength(3);
    f.setOnline(true); await vi.advanceTimersByTimeAsync(3_999);
    expect(f.controller.getState().status).toBe('offline');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.controller.getState().status).toBe('online');
    expect(f.sources).toHaveLength(2);
    expect(f.calls.some(call => call.path === '/api/v1/rpc/command')).toBe(false);
    expect(f.controller.getState().pending).toEqual([]);
  });

  it('reconnects before sending an online-only command instead of rejecting a stale offline flag', async () => {
    vi.useFakeTimers(); const f = await fixture(); await f.controller.initialize();
    f.setOnline(false); await f.controller.client.snapshot(); expect(f.controller.getState().status).toBe('offline');
    f.setOnline(true); const input = commandInput();
    expect(await f.controller.client.command(input)).toMatchObject(commandResult);
    const writes = f.calls.filter(call => call.path === '/api/v1/rpc/command');
    expect(writes).toHaveLength(1); expect(writes[0]?.body?.input).toEqual(input);
    expect(f.controller.getState().status).toBe('online'); expect(f.controller.getState().pending).toEqual([]);
  });

  it('retries a temporarily rate-limited session probe without leaving the page falsely online', async () => {
    vi.useFakeTimers(); const f = await fixture(); await f.controller.initialize(); f.setSessionStatus(429);
    f.sources[0]!.onerror?.(new Event('error')); await vi.advanceTimersByTimeAsync(15_000);
    expect(f.controller.getState().status).toBe('offline');
    f.setSessionStatus(200); await vi.advanceTimersByTimeAsync(2_000);
    expect(f.controller.getState().status).toBe('online'); expect(f.sources).toHaveLength(2);
    expect(f.calls.some(call => call.path === '/api/v1/rpc/command')).toBe(false);
  });

  it('reports definitely unsent only when reconnection fails before any outbox request exists', async () => {
    vi.useFakeTimers(); const f = await fixture(); await f.controller.initialize();
    f.setOnline(false); await f.controller.reconnect();
    expect(await f.controller.client.command(commandInput())).toMatchObject({ ok: false, error: { code: 'NETWORK', delivery: 'not-sent', message: expect.stringContaining('尚未发送') } });
    expect(f.calls.some(call => call.path === '/api/v1/rpc/command')).toBe(false); expect(f.controller.getState().pending).toEqual([]);
  });

  it('keeps a lost command response unknown on a failed retry, then checks the same receipt without repeating AI', async () => {
    vi.useFakeTimers(); const f = await fixture(); await f.controller.initialize(); const input = commandInput(); f.loseNextCommand();
    expect(await f.controller.client.command(input)).toMatchObject({ ok: false, error: { delivery: 'unknown' } });
    const pending = f.controller.getState().pending[0]!;
    expect(pending.status).toBe('uncertain');
    expect(await f.controller.client.command(input)).toMatchObject({ ok: false, error: { delivery: 'unknown' } });
    expect(f.controller.getState().pending[0]?.requestId).toBe(pending.requestId);
    f.setOnline(true); await vi.advanceTimersByTimeAsync(4_000);
    expect(f.controller.getState().status).toBe('online'); await vi.waitFor(() => expect(f.controller.getState().pending).toEqual([]));
    expect(f.calls.some(call => call.path === '/api/v1/operations/' + pending.requestId)).toBe(true);
    expect(await f.controller.client.command(input)).toMatchObject(commandResult);
    expect(f.calls.filter(call => call.path === '/api/v1/rpc/command')).toHaveLength(1);
  });

  it('returns the original reply when an explicit retry reconnects and clears its uncertain outbox item', async () => {
    vi.useFakeTimers(); const f = await fixture(); await f.controller.initialize(); const input = commandInput(); f.loseNextCommand();
    expect(await f.controller.client.command(input)).toMatchObject({ ok: false, error: { delivery: 'unknown' } });
    const pending = f.controller.getState().pending[0]!; f.setOnline(true);
    expect(await f.controller.client.command(input)).toMatchObject(commandResult);
    expect(f.controller.getState().pending).toEqual([]);
    expect(f.calls.some(call => call.path === '/api/v1/operations/' + pending.requestId)).toBe(true);
    expect(f.calls.filter(call => call.path === '/api/v1/rpc/command')).toHaveLength(1);
  });

  it('stops automatic recovery after confirmed revocation and never sends the new command', async () => {
    vi.useFakeTimers(); const f = await fixture(); await f.controller.initialize();
    f.setOnline(false); await f.controller.reconnect(); f.setOnline(true); f.revoke();
    await vi.advanceTimersByTimeAsync(2_000); expect(f.controller.getState().status).toBe('expired');
    const count = f.calls.length; await vi.advanceTimersByTimeAsync(120_000);
    expect(f.calls).toHaveLength(count);
    expect(await f.controller.client.command(commandInput())).toMatchObject({ ok: false, error: { code: 'AUTH', delivery: 'not-sent' } });
    expect(f.calls).toHaveLength(count);
  });

  it('pauses retry timers when hidden, resumes on foreground, and cancels recovery on dispose', async () => {
    vi.useFakeTimers(); const visibility = new EventTarget() as EventTarget & { visibilityState: string }; visibility.visibilityState = 'visible';
    vi.stubGlobal('document', visibility); const f = await fixture(); await f.controller.initialize();
    f.setOnline(false); await f.controller.reconnect(); visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange'));
    const count = f.calls.length; await vi.advanceTimersByTimeAsync(120_000); expect(f.calls).toHaveLength(count);
    f.setOnline(true); visibility.visibilityState = 'visible'; visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0); expect(f.controller.getState().status).toBe('online');
    f.setOnline(false); await f.controller.reconnect(); f.controller.dispose(); const disposedCount = f.calls.length;
    await vi.advanceTimersByTimeAsync(120_000); expect(f.calls).toHaveLength(disposedCount);
  });

  it('ignores an error from a replaced SSE stream instead of closing the new connection', async () => {
    vi.useFakeTimers(); const f = await fixture(); await f.controller.initialize(); const old = f.sources[0]!;
    await f.controller.reconnect(); const current = f.sources[1]!; old.onerror?.(new Event('error'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(current.close).not.toHaveBeenCalled(); expect(f.sources).toHaveLength(2);
  });
});
