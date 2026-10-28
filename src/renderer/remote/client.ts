import { SnapshotSchema, type ApiResult, type ChangedEvent, type Snapshot } from '../../shared/contracts';
import type { PlannerClient, QueuedWrite } from '../../shared/client';
import type { LedgerSnapshot } from '../../shared/ledger';
import { RemoteOperationSchema, RemoteSessionSchema, type RemoteMethod } from '../../shared/remote';
import { remoteInputs, remoteOutputs } from '../../server/protocol';
import { allowsOffline, captureBase, instant, localId, projectSnapshot, rebaseWrite, references, resolveAliases, writeLabel } from './queue';
import { createOfflineStorage, emptyPartition, partitionKey, type OfflineStorage } from './storage';
import type { DeviceSummary, OfflinePartition, PairedSession, PendingWrite, RecoveryArchive, RemoteClientState, RemoteController } from './types';

interface ClientOptions {
  origin?: string; storage?: OfflineStorage; fetch?: typeof fetch;
  events?: (url: string) => EventSource; timeoutMs?: number; now?: () => number;
}
const SESSION_RENEW_INTERVAL_MS = 12 * 60 * 60_000;
const SESSION_RENEW_RETRY_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 8_000;
const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
class HttpFault extends Error { constructor(readonly status: number, message: string) { super(message); } }
const failure = (message: string, code: 'NETWORK' | 'AUTH' | 'STORAGE' | 'CONFLICT' | 'VALIDATION' = 'NETWORK', delivery?: 'not-sent' | 'unknown'): ApiResult<never> => ({ ok: false, error: { code, message, retryable: code === 'NETWORK', ...(delivery ? { delivery } : {}) } });
const sameIdentity = (a: PairedSession, b: PairedSession) => a.device.id === b.device.id && a.identity.dataInstanceId === b.identity.dataInstanceId && a.identity.generation === b.identity.generation;
const inputOperation = (input: unknown) => input && typeof input === 'object' && 'operationId' in input ? String(input.operationId) : undefined;
const confirmedReceipt = (result: ApiResult<unknown> | undefined) => !!result?.ok && !(result.data && typeof result.data === 'object' && 'status' in result.data && ['preview', 'clarification'].includes(String(result.data.status)));
// A rejected command analysis cannot mutate its selected records or resources. Keep its receipt,
// but do not make another command wait forever for that failed analysis to become completed.
const rejectedCommandAnalysis = (item: PendingWrite) => item.method === 'command' && item.status === 'failed'
  && item.result?.ok === false && item.result.error.code === 'AI_RESPONSE' && item.result.error.delivery !== 'unknown';
function draftEntryId(input: unknown) {
  const parsed = remoteInputs.ledgerMutate.safeParse(input);
  const change = parsed.success && parsed.data.changes.length === 1 ? parsed.data.changes[0] : undefined;
  return change?.type === 'putEntry' && change.expectedVersion === null ? change.entry.id : undefined;
}

