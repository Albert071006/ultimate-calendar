import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { AccountStateSchema, BalanceInfoSchema, ModelInfoSchema, PriceCatalogSchema, emptyAccountState,
  type AccountState, type BalanceInfo, type ModelInfo, type PriceCatalog, type PriceQuote } from '../shared/account';
import { parsePricing, PRICE_URLS } from './pricing';

const MODEL_TTL = 6 * 60 * 60_000, PRICE_TTL = 24 * 60 * 60_000;
const CACHE_SCHEMA = z.strictObject({ version: z.literal(1), prices: PriceCatalogSchema });
const ModelsResponse = z.object({ object: z.literal('list'), data: z.array(z.object({
  id: z.string().trim().min(1).max(100), object: z.literal('model'), owned_by: z.string().max(200),
  name: z.string().min(1).max(200).optional(), context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(), input_modalities: z.array(z.string().min(1).max(30)).max(20).optional(),
})).max(500) });
const decimal = z.string().max(80).regex(/^-?\d+(?:\.\d+)?$/);
const BalanceResponse = z.object({ is_available: z.boolean(), balance_infos: z.array(z.object({
  currency: z.enum(['CNY', 'USD']), total_balance: decimal, granted_balance: decimal, topped_up_balance: decimal,
})).max(10) });
type Kind = 'models' | 'balance' | 'CNY' | 'USD';
type Attempt = { controller: AbortController; generation: number; promise: Promise<void> };
type Health = { failures: number; retryAt: number; error: string | null; updatedAt: string | null };
export interface AccountServiceOptions {
  getApiKey(): Promise<string | null>;
  fetch?: typeof fetch;
  now?(): number;
  onChanged?(state: AccountState): void;
  isVisible?(): boolean;
  cachePath?: string;
  /** Injectable request deadline for deterministic transport tests. */
  timeoutMs?: number;
}
class AccountFailure extends Error {
  constructor(message: string, readonly slowRetry = false) { super(message); }
}
const instant = (value: number) => new Date(value + 8 * 60 * 60_000).toISOString().replace('Z', '+08:00');
const newHealth = (): Health => ({ failures: 0, retryAt: 0, error: null, updatedAt: null });
/** Main-process only. The sole persistent cache contains public prices, never account data. */
export function createAccountService(options: AccountServiceOptions) {
  const now = options.now ?? Date.now, transport = options.fetch ?? fetch;
  let state = emptyAccountState(), generation = 0, stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cacheLoad: Promise<void> | undefined, cacheWrite = Promise.resolve();
  let queuedBalance: { generation: number; promise: Promise<void> } | undefined;
  const inFlight = new Map<Kind, Attempt>();
  const health: Record<Kind, Health> = { models: newHealth(), balance: newHealth(), CNY: newHealth(), USD: newHealth() };
  const catalogs: Partial<Record<'CNY' | 'USD', PriceCatalog>> = {};
  function snapshot(): AccountState { return AccountStateSchema.parse(state); }
  function emit() { try { options.onChanged?.(snapshot()); } catch { /* UI shutdown must not disrupt the scheduler. */ } }
  function pricesState() {
    const entries = [...(catalogs.CNY?.entries ?? []), ...(catalogs.USD?.entries ?? [])];
    const times = [health.CNY.updatedAt, health.USD.updatedAt].filter((t): t is string => !!t);
    state.prices = {
      data: entries.length ? { entries, rule: catalogs.CNY?.rule ?? catalogs.USD?.rule ?? '' } : null,
      updatedAt: times.length ? times.reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b) : null,
      loading: inFlight.has('CNY') || inFlight.has('USD'),
      error: (['CNY', 'USD'] as const).filter(c => health[c].error).map(c => `${c}：${health[c].error}`).join('；') || null,
    };
  }
  function loadCache(): Promise<void> {
    return cacheLoad ??= (async () => {
      if (!options.cachePath) return;
      try {
        if ((await stat(options.cachePath)).size > 500_000) return;
        const parsed = CACHE_SCHEMA.parse(JSON.parse(await readFile(options.cachePath, 'utf8')));
        for (const currency of ['CNY', 'USD'] as const) {
          const entries = parsed.prices.entries.filter(p => p.currency === currency);
          if (!entries.length || catalogs[currency] || entries.some(p => Date.parse(p.updatedAt) > now() + 60_000)) continue;
          if (new Set(entries.map(e => e.model)).size !== entries.length) continue;
          catalogs[currency] = { entries, rule: parsed.prices.rule };
          health[currency].updatedAt = entries.reduce((a, b) => Date.parse(a.updatedAt) < Date.parse(b.updatedAt) ? a : b).updatedAt;
        }
        pricesState(); if (!stopped) emit();
      } catch { /* A missing or invalid public cache simply causes a fresh fetch. */ }
    })();
  }
  function persistPrices() {
    if (!options.cachePath || !state.prices.data) return;
    const path = options.cachePath, payload = JSON.stringify({ version: 1, prices: state.prices.data });
    cacheWrite = cacheWrite.then(async () => {
      try { await mkdir(dirname(path), { recursive: true }); await writeFile(`${path}.tmp`, payload, 'utf8'); await rename(`${path}.tmp`, path); }
      catch { /* A cache write failure cannot turn a successful price query into a failure. */ }
    });
  }
  async function readResponse(url: string, key: string | null, controller: AbortController): Promise<string> {
    const limit = key ? 256_000 : 2_000_000;
    const response = await transport(url, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: key ? { Authorization: `Bearer ${key}`, Accept: 'application/json' } : { Accept: 'text/html' },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new AccountFailure('密钥无效或无查询权限，请检查后重新保存', true);
      if (response.status === 429) throw new AccountFailure('查询过于频繁，将稍后重试');
      throw new AccountFailure(response.status >= 500 ? '官方服务暂时不可用，将稍后重试' : '官方接口暂不支持此查询，请稍后刷新');
    }
    const size = response.headers.get('content-length');
    if (size && Number(size) > limit) { void response.body?.cancel().catch(() => {}); throw new AccountFailure('官方响应过大，未采用本次结果'); }
    if (!response.body) throw new AccountFailure('官方返回空响应，未采用本次结果');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    const cancelBody = () => { void reader.cancel().catch(() => {}); };
    if (controller.signal.aborted) cancelBody(); else controller.signal.addEventListener('abort', cancelBody, { once: true });
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) { void reader.cancel().catch(() => {}); throw new AccountFailure('官方响应过大，未采用本次结果'); }
        chunks.push(value);
      }
    } finally { controller.signal.removeEventListener('abort', cancelBody); reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  }
  async function request(url: string, key: string | null, controller: AbortController): Promise<string> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      return await Promise.race([
        readResponse(url, key, controller),
        new Promise<never>((_resolve, reject) => {
          aborted = () => reject(new AccountFailure('查询已中止，将稍后重试'));
          if (controller.signal.aborted) aborted(); else controller.signal.addEventListener('abort', aborted, { once: true });
          deadline = setTimeout(() => { reject(new AccountFailure('查询超时，将稍后重试')); controller.abort(); }, options.timeoutMs ?? 20_000);
        }),
      ]);
    } finally { if (deadline) clearTimeout(deadline); if (aborted) controller.signal.removeEventListener('abort', aborted); }
  }
  function due(kind: Kind, force: boolean): boolean {
    if (force) return true;
    const status = health[kind];
    if (status.error) return now() >= status.retryAt;
    const ttl = kind === 'models' ? MODEL_TTL : kind === 'balance' ? (options.isVisible?.() === false ? 300_000 : 30_000) : PRICE_TTL;
    return !status.updatedAt || now() - Date.parse(status.updatedAt) >= ttl;
  }
  function run(kind: Kind, key: string | null, force: boolean, currentGeneration: number): Promise<void> {
    const existing = inFlight.get(kind); if (existing) return existing.promise;
    if (stopped || generation !== currentGeneration || !due(kind, force)) return Promise.resolve();
    const controller = new AbortController();
    // Defer work until the slot is installed so synchronous injected transports still share one request.
    const attempt: Attempt = { controller, generation: currentGeneration, promise: Promise.resolve() };
    inFlight.set(kind, attempt);
    if (kind === 'models' || kind === 'balance') state[kind].loading = true; else pricesState();
    emit();
    attempt.promise = Promise.resolve().then(async () => {
      try {
        const url = kind === 'models' ? 'https://api.deepseek.com/models' : kind === 'balance' ? 'https://api.deepseek.com/user/balance' : PRICE_URLS[kind];
        const body = await request(url, key, controller);
        if (stopped || generation !== currentGeneration) return;
        const updatedAt = instant(now());
        if (kind === 'models') {
          const result = ModelsResponse.parse(JSON.parse(body));
          const models: ModelInfo[] = result.data.map(m => ModelInfoSchema.parse({ id: m.id, name: m.name,
            contextWindow: m.context_window, maxOutputTokens: m.max_output_tokens, inputModalities: m.input_modalities }));
          if (new Set(models.map(m => m.id)).size !== models.length) throw new AccountFailure('官方模型列表包含重复项，未采用本次结果');
          state.models = { data: models, updatedAt, error: null, loading: true };
        } else if (kind === 'balance') {
          const result = BalanceResponse.parse(JSON.parse(body));
          const balance: BalanceInfo = BalanceInfoSchema.parse({ isAvailable: result.is_available,
            balances: result.balance_infos.map(b => ({ currency: b.currency, total: b.total_balance, granted: b.granted_balance, toppedUp: b.topped_up_balance })) });
          state.balance = { data: balance, updatedAt, error: null, loading: true };
        } else catalogs[kind] = parsePricing(body, kind, updatedAt);
        health[kind] = { failures: 0, retryAt: 0, error: null, updatedAt };
      } catch (error) {
        if (stopped || generation !== currentGeneration) return;
        const status = health[kind], failures = status.failures + 1;
        const message = error instanceof AccountFailure ? error.message : error instanceof z.ZodError || error instanceof SyntaxError
          ? '官方响应格式已改变，未采用本次结果' : kind === 'CNY' || kind === 'USD'
            ? '价格页无法读取或格式已改变，保留上次价格' : '网络连接失败，将稍后重试';
        const delay = error instanceof AccountFailure && error.slowRetry ? 5 * 60_000 : Math.min(30 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 6));
        health[kind] = { ...status, error: message, failures, retryAt: now() + delay };
        if (kind === 'models' || kind === 'balance') state[kind].error = message;
      } finally {
        if (inFlight.get(kind) === attempt) inFlight.delete(kind);
        if (!stopped && generation === currentGeneration) {
          if (kind === 'models' || kind === 'balance') state[kind].loading = false;
          else { pricesState(); if (!health[kind].error) persistPrices(); }
          emit();
        }
      }
    });
    return attempt.promise;
  }
  async function refresh(requestOptions: { force?: boolean; balanceOnly?: boolean } = {}): Promise<AccountState> {
    if (stopped) return snapshot();
    const currentGeneration = generation;
    await loadCache();
    if (stopped || generation !== currentGeneration) return snapshot();
    let key: string | null;
    try { key = await options.getApiKey(); }
    catch {
      if (generation === currentGeneration && !stopped) {
        state.configured = false; state.models = { data: null, updatedAt: null, loading: false, error: '无法读取密钥，请重新保存' };
        state.balance = { ...state.models, data: null }; emit();
      }
      key = null;
    }
    if (stopped || generation !== currentGeneration) return snapshot();
    const configured = !!key;
    if (state.configured !== configured) { state.configured = configured; emit(); }
    const force = requestOptions.force ?? false;
    const tasks: Promise<void>[] = [];
    if (key) {
      const runningBalance = inFlight.get('balance');
      if (force && requestOptions.balanceOnly && runningBalance) {
        // A query that started before a model call completed may return its old balance.
        // Coalesce all post-usage requests into one subsequent read, not an unbounded queue.
        if (!queuedBalance || queuedBalance.generation !== currentGeneration) {
          const capturedKey = key;
          const queued = { generation: currentGeneration, promise: Promise.resolve() };
          queued.promise = runningBalance.promise.then(() => {
            // Once the queued request starts, a later AI completion may queue one more
            // read after it; at any instant there is still at most one waiting read.
            if (queuedBalance === queued) queuedBalance = undefined;
            return run('balance', capturedKey, true, currentGeneration);
          })
            .finally(() => { if (queuedBalance === queued) queuedBalance = undefined; });
          queuedBalance = queued;
        }
        tasks.push(queuedBalance.promise);
      } else tasks.push(run('balance', key, force, currentGeneration));
      if (!requestOptions.balanceOnly) tasks.push(run('models', key, force, currentGeneration));
    }
    if (!requestOptions.balanceOnly) tasks.push(run('CNY', null, force, currentGeneration), run('USD', null, force, currentGeneration));
    await Promise.all(tasks); await cacheWrite; return snapshot();
  }
  function resetKey() {
    generation++; queuedBalance = undefined;
    for (const request of inFlight.values()) request.controller.abort(); inFlight.clear();
    health.models = newHealth(); health.balance = newHealth();
    state.configured = false; state.models = emptyAccountState().models; state.balance = emptyAccountState().balance;
    pricesState(); emit(); if (!stopped) void refresh();
  }
  function start() {
    if (timer) return; stopped = false;
    timer = setInterval(() => { void refresh(); }, 30_000); timer.unref?.(); void refresh();
  }
  function stop() {
    stopped = true; generation++; queuedBalance = undefined; if (timer) clearInterval(timer); timer = undefined;
    for (const request of inFlight.values()) request.controller.abort(); inFlight.clear();
    state.models.loading = false; state.balance.loading = false; pricesState();
  }
  function quote(model: string, currency: 'CNY' | 'USD'): PriceQuote | null {
    const result = catalogs[currency]?.entries.find(entry => entry.model === model);
    if (!result || health[currency].error || now() - Date.parse(result.updatedAt) >= PRICE_TTL || Date.parse(result.updatedAt) > now()) return null;
    return { ...structuredClone(result), model };
  }
  return { snapshot, refresh, resetKey, start, stop, quote };
}
