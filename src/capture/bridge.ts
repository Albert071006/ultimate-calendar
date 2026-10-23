import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';

type Raw = Record<string, unknown>;
export type BridgeHealth = {
  state: 'stopped' | 'connecting' | 'online' | 'offline' | 'account-mismatch' | 'error';
  connected: boolean;
  online: boolean;
  accountId: string | null;
  maskedAccount: string | null;
  nickname: string | null;
  lastEventAt: string | null;
  error: string | null;
};
export type BridgeGroup = { id: string; name: string; memberCount?: number };
/** Credentials are main-process-only. Never include this object in an IPC response or log. */
export type BridgeConfiguration = { endpoint: string; token: string; source?: string; flavor?: 'snowluma' | 'napcat' };
const attachmentCapability = Symbol('QQ attachment provenance');
const attachmentLocations = new WeakSet<object>();
export type BridgeAttachmentLocation = Raw & { readonly [attachmentCapability]: true; readonly url?: string; readonly path?: string };
export function isBridgeAttachmentLocation(value: unknown): value is BridgeAttachmentLocation {
  return typeof value === 'object' && value !== null && attachmentLocations.has(value);
}
function attachmentLocation(data: Raw): BridgeAttachmentLocation {
  const file = typeof data.file === 'string' ? data.file : undefined;
  const url = typeof data.url === 'string' && data.url ? data.url : file && /^https?:\/\//i.test(file) ? file : undefined;
  const path = typeof data.path === 'string' ? data.path : file && !/^https?:\/\//i.test(file) ? file : undefined;
  const location: BridgeAttachmentLocation = Object.freeze({ ...data, ...(url ? { url } : {}), ...(path ? { path } : {}), [attachmentCapability]: true as const });
  attachmentLocations.add(location);
  return location;
}
export type BridgeOptions = BridgeConfiguration & {
  expectedAccountId?: string | null;
  isGroupSelected: (accountId: string, groupId: string) => boolean;
  onMessage?: (message: Raw) => void;
  onRecall?: (notice: Raw) => void;
  onHealth?: (health: BridgeHealth) => void;
  requestTimeoutMs?: number;
  healthIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  maxPayloadBytes?: number;
};

const READ_ACTIONS = new Set(['get_status', 'get_login_info', 'get_group_list', 'get_group_msg_history', 'get_msg', 'get_forward_msg', 'get_group_file_url', 'get_image']);
const raw = (value: unknown): Raw | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Raw : null;
const id = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const messageId = (message: Raw): string | null => id(message.message_id ?? message.id);
const masked = (value: string): string => value.length > 3 ? '*'.repeat(value.length - 3) + value.slice(-3) : '***';

export function validateBridgeEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('QQ 桥接地址格式不正确'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error('QQ 桥接只允许有鉴权的本机回环 WebSocket 地址');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.toString();
}

/** Electron's Node runtime supports the JSON source context, preserving numeric platform IDs. */
function parsePacket(text: string): unknown {
  return JSON.parse(text, (key, value: unknown, context?: { source?: string }) => {
    if (typeof value === 'number' && /(?:^|_)id$|^message_seq$/.test(key) && context?.source && /^-?\d+$/.test(context.source)) return context.source;
    return value;
  });
}

type Source = { refs: Set<string>; forwards: Set<string>; files: Map<string, number | undefined>; images: Set<string> };
type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Only this client owns the socket. There is deliberately no public arbitrary-action method. */
export class ReadOnlyBridge {
  #options: BridgeOptions;
  #endpoint: string;
  #socket: WebSocket | null = null;
  #active = false;
  #generation = 0;
  #failures = 0;
  #accountId: string | null = null;
  #nickname: string | null = null;
  #boundAccount: string | null;
  #health: BridgeHealth = { state: 'stopped', connected: false, online: false, accountId: null, maskedAccount: null, nickname: null, lastEventAt: null, error: null };
  #pending = new Map<string, Pending>();
  #sources = new Map<string, Source>();
  #reconnect: ReturnType<typeof setTimeout> | null = null;
  #healthTimer: ReturnType<typeof setInterval> | null = null;
  #verifying: Promise<void> | null = null;
  #startResult: Promise<BridgeHealth> | null = null;
  #resolveStart: ((value: BridgeHealth) => void) | null = null;
  constructor(options: BridgeOptions) {
    this.#endpoint = validateBridgeEndpoint(options.endpoint);
    if (!options.token.trim() || options.token.length > 8192 || /[\r\n]/.test(options.token)) throw new Error('QQ 桥接需要有效的访问令牌');
    this.#options = options;
    this.#boundAccount = options.expectedAccountId || null;
  }

