import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

export type BackupJob = { kind: 'safe'; databasePath: string; directory?: string } | { kind: 'desktop'; databasePath: string; target: string };
function defaultWorkerPath() {
  const directory = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
  const sibling = join(directory, 'backup-worker.cjs');
  return existsSync(sibling) ? sibling : join(directory, '../../dist-server/backup-worker.cjs');
}
/** Retain one idle worker so validated-file identities can be reused between backups. */
export function createBackupWorker(workerPath = defaultWorkerPath()) {
  let worker: Worker | undefined, active = false;
  return {
    run(job: BackupJob, signal: AbortSignal): Promise<string> {
      if (active) return Promise.reject(Error('后台备份仍在进行'));
      if (signal.aborted) return Promise.reject(Error('后台备份已取消'));
      active = true;
      return new Promise<string>((resolve, reject) => {
        let current: Worker;
        try {
          if (!worker) {
            worker = new Worker(workerPath);
            const started = worker;
            // Idle worker failures must never become uncaught process errors.
            worker.on('error', () => { if (worker === started) worker = undefined; });
            worker.on('exit', () => { if (worker === started) worker = undefined; });
          }
          current = worker; current.ref();
        }
        catch (error) { active = false; reject(error); return; }
        let done = false;
        const finish = (error?: unknown, path?: string) => {
          if (done) return; done = true; active = false;
          signal.removeEventListener('abort', abort); current.removeListener('message', message); current.removeListener('error', failed); current.removeListener('exit', exited);
          current.unref();
          if (error) reject(error); else resolve(path!);
        };
        const failed = (error: Error) => { if (worker === current) worker = undefined; finish(error); };
        const exited = () => { if (worker === current) worker = undefined; finish(Error('后台备份进程提前退出；原有备份保留')); };
        const abort = () => {
          if (worker === current) worker = undefined;
          void current.terminate().finally(() => finish(Error('后台备份已取消；原有备份保留')));
        };
        const message = (result: unknown) => {
          if (result && typeof result === 'object' && 'path' in result && typeof result.path === 'string') finish(undefined, result.path);
          else finish(Error('后台备份未完成；原有备份保留'));
        };
        current.once('message', message); current.once('error', failed); current.once('exit', exited);
        signal.addEventListener('abort', abort, { once: true }); current.postMessage(job);
        if (signal.aborted) abort();
      });
    },
    async close() { const current = worker; worker = undefined; if (current) await current.terminate(); },
  };
}
