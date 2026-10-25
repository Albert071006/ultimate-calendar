import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { safeStorage } from 'electron';
import { createRepository, type Repository } from '../storage/repository';
import { createCaptureStore, type CaptureStore } from '../capture/store';
import { createCaptureService } from '../capture/service';
import { createDocumentExtractor } from '../capture/documents/runtime';
import { createKeyStore, type AsyncEncryption } from './key-store';
import { createModelRequestQueue } from '../ai/request-queue';
import { WorkflowError } from '../ai/deepseek';

type CollectorKeys = Pick<ReturnType<typeof createKeyStore>, 'initialize' | 'get' | 'set' | 'status'>;
type CollectorCapture = Pick<ReturnType<typeof createCaptureService>, 'start' | 'stop' | 'busy' | 'snapshot'>;
type CollectorDocuments = Pick<ReturnType<typeof createDocumentExtractor>, 'extract' | 'dispose'>;
export interface CollectorDependencies {
  createRepository?: typeof createRepository;
  createCaptureStore?: typeof createCaptureStore;
  createCaptureService?(options: Parameters<typeof createCaptureService>[0]): CollectorCapture;
  createDocumentExtractor?(): CollectorDocuments;
  createKeyStore?(path: string, encryption: AsyncEncryption): CollectorKeys;
  createModelRequestQueue?: typeof createModelRequestQueue;
  encryption?: AsyncEncryption;
  fetch?: typeof fetch;
  wait?(milliseconds: number): Promise<void>;
  shutdownGraceMs?: number;
  onWarning?(code: string): void;
}

/** Windows-only local collection backend. Main owns the instance lock, lifecycle and tray. */
export async function startCollectorMode(directory: string, dependencies: CollectorDependencies = {}) {
  if (!isAbsolute(directory) || resolve(directory) === parse(resolve(directory)).root) throw Error('采集模式必须使用明确的既有资料目录');
  const database = join(directory, 'planner.sqlite');
  if (!existsSync(database) || !lstatSync(database).isFile() || lstatSync(database).isSymbolicLink()) throw Error('采集来源数据库不存在或不是普通文件；未创建空白来源库');
  const warn = (code: string) => { try { (dependencies.onWarning ?? console.warn)(code); } catch { /* diagnostics cannot rewrite credentials or decide shutdown */ } };
  const wait = dependencies.wait ?? (milliseconds => new Promise<void>(done => setTimeout(done, milliseconds)));
  const abort = new AbortController(); let closing = false, closed = false, closePromise: Promise<void> | undefined;
  let repository: Repository | undefined, store: CaptureStore | undefined, capture: CollectorCapture | undefined, documents: CollectorDocuments | undefined;
  let queue: ReturnType<typeof createModelRequestQueue> | undefined;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      try { capture?.stop(); } catch { warn('COLLECTOR_STOP_FAILED'); throw Error('采集尚未安全停止，数据库保持打开；请重试退出'); }
      try { documents?.dispose(); } catch { warn('COLLECTOR_DOCUMENT_DISPOSE_FAILED'); throw Error('文档处理尚未安全停止，数据库保持打开；请重试退出'); }
      const timer = setTimeout(() => abort.abort(), Math.max(0, dependencies.shutdownGraceMs ?? 25_000)); timer.unref();
      try {
        // stop() prevents new collection but in-flight callbacks still finalize batches.
        // Never close their SQLite connections until both activity indicators are idle.
        while (capture?.busy() || queue?.busy()) await wait(50);
        try { store?.close(); } finally { repository?.close(); closed = true; }
      } finally { clearTimeout(timer); }
    })();
    const attempt = closePromise;
    void attempt.catch(() => { if (closePromise === attempt) closePromise = undefined; });
    return attempt;
  };
  try {
    repository = (dependencies.createRepository ?? createRepository)(database);
    store = (dependencies.createCaptureStore ?? createCaptureStore)(database);
    const encryption = dependencies.encryption ?? safeStorage;
    const keys = (dependencies.createKeyStore ?? createKeyStore)(join(directory, 'credentials', 'deepseek.bin'), encryption);
    const bridgeKeys = (dependencies.createKeyStore ?? createKeyStore)(join(directory, 'credentials', 'qq-bridge.bin'), encryption);
    try { await keys.initialize(); } catch { warn('COLLECTOR_AI_CREDENTIAL_UNAVAILABLE'); }
    try { await bridgeKeys.initialize(); } catch { warn('COLLECTOR_QQ_CREDENTIAL_UNAVAILABLE'); }
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
    capture = (dependencies.createCaptureService ?? createCaptureService)({
      store, repository, credentials: bridgeKeys, extract: documents.extract, runModel: queue.run, fetch: cancellableFetch,
      getApiKey: async () => {
        if (closing) throw new WorkflowError('CANCELLED', '采集模式正在退出');
        const key = await keys.get();
        if (!key && keys.status().loadError) throw new WorkflowError('STORAGE', '已保存密钥暂未载入，原凭据保留；请正常退出后重试');
        return key;
      },
    });
    await capture.start();
    return {
      close,
      status(): { connection: string; error: boolean; enabled: boolean; analysisEnabled: boolean } {
        if (closed) return { connection: 'stopped', error: false, enabled: false, analysisEnabled: false };
        try { const current = capture!.snapshot(); return { connection: current.connection, error: !!current.error, enabled: current.config.enabled, analysisEnabled: current.config.analysisEnabled }; }
        catch { return { connection: 'unavailable', error: true, enabled: false, analysisEnabled: false }; }
      },
    };
  } catch (error) { await close(); throw error; }
}