  status(): BridgeHealth { return { ...this.#health }; }
  start(): Promise<BridgeHealth> {
    if (this.#active) return this.#startResult ?? Promise.resolve(this.status());
    this.#active = true;
    this.#startResult = new Promise(resolve => { this.#resolveStart = resolve; });
    this.#open();
    return this.#startResult;
  }
  stop(): void {
    this.#active = false;
    ++this.#generation;
    if (this.#reconnect) clearTimeout(this.#reconnect);
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    this.#reconnect = null;
    this.#healthTimer = null;
    this.#verifying = null;
    this.#rejectPending('QQ 桥接已停止');
    const socket = this.#socket;
    this.#socket = null;
    socket?.terminate();
    this.#setHealth('stopped', false, null);
    this.#settleStart();
    this.#startResult = null;
  }

  #settleStart(): void { this.#resolveStart?.(this.status()); this.#resolveStart = null; }
  #setHealth(state: BridgeHealth['state'], online: boolean, error: string | null): void {
    this.#health = { ...this.#health, state, online, connected: this.#socket?.readyState === WebSocket.OPEN, accountId: this.#accountId, maskedAccount: this.#accountId ? masked(this.#accountId) : null, nickname: this.#nickname, error };
    try { this.#options.onHealth?.(this.status()); } catch { /* Consumer failure cannot escape a socket listener. */ }
  }
  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.#pending.clear();
  }
  #open(): void {
    if (!this.#active) return;
    const generation = ++this.#generation;
    this.#setHealth('connecting', false, null);
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#endpoint, { headers: { Authorization: `Bearer ${this.#options.token}` },
        maxPayload: this.#options.maxPayloadBytes ?? 8 * 1024 * 1024,
        handshakeTimeout: this.#options.requestTimeoutMs ?? 10_000, perMessageDeflate: false, followRedirects: false });
    } catch { this.#setHealth('error', false, 'QQ 桥接连接失败'); this.#settleStart(); this.#scheduleReconnect(); return; }
    this.#socket = socket;
    const current = () => this.#active && this.#socket === socket && this.#generation === generation;
    socket.on('open', () => {
      if (!current()) return;
      void this.#verify(generation).finally(() => { if (current()) this.#settleStart(); });
      this.#healthTimer = setInterval(() => { if (current()) void this.#verify(generation); }, this.#options.healthIntervalMs ?? 30_000);
      this.#healthTimer.unref();
    });
    socket.on('message', (bytes, isBinary) => {
      if (!current() || isBinary) return;
      let packet: Raw | null;
      try { packet = raw(parsePacket(bytes.toString())); } catch { this.#setHealth('error', false, 'QQ 桥接返回了无效数据'); socket.close(1007); return; }
      if (!packet) return;
      const echo = typeof packet.echo === 'string' ? packet.echo : null;
      if (echo && this.#pending.has(echo)) {
        const pending = this.#pending.get(echo)!; this.#pending.delete(echo); clearTimeout(pending.timer);
        if (packet.status === 'ok' && (packet.retcode === 0 || packet.retcode === undefined)) pending.resolve(packet.data);
        else pending.reject(new Error('QQ 桥接读取请求未成功，稍后可重试'));
        return;
      }
      this.#event(packet, generation);
    });
    socket.on('error', () => { if (current()) { this.#setHealth('error', false, 'QQ 桥接无法连接，请检查现有组件是否登录及访问令牌'); this.#settleStart(); } });
    socket.on('close', () => {
      if (!current()) return;
      this.#socket = null;
      this.#verifying = null;
      if (this.#healthTimer) clearInterval(this.#healthTimer);
      this.#healthTimer = null;
      this.#rejectPending('QQ 桥接连接已断开');
      this.#setHealth('offline', false, 'QQ 桥接已断开，正在等待重连');
      this.#settleStart();
      this.#scheduleReconnect();
    });
  }
  #scheduleReconnect(): void {
    if (!this.#active || this.#reconnect) return;
    const delay = Math.min(this.#options.reconnectMaxMs ?? 30_000, (this.#options.reconnectMinMs ?? 1_000) * 2 ** Math.min(this.#failures++, 12));
    this.#reconnect = setTimeout(() => { this.#reconnect = null; this.#open(); }, delay);
    this.#reconnect.unref();
  }
  #verify(generation: number): Promise<void> {
    if (this.#verifying) return this.#verifying;
    const operation = (async () => {
      try {
        const [status, login] = await Promise.all([this.#request('get_status'), this.#request('get_login_info')]);
        if (generation !== this.#generation || !this.#active) return;
        const account = id(raw(login)?.user_id);
        if (!account || raw(status)?.online !== true) { this.#setHealth('offline', false, 'QQ 尚未确认在线，请在现有 QQ 组件中完成登录'); return; }
        if (this.#accountId !== account) this.#sources.clear();
        this.#accountId = account;
        const nickname = raw(login)?.nickname;
        this.#nickname = typeof nickname === 'string' ? nickname.trim().slice(0, 200) || null : null;
        if (this.#boundAccount && account !== this.#boundAccount) {
          this.#setHealth('account-mismatch', false, 'QQ 账号已变化，已暂停采集，请重新选择该账号的群'); return;
        }
        this.#boundAccount = account;
        if (raw(status)?.good === false) { this.#setHealth('error', false, 'QQ 已登录，但消息接收链路异常，采集已暂停；请检查桥接组件'); return; }
        this.#failures = 0;
        this.#setHealth('online', true, null);
      } catch {
        if (generation === this.#generation && this.#active && this.#socket?.readyState === WebSocket.OPEN) this.#setHealth('error', false, 'QQ 在线状态验证失败，正在等待重试');
      }
    })();
    this.#verifying = operation;
    void operation.finally(() => { if (this.#verifying === operation) this.#verifying = null; });
    return operation;
  }
  #request(action: string, params: Raw = {}): Promise<unknown> {
    if (!READ_ACTIONS.has(action)) return Promise.reject(new Error('仅允许指定的 QQ 读取操作'));
    const socket = this.#socket;
    if (!this.#active || !socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('QQ 桥接尚未连接'));
    if (this.#pending.size >= 32) return Promise.reject(new Error('QQ 读取队列繁忙，请稍后重试'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(echo); reject(new Error('QQ 读取请求超时')); }, this.#options.requestTimeoutMs ?? 10_000);
      this.#pending.set(echo, { resolve, reject, timer });
      socket.send(JSON.stringify({ action, params, echo }), error => {
        if (!error) return;
        const pending = this.#pending.get(echo);
        if (pending) { this.#pending.delete(echo); clearTimeout(pending.timer); pending.reject(new Error('QQ 读取请求发送失败')); }
      });
    });
  }
  #selected(groupId: string): boolean {
    if (!this.#health.online || !this.#accountId || !id(groupId)) return false;
    try { return this.#options.isGroupSelected(this.#accountId, groupId); } catch { return false; }
  }
  #requireSelected(groupId: string): void { if (!this.#selected(groupId)) throw new Error('该 QQ 账号或群尚未授权采集'); }
  #source(groupId: string, parentId: string): Source {
    this.#requireSelected(groupId);
    const source = this.#sources.get(`${groupId}:${parentId}`);
    if (!source) throw new Error('只能读取已收集消息中的引用或附件');
    return source;
  }
  #event(packet: Raw, generation: number): void {
    if (packet.post_type === 'meta_event') {
      if (packet.meta_event_type === 'heartbeat') {
        if (raw(packet.status)?.online === false) { this.#setHealth('offline', false, 'QQ 当前离线，采集已暂停'); return; }
        const account = id(packet.self_id);
        if (account && this.#boundAccount && account !== this.#boundAccount) { this.#sources.clear(); this.#accountId = account; this.#nickname = null; this.#setHealth('account-mismatch', false, 'QQ 账号已变化，已暂停采集，请重新选择该账号的群'); return; }
        if (raw(packet.status)?.good === false) { this.#setHealth('error', false, 'QQ 已登录，但消息接收链路异常，采集已暂停；请检查桥接组件'); return; }
        if (!this.#health.online) void this.#verify(generation);
      } else if (packet.meta_event_type === 'lifecycle') void this.#verify(generation);
      return;
    }
    const group = id(packet.group_id), account = id(packet.self_id);
    if (account && this.#boundAccount && account !== this.#boundAccount) {
      this.#sources.clear(); this.#accountId = account; this.#nickname = null;
      this.#setHealth('account-mismatch', false, 'QQ 账号已变化，已暂停采集，请重新选择该账号的群'); return;
    }
    if (!group || !account || account !== this.#accountId || !this.#selected(group)) return;
    this.#health.lastEventAt = new Date().toISOString();
    if ((packet.post_type === 'message' || packet.post_type === 'message_sent') && packet.message_type === 'group') {
      if (this.rememberMessage(packet)) { try { this.#options.onMessage?.(packet); } catch { /* Consumer owns persistence failure reporting. */ } }
    } else if (packet.post_type === 'notice' && packet.notice_type === 'group_recall') {
      try { this.#options.onRecall?.(packet); } catch { /* Consumer owns reporting. */ }
    } else if (packet.post_type === 'notice' && packet.notice_type === 'group_upload') {
      const file = raw(packet.file), fileId = file && id(file.id ?? file.file_id);
      if (!file || !fileId) return;
      const message = { ...packet, message_id: `upload:${fileId}:${packet.time ?? 'unknown'}`, message_type: 'group', message: [{ type: 'file', data: { ...file, file_id: fileId } }] };
      if (this.rememberMessage(message)) { try { this.#options.onMessage?.(message); } catch { /* Consumer owns reporting. */ } }
    }
  }

  /** Restore provenance only from trusted persisted raw messages, never renderer-supplied input. */
  rememberMessage(message: Raw): boolean {
    const group = id(message.group_id), mid = messageId(message), self = id(message.self_id);
    if (!group || !mid || !this.#selected(group) || (self && self !== this.#accountId)) return false;
    const source: Source = { refs: new Set(), forwards: new Set(), files: new Map(), images: new Set() };
    this.#collectSegments(message.message ?? message.content, source, 0);
    this.#sources.set(`${group}:${mid}`, source);
    if (this.#sources.size > 10_000) this.#sources.delete(this.#sources.keys().next().value!);
    return true;
  }
  #collectSegments(segments: unknown, source: Source, depth: number): void {
    if (!Array.isArray(segments) || depth > 3) return;
    for (const part of segments.slice(0, 500)) {
      const segment = raw(part), data = raw(segment?.data);
      if (!segment || !data) continue;
      if (segment.type === 'reply') { const value = id(data.id); if (value) source.refs.add(value); }
      else if (segment.type === 'forward') { const value = id(data.id); if (value) source.forwards.add(value); }
      else if (segment.type === 'file') { const value = id(data.file_id ?? data.id ?? data.file); if (value) source.files.set(value, typeof data.busid === 'number' && Number.isSafeInteger(data.busid) ? data.busid : undefined); }
      else if (segment.type === 'image') { const value = id(data.file); if (value && !/^(?:https?:|file:|base64:|[a-z]:[\\/]|[\\/])/i.test(value)) source.images.add(value); }
      else if (segment.type === 'node') this.#collectSegments(data.content, source, depth + 1);
    }
  }
  async getGroups(): Promise<BridgeGroup[]> {
    if (!this.#health.online) throw new Error('QQ 尚未确认在线');
    const generation = this.#generation, account = this.#accountId;
    const data = await this.#request('get_group_list');
    if (generation !== this.#generation || account !== this.#accountId || !this.#health.online) throw new Error('QQ 账号或连接已变化');
    if (!Array.isArray(data)) throw new Error('QQ 群列表格式不正确');
    return data.slice(0, 10_000).flatMap(value => {
      const item = raw(value), group = item && id(item.group_id);
      return item && group ? [{ id: group, name: typeof item.group_name === 'string' ? item.group_name.slice(0, 500) : group,
        ...(typeof item.member_count === 'number' ? { memberCount: item.member_count } : {}) }] : [];
    });
  }
  async history(groupId: string, cursor?: string | null, count = 100): Promise<{ messages: Raw[]; nextCursor: string | null; complete: false }> {
    this.#requireSelected(groupId);
    if (!Number.isInteger(count) || count < 1 || count > 100 || (cursor !== undefined && cursor !== null && !id(cursor))) throw new Error('QQ 历史分页参数不正确');
    const snow = this.#options.flavor === 'snowluma' || (!this.#options.flavor && this.#options.source === 'SnowLuma');
    const params = snow ? { group_id: groupId, count, reverse_order: true, ...(cursor ? { message_id: cursor } : {}) }
      : { group_id: groupId, count, reverseOrder: true, ...(cursor ? { message_seq: cursor } : {}) };
    const data = raw(await this.#request('get_group_msg_history', params));
    this.#requireSelected(groupId);
    if (!Array.isArray(data?.messages)) throw new Error('QQ 历史消息格式不正确或此桥接不支持历史读取');
    const messages = data.messages.slice(0, 100).flatMap(value => {
      const item = raw(value);
      if (!item || (item.group_id !== undefined && id(item.group_id) !== groupId) || (item.self_id !== undefined && id(item.self_id) !== this.#accountId) || item.message_type === 'private') return [];
      const normalized: Raw = { ...item, group_id: groupId, self_id: this.#accountId, message_type: 'group' };
      return this.rememberMessage(normalized) ? [normalized] : [];
    });
    const oldest = messages.reduce<Raw | null>((result, value) => !result || Number(value.time ?? Infinity) < Number(result.time ?? Infinity) ? value : result, null);
    const nextCursor = oldest ? id(snow ? oldest.message_id : oldest.message_seq ?? oldest.message_id) : null;
    return { messages, nextCursor: nextCursor === cursor ? null : nextCursor, complete: false };
  }
  async getReferencedMessage(groupId: string, parentMessageId: string, targetMessageId: string): Promise<Raw> {
    if (!this.#source(groupId, parentMessageId).refs.has(targetMessageId)) throw new Error('引用不属于已收集的消息');
    const message = raw(await this.#request('get_msg', { message_id: targetMessageId }));
    this.#requireSelected(groupId);
    if (!message || id(message.group_id) !== groupId || message.message_type === 'private' || (message.self_id !== undefined && id(message.self_id) !== this.#accountId)) throw new Error('QQ 返回的引用不属于原群');
    const normalized = { ...message, self_id: this.#accountId };
    this.rememberMessage(normalized);
    return normalized;
  }
  async getForward(groupId: string, parentMessageId: string, forwardId: string): Promise<Raw[]> {
    const source = this.#source(groupId, parentMessageId);
    if (!source.forwards.has(forwardId)) throw new Error('转发不属于已收集的消息');
    const data = raw(await this.#request('get_forward_msg', { message_id: forwardId }));
    this.#requireSelected(groupId);
    const values = data?.messages ?? data?.message;
    if (!Array.isArray(values) || values.length > 100) throw new Error('合并转发格式不正确或超过 100 条上限');
    const messages = values.map(raw).filter((value): value is Raw => value !== null);
    for (const message of messages) this.#collectSegments(message.content ?? message.message, source, 1);
    return messages;
  }
  async getFileUrl(groupId: string, parentMessageId: string, fileId: string, busid?: number): Promise<BridgeAttachmentLocation> {
    const source = this.#source(groupId, parentMessageId);
    if (!source.files.has(fileId) || (busid !== undefined && busid !== source.files.get(fileId))) throw new Error('文件不属于已收集的消息');
    const knownBusid = source.files.get(fileId);
    const data = raw(await this.#request('get_group_file_url', { group_id: groupId, file_id: fileId, ...(knownBusid !== undefined ? { busid: knownBusid } : {}) }));
    this.#requireSelected(groupId);
    if (!data || typeof data.url !== 'string') throw new Error('QQ 文件下载地址暂不可用');
    return attachmentLocation(data);
  }
  async getImage(groupId: string, parentMessageId: string, fileId: string): Promise<BridgeAttachmentLocation> {
    if (!this.#source(groupId, parentMessageId).images.has(fileId)) throw new Error('图片不属于已收集的消息');
    const data = raw(await this.#request('get_image', { file: fileId }));
    this.#requireSelected(groupId);
    if (!data) throw new Error('QQ 图片暂不可用');
    return attachmentLocation(data);
  }
}
export function createReadOnlyBridge(options: BridgeOptions): ReadOnlyBridge { return new ReadOnlyBridge(options); }

async function readConfiguration(path: string): Promise<Raw | null> {
  try { if ((await stat(path)).size > 1024 * 1024) return null; return raw(JSON.parse(await readFile(path, 'utf8'))); } catch { return null; }
}
/** Calendar-owned locations only. Never reads another application's bridge configuration. */
export async function detectExistingBridge(): Promise<BridgeConfiguration[]> {
  const candidates: BridgeConfiguration[] = [];
  const seen = new Set<string>();
  const add = (endpoint: unknown, token: unknown, source: string) => {
    if (typeof endpoint !== 'string' || typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token) || token.length > 8192) return;
    try { endpoint = validateBridgeEndpoint(endpoint); } catch { return; }
    const signature = `${endpoint}\0${token}\0${source}`;
    if (!seen.has(signature)) { seen.add(signature); candidates.push({ endpoint: endpoint as string, token, source, flavor: source === 'NapCat' ? 'napcat' : 'snowluma' }); }
  };
  for (const [directory, source] of [
    ['C:\\Software\\终极日历\\qq-bridge\\config', 'NapCat'],
    ['C:\\Software\\终极日历\\qq-bridge\\napcat\\config', 'NapCat'],
    ['C:\\Software\\终极日历\\qq-bridge\\snowluma\\config', 'SnowLuma'],
  ] as const) {
    let files: string[];
    try { files = (await readdir(directory)).filter(name => /^onebot(?:11)?_\d+\.json$/.test(name)).slice(0, 100); } catch { continue; }
    for (const name of files) {
      const config = await readConfiguration(join(directory, name));
      const servers = [raw(config?.networks)?.wsServers, raw(config?.network)?.websocketServers].flatMap(value => Array.isArray(value) ? value : []);
      for (const server of servers) {
        const value = raw(server);
        if (!value || (value.enable !== undefined && value.enable !== true) || (value.enabled !== undefined && value.enabled !== true)) continue;
        if (typeof value.port !== 'number' && !(typeof value.port === 'string' && /^\d+$/.test(value.port))) continue;
        const port = Number(value.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        const host = value.host === '::1' ? '[::1]' : value.host;
        if (typeof host !== 'string' || !['127.0.0.1', '[::1]', 'localhost'].includes(host)) continue;
        add(`ws://${host}:${port}`, value.accessToken ?? value.token, source);
      }
    }
  }
  return candidates;
}
