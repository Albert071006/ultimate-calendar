import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRepository, records, updateEntity, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createLedgerService, type LedgerService } from '../ledger/service';
import { createController, type ControllerOptions } from '../application/controller';
import { createModelRequestQueue } from '../ai/request-queue';
import { createAccountService } from '../ai/account';
import { safeError, WorkflowError } from '../ai/deepseek';
import { SettingsSchema, type ApiResult, type ChangedEvent, type Snapshot } from '../shared/contracts';
import { RemoteIdentitySchema, REMOTE_READ_METHODS, type RemoteRequest, type RemoteMethod } from '../shared/remote';
import { sharedSettings } from '../shared/cloud-management';
import { remoteInputs, remoteOutputs } from './protocol';
import { RemoteFault, RemoteState, type BackupStatus } from './state';
import { createSafeBackup, redactEvidence, SOURCE_PLACEHOLDER } from './backup';
import { importDistilled } from './distilled';
import { DistilledRequestSchema, type DistilledRequest } from '../shared/distilled';
import { AiConfigurationUpdateSchema, AiConfigurationClearSchema } from '../shared/ai-configuration';
import { createExternalApiKeyConfiguration, type ApiKeyConfiguration } from './ai-configuration';
import { AiKeySyncRequestSchema } from '../shared/ai-key-sync';
import { createAiKeyReceiver } from './ai-key-receiver';
import { ledgerExportData, backupExportData } from './cloud-export';
import { createCloudRestore } from './cloud-restore';