/** One durable outbox per service generation and paired device. No token is kept in browser storage. */
export function createRemoteClient(options: ClientOptions = {}): RemoteController {
  const origin = options.origin ?? location.origin;
  const storage = options.storage ?? createOfflineStorage();
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const pointer = 'active:' + origin;
  const authBlockKey = 'auth-blocked:' + origin;
  let partition: OfflinePartition | undefined;
  let session: PairedSession | undefined;
  let state: RemoteClientState = { status: 'connecting', session: null, pending: [], cachedAt: null, message: '', storageError: '' };
  const listeners = new Set<() => void>(), changed = new Set<(event: ChangedEvent) => void>();
  let serial: Promise<unknown> = Promise.resolve(), initialized: Promise<void> | undefined, disposed = false;
  let loaded: Promise<void> | undefined, reconnectFlight: Promise<void> | undefined, cachedSessionAllowed = false, refreshAfterFlight = false;
  let eventSource: EventSource | undefined, refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let renewTimer: ReturnType<typeof setTimeout> | undefined, renewAfter = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined, reconnectFailures = 0;
  // Completed command replies can outlive outbox cleanup while their conversation still offers Retry.
  // Fingerprints avoid retaining image bytes or full conversation inputs in this small in-memory cache.
  const commandReplies = new Map<string, ApiResult<unknown>>();
  async function commandReplyKey(input: unknown) {
    if (!partition) return undefined;
    const namespace = partitionKey(origin, partition.session);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
    return namespace + ':' + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  }
  let validatedSnapshot: { source: Snapshot; value: Snapshot | null } | undefined;
  function stopRenewTimer() { if (renewTimer) clearTimeout(renewTimer); renewTimer = undefined; }
  function stopReconnectTimer() { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = undefined; }
  function scheduleReconnect(delay?: number) {
    if (disposed || reconnectTimer || !partition || ['expired', 'unpaired'].includes(state.status)
      || typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const wait = delay ?? Math.min(RECONNECT_INITIAL_MS * 2 ** Math.min(reconnectFailures++, 4), RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (reconnectFlight) { refreshAfterFlight = true; return; }
      void reconnect().catch(() => {});
    }, wait);
  }
  const clone = () => structuredClone(partition!);
  function emit(patch: Partial<RemoteClientState> = {}, dataChanged = false) {
    state = { ...state, session: session ?? (cachedSessionAllowed && ['connecting', 'offline'].includes(state.status) ? partition?.session : undefined) ?? null,
      pending: partition?.queue ?? [], cachedAt: partition?.cachedAt ?? null, ...patch };
    for (const listener of listeners) listener();
    if (dataChanged) for (const listener of changed) listener({ reason: 'mutation' });
  }
  function locked<T>(action: () => Promise<T>): Promise<T> {
    const exclusive = async () => {
      const run = async () => {
        // A second tab must start from the latest durable outbox, never overwrite its sibling's drafts.
        if (partition) { const latest = await storage.read<OfflinePartition>(partitionKey(origin, partition.session)); if (latest) partition = latest; }
        return action();
      };
      return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('planner-outbox:' + origin, run) : run();
    };
    const next = serial.then(exclusive, exclusive); serial = next.catch(() => {}); return next;
  }
  async function persist(next: OfflinePartition, dataChanged = false) {
    try {
      await storage.write(partitionKey(origin, next.session), { ...next, session: { ...next.session, csrfToken: '' } });
      partition = next; emit({ storageError: '' }, dataChanged);
    } catch {
      emit({ storageError: '无法可靠保存手机缓存或待提交操作，请释放储存空间后重试。' });
      throw new HttpFault(507, '手机储存未完成，操作没有被确认保存');
    }
  }
  function loadLocal() {
    return loaded ??= (async () => {
      try {
        const key = await storage.read<string>(pointer);
        const saved = key ? await storage.read<OfflinePartition>(key) : undefined;
        // The pointer must belong to this origin and the saved pairing, never another partition.
        if (saved && key === partitionKey(origin, saved.session)) {
          partition = saved;
          cachedSessionAllowed = await storage.read<string>(authBlockKey) !== key;
          if (!cachedSessionAllowed) emit({ status: 'expired', session: null, message: '设备授权待重新核对，原修改仍保留。' });
        }
      } catch { emit({ storageError: '无法打开手机储存，暂时不能保存离线修改。' }); }
      emit();
    })();
  }
  async function blockAuthorization(message: string) {
    cachedSessionAllowed = false; session = undefined; stopRenewTimer(); stopReconnectTimer(); eventSource?.close();
    emit({ status: partition ? 'expired' : 'unpaired', session: null, message });
    // Remember a known revocation across reloads without deleting the recoverable outbox.
    if (partition) {
      try { await storage.write(authBlockKey, partitionKey(origin, partition.session)); }
      catch { emit({ storageError: '无法保存授权状态，请恢复手机储存后重新核对连接。' }); }
    }
  }
  async function request<T>(path: string, input?: unknown, method = input === undefined ? 'GET' : 'POST'): Promise<T> {
    if (!path.startsWith('/api/v1/') || path.includes('\\') || new URL(path, origin).origin !== origin) throw Error('只能访问当前资料服务');
    const controller = new AbortController();
    const readOnly = ['/api/v1/session', '/api/v1/session/renew', '/api/v1/rpc/snapshot', '/api/v1/rpc/ledgerSnapshot'].includes(path);
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? (readOnly ? READ_TIMEOUT_MS : 60_000));
    try {
      const response = await fetcher(new URL(path, origin), { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method === 'GET' ? {} : { 'X-CSRF-Token': session?.csrfToken ?? '' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      const value: unknown = await response.json();
      if (!response.ok) {
        const message = value && typeof value === 'object' && 'error' in value && value.error && typeof value.error === 'object' && 'message' in value.error ? String(value.error.message) : '资料服务未完成请求';
        if (response.status === 401) await blockAuthorization('授权已失效；手机修改仍保留，尚未提交。');
        throw new HttpFault(response.status, message);
      }
      return value as T;
    } finally { clearTimeout(timer); }
  }
  function networkFailure(error: unknown) {
    if (['expired', 'unpaired'].includes(state.status)) return;
    if (error instanceof HttpFault && [401, 507].includes(error.status)) return;
    if (!(error instanceof HttpFault) || error.status >= 500 || [408, 429].includes(error.status)) {
      emit({ status: 'offline', session: session ?? partition?.session ?? null, message: '资料服务连接中断，正在尝试恢复。普通安排可离线暂存，生活助手需恢复连接后使用。' });
      scheduleReconnect();
    }
  }
  async function rpc(method: RemoteMethod, input: unknown, requestId: string = crypto.randomUUID()): Promise<ApiResult<unknown>> {
    if (!session) throw new HttpFault(401, '请先配对此设备');
    const result = await request<unknown>('/api/v1/rpc/' + method, { requestId, identity: session.identity, input });
    return remoteOutputs[method].parse(result);
  }
  async function read(method: 'snapshot' | 'ledgerSnapshot', input?: unknown): Promise<ApiResult<unknown>> {
    if (!partition || !session && state.status !== 'offline') return failure('请先配对并联网加载一次资料', 'AUTH');
    if (state.status === 'online' && session) {
      try {
        const result = await rpc(method, input);
        if (!result.ok) return result;
        const next = clone(); next.cachedAt = instant();
        if (method === 'snapshot') next.snapshot = result.data as Snapshot;
        else { const data = result.data as LedgerSnapshot; const month = input && typeof input === 'object' && 'month' in input && typeof input.month === 'string' ? input.month : instant().slice(0, 7); next.ledgers[month] = data; }
        await persist(next);
      } catch (error) { if (error instanceof HttpFault && error.status === 507) return failure(error.message, 'STORAGE'); networkFailure(error); if (error instanceof HttpFault && error.status === 401) return failure('设备授权已失效', 'AUTH'); }
    }
    if (method === 'snapshot') { const snapshot = projectCachedSnapshot(); return snapshot ? { ok: true, data: snapshot } : failure('此手机没有可读取的安排缓存，请联网刷新；待提交修改仍保留。'); }
    const month = input && typeof input === 'object' && 'month' in input && typeof input.month === 'string' ? input.month : instant().slice(0, 7);
    const ledger = partition?.ledgers[month]; return ledger ? { ok: true, data: ledger } : failure('此月份尚无账本缓存，请联网加载；离线草稿不计入正式余额');
  }
  async function refreshCanonical(includeLedgers = true) {
    const result = await rpc('snapshot', undefined);
    if (!result.ok) throw Error(result.error.message);
    const next = clone(); next.snapshot = result.data as Snapshot; next.cachedAt = instant();
    for (const month of includeLedgers ? Object.keys(next.ledgers) : []) {
      const ledger = await rpc('ledgerSnapshot', { month });
      if (!ledger.ok) throw Error(ledger.error.message);
      next.ledgers[month] = ledger.data as LedgerSnapshot;
    }
    await persist(next, !includeLedgers);
  }
  function connectEvents() {
    eventSource?.close();
    const factory = options.events ?? (typeof EventSource === 'undefined' ? undefined : (url: string) => new EventSource(url));
    if (!factory || disposed) return;
    const source = factory(new URL('/api/v1/events', origin).href);
    eventSource = source;
    // Re-read the authoritative session as well as data: an event can announce a restored generation.
    const retry = () => {
      if (disposed || ['expired', 'unpaired'].includes(state.status)) return;
      if (reconnectFlight) refreshAfterFlight = true;
      else void reconnect().catch(() => {});
    };
    source.addEventListener('changed', () => {
      if (disposed || eventSource !== source) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(retry, 250);
    });
    source.onerror = () => {
      if (disposed || eventSource !== source) return;
      source.close(); eventSource = undefined;
      // A one-shot SSE retry can also fail while Wi-Fi remains connected. Keep bounded foreground
      // retries after that failure; browser online/pageshow events are not guaranteed to fire again.
      scheduleReconnect(15_000);
    };
  }
  async function acceptSession(value: unknown) {
    const parsed = RemoteSessionSchema.parse(value);
    if (!parsed.paired) { await blockAuthorization(partition?.queue.length ? '原设备仍有待提交修改，重新配对不会自动转移或清除它们。' : ''); return false; }
    if (partition && !sameIdentity(partition.session, parsed) && partition.queue.length) {
      await blockAuthorization('服务资料代际或设备授权发生变化。原修改已隔离保存；需要先在原会话核对，不能自动重放到新资料。');
      throw new HttpFault(409, state.message);
    }
    const key = partitionKey(origin, parsed);
    const next = sameIdentity(partition?.session ?? parsed, parsed) && partition ? clone() : await storage.read<OfflinePartition>(key) ?? emptyPartition(parsed);
    next.session = { ...parsed, csrfToken: '' };
    await persist(next); await storage.write(pointer, key); await storage.remove(authBlockKey);
    cachedSessionAllowed = true;
    if (!session || !sameIdentity(session, parsed)) renewAfter = 0;
    session = parsed; emit({ status: 'online', session: parsed, message: '' }); connectEvents(); return true;
  }
  /** Session maintenance is independent of the business outbox and cannot replay a write. */
  async function renewSessionIfDue() {
    if (disposed || !session || state.status !== 'online') return false;
    if (now() < renewAfter || typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
    const expected = session;
    renewAfter = now() + SESSION_RENEW_RETRY_MS;
    try {
      const parsed = RemoteSessionSchema.parse(await request('/api/v1/session/renew', undefined, 'POST'));
      if (disposed || session !== expected || state.status !== 'online') return false;
      if (!parsed.paired || !sameIdentity(expected, parsed) || parsed.csrfToken !== expected.csrfToken) {
        await blockAuthorization('续期时设备授权或资料身份发生变化，原修改已保留，请重新核对连接。');
        return false;
      }
      session = parsed; renewAfter = now() + SESSION_RENEW_INTERVAL_MS; emit({ session: parsed });
      return true;
    } catch {
      // A lost maintenance response never resends business mutations, discards drafts or restores revoked auth.
      // Legacy services may not yet expose this endpoint; ordinary authenticated work remains available.
      return !!session && state.status === 'online';
    }
  }
  function scheduleRenewal() {
    stopRenewTimer();
    if (disposed || !session || state.status !== 'online') return;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    renewTimer = setTimeout(() => {
      renewTimer = undefined;
      void locked(renewSessionIfDue).catch(() => {}).finally(scheduleRenewal);
    }, Math.max(1000, hidden ? SESSION_RENEW_RETRY_MS : renewAfter - now()));
  }
  async function finish(item: PendingWrite, result: ApiResult<unknown>): Promise<void> {
    if (!partition) return;
    const next = clone(), saved = next.queue.find(value => value.id === item.id); if (!saved) return;
    if (item.method === 'command') {
      const key = await commandReplyKey(item.input);
      if (key) {
        commandReplies.set(key, result);
        while (commandReplies.size > 20) commandReplies.delete(commandReplies.keys().next().value!);
      }
    }
    saved.result = result;
    if (!result.ok) {
      saved.status = result.error.code === 'CONFLICT' ? 'conflict' : 'failed'; saved.message = result.error.message;
      await persist(next, true); return;
    }
    const data = result.data as Record<string, unknown>;
    if (data && data.status === 'preview') {
      saved.status = 'review'; saved.preview = result.data as PendingWrite['preview']; saved.message = String(data.message);
      await persist(next, true); return;
    }
    if (data && data.status === 'clarification') {
      saved.status = 'conflict'; saved.message = '服务需要重新确认这项修改，请查看事项后调整。'; await persist(next, true); return;
    }
    // A successful receipt is retained until the canonical cache is refreshed. A dropped refresh can only query this same request.
    saved.status = 'uncertain'; saved.message = '服务已确认，正在核对最新资料。'; await persist(next);
    await refreshCanonical();
    const complete = clone();
    if ((item.method === 'ledgerMutate' || item.method === 'ledgerUndo') && data && data.snapshot) {
      const original = item.input as { expectedRevision: number };
      complete.ledgerRevisions ??= {};
      complete.ledgerRevisions[item.id] = { base: original.expectedRevision, after: (data.snapshot as LedgerSnapshot).revision };
    }
    if (item.method === 'mutate' && data && Array.isArray(data.changes)) {
      const input = remoteInputs.mutate.parse(item.wireInput ?? item.input);
      const creates = data.changes.filter((change: Record<string, unknown>) => change.action === 'create');
      const used = new Set<string>();
      input.mutations.forEach((change, index) => {
        if (change.type !== 'create') return;
        const match = creates.find((created: Record<string, unknown>) => created.entity === change.entity && !used.has(String(created.id)));
        if (match) { used.add(String(match.id)); complete.aliases[localId(item, index)] = String(match.id); }
      });
    }
    complete.queue = complete.queue.filter(value => value.id !== item.id);
    complete.completed.push(item.id);
    await persist(complete, true);
  }
  async function flush(): Promise<Map<string, ApiResult<unknown>>> {
    const results = new Map<string, ApiResult<unknown>>();
    if (!partition || !session || state.status !== 'online') return results;
    for (const id of partition.queue.map(item => item.id)) {
      let item = partition.queue.find(value => value.id === id);
      if (!item || !['queued', 'sending', 'uncertain', 'blocked'].includes(item.status)) continue;
      if (JSON.stringify(item.identity) !== JSON.stringify(session.identity)) continue;
      if (item.dependencies.some(dependency => !partition!.completed.includes(dependency))) {
        const next = clone(); const saved = next.queue.find(value => value.id === id)!;
        saved.status = 'blocked'; saved.message = '前置修改尚未确认，请先处理它。'; await persist(next); continue;
      }
      try {
        if (confirmedReceipt(item.result)) { results.set(id, item.result!); await finish(item, item.result!); continue; }
        if (['sending', 'uncertain'].includes(item.status)) {
          const operation = RemoteOperationSchema.parse(await request('/api/v1/operations/' + encodeURIComponent(item.requestId)));
          if (operation.status === 'completed') {
            if (operation.method !== item.method) throw Error('操作回执类型不匹配');
            const result = remoteOutputs[item.method].parse(operation.result); results.set(id, result); await finish(item, result); continue;
          }
          if (operation.status !== 'unknown') {
            const next = clone(); const saved = next.queue.find(value => value.id === id)!;
            saved.status = 'uncertain'; saved.message = operation.status === 'interrupted' ? '服务在执行中重启，结果须人工核对；不会自动重复执行或收费。' : '原操作仍在处理中，稍后查询。'; await persist(next); continue;
          }
        }
        const next = clone(); const sending = next.queue.find(value => value.id === id)!;
        if (sending.wireInput === undefined) {
          sending.wireInput = resolveAliases(sending.input, next.aliases);
          if (sending.method === 'ledgerMutate') {
            const input = remoteInputs.ledgerMutate.parse(sending.wireInput);
            const previous = sending.dependencies.map(dependency => next.ledgerRevisions?.[dependency]).filter(value => !!value).at(-1);
            const cached = next.ledgers[input.month ?? instant().slice(0, 7)];
            // Only our own immediately preceding confirmed draft can advance this base revision.
            // Any other device's revision remains a conflict, never an implicit overwrite.
            if (previous && previous.base === input.expectedRevision && cached?.revision === previous.after)
              sending.wireInput = { ...input, expectedRevision: previous.after };
          }
        }
        sending.status = 'sending'; sending.message = '已在手机持久保存，等待服务确认。';
        await persist(next); item = sending;
        const result = await rpc(item.method, item.wireInput, item.requestId); results.set(id, result);
        await finish(item, result);
      } catch (error) {
        if (error instanceof HttpFault && error.status === 507) throw error;
        const next = clone(); const saved = next.queue.find(value => value.id === id)!;
        const definitive = error instanceof HttpFault && [400, 403, 409, 413, 415].includes(error.status);
        saved.status = definitive && !confirmedReceipt(saved.result) ? (error.status === 409 ? 'conflict' : 'failed') : 'uncertain';
        saved.message = confirmedReceipt(saved.result) ? '服务已确认保存，最新资料尚未核对；不会重复提交。' : error instanceof Error ? error.message : '结果未知，请联网查询原操作'; await persist(next, true);
        networkFailure(error); if (state.status !== 'online') break;
      }
    }
    return results;
  }
  async function write(method: RemoteMethod, value: unknown): Promise<ApiResult<unknown>> {
    let input: unknown;
    try { input = remoteInputs[method].parse(value); } catch { return failure('修改内容不符合资料契约', 'VALIDATION', 'not-sent'); }
    const operationId = inputOperation(input);
    const equivalent = partition?.queue.find(item => item.method === method && (operationId ? inputOperation(item.input) === operationId && JSON.stringify(item.input) === JSON.stringify(input) : JSON.stringify(item.input) === JSON.stringify(input)));
    if (!partition || !session && state.status !== 'offline') return failure('请先配对此设备', 'AUTH', equivalent ? 'unknown' : 'not-sent');
    const offline = allowsOffline(method, input, projectCachedSnapshot());
    if (state.status !== 'online' && !offline) return equivalent
      ? failure('原指令的处理结果尚未确认。恢复连接后请查询原操作，勿另建重复指令。', 'NETWORK', 'unknown')
      : failure('连接资料服务失败，这条指令尚未发送。请检查网络或 Tailscale 后重试。', 'NETWORK', 'not-sent');
    let item = equivalent;
    if (!item) {
      const next = clone();
      // Confirming a preview consumes that preview's queue entry, but has its own transport request ID.
      const confirmed = method === 'mutate' && remoteInputs.mutate.parse(input).confirmed;
      const draftId = method === 'ledgerMutate' ? draftEntryId(input) : undefined;
      const previous = confirmed ? next.queue.find(pending => pending.method === method && inputOperation(pending.input) === operationId && pending.status === 'review')
        : draftId ? next.queue.find(pending => pending.method === 'ledgerMutate' && pending.status === 'failed' && pending.result?.ok === false && pending.result.error.code === 'VALIDATION' && draftEntryId(pending.input) === draftId) : undefined;
      const refs = references(input);
      item = { id: previous?.id ?? crypto.randomUUID(), requestId: crypto.randomUUID(), method, input, identity: partition!.session.identity,
        createdAt: instant(), status: 'queued', label: writeLabel(method, input), message: '待提交 · 仅保存在此手机', base: captureBase(method, input, partition!),
        dependencies: next.queue.filter(pending => pending.id !== previous?.id && !rejectedCommandAnalysis(pending)
          && pending.targets.some(target => refs.includes(target))).map(pending => pending.id), targets: refs };
      if (previous) item.dependencies = previous.dependencies;
      else if (method === 'ledgerMutate' || method === 'ledgerUndo') {
        const predecessor = next.queue.findLast(pending => pending.method === 'ledgerMutate' || pending.method === 'ledgerUndo');
        if (predecessor && !item.dependencies.includes(predecessor.id)) item.dependencies.push(predecessor.id);
      }
      if (method === 'mutate') remoteInputs.mutate.parse(input).mutations.forEach((change, index) => { if (change.type === 'create') item!.targets.push(localId(item!, index)); });
      next.queue = previous ? next.queue.map(pending => pending.id === previous.id ? item! : pending) : [...next.queue, item];
      try { await persist(next, true); } catch { return failure('手机储存失败，未发送这项修改', 'STORAGE', 'not-sent'); }
    }
    try {
      const result = (await flush()).get(item.id) ?? partition!.queue.find(pending => pending.id === item!.id)?.result;
      if (result) return result;
    } catch { return failure('手机储存异常。若操作已发送，请先恢复储存并查询结果，勿另建重复操作', 'STORAGE', 'unknown'); }
    const queued: QueuedWrite = { status: 'queued', requestId: item.requestId, message: '待提交 · 已保存在此手机，尚未获得资料服务确认' };
    return offline ? { ok: true, data: queued } : failure(method === 'command'
      ? '已保留原指令，尚未确认处理结果。'
      : '操作结果尚未确认，已保留原操作标识。请在「我的」查询，勿重复创建。', 'NETWORK', 'unknown');
  }
  async function command(value: unknown) {
    await loadLocal();
    // Wait outside the outbox lock: reconnect owns that same lock. A failed read immediately before
    // this command must not leave the user stuck offline merely because the browser still has Wi-Fi.
    await locked(async () => {});
    const parsed = remoteInputs.command.safeParse(value);
    if (!parsed.success) return failure('修改内容不符合资料契约', 'VALIDATION', 'not-sent');
    const key = await commandReplyKey(parsed.data);
    const reply = key && commandReplies.get(key);
    if (reply && !['expired', 'unpaired'].includes(state.status)) return reply;
    const original = partition?.queue.find(item => item.method === 'command' && JSON.stringify(item.input) === JSON.stringify(parsed.data));
    if (['connecting', 'offline'].includes(state.status)) {
      try { await reconnect(); }
      catch (error) {
        if (error instanceof HttpFault && error.status === 507) return failure(error.message, 'STORAGE', original ? 'unknown' : 'not-sent');
      }
    }
    // Reconnection may have queried and completed this exact original request. Use that reply, even
    // after its durable queue item was removed, instead of creating a second transport request ID.
    const recovered = key && commandReplies.get(key);
    if (recovered && !['expired', 'unpaired'].includes(state.status) && key === await commandReplyKey(parsed.data)) return recovered;
    return locked(() => write('command', value));
  }
  function reconnect(): Promise<void> {
    if (disposed) return Promise.resolve();
    // iOS can fire pageshow, online and visibilitychange for the same foreground transition.
    return reconnectFlight ??= loadLocal().then(() => locked(async () => {
      stopReconnectTimer();
      try {
        if (!await acceptSession(await request('/api/v1/session'))) return;
        emit({ status: 'connecting' });
        // Publish the calendar before maintenance, queued work or any historical ledger reads.
        await refreshCanonical(false);
        reconnectFailures = 0;
        emit({ status: 'online', message: '' });
        if (!await renewSessionIfDue()) return;
        await flush();
      } catch (error) { networkFailure(error); if (error instanceof HttpFault && [409, 507].includes(error.status)) throw error; }
      finally { scheduleRenewal(); }
    })).finally(() => {
      reconnectFlight = undefined;
      if (refreshAfterFlight) {
        refreshAfterFlight = false;
        if (!disposed && !['expired', 'unpaired'].includes(state.status)) void reconnect().catch(() => {});
      }
    });
  }
  const online = () => { if (!disposed) void reconnect().catch(() => {}); };
  const visible = () => { if (document.visibilityState === 'visible') online(); else stopReconnectTimer(); };
  const offlineEvent = () => { if (['expired', 'unpaired'].includes(state.status)) return; emit({ status: 'offline', session: session ?? partition?.session ?? null, message: '网络已断开。普通安排可以暂存到此手机。' }); scheduleReconnect(); };
  function recoveryArchive(): RecoveryArchive {
    if (!partition?.queue.length) throw Error('当前没有需要导出的待提交修改');
    return { id: crypto.randomUUID(), createdAt: instant(), reason: state.message || '本机待提交修改',
      identity: structuredClone(partition.session.identity), device: structuredClone(partition.session.device), cachedAt: partition.cachedAt, pending: structuredClone(partition.queue) };
  }
  function projectCachedSnapshot() {
    if (!partition?.snapshot) return null;
    // Cached objects predate the current renderer. Validate/default them just like an RPC response,
    // without rewriting the durable outbox or discarding an unreadable old cache.
    if (validatedSnapshot?.source !== partition.snapshot) {
      const parsed = SnapshotSchema.safeParse(partition.snapshot);
      validatedSnapshot = { source: partition.snapshot, value: parsed.success ? parsed.data : null };
    }
    if (!validatedSnapshot.value) return null;
    try { return projectSnapshot({ ...partition, snapshot: validatedSnapshot.value }); }
    catch { return null; }
  }
  function cachedSnapshot() {
    if (!cachedSessionAllowed || !partition || ['expired', 'unpaired'].includes(state.status)
      || session && !sameIdentity(session, partition.session)) return null;
    return projectCachedSnapshot();
  }
  async function calendarSnapshot(): Promise<ApiResult<Snapshot>> {
    await loadLocal();
    const flight = reconnectFlight ?? (state.status === 'connecting' ? reconnect() : undefined);
    if (flight) {
      // A fresh install may have no cache yet. Release its read as soon as the calendar arrives,
      // even if renewal or pending writes are still in flight; known auth failures release it too.
      if (!cachedSnapshot() && !['expired', 'unpaired'].includes(state.status)) {
        let wake!: () => void;
        const ready = new Promise<void>(resolve => { wake = resolve; });
        const check = () => { if (cachedSnapshot() || ['expired', 'unpaired'].includes(state.status)) wake(); };
        listeners.add(check);
        try { check(); await Promise.race([ready, flight.catch(() => {})]); }
        finally { listeners.delete(check); }
      }
      const snapshot = cachedSnapshot();
      if (snapshot) return { ok: true, data: snapshot };
      if (['expired', 'unpaired'].includes(state.status)) return failure('设备授权已失效', 'AUTH');
    }
    return locked(() => read('snapshot')) as Promise<ApiResult<Snapshot>>;
  }
  const controller: RemoteController = {
    client: {
      // Read-only projection bypasses the write lock; it never sends or acknowledges a draft.
      snapshot: calendarSnapshot,
      ledgerSnapshot: input => locked(() => read('ledgerSnapshot', input)),
      mutate: input => locked(() => write('mutate', input)), undo: id => locked(() => write('undo', id ?? partition?.snapshot?.journal.findLast(entry => entry.undoable && !entry.undoneAt)?.id)),
      command, importSource: input => locked(() => write('importSource', input)),
      analyzeSource: input => locked(() => write('analyzeSource', input)), ledgerMutate: input => locked(() => write('ledgerMutate', input)),
      ledgerUndo: input => locked(() => write('ledgerUndo', input)), onChanged(listener) { changed.add(listener); return () => { changed.delete(listener); }; },
    } as PlannerClient,
    getState: () => state, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, request,
    initialize() {
      return initialized ??= (async () => {
        await loadLocal();
        if (typeof window !== 'undefined') { window.addEventListener('online', online); window.addEventListener('offline', offlineEvent); window.addEventListener('pageshow', online); }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible);
        await reconnect();
      })();
    },
    pair: (code, name) => locked(async () => {
      if (partition?.queue.length && state.status === 'expired') throw Error('原设备有未完成操作。请恢复原设备会话或先核对保留的修改，不能直接换身份提交。');
      if (await acceptSession(await request('/api/v1/pair', { code, name }))) {
        renewAfter = now() + SESSION_RENEW_INTERVAL_MS;
        await refreshCanonical(); emit({}, true); scheduleRenewal();
      }
    }), reconnect,
    resolve: (id, action) => locked(async () => {
      const item = partition?.queue.find(value => value.id === id); if (!item) return;
      if (action === 'discard') {
        if (!['queued', 'conflict', 'failed', 'review'].includes(item.status) && !(item.status === 'blocked' && item.wireInput === undefined)) throw Error('结果未知或正在执行的操作不能丢弃，先查询原操作结果');
        if (partition!.queue.some(value => value.dependencies.includes(id))) throw Error('后续修改依赖这项操作。请先处理或放弃依赖它的修改');
        const next = clone(); next.queue = next.queue.filter(value => value.id !== id); await persist(next, true); return;
      }
      if (state.status !== 'online') throw Error('请先重新连接资料服务');
      if (action === 'use-local') {
        if (item.status !== 'conflict') throw Error('只有明确的版本冲突可重新提出本机修改');
        await refreshCanonical(); const next = clone(); const saved = next.queue.find(value => value.id === id)!;
        saved.input = rebaseWrite(item, next); saved.requestId = crypto.randomUUID(); delete saved.wireInput; delete saved.result; delete saved.preview;
        saved.base = captureBase(item.method, saved.input, next); saved.status = 'queued'; saved.message = '已基于最新资料重新提出修改'; await persist(next);
      } else if (action === 'confirm') {
        if (!item.preview || item.status !== 'review') throw Error('此操作没有可确认的预览');
        const next = clone(); const saved = next.queue.find(value => value.id === id)!;
        saved.input = { ...item.preview.proposedRequest, confirmed: true, confirmationToken: item.preview.confirmationToken };
        saved.requestId = crypto.randomUUID(); saved.status = 'queued'; delete saved.wireInput; delete saved.result; delete saved.preview; await persist(next);
      } else if (item.status === 'failed' || item.status === 'conflict') throw Error('服务已返回明确失败，请调整原内容或基于最新版本重新提出；不会重复已结束的请求');
      await flush();
    }),
    logout: () => locked(async () => {
      if (partition?.queue.length) throw Error('还有未提交或结果未知的修改，请先处理后退出');
      await request('/api/v1/logout', {}); await storage.remove(pointer); partition = undefined; session = undefined; stopRenewTimer(); stopReconnectTimer(); eventSource?.close(); emit({ status: 'unpaired', session: null, message: '' });
    }),
    async devices() { const result = await request<{ devices: DeviceSummary[] }>('/api/v1/devices'); return result.devices.map(device => ({ ...device, current: device.id === session?.device.id })); },
    async revokeDevice(id) { if (id === session?.device.id) return controller.logout(); await request('/api/v1/devices/' + encodeURIComponent(id), undefined, 'DELETE'); },
    clearCache: () => locked(async () => {
      if (partition?.queue.length) throw Error('还有未提交或结果未知的修改，不能清理缓存');
      if (!partition) return; const next = clone(); next.snapshot = null; next.ledgers = {}; next.cachedAt = null; await persist(next, true);
    }),
    exportPending: () => locked(async () => recoveryArchive()),
    archivePending: () => locked(async () => {
      if (state.status !== 'expired') throw Error('只有授权失效或资料代际变化时才需要隔离旧队列');
      const archive = recoveryArchive();
      const archiveKey = 'archive:' + origin + ':' + archive.id, indexKey = 'archives:' + origin;
      // Each step precedes detachment. A failed write keeps the active partition and all drafts recoverable.
      await storage.write(archiveKey, archive);
      const index = await storage.read<string[]>(indexKey) ?? [];
      await storage.write(indexKey, [...index, archiveKey]);
      await storage.remove(pointer);
      partition = undefined; session = undefined; stopRenewTimer(); stopReconnectTimer(); eventSource?.close();
      emit({ status: 'unpaired', session: null, message: '旧修改已保留在此手机的隔离档案。新配对不会自动发送它们。' });
      return archive;
    }),
    archives: () => locked(async () => {
      const keys = await storage.read<string[]>('archives:' + origin) ?? [];
      const values = await Promise.all(keys.map(key => storage.read<RecoveryArchive>(key)));
      return values.filter((value): value is RecoveryArchive => !!value);
    }),
    dispose() { disposed = true; stopRenewTimer(); stopReconnectTimer(); eventSource?.close(); if (refreshTimer) clearTimeout(refreshTimer); if (typeof window !== 'undefined') { window.removeEventListener('online', online); window.removeEventListener('offline', offlineEvent); window.removeEventListener('pageshow', online); } if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visible); listeners.clear(); changed.clear(); },
  };
  return controller;
}
