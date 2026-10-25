import { existsSync, realpathSync } from 'node:fs';
import { DistilledResultSchema, type DistilledRequest, type DistilledResult } from '../shared/distilled';
import { RemoteIdentitySchema, type RemoteIdentity } from '../shared/remote';
import { BridgeFault, normalizeBridgeOrigin, parseBridgeConfig, type BridgeConfigInput, type BridgeIssue } from './config';
import { createCandidateReader } from './source-reader';
import { createBridgeOutbox, type OutboxStats } from './outbox';
import { distilledHash } from './projection';

export interface BridgeTransport {
  readonly origin: string;
  getSession(): Promise<{ identity: RemoteIdentity; deviceId: string }>;
  sendDistilled(input: DistilledRequest, options?: { signal?: AbortSignal }): Promise<DistilledResult>;
}
export interface BridgeCycle {
  examined: number; privacyRejected: number; schemaRejected: number; queued: number; duplicates: number; accepted: number;
  issue: BridgeIssue | null; outbox: OutboxStats;
}
export interface BridgeOptions { now?: () => number; onStatus?: (value: BridgeCycle) => void }
function failure(error: unknown): { issue: BridgeIssue; status: number; retryAfterMs: number } {
  if (error instanceof BridgeFault) return { issue: error.code, status: 0, retryAfterMs: 0 };
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 0;
  const retry = error && typeof error === 'object' && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number' ? error.retryAfterMs : 0;
  return { issue: status === 401 || status === 403 ? 'auth' : status === 409 ? 'conflict' : status === 400 || status === 413 || status === 422 ? 'validation' : 'network', status, retryAfterMs: Number.isFinite(retry) ? Math.min(86_400_000, Math.max(0, retry)) : 0 };
}
const equalIdentity = (a: RemoteIdentity, b: RemoteIdentity) => a.protocolVersion === b.protocolVersion && a.dataInstanceId === b.dataInstanceId && a.generation === b.generation;

