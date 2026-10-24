import { z } from 'zod';
import { CaptureConfigSchema, CaptureSnapshotSchema } from '../shared/capture';
import { ImageDataUrlSchema } from '../shared/contracts';
import { nowInstant } from '../domain/time';
import { safeError, WorkflowError } from '../ai/deepseek';
import { createReadOnlyBridge, detectExistingBridge, type ReadOnlyBridge, type BridgeHealth, type BridgeConfiguration } from './bridge';
import { downloadAttachment, AttachmentDownloadError } from './download';
import { EXTRACTOR_VERSION, type DocumentExtraction, type DocumentInput } from './documents';
import { analyzeCapture } from './analysis';
import { isAddressedElsewhere, mentionLabel } from './recipients';
import type { CaptureStore, CapturedMessageInput, StoredCaptureMessage, StoredCaptureAttachment } from './store';
import type { Repository } from '../storage/repository';
import type { PriceQuote } from '../shared/account';
import type { ModelRequestRunner } from '../ai/request-queue';

type Raw = Record<string, unknown>;
const object = (value: unknown): Raw => value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};
const string = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
export const fromUnix = (value: unknown): string | null => { const n = seconds(value); if (n === null || n > 253_370_000_000) return null; return new Date(n * 1000 + 8 * 3600_000).toISOString().replace('Z', '+08:00'); };
export function normalizeMessage(raw: Raw, accountId: string, groupNames: Map<string, string>): CapturedMessageInput | null {
  const groupId = string(raw.group_id); const messageId = string(raw.message_id ?? raw.id); const sentAt = fromUnix(raw.time);
  if (!groupId || !messageId || !sentAt || raw.message_type === 'private') return null;
  const segments = Array.isArray(raw.message) ? raw.message.slice(0, 1000).map(object) : typeof raw.message === 'string' ? [{ type: 'text', data: { text: raw.message } }] : [];
  const attachments: NonNullable<CapturedMessageInput['attachments']> = [];
  const text: string[] = [];
  const warnings: string[] = [];
  if (Array.isArray(raw.message) && raw.message.length > 1000) warnings.push('消息超过 1000 个片段，只收录前 1000 个，请手动查看完整消息');
  for (const segment of segments) {
    const data = object(segment.data); const type = string(segment.type);
    if (type === 'text') text.push(string(data.text));
    else if (type === 'at') text.push(mentionLabel(data.qq, accountId));
    else if (type === 'face') text.push('[表情]');
    else if (['image', 'file', 'record', 'video', 'reply', 'forward', 'node'].includes(type)) {
      const kind = type === 'record' ? 'voice' : ['reply', 'forward', 'node'].includes(type) ? 'other' : type as 'image' | 'file' | 'video';
      const fallback = type === 'image' ? '群图片.jpg' : type === 'reply' ? '引用消息' : type === 'forward' || type === 'node' ? '合并转发' : type === 'record' ? '语音' : type === 'video' ? '视频' : '未命名文件';
      attachments.push({ kind, name: (string(data.name ?? data.file_name ?? data.filename) || fallback).slice(0, 1000), size: Number.isSafeInteger(Number(data.size ?? data.file_size)) && Number(data.size ?? data.file_size) >= 0 ? Number(data.size ?? data.file_size) : null, locator: z.json().parse({ type, data }) });
    }
  }
  const sender = object(raw.sender);
  if (attachments.length > 100) warnings.push('附件超过 100 个，仅处理前 100 个，请手动查看其余附件');
  const combined = text.join(''); if (combined.length > 990_000) warnings.push('消息正文过长，末尾内容需手动查看');
  return { accountId, groupId, messageId, sentAt, senderId: string(raw.user_id ?? sender.user_id) || null, senderName: (string(sender.card) || string(sender.nickname)).slice(0, 1000), groupName: (groupNames.get(groupId) || string(raw.group_name)).slice(0, 1000), text: [combined.slice(0, 990_000), ...warnings.map(w => `[采集提示：${w}]`)].filter(Boolean).join('\n'), segments: z.array(z.json()).parse(segments), attachments: attachments.slice(0, 100) };
}
export function createCaptureService(options: {
  store: CaptureStore; repository: Repository;
  credentials: { get(): Promise<string | null>; set(value: string | null): Promise<unknown>; status(): { configured: boolean } };
  getApiKey(): Promise<string | null>; extract(input: DocumentInput, signal?: AbortSignal): Promise<DocumentExtraction>;
  getPriceQuote?(model: string, currency: 'CNY' | 'USD'): PriceQuote | null;
  getModelInputModalities?(model: string): string[] | null;
  runModel?: ModelRequestRunner;
  afterModelRequest?(): void; onChanged?(value: z.infer<typeof CaptureSnapshotSchema>): void; onPlannerChanged?(): void;
  bridgeFactory?: typeof createReadOnlyBridge; downloader?: typeof downloadAttachment;
  fetch?: typeof fetch;
}) {
  const { store } = options;
  let bridge: ReadOnlyBridge | null = null;
  let health: BridgeHealth | null = null; let error: string | null = null; let lastReceivedAt: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null; let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false; let historyRunning = false; let stopped = false; let suspended = false; let connectionGeneration = 0;
  let groupNames = new Map<string, string>(); let connectPromise: Promise<z.infer<typeof CaptureSnapshotSchema>> | null = null;
  function snapshot() {
    const state = health?.state, config = store.config();
    return CaptureSnapshotSchema.parse({ config, connection: state === 'online' ? 'online' : state === 'account-mismatch' ? 'account-changed' : state === 'connecting' ? 'connecting' : state === 'error' ? 'error' : 'disconnected', accountLabel: health?.maskedAccount ?? null, accountName: health?.nickname ?? null, error: error ?? health?.error ?? null, lastReceivedAt, credentialConfigured: options.credentials.status().configured, stats: store.stats(), coverage: store.listCoverage(config.accountId ?? undefined).filter(item => config.groupIds.includes(item.groupId)) });
  }
  function emit() { if (!stopped && !notifyTimer) notifyTimer = setTimeout(() => { notifyTimer = null; if (!stopped) options.onChanged?.(snapshot()); }, 200); }
  function permitted(accountId: string, groupId: string, collection = true) { const config = store.config(); return !stopped && !suspended && (!collection || config.enabled) && config.accountId === accountId && config.groupIds.includes(groupId); }
  function ingest(raw: Raw) {
    const accountId = health?.accountId; if (!accountId || !permitted(accountId, string(raw.group_id))) return;
    try { const message = normalizeMessage(raw, accountId, groupNames); if (message) { const result = store.ingest([message]); if (result.inserted) { lastReceivedAt = nowInstant(); emit(); } } }
    catch { error = '有一条消息格式无法保存，已保留采集连接；请检查历史补采状态'; emit(); }
  }
  async function connect(request: { token?: string; detect?: boolean } = {}): Promise<z.infer<typeof CaptureSnapshotSchema>> {
    if (connectPromise) return connectPromise;
    if (running || historyRunning) throw new WorkflowError('CONFLICT', '当前采集或分析仍在处理，请暂停并等待后再重新连接');
    connectPromise = (async () => {
      let selected: BridgeConfiguration | undefined;
      if (request.detect) {
        const detected = await detectExistingBridge();
        selected = detected[0]; if (!selected) throw new WorkflowError('NOT_FOUND', '日历专用 QQ 桥接尚未配置，请先在终极日历的 qq-bridge 目录配置独立组件及访问令牌');
        const current = store.config(), flavor = selected.flavor ?? 'napcat';
        const changed = current.endpoint !== selected.endpoint || current.flavor !== flavor;
        store.saveConfig({ ...current, endpoint: selected.endpoint, flavor, enabled: !changed && current.enabled, analysisEnabled: !changed && current.analysisEnabled });
        await options.credentials.set(selected.token);
      }
      if (request.token) await options.credentials.set(request.token);
      const token = await options.credentials.get(); if (!token) throw new WorkflowError('VALIDATION', '请检测现有配置或填写本机 QQ 接口访问令牌');
      const generation = ++connectionGeneration; bridge?.stop(); health = null; error = null; emit();
      bridge = (options.bridgeFactory ?? createReadOnlyBridge)({ ...selected, endpoint: store.config().endpoint, flavor: store.config().flavor, token, expectedAccountId: store.config().accountId, isGroupSelected: (accountId, groupId) => permitted(accountId, groupId, false),
        onMessage: ingest,
        onRecall: raw => { const accountId = health?.accountId; if (!accountId) return; const m = store.messageByKey(accountId, string(raw.group_id), string(raw.message_id)); if (m) { store.markMessageChanged(m.id); emit(); } },
        onHealth: next => {
          if (generation !== connectionGeneration || stopped) return;
          const becameOnline = next.online && !health?.online; health = next;
          if (next.state === 'account-mismatch') { const c = store.config(); store.saveConfig({ ...c, enabled: false, analysisEnabled: false }); error = 'QQ 账号已改变。请清空原账号绑定后重新连接并选择群'; }
          if (next.online && next.accountId && !store.config().accountId) store.saveConfig({ ...store.config(), accountId: next.accountId, groupIds: [], enabled: false });
          emit(); if (becameOnline && store.config().enabled) void backfill();
        },
      });
      await bridge.start(); emit(); return snapshot();
    })();
    try { return await connectPromise; } finally { connectPromise = null; }
  }
  async function getGroups() {
    if (!bridge || !health?.online) throw new WorkflowError('VALIDATION', 'QQ 尚未在线，请先启动桥接、登录 QQ 并连接');
    const groups = await bridge.getGroups(); groupNames = new Map(groups.map(g => [g.id, g.name]));
    return groups.map(g => ({ id: g.id, name: g.name }));
  }
  async function configure(input: z.input<typeof CaptureConfigSchema>) {
    let next = CaptureConfigSchema.parse(input); const previous = store.config();
    const bridgeChanged = next.endpoint !== previous.endpoint || next.flavor !== previous.flavor;
    if ((running || historyRunning || connectPromise) && (next.accountId !== previous.accountId || bridgeChanged)) throw new WorkflowError('CONFLICT', '当前采集或分析仍在处理，请暂停并等待后再切换账号/接口');
    if (bridgeChanged) next = { ...next, enabled: false, analysisEnabled: false };
    if (next.enabled && (!health?.online || next.accountId !== health.accountId)) throw new WorkflowError('VALIDATION', '请先验证该 QQ 账号在线后再开始收集');
    if (next.groupIds.some(id => !previous.groupIds.includes(id))) {
      const groups = await getGroups(); if (next.groupIds.some(id => !groups.some(g => g.id === id))) throw new WorkflowError('VALIDATION', '所选群不属于当前在线账号，请刷新群列表');
    }
    store.saveConfig(next);
    if (bridgeChanged || next.accountId !== previous.accountId) { ++connectionGeneration; bridge?.stop(); bridge = null; health = null; }
    emit();
    if (next.enabled) void backfill();
    if (next.analysisEnabled) void tick(false);
    return snapshot();
  }
  async function backfill() {
    if (historyRunning || stopped || suspended || !bridge || !health?.online || !store.config().enabled) return;
    historyRunning = true; const client = bridge;
    try {
      const config = store.config(); if (!config.accountId) return;
      for (const groupId of config.groupIds) {
        if (!permitted(config.accountId, groupId) || client !== bridge || !health?.online) break;
        const previous = store.getCoverage(config.accountId, groupId);
        const resumable = previous && previous.status !== 'complete' && previous.cursor && Date.parse(nowInstant()) - Date.parse(previous.windowEnd) < 86400_000 ? previous : null;
        const end = nowInstant(); const start = fromUnix(Date.parse(end) / 1000 - 7 * 86400)!;
        // Always fill the newest gap first. Starting directly at an old cursor loses messages
        // received while disconnected. Once overlap is reached, jump to the saved older frontier.
        let resumeCursor = resumable?.cursor ?? null; const resumeUntil = resumable?.windowEnd ?? null;
        let cursor: string | null = null; let earliest: string | null = resumable?.earliestAt ?? null; let count = resumable?.fetchedCount ?? 0; let complete = false; let failure: string | null = null;
        const seen = new Set<string>();
        const save = (status: 'fetching' | 'complete' | 'partial' | 'failed') => store.saveCoverage({ accountId: config.accountId, groupId, status, windowStart: start, windowEnd: end, earliestAt: earliest, cursor, fetchedCount: count, updatedAt: nowInstant(), error: failure });
        save('fetching'); emit();
        try {
          // A bounded pass is an engineering limit, never a claim of complete history.
          for (let page = 0; page < 200; page++) {
            if (!permitted(config.accountId, groupId) || bridge !== client || !health?.online) { failure = '连接或采集状态发生变化，补采暂停；重新连接后继续检查最近七天'; break; }
            const result = await client.history(groupId, cursor, 100);
            if (!permitted(config.accountId, groupId) || bridge !== client || !health?.online) { failure = '采集状态已改变，已暂停历史读取'; break; }
            let pageEarliest: string | null = null;
            for (const raw of result.messages) {
              const at = fromUnix(raw.time); if (!at) { failure = '历史消息缺少有效发送时间，无法确认覆盖完整'; continue; }
              if (!pageEarliest || Date.parse(at) < Date.parse(pageEarliest)) pageEarliest = at;
              if (!earliest || at < earliest) earliest = at;
              if (Date.parse(at) <= Date.parse(start)) complete = true;
              if (Date.parse(at) >= Date.parse(start) && Date.parse(at) <= Date.parse(end)) { const parsed = normalizeMessage({ ...raw, group_id: groupId }, config.accountId, groupNames); if (parsed) count += store.ingest([{ ...parsed, origin: 'history' }]).inserted; }
            }
            if (complete) break;
            if (resumeCursor && resumeUntil && pageEarliest && Date.parse(pageEarliest) <= Date.parse(resumeUntil)) {
              cursor = resumeCursor; resumeCursor = null; seen.add(cursor); save('fetching'); emit();
              await new Promise(resolve => setTimeout(resolve, 200)); continue;
            }
            if (!result.messages.length || !result.nextCursor || seen.has(result.nextCursor)) { failure ||= '接口未返回更早消息，最近七天可能仍有缺口'; break; }
            seen.add(result.nextCursor); cursor = result.nextCursor; save('fetching'); emit();
            // Yield to real-time ingestion and UI; no network floods.
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          if (!complete && !failure) failure = '本轮已达到 200 页；已保存获取的消息，可再次补采核对剩余历史';
          save(complete && !failure ? 'complete' : 'partial');
        } catch { failure = '历史接口不可用或请求中断，已取得的消息仍保留；可手动补采'; save(count ? 'partial' : 'failed'); }
        emit();
      }
    } catch { error = 'QQ 补采状态未能保存，请检查本地存储后再试'; }
    finally { historyRunning = false; emit(); }
  }
  function remember(message: StoredCaptureMessage) {
    bridge?.rememberMessage({ self_id: message.accountId, group_id: message.groupId, message_type: 'group', message_id: message.messageId, time: Date.parse(message.sentAt) / 1000, message: message.segments });
  }
  async function processAttachment(message: StoredCaptureMessage, a: StoredCaptureAttachment) {
    if (a.status === 'ready' || a.status === 'deleted') return;
    if (!permitted(message.accountId, message.groupId, false)) throw new WorkflowError('CANCELLED', '来源群已取消选择，已停止附件处理');
    if (['voice', 'video'].includes(a.kind)) { store.setAttachmentStatus(a.id, 'unsupported', a.kind === 'voice' ? '语音不自动分析，请手动查看' : '视频不自动分析，请手动查看'); return; }
    if (a.size && a.size > 25 * 1024 * 1024) { store.setAttachmentStatus(a.id, 'too-large', '文件超过 25 MB 自动处理限额，请手动查看'); return; }
    const loc = object(a.locator); const data = object(loc.data); const type = string(loc.type);
    try {
      if (a.kind === 'other') {
        if (!bridge || !health?.online) throw Error('QQ 未在线'); remember(message);
        const refs = type === 'reply' ? [await bridge.getReferencedMessage(message.groupId, message.messageId, string(data.id))] : type === 'forward' ? await bridge.getForward(message.groupId, message.messageId, string(data.id)) : [data];
        const parts = refs.slice(0, 500).map((raw, index) => {
          const normalized = normalizeMessage({ ...raw, message: raw.message ?? raw.content, message_id: raw.message_id ?? `context-${index}`, group_id: message.groupId, time: raw.time ?? 0 }, message.accountId, groupNames);
          const segments = Array.isArray(raw.content ?? raw.message) ? (raw.content ?? raw.message) as unknown[] : [];
          const text = normalized?.text ?? segments.map(s => string(object(object(s).data).text)).join('');
          return { ordinal: index, location: `${type === 'reply' ? '引用' : '转发'} ${index + 1} · ${fromUnix(raw.time) || '原发送时间未知'}`, text, status: text.trim() ? 'ready' as const : 'failed' as const, error: !text.trim() ? '未取得可读上下文；嵌套图片/文件需手动查看' : segments.some(s => object(s).type !== 'text' && object(s).type !== 'at') ? '上下文内含未展开的图片/文件，请手动查看' : null, imageDataUrl: null, sentAt: fromUnix(raw.time) };
        });
        store.saveExtraction(a.id, { extractorVersion: EXTRACTOR_VERSION, chunks: parts, status: parts.some(p => p.error) ? 'failed' : 'ready', error: parts.some(p => p.error) ? '部分引用/转发内容需手动查看' : null }); return;
      }
      let bytes = store.readAttachmentBytes(a.id);
      if (!bytes) {
        if (!bridge || !health?.online) throw Error('QQ 未在线'); remember(message);
        store.setAttachmentStatus(a.id, 'downloading'); emit();
        const locator = a.kind === 'image' ? await bridge.getImage(message.groupId, message.messageId, string(data.file ?? data.file_id ?? data.url)) : await bridge.getFileUrl(message.groupId, message.messageId, string(data.id ?? data.file_id ?? data.file), typeof data.busid === 'number' ? data.busid : undefined);
        bytes = await (options.downloader ?? downloadAttachment)(locator, { fileName: a.name });
        if (!permitted(message.accountId, message.groupId, false)) throw new WorkflowError('CANCELLED', '来源群已取消选择，已停止附件处理');
        const saved = store.putAttachment(a.id, bytes);
        const cached = saved.hash && store.findExtraction(saved.hash, EXTRACTOR_VERSION);
        if (cached) { store.saveExtraction(a.id, { extractorVersion: EXTRACTOR_VERSION, chunks: cached.chunks.map(({ id: _id, attachmentId: _attachmentId, ...c }) => c) }); return; }
      }
      store.setAttachmentStatus(a.id, 'extracting'); emit();
      const result = await options.extract({ bytes, name: a.name });
      store.saveExtraction(a.id, { extractorVersion: EXTRACTOR_VERSION, chunks: result.parts.map((p, index) => ({ ordinal: index, location: p.locator, text: p.text, imageDataUrl: p.imageDataUrl && ImageDataUrlSchema.safeParse(p.imageDataUrl).success ? p.imageDataUrl : null, status: p.imageDataUrl && !ImageDataUrlSchema.safeParse(p.imageDataUrl).success ? 'failed' : 'ready', error: p.imageDataUrl && !ImageDataUrlSchema.safeParse(p.imageDataUrl).success ? '图像格式或大小不支持，需手动查看' : null })), status: result.status === 'ready' ? 'ready' : result.status === 'encrypted' ? 'encrypted' : result.status === 'unsupported' ? 'unsupported' : 'failed', error: result.warnings.join('；').slice(0, 2000) || null });
    } catch (cause) {
      const message = cause instanceof WorkflowError || cause instanceof AttachmentDownloadError ? cause.message : '附件下载、授权或解析未完成；请确认 QQ 在线后重试批次，或手动查看';
      store.setAttachmentStatus(a.id, cause instanceof AttachmentDownloadError ? cause.status : 'failed', message);
    } finally { emit(); }
  }
  async function tick(force = false) {
    if (running || stopped || suspended || connectPromise) return;
    const config = store.config(); if (!config.analysisEnabled) return;
    running = true;
    try {
      store.sealBatches({ force, maxMessages: 20 });
      for (let n = 0; n < 5 && !stopped && !suspended && store.config().analysisEnabled; n++) {
        const batch = store.claimBatch(); if (!batch) break; emit();
        try {
          if (!batch.result) for (const m of store.batchMessages(batch.id).filter(message => !isAddressedElsewhere(message))) for (const a of store.attachments(m.id)) {
            if (!store.config().analysisEnabled || stopped || suspended) throw new WorkflowError('CANCELLED', '分析已暂停');
            await processAttachment(m, a);
          }
          await analyzeCapture({ store, repository: options.repository, batch: store.batch(batch.id)!, getApiKey: options.getApiKey, getPriceQuote: options.getPriceQuote, getModelInputModalities: options.getModelInputModalities, runModel: options.runModel, afterRequest: options.afterModelRequest, fetch: options.fetch, canContinue: () => permitted(batch.accountId, batch.groupId, false) && store.config().analysisEnabled });
          options.onPlannerChanged?.();
        } catch (cause) {
          const current = store.batch(batch.id); if (!current) continue;
          const message = safeError(cause).message;
          if (current.status === 'result-ready') { error = 'AI 结果已保存，候选提交暂未完成；下次检查会继续提交，不重复调用 AI'; break; }
          if (cause instanceof WorkflowError && cause.code === 'CANCELLED' && current.status !== 'requesting') {
            store.failBatch(batch.id, '分析已暂停，恢复后继续已保存的进度'); store.retryBatch(batch.id); break;
          }
          const uncertain = current.status === 'requesting' && (!(cause instanceof WorkflowError) || ['NETWORK', 'AI_RESPONSE', 'STORAGE', 'INTERNAL'].includes(cause.code));
          store.failBatch(batch.id, uncertain ? `${message}。响应结果未知或未通过校验，自动重试已停止；手动重试可能再次计费` : message, uncertain);
          if (cause instanceof WorkflowError && ['NO_API_KEY', 'AUTH', 'BALANCE', 'RATE_LIMIT'].includes(cause.code)) { error = message; store.saveConfig({ ...store.config(), analysisEnabled: false }); break; }
        }
        emit();
      }
    } catch { error = 'QQ 分析队列暂时无法更新，请检查本地存储后再试'; }
    finally { running = false; emit(); }
  }
  return {
    snapshot, connect, configure, groups: getGroups,
    async start() { stopped = false; suspended = false; if (!timer) timer = setInterval(() => { void tick(); }, 5000); const config = store.config(), stats = store.stats(); if ((config.enabled || config.analysisEnabled && (stats.pendingBatches > 0 || stats.pendingMessages > 0)) && await options.credentials.get()) await connect(); },
    stop() { stopped = true; suspended = true; ++connectionGeneration; if (timer) clearInterval(timer); timer = null; if (notifyTimer) clearTimeout(notifyTimer); notifyTimer = null; bridge?.stop(); },
    busy: () => running || historyRunning || !!connectPromise,
    suspendForRestore() { if (running || historyRunning || connectPromise) throw new WorkflowError('CONFLICT', 'QQ 正在处理消息，请稍后恢复'); suspended = true; ++connectionGeneration; bridge?.stop(); health = null; },
    async resume() { suspended = false; emit(); if (store.config().enabled) await connect(); },
    action(request: { action: 'analyze' | 'backfill' | 'retry' | 'reanalyze' | 'disconnect'; batchId?: string }) {
      if (request.action === 'disconnect') {
        if (running || historyRunning || connectPromise) throw new WorkflowError('CONFLICT', '当前采集或分析仍在处理，请暂停并等待后再解除绑定');
        store.saveConfig({ ...store.config(), accountId: null, groupIds: [], enabled: false, analysisEnabled: false });
        ++connectionGeneration; bridge?.stop(); bridge = null; health = null; error = null; lastReceivedAt = null; groupNames.clear();
        emit(); return snapshot();
      }
      error = null;
      if (request.action === 'backfill') { if (!health?.online || !store.config().enabled) throw new WorkflowError('VALIDATION', '请先连接 QQ 并启用所选群收集'); void backfill(); }
      else { if (!store.config().analysisEnabled) throw new WorkflowError('VALIDATION', '分析已暂停，请先恢复自动分析'); if (request.action === 'retry') store.retryBatch(request.batchId!); if (request.action === 'reanalyze') store.reanalyzeBatch(request.batchId!); void tick(true); }
      emit(); return snapshot();
    },
    messages: store.listMessages, batches: store.listBatches,
    chunks(request: { attachmentId: string; offset?: number; limit?: number }) {
      const page = store.listChunks(request.attachmentId, { offset: request.offset ?? 0, limit: request.limit ?? 5 });
      return { ...page, items: page.items.map(c => ({ id: c.id, locator: c.location, text: c.text, imageDataUrl: c.imageDataUrl && ImageDataUrlSchema.safeParse(c.imageDataUrl).success ? c.imageDataUrl : null, status: c.status, error: c.error })) };
    },
    cleanup(request: Parameters<CaptureStore['cleanup']>[0]) { if (running || historyRunning) throw new WorkflowError('CONFLICT', '请等待当前采集/分析完成后再清理'); store.cleanup(request); emit(); return snapshot(); },
    previewAttachmentRetention: store.previewAttachmentRetention,
    cleanAttachments(policy: Parameters<CaptureStore['cleanAttachments']>[0]) {
      if (running || historyRunning || connectPromise) throw new WorkflowError('CONFLICT', '请等待当前采集/分析完成后再清理附件');
      const result = store.cleanAttachments(policy); emit(); return result;
    },
  };
}
export type CaptureService = ReturnType<typeof createCaptureService>;
