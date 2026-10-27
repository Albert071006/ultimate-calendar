import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { safeStorage, session, shell } from 'electron';
import { z } from 'zod';
import { createRepository, type Repository } from '../storage/repository';
import { createCaptureStore, type CaptureStore } from '../capture/store';
import { createCaptureService } from '../capture/service';
import { createLocalWechatBridge, wechatCredentials } from './wechat-runtime';
import { createDocumentExtractor } from '../capture/documents/runtime';
import { createKeyStore, type AsyncEncryption } from './key-store';
import { createModelRequestQueue } from '../ai/request-queue';
import { createAccountService } from '../ai/account';
import { safeError, WorkflowError } from '../ai/deepseek';
import { CaptureSnapshotSchema, type CaptureSnapshot } from '../shared/capture';
import { apiResultSchema, KeyStatusSchema, SetApiKeyRequestSchema, type ApiResult } from '../shared/contracts';
import { requests, responses, type Method } from './protocol';
import { createLocalEvidenceResolver, LocalSourceEvidenceRequestSchema, LocalSourceEvidenceResultSchema } from './local-evidence';
import { combinedCaptureSources, createSourceAttachmentHost } from './source-attachments';
import { createSpaceManager } from '../storage/space-management';
import { createCollectorKeySync, hasCollectorKeySyncConfiguration, requirePersistentEncryption, type CollectorKeyChange, type CollectorKeySync } from './collector-key-sync';

type CollectorKeys = Pick<ReturnType<typeof createKeyStore>, 'initialize' | 'get' | 'set' | 'status'>;
type CollectorCapture = Pick<ReturnType<typeof createCaptureService>, 'start' | 'stop' | 'busy' | 'snapshot'> & Partial<ReturnType<typeof createCaptureService>>;
type CollectorDocuments = Pick<ReturnType<typeof createDocumentExtractor>, 'extract' | 'dispose'>;
type CollectorAccount = Pick<ReturnType<typeof createAccountService>, 'snapshot' | 'start' | 'stop' | 'resetKey' | 'quote'>;
export interface CollectorDependencies {
  createRepository?: typeof createRepository;
  createCaptureStore?: typeof createCaptureStore;
  createCaptureService?(options: Parameters<typeof createCaptureService>[0]): CollectorCapture;
  createDocumentExtractor?(): CollectorDocuments;
  createKeyStore?(path: string, encryption: AsyncEncryption): CollectorKeys;
  createModelRequestQueue?: typeof createModelRequestQueue;
  createAccountService?(options: Parameters<typeof createAccountService>[0]): CollectorAccount;
  encryption?: AsyncEncryption;
  fetch?: typeof fetch;
  wait?(milliseconds: number): Promise<void>;
  shutdownGraceMs?: number;
  onWarning?(code: string): void;
  onCaptureChanged?(snapshot: CaptureSnapshot): void;
  clearCache?(): Promise<void>;
  openPath?(path: string): Promise<string>;
  createSpaceManager?: typeof createSpaceManager;
  createCollectorKeySync?: typeof createCollectorKeySync;
  onCloudKeyChanged?(value: CollectorKeyChange): void;
}

