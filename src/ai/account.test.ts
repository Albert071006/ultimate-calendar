import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountService } from './account';
import { parsePricing } from './pricing';
const cny = readFileSync(new URL('./fixtures/pricing-cny.html', import.meta.url), 'utf8');
const usd = readFileSync(new URL('./fixtures/pricing-usd.html', import.meta.url), 'utf8');
const timestamp = '2026-10-23T12:00:00+08:00';
const epoch = Date.parse(timestamp);
const modelBody = { object: 'list', data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-Flash', context_window: 1048576, max_output_tokens: 393216, input_modalities: ['text', 'image'] }, { id: 'future', object: 'model', owned_by: 'deepseek' }] };
const balanceBody = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '100.000001', granted_balance: '1.00', topped_up_balance: '99.000001' }, { currency: 'USD', total_balance: '-0.01', granted_balance: '0', topped_up_balance: '-0.01' }] };
function response(url: string | URL | Request) {
  const value = String(url);
  return new Response(value.endsWith('/models') ? JSON.stringify(modelBody) : value.endsWith('/balance') ? JSON.stringify(balanceBody) : value.includes('/zh-cn/') ? cny : usd);
}
afterEach(() => { vi.useRealTimers(); });
describe('DeepSeek account service transport and lifecycle', () => {
  it('calls fixed authenticated endpoints and anonymous public pages, maps optional model fields, preserves decimal currencies', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const account = createAccountService({ getApiKey: async () => 'synthetic-private-key', now: () => epoch, fetch: async (url, init) => { calls.push({ url: String(url), init }); return response(url); } });
    const result = await account.refresh();
    expect(calls).toHaveLength(4); expect(result.configured).toBe(true);
    for (const call of calls) {
      expect(call.init?.redirect).toBe('error');
      const headers = new Headers(call.init?.headers);
      expect(headers.get('authorization')).toBe(call.url.startsWith('https://api.deepseek.com/') ? 'Bearer synthetic-private-key' : null);
    }
    expect(result.models.data?.[0]).toMatchObject({ id: 'deepseek-flash', name: 'DeepSeek-Flash', contextWindow: 1048576, maxOutputTokens: 393216, inputModalities: ['text', 'image'] });
    expect(result.models.data?.[1]).toEqual({ id: 'future' });
    expect(result.balance.data?.balances.map(b => [b.currency, b.total])).toEqual([['CNY', '100.000001'], ['USD', '-0.01']]);
    expect(account.quote('deepseek-flash', 'CNY')?.low.outputPerMillion).toBe(4);
    expect(account.quote('deepseek-v4-flash', 'USD')?.model).toBe('deepseek-v4-flash');
    expect(account.quote('future', 'CNY')).toBeNull(); expect(JSON.stringify(result)).not.toContain('synthetic-private-key'); account.stop();
  });
  it('fetches public prices without a key and does not request private endpoints', async () => {
    const urls: string[] = [];
    const account = createAccountService({ getApiKey: async () => null, now: () => epoch, fetch: async url => { urls.push(String(url)); return response(url); } });
    const result = await account.refresh(); expect(urls).toHaveLength(2); expect(result.configured).toBe(false);
    expect(result.models.data).toBeNull(); expect(result.balance.data).toBeNull(); expect(result.prices.data?.entries.length).toBeGreaterThan(0); account.stop();
  });
  it('preserves previous balance on failure, independently refreshes models/prices, and backs off failures', async () => {
    let now = epoch, fail = false, calls = 0;
    const account = createAccountService({ getApiKey: async () => 'key', now: () => now, fetch: async url => {
      if (String(url).endsWith('/balance')) { calls++; if (fail) return new Response('key private-details', { status: 429 }); }
      return response(url);
    } });
    await account.refresh(); fail = true; now += 30_000; await account.refresh();
    expect(calls).toBe(2); expect(account.snapshot().balance.error).toContain('频繁');
    expect(account.snapshot().balance.data?.balances[0]?.total).toBe('100.000001');
    expect(account.snapshot().balance.updatedAt).toBe(timestamp.replace('+08:00', '.000+08:00'));
    expect(account.snapshot().models.error).toBeNull(); expect(account.snapshot().prices.error).toBeNull();
    await account.refresh(); expect(calls).toBe(2); now += 30_000; await account.refresh(); expect(calls).toBe(3);
    now += 30_000; await account.refresh(); expect(calls).toBe(3); // second failure waits 60s
    expect(JSON.stringify(account.snapshot())).not.toContain('private-details'); account.stop();
  });
  it('keeps cached public prices visible but refuses stale/failed estimates, with per-currency failure isolation', async () => {
    let now = epoch, fail = false;
    const account = createAccountService({ getApiKey: async () => null, now: () => now, fetch: async url => fail && String(url).includes('/zh-cn/') ? new Response('bad table') : response(url) });
    await account.refresh(); fail = true; await account.refresh({ force: true });
    expect(account.snapshot().prices.data?.entries.find(p => p.currency === 'CNY')?.low.inputPerMillion).toBe(1);
    expect(account.snapshot().prices.error).toContain('CNY'); expect(account.quote('deepseek-flash', 'CNY')).toBeNull();
    expect(account.quote('deepseek-flash', 'USD')).not.toBeNull(); now += 24 * 3600_000;
    expect(account.quote('deepseek-flash', 'USD')).toBeNull(); account.stop();
  });
  it('ignores old-key responses after rotation and clears old account data immediately', async () => {
    let key = 'old'; let resolveOld: ((response: Response) => void) | undefined; let oldSignal: AbortSignal | null | undefined;
    const account = createAccountService({ getApiKey: async () => key, now: () => epoch, fetch: async (url, init) => {
      if (String(url).endsWith('/balance') && new Headers(init?.headers).get('authorization') === 'Bearer old') {
        oldSignal = init?.signal; return new Promise(resolve => { resolveOld = resolve; });
      }
      if (String(url).endsWith('/balance')) return new Response(JSON.stringify({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0', granted_balance: '0', topped_up_balance: '0' }] }));
      return response(url);
    } });
    const old = account.refresh(); await vi.waitFor(() => expect(resolveOld).toBeDefined());
    key = 'new'; account.resetKey(); expect(account.snapshot().balance.data).toBeNull(); expect(oldSignal?.aborted).toBe(true);
    await account.refresh(); resolveOld!(response('https://api.deepseek.com/user/balance')); await old;
    expect(account.snapshot().balance.data?.balances[0]?.total).toBe('0'); expect(account.snapshot().balance.data?.isAvailable).toBe(false); account.stop();
  });
  it('does not revive a removed key while an earlier key-store read is pending', async () => {
    let resolveKey: ((value: string | null) => void) | undefined, first = true;
    const calls: string[] = [];
    const account = createAccountService({ getApiKey: async () => first ? (first = false, new Promise(resolve => { resolveKey = resolve; })) : null,
      now: () => epoch, fetch: async url => { calls.push(String(url)); return response(url); } });
    const pending = account.refresh(); await vi.waitFor(() => expect(resolveKey).toBeDefined()); account.resetKey();
    await account.refresh(); resolveKey!('old-key'); await pending;
    expect(account.snapshot().configured).toBe(false); expect(calls.some(c => c.includes('api.deepseek.com'))).toBe(false); account.stop();
  });
  it('deduplicates simultaneous refreshes and rejects timed-out transports without showing their error text', async () => {
    let calls = 0;
    const account = createAccountService({ getApiKey: async () => 'key', timeoutMs: 10, now: () => epoch,
      fetch: async () => { calls++; return new Promise(() => {}); } });
    await Promise.all([account.refresh({ force: true }), account.refresh({ force: true })]);
    expect(calls).toBe(4); expect(account.snapshot().balance.error).toContain('超时'); expect(account.snapshot().prices.loading).toBe(false); account.stop();
  });
  it('queues one fresh balance read after an in-flight query when AI usage has just completed', async () => {
    let balanceCalls = 0, resolveFirst: ((response: Response) => void) | undefined;
    const account = createAccountService({ getApiKey: async () => 'key', now: () => epoch, fetch: async url => {
      if (String(url).endsWith('/balance') && ++balanceCalls === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return response(url);
    } });
    const initial = account.refresh(); await vi.waitFor(() => expect(resolveFirst).toBeDefined());
    const postUsage = account.refresh({ force: true, balanceOnly: true });
    const anotherCompletion = account.refresh({ force: true, balanceOnly: true });
    await Promise.resolve(); resolveFirst!(response('https://api.deepseek.com/user/balance'));
    await Promise.all([initial, postUsage, anotherCompletion]); expect(balanceCalls).toBe(2); account.stop();
  });
  it('allows another bounded follow-up when new usage completes during the earlier follow-up', async () => {
    const resolvers: ((response: Response) => void)[] = [];
    const account = createAccountService({ getApiKey: async () => 'key', now: () => epoch, fetch: async url => {
      if (String(url).endsWith('/balance')) return new Promise(resolve => { resolvers.push(resolve); });
      return response(url);
    } });
    const initial = account.refresh(); await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const firstCompletion = account.refresh({ force: true, balanceOnly: true }); await Promise.resolve();
    resolvers[0]!(response('https://api.deepseek.com/user/balance')); await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    const secondCompletion = account.refresh({ force: true, balanceOnly: true }); await Promise.resolve();
    resolvers[1]!(response('https://api.deepseek.com/user/balance')); await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[2]!(response('https://api.deepseek.com/user/balance')); await Promise.all([initial, firstCompletion, secondCompletion]);
    expect(resolvers).toHaveLength(3); account.stop();
  });
  it('rejects malformed balances, duplicate currencies, and oversized response bodies', async () => {
    for (const body of [
      { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'NaN', granted_balance: '0', topped_up_balance: '0' }] },
      { is_available: true, balance_infos: [balanceBody.balance_infos[0], balanceBody.balance_infos[0]] },
    ]) {
      const account = createAccountService({ getApiKey: async () => 'key', now: () => epoch, fetch: async url => String(url).endsWith('/balance') ? new Response(JSON.stringify(body)) : response(url) });
      await account.refresh(); expect(account.snapshot().balance.data).toBeNull(); expect(account.snapshot().balance.error).toContain('格式'); account.stop();
    }
    const account = createAccountService({ getApiKey: async () => 'key', now: () => epoch, fetch: async url => String(url).endsWith('/balance') ? new Response('x'.repeat(256_001)) : response(url) });
    await account.refresh(); expect(account.snapshot().balance.error).toContain('过大'); account.stop();
  });
  it('polls every 30 seconds when visible, every 5 minutes hidden, and stops all polling on quit', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch); let visible = true, balances = 0;
    const account = createAccountService({ getApiKey: async () => 'key', isVisible: () => visible, fetch: async url => { if (String(url).endsWith('/balance')) balances++; return response(url); } });
    account.start(); await vi.advanceTimersByTimeAsync(0); expect(balances).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(balances).toBe(2);
    visible = false; await vi.advanceTimersByTimeAsync(270_000); expect(balances).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000); expect(balances).toBe(3);
    account.stop(); await vi.advanceTimersByTimeAsync(600_000); expect(balances).toBe(3);
  });
  it('persists public prices only and validates a fresh cache before reusing it', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'planner-price-')); const path = join(folder, 'prices.json');
    try {
      const account = createAccountService({ getApiKey: async () => 'synthetic-secret', cachePath: path, now: () => epoch, fetch: async url => response(url) });
      await account.refresh();
      await vi.waitFor(async () => { const saved = JSON.parse(await readFile(path, 'utf8')); expect(saved.prices.entries.some((p: { currency: string }) => p.currency === 'USD')).toBe(true); });
      const raw = await readFile(path, 'utf8'); expect(raw).not.toContain('synthetic-secret'); expect(raw).not.toContain('100.000001'); expect(raw).not.toContain('balance'); account.stop();
      const fetcher = vi.fn(async (url: string | URL | Request) => response(url));
      const restored = createAccountService({ getApiKey: async () => null, cachePath: path, now: () => epoch, fetch: fetcher });
      await restored.refresh(); expect(fetcher).not.toHaveBeenCalled(); expect(restored.quote('deepseek-flash', 'CNY')?.high.inputPerMillion).toBe(2); restored.stop();
      const future = parsePricing(cny, 'CNY', '2099-01-01T12:00:00+08:00'); await writeFile(path, JSON.stringify({ version: 1, prices: future }));
      const invalid = createAccountService({ getApiKey: async () => null, cachePath: path, now: () => epoch, fetch: fetcher }); await invalid.refresh(); expect(fetcher).toHaveBeenCalledTimes(2); invalid.stop();
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
});