/** Opens only the explicitly configured source. No QQ connection, capture recovery, AI request or database migration. */
export function createQQCloudBridge(input: BridgeConfigInput, remote: BridgeTransport, options: BridgeOptions = {}) {
  const config = parseBridgeConfig(input); if (!config.enabled) throw new BridgeFault('configuration');
  if (normalizeBridgeOrigin(remote.origin) !== config.origin) throw new BridgeFault('identity');
  const now = options.now ?? Date.now;
  const source = createCandidateReader(config.sourceDatabase);
  let opened: ReturnType<typeof createBridgeOutbox> | undefined;
  let outbox: ReturnType<typeof createBridgeOutbox>;
  try {
    // Resolve aliases before opening any write connection to the outbox.
    if (existsSync(config.outboxDatabase)) {
      const path = realpathSync(config.outboxDatabase); const fingerprint = distilledHash(process.platform === 'win32' ? path.toLowerCase() : path);
      if (fingerprint === source.fingerprint) throw new BridgeFault('configuration');
    }
    outbox = opened = createBridgeOutbox(config.outboxDatabase);
    outbox.bind(distilledHash({ source: source.fingerprint, origin: config.origin, identity: config.identity, device: config.deviceId }));
  } catch (error) { opened?.close(); source.close(); throw error instanceof BridgeFault ? error : new BridgeFault('storage'); }
  let running: Promise<BridgeCycle> | undefined; let timer: ReturnType<typeof setInterval> | undefined; let stopped = false; let closed = false;
  let lifetime = new AbortController();
  function emit(value: BridgeCycle) { try { options.onStatus?.(structuredClone(value)); } catch { /* observer errors never change a durable receipt */ } }
  async function cycle(): Promise<BridgeCycle> {
    const result: BridgeCycle = { examined: 0, privacyRejected: 0, schemaRejected: 0, queued: 0, duplicates: 0, accepted: 0, issue: null, outbox: { pending: 0, sending: 0, accepted: 0, blocked: 0 } };
    try {
      result.outbox = outbox.stats();
      if (stopped || lifetime.signal.aborted) throw new BridgeFault('stopped');
      let cursor = outbox.cursor();
      for (let pageNumber = 0; pageNumber < config.maxPagesPerTick; pageNumber++) {
        const page = source.scan(cursor, config.scanBatchSize); cursor = page.done ? 0 : page.cursor;
        const saved = outbox.enqueue(page.items, config.identity, now(), cursor);
        result.examined += page.examined; result.privacyRejected += page.privacyRejected; result.schemaRejected += page.schemaRejected;
        result.queued += saved.inserted; result.duplicates += saved.duplicates;
        if (page.done) break;
      }
      if (normalizeBridgeOrigin(remote.origin) !== config.origin) throw new BridgeFault('identity');
      const session = await remote.getSession(); const identity = RemoteIdentitySchema.safeParse(session.identity);
      if (!identity.success || session.deviceId !== config.deviceId || !equalIdentity(identity.data, config.identity)) throw new BridgeFault('identity');
      for (let count = 0; count < 100 && !stopped; count++) {
        const item = outbox.claim(now()); if (!item) break;
        if (!equalIdentity(item.request.identity, config.identity)) { outbox.block(item, 'identity'); result.issue = 'identity'; break; }
        try {
          const value = DistilledResultSchema.safeParse(await remote.sendDistilled(item.request, { signal: lifetime.signal }));
          // Never persist service-provided text or IDs. A single-item request needs exactly one opaque candidate receipt.
          if (!value.success || value.data.candidateIds.length !== 1 || !/^distilled-candidate:[a-f0-9]{64}$/.test(value.data.candidateIds[0]!) || value.data.created > 1) throw new BridgeFault('protocol');
          if (!outbox.accepted(item, now())) throw new BridgeFault('storage'); result.accepted++;
        } catch (error) {
          const failed = failure(error); result.issue = stopped ? 'stopped' : failed.issue;
          if (['validation', 'conflict'].includes(failed.issue) || failed.status === 404) {
            outbox.block(item, failed.status === 404 ? 'configuration' : failed.issue); continue;
          }
          const delay = Math.max(failed.retryAfterMs, Math.min(900_000, 5000 * 2 ** Math.min(item.attempts - 1, 8)));
          outbox.retry(item, now() + (stopped ? 0 : delay), result.issue); break;
        }
      }
    } catch (error) {
      const failed = failure(error); result.issue = failed.status === 409 ? 'identity' : failed.issue;
    }
    try { result.outbox = outbox.stats(); } catch { result.issue = 'storage'; }
    emit(result); return result;
  }
  function once(): Promise<BridgeCycle> {
    if (closed || stopped) return Promise.reject(new BridgeFault('stopped'));
    if (running) return running; running = cycle().finally(() => { running = undefined; }); return running;
  }
  return {
    once,
    status: (): OutboxStats => outbox.stats(),
    start() {
      if (closed) throw new BridgeFault('stopped'); if (timer) return;
      stopped = false; lifetime = new AbortController();
      const check = () => { void once().catch(() => { /* a fixed status is emitted by each ordinary cycle */ }); };
      check(); timer = setInterval(check, config.pollSeconds * 1000);
    },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; lifetime.abort(); await running; },
    async close() { if (!closed) { await this.stop(); closed = true; source.close(); outbox.close(); } },
  };
}
export async function runBridgeOnce(config: BridgeConfigInput, remote: BridgeTransport, options?: BridgeOptions): Promise<BridgeCycle> {
  const bridge = createQQCloudBridge(config, remote, options); try { return await bridge.once(); } finally { await bridge.close(); }
}
export function runBridge(config: BridgeConfigInput, remote: BridgeTransport, options?: BridgeOptions) {
  const bridge = createQQCloudBridge(config, remote, options); bridge.start(); return bridge;
}
