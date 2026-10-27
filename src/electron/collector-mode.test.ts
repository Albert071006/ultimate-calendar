import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCollectorMode, type CollectorDependencies } from './collector-mode';
import type { Repository } from '../storage/repository';
import type { CaptureStore } from '../capture/store';
import { CaptureSnapshotSchema } from '../shared/capture';
import { SpaceSnapshotSchema } from '../shared/space';

vi.mock('electron', () => ({ app: { isPackaged: false }, safeStorage: { isAsyncEncryptionAvailable: async () => true } }));
vi.mock('../capture/documents/runtime', () => ({ createDocumentExtractor: () => { throw Error('Tests must inject document handling'); } }));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'collector-mode-')); writeFileSync(join(root, 'planner.sqlite'), 'synthetic-existing-database');
  const repoClose = vi.fn(), storeClose = vi.fn(), dispose = vi.fn(), start = vi.fn(async () => {}), stop = vi.fn();
  const keyGet = vi.fn(async () => 'synthetic-preserved-ai-key'), bridgeGet = vi.fn(async () => 'synthetic-preserved-bridge-key'), set = vi.fn();
  let options: Parameters<NonNullable<CollectorDependencies['createCaptureService']>>[0] | undefined, busy = false;
  const warnings: string[] = [];
  const dependencies: CollectorDependencies = {
    createRepository: vi.fn(() => ({ close: repoClose }) as unknown as Repository),
    createCaptureStore: vi.fn((_path, options) => ({ close: options?.platform === 'wechat' ? vi.fn() : storeClose }) as unknown as CaptureStore),
    createDocumentExtractor: () => ({ extract: vi.fn(), dispose }),
    createKeyStore: path => ({ initialize: vi.fn(async () => {}), get: path.endsWith('deepseek.bin') ? keyGet : bridgeGet, set, status: () => ({ configured: true, sessionOnly: false }) }),
    createCaptureService: value => {
      if (value.platform === 'wechat') return { start: vi.fn(async () => {}), stop: vi.fn(), busy: () => false, snapshot: () => CaptureSnapshotSchema.parse({ config: {}, connection: 'disconnected', accountLabel: null, error: null, lastReceivedAt: null, credentialConfigured: false, stats: { messages: 0, attachments: 0, attachmentBytes: 0, pendingMessages: 0, batches: 0, pendingBatches: 0, uncertainBatches: 0, failedAttachments: 0 }, coverage: [] }) };
      options = value;
      return { start, stop, busy: () => busy, snapshot: () => ({ connection: 'online', error: 'synthetic-private-account-error', config: { enabled: true, analysisEnabled: true } }) as ReturnType<typeof import('../capture/service').createCaptureService> extends { snapshot(): infer T } ? T : never };
    },
    fetch: async () => { throw Error('Tests must not connect real QQ or AI'); }, onWarning: code => warnings.push(code),
  };
  return { root, dependencies, repoClose, storeClose, dispose, start, stop, keyGet, bridgeGet, set, warnings, options: () => options!, busy: (value: boolean) => { busy = value; } };
}
describe('Windows collection-only backend', () => {
  it('owns cloud synchronization independently of UI subscribers and exposes only its metadata', async () => {
    const value = fixture(), original = value.dependencies.createCaptureService!;
    const snapshot = CaptureSnapshotSchema.parse({ config: {}, connection: 'disconnected', accountLabel: null, error: null, lastReceivedAt: null, credentialConfigured: true,
      stats: { messages: 0, attachments: 0, attachmentBytes: 0, pendingMessages: 0, batches: 0, pendingBatches: 0, uncertainBatches: 0, failedAttachments: 0 }, coverage: [] });
    const credentialsChanged = vi.fn(async () => snapshot);
    value.dependencies.createCaptureService = options => options.platform === 'wechat' ? original(options) : ({ ...original(options), snapshot: () => snapshot, credentialsChanged });
    const state = { state: 'ready' as const, configured: true, revision: '33333333-3333-4333-8333-333333333333', lastSyncedAt: new Date(0).toISOString(), message: null };
    const startSync = vi.fn(), refresh = vi.fn(async () => {}), getApiKey = vi.fn(async () => 'synthetic-cloud-exclusive-key');
    let release: () => void = () => {};
    const closeSync = vi.fn(() => new Promise<void>(done => { release = done; }));
    let syncOptions: Parameters<NonNullable<CollectorDependencies['createCollectorKeySync']>>[0] | undefined;
    value.dependencies.createCollectorKeySync = options => { syncOptions = options; return { start: startSync, refresh, getApiKey, status: () => state, close: closeSync }; };
    try {
      const mode = await startCollectorMode(value.root, value.dependencies); expect(startSync).toHaveBeenCalledOnce();
      expect(await value.options().getApiKey()).toBe('synthetic-cloud-exclusive-key'); expect(value.keyGet).not.toHaveBeenCalled();
      expect(await mode.api.invoke('captureSetApiKey', { key: 'synthetic-manual-replacement' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } }); expect(value.set).not.toHaveBeenCalled();
      expect(await mode.api.invoke('captureRefreshApiKey')).toMatchObject({ ok: true, data: { cloudKeySync: state } }); expect(refresh).toHaveBeenCalledOnce();
      expect(await mode.api.invoke('captureRefreshApiKey', { key: 'synthetic-wrong-input' })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      const listener = vi.fn(), unsubscribe = mode.subscribe(listener); syncOptions!.onStatusChanged!(); expect(listener).toHaveBeenCalledWith({ ...snapshot, cloudKeySync: state });
      unsubscribe(); await syncOptions!.onChanged!({ previousRevision: undefined, revision: state.revision, configured: true, sourceId: 'a'.repeat(64) });
      expect(credentialsChanged).toHaveBeenCalledExactlyOnceWith({ configured: true, revision: state.revision, sourceId: 'a'.repeat(64) });
      expect(JSON.stringify(await mode.api.invoke('captureSnapshot'))).not.toContain('synthetic-cloud-exclusive-key');
      const closing = mode.close(); expect(closeSync).toHaveBeenCalledOnce(); expect(value.repoClose).not.toHaveBeenCalled(); release(); await closing;
      expect(value.repoClose).toHaveBeenCalledOnce(); expect(value.stop).toHaveBeenCalledOnce();
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('keeps collection alive while invalid cloud configuration blocks old-key fallback', async () => {
    const value = fixture(); mkdirSync(join(value.root, 'credentials')); writeFileSync(join(value.root, 'credentials', 'cloud-key-sync.json'), '{invalid synthetic config}', { mode: 0o600 });
    try {
      const mode = await startCollectorMode(value.root, value.dependencies); expect(value.start).toHaveBeenCalledOnce();
      await expect(value.options().getApiKey()).rejects.toMatchObject({ code: 'CANCELLED' }); expect(value.keyGet).not.toHaveBeenCalled(); expect(value.set).not.toHaveBeenCalled();
      expect(await mode.api.invoke('captureSetApiKey', { key: 'synthetic-manual-replacement' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await mode.close(); expect(value.repoClose).toHaveBeenCalledOnce();
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('updates only the local AI key through the existing encrypted owner without returning its value', async () => {
    const value = fixture(); value.set.mockResolvedValue({ configured: true, sessionOnly: false });
    try {
      const mode = await startCollectorMode(value.root, value.dependencies);
      const key = 'synthetic-repaired-capture-key';
      const result = await mode.api.invoke('captureSetApiKey', { key });
      expect(result).toEqual({ ok: true, data: { configured: true, sessionOnly: false } });
      expect(value.set).toHaveBeenCalledExactlyOnceWith(key);
      expect(JSON.stringify(result)).not.toContain(key);
      expect(await mode.api.invoke('captureSetApiKey', { key: 123 })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      expect(value.set).toHaveBeenCalledTimes(1); await mode.close();
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('preserves the old capture key when secure persistence is unavailable', async () => {
    const value = fixture();
    value.dependencies.encryption = { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: vi.fn(), decryptStringAsync: vi.fn() };
    try {
      const mode = await startCollectorMode(value.root, value.dependencies);
      expect(await mode.api.invoke('captureSetApiKey', { key: 'synthetic-repaired-capture-key' })).toMatchObject({ ok: false, error: { code: 'STORAGE' } });
      expect(value.set).not.toHaveBeenCalled(); await mode.close();
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('runs storage management in the collector owner and drains cleanup before closing its databases', async () => {
    const value = fixture(); let cleaning = false, release: () => void = () => {}, managerBusy: () => boolean = () => false;
    const storage = SpaceSnapshotSchema.parse({ policy: {}, backupDirectory: value.root, databaseBytes: 0, reusableBytes: 0, cacheBytes: 0, backupBytes: 0, managedBackupBytes: 0, unmanagedBackupBytes: 0, backupCount: 0, removableBackupCount: 0, removableBackupBytes: 0, lastRunAt: null, lastResult: null, warnings: [],
      attachments: { totalBytes: 0, eligibleBytes: 0, protectedBytes: 0, reclaimableBytes: 0, remainingBytes: 0, selectedAttachments: 0, protectedAttachments: 0, overBudgetBytes: 0 } });
    const storageStart = vi.fn(), storageStop = vi.fn(), configure = vi.fn(() => storage);
    value.dependencies.createSpaceManager = options => {
      expect(options.directory).toBe(value.root); managerBusy = options.isBusy;
      return { snapshot: () => storage, configure, isRunning: () => cleaning, start: storageStart, stop: storageStop,
        cleanup: async () => { expect(managerBusy()).toBe(false); cleaning = true; await new Promise<void>(done => { release = done; }); cleaning = false; return storage; } };
    };
    try {
      const mode = await startCollectorMode(value.root, value.dependencies); expect(storageStart).toHaveBeenCalledOnce();
      expect(await mode.api.invoke('spaceSnapshot')).toMatchObject({ ok: true, data: storage });
      expect(await mode.api.invoke('spaceConfigure', storage.policy)).toMatchObject({ ok: true }); expect(configure).toHaveBeenCalledOnce();
      const cleanup = mode.api.invoke('spaceCleanup', {});
      expect(await mode.api.invoke('captureSnapshot')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      const closing = mode.close(); expect(value.repoClose).not.toHaveBeenCalled(); expect(storageStop).toHaveBeenCalledOnce();
      release(); expect(await cleanup).toMatchObject({ ok: true }); await closing; expect(value.repoClose).toHaveBeenCalledOnce();
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
  it('routes bounded capture controls through the existing owner and rejects arbitrary methods', async () => {
    const value = fixture(); const original = value.dependencies.createCaptureService!;
    const snapshot = CaptureSnapshotSchema.parse({ config: {}, connection: 'disconnected', accountLabel: null, error: null, lastReceivedAt: null, credentialConfigured: true,
      stats: { messages: 0, attachments: 0, attachmentBytes: 0, pendingMessages: 0, batches: 0, pendingBatches: 0, uncertainBatches: 0, failedAttachments: 0 }, coverage: [] });
    const configure = vi.fn(async () => snapshot), messages = vi.fn(() => ({ items: [], total: 0, offset: 0, limit: 30 }));
    value.dependencies.createCaptureService = options => ({ ...original(options), snapshot: () => snapshot, configure, messages });
    try {
      const mode = await startCollectorMode(value.root, value.dependencies);
      expect(await mode.api.invoke('captureSnapshot')).toMatchObject({ ok: true, data: snapshot });
      expect(await mode.api.invoke('captureConfigure', snapshot.config)).toMatchObject({ ok: true }); expect(configure).toHaveBeenCalledOnce();
      expect(await mode.api.invoke('captureMessages', {})).toMatchObject({ ok: true }); expect(messages).toHaveBeenCalledOnce();
      expect(await mode.api.invoke('captureMessages', { limit: 1000 })).toMatchObject({ ok: false, error: { code: 'VALIDATION' } }); expect(messages).toHaveBeenCalledOnce();
      expect(await mode.api.invoke('mutate', {})).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
      const observer = vi.fn(); const unsubscribe = mode.subscribe(observer); value.options().onChanged!(snapshot); expect(observer).toHaveBeenCalledOnce(); unsubscribe();
      await mode.close(); expect(await mode.api.invoke('captureSnapshot')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(value.dependencies.createRepository).toHaveBeenCalledOnce(); expect(value.dependencies.createCaptureStore).toHaveBeenCalledTimes(2);
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
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


describe('WeChat collector lifecycle', () => {
  it('routes the second collector independently and waits for its pending work before closing SQLite', async () => {
    const value = fixture(), original = value.dependencies.createCaptureService!;
    let wechatBusy = false;
    const state = CaptureSnapshotSchema.parse({ platform: 'wechat', config: { platform: 'wechat', accountId: 'wechat:synthetic-user', groupIds: [] }, connection: 'online', accountLabel: '微信 · test', accountName: '合成账号', error: null, lastReceivedAt: null, credentialConfigured: true, stats: { messages: 0, attachments: 0, attachmentBytes: 0, pendingMessages: 0, batches: 0, pendingBatches: 0, uncertainBatches: 0, failedAttachments: 0 }, coverage: [] });
    const groups = vi.fn(async () => [{ id: 'test@chatroom', name: '合成微信群' }]), stopWechat = vi.fn();
    value.dependencies.createCaptureService = options => options.platform === 'wechat'
      ? { ...original(options), snapshot: () => state, groups, busy: () => wechatBusy, stop: stopWechat }
      : original(options);
    try {
      const mode = await startCollectorMode(value.root, value.dependencies);
      expect(await mode.api.invoke('wechatCaptureSnapshot')).toMatchObject({ ok: true, data: { platform: 'wechat', config: { accountId: 'wechat:synthetic-user' } } });
      expect(await mode.api.invoke('wechatCaptureGroups')).toMatchObject({ ok: true, data: [{ id: 'test@chatroom' }] });
      expect(groups).toHaveBeenCalledOnce();
      expect(value.dependencies.createCaptureStore).toHaveBeenCalledWith(join(value.root, 'planner.sqlite'), { platform: 'wechat' });
      wechatBusy = true;
      const closing = mode.close();
      expect(stopWechat).toHaveBeenCalledOnce();
      expect(value.storeClose).not.toHaveBeenCalled();
      wechatBusy = false;
      await closing;
      expect(value.storeClose).toHaveBeenCalledOnce();
      expect(value.repoClose).toHaveBeenCalledOnce();
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
});
