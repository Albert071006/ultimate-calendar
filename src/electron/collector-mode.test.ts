import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCollectorMode, type CollectorDependencies } from './collector-mode';
import type { Repository } from '../storage/repository';
import type { CaptureStore } from '../capture/store';

vi.mock('electron', () => ({ safeStorage: { isAsyncEncryptionAvailable: async () => true } }));
vi.mock('../capture/documents/runtime', () => ({ createDocumentExtractor: () => { throw Error('Tests must inject document handling'); } }));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'collector-mode-')); writeFileSync(join(root, 'planner.sqlite'), 'synthetic-existing-database');
  const repoClose = vi.fn(), storeClose = vi.fn(), dispose = vi.fn(), start = vi.fn(async () => {}), stop = vi.fn();
  const keyGet = vi.fn(async () => 'synthetic-preserved-ai-key'), bridgeGet = vi.fn(async () => 'synthetic-preserved-bridge-key'), set = vi.fn();
  let options: Parameters<NonNullable<CollectorDependencies['createCaptureService']>>[0] | undefined, busy = false;
  const warnings: string[] = [];
  const dependencies: CollectorDependencies = {
    createRepository: vi.fn(() => ({ close: repoClose }) as unknown as Repository),
    createCaptureStore: vi.fn(() => ({ close: storeClose }) as unknown as CaptureStore),
    createDocumentExtractor: () => ({ extract: vi.fn(), dispose }),
    createKeyStore: path => ({ initialize: vi.fn(async () => {}), get: path.endsWith('deepseek.bin') ? keyGet : bridgeGet, set, status: () => ({ configured: true, sessionOnly: false }) }),
    createCaptureService: value => {
      options = value;
      return { start, stop, busy: () => busy, snapshot: () => ({ connection: 'online', error: 'synthetic-private-account-error', config: { enabled: true, analysisEnabled: true } }) as ReturnType<typeof import('../capture/service').createCaptureService> extends { snapshot(): infer T } ? T : never };
    },
    fetch: async () => { throw Error('Tests must not connect real QQ or AI'); }, onWarning: code => warnings.push(code),
  };
  return { root, dependencies, repoClose, storeClose, dispose, start, stop, keyGet, bridgeGet, set, warnings, options: () => options!, busy: (value: boolean) => { busy = value; } };
}
describe('Windows collection-only backend', () => {
  it('refuses a missing source without creating a database or initializing services', async () => {
    const value = fixture();
    try {
      const missing = join(value.root, 'missing'); await expect(startCollectorMode(missing, value.dependencies)).rejects.toThrow(/未创建空白/);
      expect(existsSync(missing)).toBe(false); expect(value.dependencies.createRepository).not.toHaveBeenCalled(); expect(value.start).not.toHaveBeenCalled();
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('reuses existing encrypted keys and saved capture configuration without exposing identities', async () => {
    const value = fixture();
    try {
      const mode = await startCollectorMode(value.root, value.dependencies);
      expect(value.dependencies.createRepository).toHaveBeenCalledWith(join(value.root, 'planner.sqlite'));
      expect(value.dependencies.createCaptureStore).toHaveBeenCalledWith(join(value.root, 'planner.sqlite'));
      expect(await value.options().getApiKey()).toBe('synthetic-preserved-ai-key'); expect(await value.options().credentials.get()).toBe('synthetic-preserved-bridge-key'); expect(value.set).not.toHaveBeenCalled();
      expect(mode.status()).toEqual({ connection: 'online', error: true, enabled: true, analysisEnabled: true }); expect(JSON.stringify(mode.status())).not.toContain('private-account');
      const close = mode.close(); expect(mode.close()).toBe(close); await close;
      expect(value.stop).toHaveBeenCalledOnce(); expect(value.dispose).toHaveBeenCalledOnce(); expect(value.storeClose).toHaveBeenCalledOnce(); expect(value.repoClose).toHaveBeenCalledOnce(); expect(mode.status().connection).toBe('stopped');
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('waits for capture finalization before closing either database', async () => {
    const value = fixture(); let resume: () => void = () => {};
    value.busy(true); value.dependencies.wait = async () => new Promise<void>(done => { resume = () => { value.busy(false); done(); }; });
    try {
      const mode = await startCollectorMode(value.root, value.dependencies), closing = mode.close();
      expect(value.stop).toHaveBeenCalledOnce(); expect(value.dispose).toHaveBeenCalledOnce(); expect(value.storeClose).not.toHaveBeenCalled(); expect(value.repoClose).not.toHaveBeenCalled();
      resume(); await closing; expect(value.storeClose).toHaveBeenCalledOnce(); expect(value.repoClose).toHaveBeenCalledOnce();
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('preserves unavailable credentials and cleans startup failure without changing configuration', async () => {
    const value = fixture(); value.dependencies.createKeyStore = () => ({ initialize: async () => { throw Error('synthetic-encryption-unavailable'); }, get: async () => null, set: value.set, status: () => ({ configured: false, sessionOnly: false, loadError: 'decrypt' }) });
    value.start.mockImplementationOnce(async () => { throw Error('synthetic-start-failure'); });
    try {
      await expect(startCollectorMode(value.root, value.dependencies)).rejects.toThrow(/start-failure/);
      expect(value.warnings).toEqual(['COLLECTOR_AI_CREDENTIAL_UNAVAILABLE', 'COLLECTOR_QQ_CREDENTIAL_UNAVAILABLE']); expect(value.set).not.toHaveBeenCalled(); expect(value.stop).toHaveBeenCalledOnce(); expect(value.dispose).toHaveBeenCalledOnce(); expect(value.storeClose).toHaveBeenCalledOnce(); expect(value.repoClose).toHaveBeenCalledOnce();
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('cancels stalled model work after grace and waits for its batch finalizer before closing', async () => {
    const value = fixture(); let entered: () => void = () => {}, signal: AbortSignal | undefined;
    const started = new Promise<void>(done => { entered = done; }); value.dependencies.shutdownGraceMs = 0;
    value.dependencies.fetch = async (_url, init) => { signal = init?.signal ?? undefined; entered(); return new Promise<Response>(() => {}); };
    try {
      const mode = await startCollectorMode(value.root, value.dependencies); value.busy(true);
      const options = value.options();
      const work = options.runModel!(() => options.fetch!('https://synthetic.invalid')).catch(error => error).finally(() => value.busy(false));
      await started; const closing = mode.close(); expect(value.storeClose).not.toHaveBeenCalled();
      expect(await work).toMatchObject({ code: 'CANCELLED' }); await closing;
      expect(signal?.aborted).toBe(true); expect(value.storeClose).toHaveBeenCalledOnce(); expect(value.repoClose).toHaveBeenCalledOnce();
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('keeps databases open when stop or document cancellation fails and allows retrying close', async () => {
    for (const phase of ['stop', 'dispose'] as const) {
      const value = fixture(); value[phase].mockImplementationOnce(() => { throw Error('synthetic-close-failure'); });
      try {
        const mode = await startCollectorMode(value.root, value.dependencies);
        await expect(mode.close()).rejects.toThrow(/数据库保持打开/);
        expect(value.storeClose).not.toHaveBeenCalled(); expect(value.repoClose).not.toHaveBeenCalled();
        expect(value.warnings).toContain(phase === 'stop' ? 'COLLECTOR_STOP_FAILED' : 'COLLECTOR_DOCUMENT_DISPOSE_FAILED');
        await mode.close(); expect(value.storeClose).toHaveBeenCalledOnce(); expect(value.repoClose).toHaveBeenCalledOnce();
      } finally { rmSync(value.root, { recursive: true, force: true }); }
    }
  });
});