export interface RemoteServiceOptions {
  dataDirectory: string;
  getApiKey(): Promise<string | null>;
  apiKeyConfiguration?: ApiKeyConfiguration;
  /** Private local authorization registry; never exposed through HTTP or business backups. */
  aiKeyReceiversFile?: string;
  controller?: Pick<ControllerOptions, 'fetch' | 'now' | 'getPriceQuote' | 'getModelInputModalities' | 'afterModelRequest'>;
  state?: RemoteState;
  backupDirectory?: string;
  onBackupError?(error: unknown): void;
  maxConcurrentWrites?: number;
  maxConcurrentWritesPerDevice?: number;
  startupBackup?: boolean;
}
function acquireDirectory(directory: string): () => void {
  const path = join(directory, '.remote-service.lock'), token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      return () => { try { if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path); } catch { /* retain another owner's lock */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try { const value = JSON.parse(readFileSync(path, 'utf8')); pid = value.pid; if (!Number.isInteger(pid) || pid <= 0) throw Error(); }
      catch { throw Error('服务目录锁无法可靠读取，请先核对旧服务；未打开资料'); }
      try { process.kill(pid, 0); } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(path); continue; }
      }
      throw Error('此资料目录已有服务运行；不能同时启动第二个写入服务');
    }
  }
  throw Error('无法取得服务目录锁');
}
export function createRemoteService(options: RemoteServiceOptions) {
  if (!isAbsolute(options.dataDirectory) || resolve(options.dataDirectory) === parse(resolve(options.dataDirectory)).root) throw Error('必须显式指定磁盘根目录以外的绝对资料目录');
  mkdirSync(options.dataDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(options.dataDirectory, 0o700);
  const releaseDirectory = acquireDirectory(options.dataDirectory);
  const initialized = (() => {
    let repository: Repository | undefined, ledger: LedgerService | undefined, state: RemoteState | undefined;
    try {
      // Raw mobile inputs are temporary and must never enter the desktop full-DB backup.
      repository = createRepository(join(options.dataDirectory, 'planner.sqlite'), { automaticBackup: () => {} });
      const planner = createPlanner(repository, { automaticBackup: () => {} }); ledger = createLedgerService(repository.path);
      state = options.state ?? new RemoteState(join(options.dataDirectory, 'remote-state.sqlite'));
      return { repository, planner, ledger, state };
    } catch (error) { ledger?.close(); repository?.close(); if (!options.state) state?.close(); releaseDirectory(); throw error; }
  })();
  const { repository, planner, ledger, state } = initialized;
  const aiConfiguration = options.apiKeyConfiguration ?? createExternalApiKeyConfiguration(options.getApiKey);
  const aiKeyReceiver = createAiKeyReceiver(options.aiKeyReceiversFile ?? join(options.dataDirectory, 'ai-key-receivers.json'));
  const getApiKey = () => aiConfiguration.getApiKey();
  if (process.platform !== 'win32') for (const name of ['planner.sqlite', 'remote-state.sqlite']) for (const suffix of ['', '-wal', '-shm']) {
    const path = join(options.dataDirectory, `${name}${suffix}`); if (existsSync(path)) chmodSync(path, 0o600);
  }
  const queue = createModelRequestQueue();
  const shutdownAbort = new AbortController();
  const transport = options.controller?.fetch ?? fetch;
  const cancellableFetch: typeof fetch = async (input, init) => {
    const signal = AbortSignal.any([shutdownAbort.signal, ...(init?.signal ? [init.signal] : [])]);
    if (signal.aborted) throw new WorkflowError('CANCELLED', '服务正在退出，未继续请求模型');
    let abort: () => void = () => {};
    try {
      return await Promise.race([transport(input, { ...init, signal }), new Promise<Response>((_done, reject) => {
        abort = () => reject(new WorkflowError('CANCELLED', '服务正在退出，模型请求已中断，结果需核对'));
        signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  };
  const account = createAccountService({ getApiKey, fetch: cancellableFetch, cachePath: join(options.dataDirectory, 'cache', 'deepseek-prices.json'), isVisible: () => false });
  account.stop(); let accountStarted = false;
  const startAccount = () => { if (!accountStarted) { accountStarted = true; account.start(); } };
  let controller: ReturnType<typeof createController>;
  try { controller = createController({ ...options.controller, fetch: cancellableFetch, repository, planner, ledger, getApiKey, runModel: queue.run, automaticBackup: () => {},
    getPriceQuote: options.controller?.getPriceQuote ?? account.quote,
    getModelInputModalities: options.controller?.getModelInputModalities ?? (model => account.snapshot().models.data?.find(value => value.id === model)?.inputModalities ?? null),
    afterModelRequest: () => { options.controller?.afterModelRequest?.(); if (accountStarted) void account.refresh({ force: true, balanceOnly: true }); },
  }); }
  catch (error) { account.stop(); ledger.close(); repository.close(); if (!options.state) state.close(); releaseDirectory(); throw error; }
  let settingsWrites: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(event: ChangedEvent) => void>();
  const running = new Map<string, { deviceId: string; fingerprint: string; promise: Promise<unknown> }>();
  let lifecycle: 'running' | 'draining' | 'closed' = 'running', closePromise: Promise<void> | undefined;
  const maxWrites = options.maxConcurrentWrites ?? 8, maxDeviceWrites = options.maxConcurrentWritesPerDevice ?? 4;
  if (![maxWrites, maxDeviceWrites].every(value => Number.isInteger(value) && value > 0 && value <= 128)) { account.stop(); ledger.close(); repository.close(); if (!options.state) state.close(); releaseDirectory(); throw Error('写请求并发上限必须为1–128'); }
  let backupStatus: BackupStatus = state.backupStatus();
  let restoreStatus = state.restoreStatus();
  let lastBackup = 0;
  function backup(force = false) {
    if (!force && Date.now() - lastBackup < 60_000) return;
    const at = new Date().toISOString(); backupStatus = { ...backupStatus, lastAttemptAt: at };
    try {
      const path = createSafeBackup({ repository, ledger, directory: options.backupDirectory }); lastBackup = Date.now();
      backupStatus = { status: 'ok', lastAttemptAt: at, lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0, failureCode: null };
      try { state.saveBackupStatus(backupStatus); } catch { /* In-memory status remains visible if status persistence is unavailable. */ }
      return path;
    } catch (error) {
      backupStatus = { ...backupStatus, status: 'failed', consecutiveFailures: backupStatus.consecutiveFailures + 1, failureCode: 'BACKUP_FAILED' };
      try { state.saveBackupStatus(backupStatus); } catch { /* Backup failure must not hide an already committed business result. */ }
      try { options.onBackupError?.(error); } catch { /* Diagnostics are not a business transaction. */ }
    }
  }
  function cleanupEvidence() {
    repository.transact(value => {
      for (const source of records(value, 'source')) {
        const completed = ['succeeded', 'needs-review'].includes(source.status);
        const expired = source.status !== 'processing' && Date.now() - Date.parse(source.importedAt) >= 86400_000;
        if ((completed || expired) && (source.kind !== 'text' || source.text !== redactEvidence(source).text || source.captureRef)) updateEntity(value, 'source', source.id, redactEvidence(source));
      }
      // Retained derived items need no verbatim quotations, including historical copies.
      value.entities.candidate = value.entities.candidate.map(candidate => redactEvidence(candidate));
      value.journal = redactEvidence(value.journal); value.operations = redactEvidence(value.operations);
    });
  }
  try { cleanupEvidence(); } catch (error) { account.stop(); ledger.close(); repository.close(); if (!options.state) state.close(); releaseDirectory(); throw error; }
  if (options.startupBackup !== false) backup(true);
  const maintenance = setInterval(() => { try { cleanupEvidence(); backup(); } catch (error) { options.onBackupError?.(error); } }, 60 * 60_000); maintenance.unref();
  const emit = (reason: ChangedEvent['reason']) => { for (const listener of listeners) { try { listener({ reason }); } catch { /* a disconnected observer cannot reject a committed operation */ } } };
  const restore = createCloudRestore({ repository, ledger, state, backup: () => backup(true), hasPendingWrites: () => running.size > 0 });
  async function invoke(method: RemoteMethod, input: unknown, deviceId: string, modernAiSettings: boolean): Promise<unknown> {
    switch (method) {
      case 'snapshot': return { ok: true, data: { ...planner.snapshot(), keyStatus: { configured: !!await getApiKey(), sessionOnly: false } } };
      case 'mutate': { const result = planner.mutate(remoteInputs.mutate.parse(input)); if (result.status === 'applied') emit('mutation'); return { ok: true, data: result }; }
      case 'undo': { const result = planner.undo(remoteInputs.undo.parse(input)); if (result.status === 'applied') emit('undo'); return { ok: true, data: result }; }
      case 'importSource': { const result = await controller.importSource(remoteInputs.importSource.parse(input)); if (result.ok) emit('import'); return result; }
      case 'analyzeSource': {
        const request = remoteInputs.analyzeSource.parse(input), source = planner.snapshot().sources.find(item => item.id === request.sourceId);
        if (source && (source.text === SOURCE_PLACEHOLDER || source.label === '采集电脑提炼')) throw new WorkflowError('VALIDATION', '原文已清理或留在采集电脑，不能重新分析；请重新提供需要分析的内容');
        const result = await controller.analyzeSource(request); cleanupEvidence(); emit('analysis'); return result;
      }
      case 'command': { const result = await controller.command(remoteInputs.command.parse(input)); emit('mutation'); return result; }
      case 'saveSettings': {
        const request = remoteInputs.saveSettings.parse(input);
        const pending = settingsWrites.then(async () => {
          const current = planner.snapshot().settings;
          // An old settings form cannot display or change the optional reasoning field.
          // Preserve it on legacy saves instead of silently resetting a newer choice.
          const preserveEffort = (settings: typeof current) => settings.reasoningEffort === undefined && current.reasoningEffort !== undefined
            ? { ...settings, reasoningEffort: current.reasoningEffort } : settings;
          const comparable = (settings: typeof current) => sharedSettings(SettingsSchema.parse({ ...settings, reasoningEffort: settings.reasoningEffort ?? 'none' }));
          const expected = modernAiSettings ? request.expectedSettings : preserveEffort(request.expectedSettings);
          if (JSON.stringify(comparable(current)) !== JSON.stringify(comparable(expected))) throw new WorkflowError('CONFLICT', '共享设置已被其他设备修改，请刷新后重新核对');
          const result = await controller.saveSettings({ settings: { ...preserveEffort(request.settings), closeToTray: current.closeToTray, autoLaunch: current.autoLaunch } });
          if (result.ok) emit('settings'); return result;
        });
        settingsWrites = pending.catch(() => {}); return pending;
      }
      case 'accountSnapshot': { startAccount(); return { ok: true, data: await account.refresh() }; }
      case 'refreshAccount': { startAccount(); return { ok: true, data: await account.refresh({ force: true }) }; }
      case 'importCourses': { const result = await controller.importCourses(remoteInputs.importCourses.parse(input)); cleanupEvidence(); if (result.ok) emit('import'); return result; }
      case 'ledgerExportData': { const request = remoteInputs.ledgerExportData.parse(input); return { ok: true, data: ledgerExportData(request.format === 'json' ? JSON.stringify(ledger.exportJson(), null, 2) : ledger.exportCsv(request.month), request.format) }; }
      case 'backupExportData': { const path = backup(true); if (!path) throw new WorkflowError('STORAGE', '安全备份未完成，请检查服务状态'); return { ok: true, data: backupExportData(path) }; }
      case 'restorePreview': return { ok: true, data: restore.preview(input, deviceId) };
      case 'restoreConfirm': { const result = restore.confirm(input, deviceId); emit('restore'); return { ok: true, data: result }; }
      case 'ledgerSnapshot': { if (ledger.ensureMonthlyAllowance()) { backup(); emit('mutation'); } return { ok: true, data: ledger.snapshot(remoteInputs.ledgerSnapshot.parse(input)?.month) }; }
      case 'ledgerMutate': { const result = ledger.mutate(remoteInputs.ledgerMutate.parse(input)); emit('mutation'); return { ok: true, data: { ...result, message: result.message.replaceAll('本地账本', '资料服务账本') } }; }
      case 'ledgerUndo': { const result = ledger.undo(remoteInputs.ledgerUndo.parse(input)); emit('undo'); return { ok: true, data: { ...result, message: result.message.replaceAll('本地账本', '资料服务账本') } }; }
    }
  }
  return {
    dataDirectory: resolve(options.dataDirectory),
    state,
    status() {
      const bytes = (name: string) => ['', '-wal', '-shm'].reduce((total, suffix) => { try { const file = lstatSync(join(options.dataDirectory, `${name}${suffix}`)); return total + (file.isFile() ? file.size : 0); } catch { return total; } }, 0);
      return { lifecycle, activeWrites: running.size, backup: { ...backupStatus }, restore: lifecycle === 'closed' ? restoreStatus : (restoreStatus = state.restoreStatus()), storageBytes: { planner: bytes('planner.sqlite'), receipts: bytes('remote-state.sqlite'), notifications: bytes('notifications.sqlite') } };
    },
    readiness() {
      if (lifecycle !== 'running') return { ready: false, status: lifecycle, checks: { storage: 'unavailable', backup: backupStatus.status } };
      try { state.identity(); repository.estimatedBackupBytes(); return { ready: true, status: backupStatus.status === 'failed' ? 'degraded' : 'ready', checks: { storage: 'ok', backup: backupStatus.status } }; }
      catch { return { ready: false, status: 'unavailable', checks: { storage: 'failed', backup: backupStatus.status } }; }
    },
    beginShutdown() { if (lifecycle === 'running') lifecycle = 'draining'; },
    snapshot: (): Snapshot => planner.snapshot(),
    aiConfigured: async () => !!await getApiKey(),
    async aiConfigurationStatus() {
      if (lifecycle !== 'running') throw new RemoteFault(503, '服务正在退出');
      const identity = state.identity();
      return { ok: true as const, identity, configuration: await aiConfiguration.status() };
    },
    async syncAiKeyReceiver(input: unknown, deviceId: string, modernAiSettings = false) {
      const request = AiKeySyncRequestSchema.parse(input);
      const check = () => {
        if (lifecycle !== 'running') throw new RemoteFault(503, '服务正在退出');
        if (!state.devices().some(device => device.id === deviceId)) throw new RemoteFault(401, '请先配对此设备');
        if (JSON.stringify(request.identity) !== JSON.stringify(state.identity())) throw new RemoteFault(409, '资料实例或恢复代际已改变，请重新连接');
      };
      check(); aiKeyReceiver.authorize(deviceId, request.keyId);
      // This is one atomic snapshot, never separate status() and getApiKey() reads.
      const snapshot = await aiConfiguration.readForReceiver();
      check();
      const settings = planner.snapshot().settings;
      return aiKeyReceiver.seal(deviceId, request, { ...snapshot, ...(modernAiSettings ? { settings: { model: settings.model, ...(settings.reasoningEffort !== undefined ? { reasoningEffort: settings.reasoningEffort } : {}) } } : {}) });
    },
    async setAiConfiguration(input: unknown) {
      if (lifecycle !== 'running') throw new RemoteFault(503, '服务正在退出');
      const request = AiConfigurationUpdateSchema.parse(input), identity = state.identity();
      if (JSON.stringify(request.identity) !== JSON.stringify(identity)) throw new RemoteFault(409, '资料实例或恢复代际已改变，请刷新并核对配置');
      // Dedicated credential storage: never place keys in RPC receipts or business backups.
      const configuration = await aiConfiguration.set(request.expectedRevision, request.apiKey);
      account.resetKey();
      emit('key');
      return { ok: true as const, identity, configuration };
    },
    async clearAiConfiguration(input: unknown) {
      if (lifecycle !== 'running') throw new RemoteFault(503, '服务正在退出');
      const request = AiConfigurationClearSchema.parse(input), identity = state.identity();
      if (JSON.stringify(request.identity) !== JSON.stringify(identity)) throw new RemoteFault(409, '资料实例或恢复代际已改变，请刷新并核对配置');
      const configuration = await aiConfiguration.clear(request.expectedRevision);
      account.resetKey();
      emit('key');
      return { ok: true as const, identity, configuration };
    },
    backup() { if (lifecycle !== 'running') throw new RemoteFault(503, '服务正在退出'); const path = backup(true); if (!path) throw new RemoteFault(503, '安全备份未完成，请检查服务状态'); return path; },
    importDistilled(input: DistilledRequest) {
      if (lifecycle !== 'running') throw new RemoteFault(503, '服务正在退出，请稍后重试原请求');
      const request = DistilledRequestSchema.parse(input);
      if (JSON.stringify(request.identity) !== JSON.stringify(state.identity())) throw new RemoteFault(409, '资料实例或恢复代际已改变');
      const result = importDistilled(repository, request); emit('import'); backup(true); return result;
    },
    subscribe(listener: (event: ChangedEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async rpc(method: RemoteMethod, request: RemoteRequest, deviceId: string, modernAiSettings = false): Promise<unknown> {
      if (lifecycle !== 'running') throw new RemoteFault(503, '服务正在退出，请稍后重试原请求');
      const identity = RemoteIdentitySchema.parse(request.identity);
      if (JSON.stringify(identity) !== JSON.stringify(state.identity())) throw new RemoteFault(409, '资料实例或恢复代际已改变，请刷新并核对待提交内容');
      const input = remoteInputs[method].parse(request.input);
      // Refreshes must not turn the receipt database into an unbounded archive
      // of complete personal snapshots. Only writes need durable transport receipts.
      // Restore confirmation fences generations itself and cannot enter replayable
      // receipts (nor may it store an uploaded backup in a request journal).
      if ((REMOTE_READ_METHODS as readonly RemoteMethod[]).includes(method) || method === 'restoreConfirm') {
        let result: unknown;
        try { result = await invoke(method, input, deviceId, modernAiSettings); } catch (error) { result = { ok: false, error: safeError(error) }; }
        if (method !== 'restoreConfirm') {
          if (lifecycle !== 'running') throw new RemoteFault(503, '服务正在退出，请重新读取资料');
          if (JSON.stringify(identity) !== JSON.stringify(state.identity())) throw new RemoteFault(409, '读取期间资料代际已改变，旧结果已丢弃，请重新连接核对');
        }
        return remoteOutputs[method].parse(redactEvidence(result));
      }
      // requestId is the durable transport retry boundary. Domain operationId remains
      // unchanged across preview and confirmation, whose transport IDs must differ.
      const fingerprint = createHash('sha256').update(JSON.stringify({ method, identity, input })).digest('hex');
      const current = running.get(request.requestId);
      if (current) {
        if (current.fingerprint !== `${deviceId}:${fingerprint}`) throw new RemoteFault(409, '请求编号已用于不同操作');
        return current.promise;
      }
      if (running.size >= maxWrites || [...running.values()].filter(value => value.deviceId === deviceId).length >= maxDeviceWrites) throw new RemoteFault(429, '正在处理的写请求过多，请稍后重试原请求');
      const prior = state.begin(request.requestId, deviceId, method, fingerprint);
      if (prior?.status === 'completed') return remoteOutputs[method].parse(prior.result);
      if (prior) throw new RemoteFault(409, prior.status === 'interrupted' ? '上次请求中断，结果待核对；未自动重新执行' : '请求正在处理，请查询原操作');
      const promise = (async () => {
        try {
          let raw: unknown;
          try { raw = await invoke(method, input, deviceId, modernAiSettings); } catch (error) { raw = { ok: false, error: safeError(error) } satisfies ApiResult<never>; }
          const result = remoteOutputs[method].parse(redactEvidence(raw));
          state.complete(request.requestId, result);
          backup(true);
          return result;
        } catch (error) { state.interrupt(request.requestId); throw error; }
        finally { running.delete(request.requestId); }
      })();
      running.set(request.requestId, { deviceId, fingerprint: `${deviceId}:${fingerprint}`, promise });
      return promise;
    },
    close(config: { graceMs?: number } = {}): Promise<void> {
      if (closePromise) return closePromise;
      lifecycle = 'draining'; clearInterval(maintenance); account.stop();
      closePromise = (async () => {
        const timer = setTimeout(() => shutdownAbort.abort(), Math.max(0, config.graceMs ?? 25_000)); timer.unref();
        try {
          await Promise.allSettled([...running.values()].map(value => value.promise));
          if (backupStatus.status === 'failed') backup(true);
          listeners.clear(); restoreStatus = state.restoreStatus(); ledger.close(); repository.close(); if (!options.state) state.close();
        } finally { clearTimeout(timer); lifecycle = 'closed'; releaseDirectory(); }
      })();
      return closePromise;
    },
  };
}
export type RemoteService = ReturnType<typeof createRemoteService>;