/** Windows-only local collection backend. Main owns the instance lock, lifecycle and tray. */
export async function startCollectorMode(directory: string, dependencies: CollectorDependencies = {}) {
  if (!isAbsolute(directory) || resolve(directory) === parse(resolve(directory)).root) throw Error('采集模式必须使用明确的既有资料目录');
  const database = join(directory, 'planner.sqlite');
  if (!existsSync(database) || !lstatSync(database).isFile() || lstatSync(database).isSymbolicLink()) throw Error('采集来源数据库不存在或不是普通文件；未创建空白来源库');
  const warn = (code: string) => { try { (dependencies.onWarning ?? console.warn)(code); } catch { /* diagnostics cannot rewrite credentials or decide shutdown */ } };
  const wait = dependencies.wait ?? (milliseconds => new Promise<void>(done => setTimeout(done, milliseconds)));
  const abort = new AbortController(); let closing = false, closed = false, closePromise: Promise<void> | undefined;
  let repository: Repository | undefined, store: CaptureStore | undefined, wechatStore: CaptureStore | undefined, capture: CollectorCapture | undefined, wechat: CollectorCapture | undefined, documents: CollectorDocuments | undefined;
  let queue: ReturnType<typeof createModelRequestQueue> | undefined;
  let space: ReturnType<typeof createSpaceManager> | undefined;
  let keySync: CollectorKeySync | undefined;
  let account: CollectorAccount | undefined;
  let activeCalls = 0;
  const subscribers = new Set<(snapshot: CaptureSnapshot) => void>();
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const syncingClosed = keySync?.close();
      account?.stop();
      space?.stop();
      try { capture?.stop(); wechat?.stop(); } catch { warn('COLLECTOR_STOP_FAILED'); throw Error('采集尚未安全停止，数据库保持打开；请重试退出'); }
      try { documents?.dispose(); } catch { warn('COLLECTOR_DOCUMENT_DISPOSE_FAILED'); throw Error('文档处理尚未安全停止，数据库保持打开；请重试退出'); }
      const timer = setTimeout(() => abort.abort(), Math.max(0, dependencies.shutdownGraceMs ?? 25_000)); timer.unref();
      try {
        if (syncingClosed) await syncingClosed;
        // stop() prevents new collection but in-flight callbacks still finalize batches.
        // Never close their SQLite connections until both activity indicators are idle.
        while (capture?.busy() || wechat?.busy() || queue?.busy() || activeCalls || space?.isRunning()) await wait(50);
        try { wechatStore?.close(); store?.close(); } finally { repository?.close(); closed = true; subscribers.clear(); }
      } finally { clearTimeout(timer); }
    })();
    const attempt = closePromise;
    void attempt.catch(() => { if (closePromise === attempt) closePromise = undefined; });
    return attempt;
  };
  try {
    repository = (dependencies.createRepository ?? createRepository)(database);
    store = (dependencies.createCaptureStore ?? createCaptureStore)(database);
    wechatStore = (dependencies.createCaptureStore ?? createCaptureStore)(database, { platform: 'wechat' });
    const encryption = dependencies.encryption ?? safeStorage;
    const keys = (dependencies.createKeyStore ?? createKeyStore)(join(directory, 'credentials', 'deepseek.bin'), hasCollectorKeySyncConfiguration(directory) ? requirePersistentEncryption(encryption) : encryption);
    const bridgeKeys = (dependencies.createKeyStore ?? createKeyStore)(join(directory, 'credentials', 'qq-bridge.bin'), encryption);
    try { await keys.initialize(); } catch { warn('COLLECTOR_AI_CREDENTIAL_UNAVAILABLE'); }
    try { await bridgeKeys.initialize(); } catch { warn('COLLECTOR_QQ_CREDENTIAL_UNAVAILABLE'); }
    const withCloudKeySync = (value: CaptureSnapshot): CaptureSnapshot => keySync ? CaptureSnapshotSchema.parse({ ...value, cloudKeySync: keySync.status() }) : value;
    const emitCapture = (value: CaptureSnapshot) => {
      const checked = withCloudKeySync(CaptureSnapshotSchema.parse(value));
      try { dependencies.onCaptureChanged?.(checked); } catch { /* Observers cannot change collection state. */ }
      for (const listener of subscribers) try { listener(CaptureSnapshotSchema.parse(checked)); } catch { /* Isolate UI observers. */ }
    };
    keySync = (dependencies.createCollectorKeySync ?? createCollectorKeySync)({ directory, encryption, keys,
      async onChanged(value) {
        account?.resetKey();
        await capture?.credentialsChanged?.({ configured: value.configured, revision: value.revision, sourceId: value.sourceId });
        await wechat?.credentialsChanged?.({ configured: value.configured, revision: value.revision, sourceId: value.sourceId });
        try { dependencies.onCloudKeyChanged?.(value); } catch { /* Observers cannot change the saved credential. */ }
      },
      onStatusChanged() { if (capture && !closing) try { emitCapture(capture.snapshot()); } catch { /* Startup may not yet have a snapshot. */ } },
    });
    documents = (dependencies.createDocumentExtractor ?? createDocumentExtractor)();
    queue = (dependencies.createModelRequestQueue ?? createModelRequestQueue)();
    const transport = dependencies.fetch ?? fetch;
    const cancellableFetch: typeof fetch = async (input, init) => {
      if (closing) throw new WorkflowError('CANCELLED', '采集模式正在退出，未继续请求模型');
      const signal = AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]);
      let cancel: () => void = () => {};
      try { return await Promise.race([transport(input, { ...init, signal }), new Promise<Response>((_done, reject) => {
        cancel = () => reject(new WorkflowError('CANCELLED', '采集模式正在退出，模型请求已取消')); signal.addEventListener('abort', cancel, { once: true });
      })]); } finally { signal.removeEventListener('abort', cancel); }
    };
    const getApiKey = async () => {
      if (closing) throw new WorkflowError('CANCELLED', '采集模式正在退出');
      if (keySync) return keySync.getApiKey();
      const key = await keys.get();
      if (!key && keys.status().loadError) throw new WorkflowError('STORAGE', '已保存密钥暂未载入，原凭据保留；请正常退出后重试');
      return key;
    };
    account = (dependencies.createAccountService ?? createAccountService)({ getApiKey, fetch: cancellableFetch, isVisible: () => false });
    const captureOptions: Parameters<typeof createCaptureService>[0] = {
      store, repository, credentials: bridgeKeys, extract: documents.extract, runModel: queue.run, fetch: cancellableFetch,
      onChanged: emitCapture, getApiKey, getPriceQuote: account.quote,
      getModelInputModalities: model => account!.snapshot().models.data?.find(item => item.id === model)?.inputModalities ?? null,
    };
    capture = (dependencies.createCaptureService ?? createCaptureService)(captureOptions);
    wechat = (dependencies.createCaptureService ?? createCaptureService)({ ...captureOptions, store: wechatStore, platform: 'wechat', credentials: wechatCredentials, bridgeFactory: createLocalWechatBridge(directory), onChanged: undefined });
    const resolveEvidence = createLocalEvidenceResolver(repository);
    const sourceAttachments = createSourceAttachmentHost({ directory, store: combinedCaptureSources(store, wechatStore), resolveEvidence, openPath: path => dependencies.openPath ? dependencies.openPath(path) : shell.openPath(path) });
    const unavailable = () => { throw new WorkflowError('INTERNAL', '本机采集能力尚未准备好，请重试。'); };
    space = (dependencies.createSpaceManager ?? createSpaceManager)({ directory,
      isBusy: () => closing || activeCalls > 0 || !!capture?.busy() || !!wechat?.busy() || !!queue?.busy(),
      attachments: {
        previewAttachmentRetention: policy => capture?.previewAttachmentRetention?.(policy) ?? unavailable(),
        cleanAttachments: policy => capture?.cleanAttachments?.(policy) ?? unavailable(),
      },
      clearCache: dependencies.clearCache ?? (() => session.defaultSession.clearCache()),
    });
    const handlers: Record<string, (input: any) => unknown | Promise<unknown>> = {
      // Only the authenticated local control pipe exposes this; no renderer or cloud read-back route.
      captureSetApiKey: async input => {
        if (keySync) throw new WorkflowError('CONFLICT', '本机分析密钥由云端管理，请更新云端密钥后同步');
        if (!await encryption.isAsyncEncryptionAvailable()) throw new WorkflowError('STORAGE', '本机密钥加密暂不可用，原密钥保持不变');
        const status = await keys.set(input.key); account?.resetKey(); return status;
      },
      captureRefreshApiKey: async () => {
        if (!keySync) throw new WorkflowError('CONFLICT', '本机尚未配置云端密钥同步');
        await keySync.refresh(); return withCloudKeySync(capture!.snapshot());
      },
      captureSnapshot: () => withCloudKeySync(capture!.snapshot()),
      wechatCaptureSnapshot: () => withCloudKeySync(wechat!.snapshot()),
      captureConfigure: input => capture!.configure?.(input) ?? unavailable(),
      wechatCaptureConfigure: input => wechat!.configure?.(input) ?? unavailable(),
      captureConnect: input => capture!.connect?.(input) ?? unavailable(),
      wechatCaptureConnect: input => wechat!.connect?.(input) ?? unavailable(),
      captureGroups: () => capture!.groups?.() ?? unavailable(),
      wechatCaptureGroups: () => wechat!.groups?.() ?? unavailable(),
      captureMessages: input => capture!.messages?.(input) ?? unavailable(),
      wechatCaptureMessages: input => wechat!.messages?.(input) ?? unavailable(),
      captureBatches: input => capture!.batches?.(input) ?? unavailable(),
      wechatCaptureBatches: input => wechat!.batches?.(input) ?? unavailable(),
      captureAction: input => capture!.action?.(input) ?? unavailable(),
      wechatCaptureAction: input => wechat!.action?.(input) ?? unavailable(),
      captureChunks: input => capture!.chunks?.(input) ?? unavailable(),
      wechatCaptureChunks: input => wechat!.chunks?.(input) ?? unavailable(),
      captureCleanup: input => capture!.cleanup?.(input) ?? unavailable(),
      wechatCaptureCleanup: input => wechat!.cleanup?.(input) ?? unavailable(),
      localSourceEvidence: resolveEvidence,
      sourceAttachments: input => sourceAttachments.list(input),
      sourceAttachmentOpen: input => sourceAttachments.open(input),
      spaceSnapshot: () => space!.snapshot(),
      spaceConfigure: input => space!.configure(input),
      spaceCleanup: input => space!.cleanup(input),
    };
    const api = {
      async invoke(method: string, input?: unknown): Promise<ApiResult<unknown>> {
        let counted = false;
        try {
          if (closing || closed) throw new WorkflowError('CONFLICT', '本机采集服务正在退出，请稍后重试。');
          if (!Object.hasOwn(handlers, method)) throw new WorkflowError('VALIDATION', '本机采集接口不支持此操作。');
          const schema = method === 'captureSetApiKey' ? SetApiKeyRequestSchema : method === 'captureRefreshApiKey' ? z.undefined() : method === 'localSourceEvidence' ? LocalSourceEvidenceRequestSchema : requests[method as Method];
          const parsed = schema.safeParse(input); if (!parsed.success) throw new WorkflowError('VALIDATION', '本机采集请求格式无效。');
          if (space?.isRunning()) throw new WorkflowError('CONFLICT', '正在整理本机存储，请稍候再操作。');
          if (method !== 'spaceCleanup') { activeCalls++; counted = true; }
          const value = await handlers[method]!(parsed.data);
          const snapshot = keySync ? CaptureSnapshotSchema.safeParse(value) : undefined;
          const result = { ok: true as const, data: snapshot?.success ? withCloudKeySync(snapshot.data) : value };
          const output = method === 'captureSetApiKey' ? apiResultSchema(KeyStatusSchema) : method === 'captureRefreshApiKey' ? apiResultSchema(CaptureSnapshotSchema) : method === 'localSourceEvidence' ? apiResultSchema(LocalSourceEvidenceResultSchema) : responses[method as Method];
          const checked = output.safeParse(result); if (!checked.success) throw new WorkflowError('INTERNAL', '本机采集返回的数据格式无效。');
          return checked.data;
        } catch (error) { return { ok: false, error: safeError(error) }; }
        finally { if (counted) activeCalls--; }
      },
    };
    await capture.start();
    await wechat.start();
    keySync?.start();
    account.start();
    space.start();
    return {
      close, api,
      subscribe(listener: (value: CaptureSnapshot) => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
      status(): { connection: string; error: boolean; enabled: boolean; analysisEnabled: boolean } {
        if (closed) return { connection: 'stopped', error: false, enabled: false, analysisEnabled: false };
        try { const states = [capture!.snapshot(), wechat!.snapshot()], active = states.filter(value => value.config.enabled); const current = active[0] ?? states[0]!; return { connection: active.every(value => value.connection === 'online') && active.length ? 'online' : current.connection, error: active.some(value => !!value.error), enabled: active.length > 0, analysisEnabled: states.some(value => value.config.enabled && value.config.analysisEnabled) }; }
        catch { return { connection: 'unavailable', error: true, enabled: false, analysisEnabled: false }; }
      },
    };
  } catch (error) { await close(); throw error; }
}
