import { join } from 'node:path';
import { createRemoteService, type RemoteServiceOptions } from './service';
import { createRemoteHttpServer } from './http';
import { createPushStore, type PushStore } from './push-store';
import { createWebPushTransport } from './web-push-transport';
import { createPushScheduler } from './push-scheduler';
import { createPushHttpExtension } from './push-http';

export interface RemoteRuntimeOptions extends RemoteServiceOptions {
  origin: string; port: number; host?: string; staticDirectory?: string; vapidSubject?: string;
  shutdownGraceMs?: number; onPushError?(error: unknown): void;
}
/** Own every runtime resource, including partially initialized startup failures. */
export async function startRemoteRuntime(options: RemoteRuntimeOptions) {
  const service = createRemoteService(options);
  let store: PushStore | undefined, transport: ReturnType<typeof createWebPushTransport> | undefined;
  let scheduler: ReturnType<typeof createPushScheduler> | undefined, http: ReturnType<typeof createRemoteHttpServer> | undefined;
  let closePromise: Promise<void> | undefined;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      service.beginShutdown();
      const pushStopped = scheduler?.stop() ?? Promise.resolve();
      transport?.close();
      const grace = options.shutdownGraceMs ?? 25_000;
      const results = await Promise.allSettled([pushStopped, http?.close({ graceMs: grace + 5000 }), service.close({ graceMs: grace })]);
      store?.close();
      if (results.some(result => result.status === 'rejected')) throw Error('服务退出期间资源未完全正常关闭，请核对操作回执和进程状态');
    })(); return closePromise;
  };
  try {
    // An explicitly configured unreadable secret must fail startup, not look unconfigured.
    await service.aiConfigured();
    if (!service.readiness().ready) throw Error('本地资料服务未通过就绪校验，请先核对存储状态');
    store = createPushStore(join(options.dataDirectory, 'notifications.sqlite'));
    if (options.vapidSubject) {
      transport = createWebPushTransport({ store, subject: options.vapidSubject });
      scheduler = createPushScheduler({ snapshot: service.snapshot, store, send: transport.send, onError: options.onPushError });
    }
    const pushStore = store;
    http = createRemoteHttpServer({ service, origin: options.origin, staticDirectory: options.staticDirectory,
      extension: createPushHttpExtension({ store: pushStore, publicKey: transport?.publicKey ?? null, send: transport?.send }),
      onRevokeDevice: id => pushStore.revokeDevice(id) });
    const port = await http.listen(options.port, options.host ?? '127.0.0.1'); scheduler?.start();
    return { service, http, port, close };
  } catch (error) { await close(); throw error; }
}
