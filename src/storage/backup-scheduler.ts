/** A deadline from the first unprotected change, not a sliding debounce. */
export function createBackupScheduler(options: {
  run(signal: AbortSignal): Promise<string>;
  delayMs?: number;
  now?(): number;
  onAttempt?(at: string): void;
  onSuccess?(path: string, at: string): void;
  onFailure?(error: unknown, at: string): void;
}) {
  const now = options.now ?? Date.now, delay = options.delayMs ?? 60_000;
  let revision = 0, savedRevision = 0, dirtySince: number | null = null, duringRunSince: number | null = null;
  let failures = 0, lastPath: string | undefined, closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined, running: Promise<string> | undefined, controller: AbortController | undefined;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  function schedule(retry = false) {
    clearTimer();
    if (closing || running || dirtySince === null) return;
    const wait = retry ? Math.min(300_000, 15_000 * 2 ** Math.min(failures - 1, 5)) : Math.max(0, dirtySince + delay - now());
    timer = setTimeout(() => { timer = undefined; void start().catch(() => {}); }, wait); timer.unref();
  }
  function markDirty() {
    if (closing) return;
    revision++;
    if (dirtySince === null) dirtySince = now();
    if (running && duringRunSince === null) duringRunSince = now();
    // Later changes must not postpone the existing first-change deadline.
    if (!timer) schedule();
  }
  function start(): Promise<string> {
    if (running) return running;
    clearTimer();
    const target = revision, firstChange = dirtySince;
    duringRunSince = null; controller = new AbortController();
    options.onAttempt?.(new Date(now()).toISOString());
    running = Promise.resolve().then(() => options.run(controller!.signal)).then(path => {
      savedRevision = target; lastPath = path; failures = 0;
      dirtySince = revision === target ? null : duringRunSince ?? firstChange ?? now();
      options.onSuccess?.(path, new Date(now()).toISOString());
      return path;
    }, error => {
      failures++; dirtySince ??= firstChange ?? now();
      options.onFailure?.(error, new Date(now()).toISOString());
      throw error;
    }).finally(() => { running = undefined; controller = undefined; schedule(failures > 0); });
    return running;
  }
  async function flush(force = false): Promise<string | undefined> {
    if (force) { revision++; dirtySince ??= now(); if (running) duringRunSince ??= now(); }
    const target = revision;
    while (savedRevision < target) await start();
    return lastPath;
  }
  return {
    markDirty, flush,
    cancel() { closing = true; clearTimer(); controller?.abort(); },
    status: () => ({ pending: dirtySince !== null, pendingSince: dirtySince === null ? null : new Date(dirtySince).toISOString(), running: !!running }),
    async close(timeoutMs = 25_000): Promise<void> {
      closing = true; clearTimer();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([flush(), new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { controller?.abort(); reject(Error('等待后台备份完成超时；数据库已保存，下次启动会继续尝试备份')); }, timeoutMs);
        })]);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (controller?.signal.aborted) await running?.catch(() => {});
      }
    },
  };
}
