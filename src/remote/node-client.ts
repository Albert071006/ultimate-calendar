import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { RemoteIdentitySchema, RemoteOperationSchema, RemoteSessionSchema, PairRequestSchema, type RemoteIdentity, type RemoteMethod } from '../shared/remote';
import { DistilledRequestSchema, DistilledResultSchema, type DistilledRequest } from '../shared/distilled';
import { AiApiKeySchema, AiConfigurationRevisionSchema, AiConfigurationStatusSchema, type AiConfigurationStatus } from '../shared/ai-configuration';
import { AiKeySyncRequestSchema, AiKeySyncResponseSchema, MAX_AI_KEY_SYNC_BYTES } from '../shared/ai-key-sync';
import { remoteInputs, remoteOutputs } from '../server/protocol';
import { readPrivate, writePrivate, privatePath } from './private-file';
import { createLoopbackHttpsTransport } from './loopback-https';
import { LEDGER_API_HEADER, LEDGER_API_VERSION } from '../shared/ledger-compatibility';

const CredentialSchema = z.strictObject({ version: z.literal(1), origin: z.string(), cookie: z.string().regex(/^(?:__Host-planner_session|planner_dev_session)=[A-Za-z0-9_-]+$/), identity: RemoteIdentitySchema, deviceId: z.string().uuid() });
export type RemoteCredential = z.infer<typeof CredentialSchema>;
export interface CredentialStore { read(): RemoteCredential | null; write(value: RemoteCredential): void }
export class RemoteClientError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) { super(message); this.name = 'RemoteClientError'; }
}
export function normalizeRemoteOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw Error('资料服务必须是 HTTPS 根地址；HTTP 仅限本机测试');
  return url.origin;
}
export function fileCredentialStore(file: string): CredentialStore {
  privatePath(file);
  return { read() { const bytes = readPrivate(file, 16_384); return bytes ? CredentialSchema.parse(JSON.parse(bytes.toString('utf8'))) : null; },
    write(value) { writePrivate(file, JSON.stringify(CredentialSchema.parse(value))); } };
}
export function sameRemoteIdentity(a: RemoteIdentity, b: RemoteIdentity) { return a.dataInstanceId === b.dataInstanceId && a.generation === b.generation && a.protocolVersion === b.protocolVersion; }
function parseRemote<S extends z.ZodType>(schema:S,value:unknown):z.output<S> { const result=schema.safeParse(value);if(!result.success)throw new RemoteClientError(502,'资料服务响应不符合接口契约，未确认操作结果');return result.data as z.output<S>; }

/** Node-only transport. Cookies never reach the renderer, redirects are never followed. */
export function createNodeRemoteClient(options: { origin: string; credentialsFile?: string; credentials?: CredentialStore; fetch?: typeof fetch; timeoutMs?: number; localConnectAddress?: '127.0.0.1' }) {
  const origin = normalizeRemoteOrigin(options.origin);
  const store = options.credentials ?? (options.credentialsFile ? fileCredentialStore(options.credentialsFile) : undefined);
  if (!store) throw Error('必须提供设备凭据存储');
  if (options.localConnectAddress !== undefined && options.fetch) throw Error('本机 HTTPS 连接不能同时覆盖网络传输。');
  const localTransport = options.localConnectAddress === undefined ? undefined : createLoopbackHttpsTransport({ origin, localConnectAddress: options.localConnectAddress });
  const fetcher = localTransport?.fetch ?? options.fetch ?? fetch;
  const saved = store.read();
  let credential = saved ? CredentialSchema.parse(saved) : null;
  if (credential && credential.origin !== origin) throw new RemoteClientError(409, '凭据属于另一资料服务；请使用独立配置与凭据文件');
  if(credential&&!credential.cookie.startsWith(origin.startsWith('https:')?'__Host-planner_session=':'planner_dev_session='))throw new RemoteClientError(409,'设备 Cookie 类型与服务来源不匹配，请核对独立凭据文件');
  let session: Extract<z.infer<typeof RemoteSessionSchema>, { paired: true }> | undefined;
  const lifetime = new AbortController();
  async function request(path: string, input?: unknown, config: { signal?: AbortSignal; pairing?: boolean; method?: 'GET' | 'POST' | 'PUT' | 'DELETE' } = {}) {
    const timeout = AbortSignal.timeout(Math.min(30_000, Math.max(100, options.timeoutMs ?? 30_000)));
    const receiverSync = path === '/api/v1/ai/receiver/sync';
    const aiConfiguration = path === '/api/v1/ai/config' || receiverSync;
    const httpFailure = (response: Response) => {
      if (response.status === 401) session = undefined;
      const retry = Number(response.headers.get('retry-after'));
      const message = response.status === 401 ? '设备授权已失效，请重新配对' : aiConfiguration ?
        response.status === 403 ? '云端拒绝修改配置；请重新读取状态，核对管理员配置或设备授权' :
        response.status === 409 ? '云端配置已变化；请重新读取状态，核对后再操作' :
        response.status === 400 ? '云端配置输入无效，请检查后重试' :
        '云端配置未确认；请重新读取状态核对，不会自动重发' :
        response.status === 409 ? '资料代际或操作编号冲突，请核对后处理' : '资料服务未完成请求，请核对原操作结果';
      return new RemoteClientError(response.status, message, Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 300_000) : undefined);
    };
    if (!path.startsWith('/api/v1/') || new URL(path, origin).origin !== origin || path.includes('\\')) throw Error('无效接口路径');
    try {
      const response = await fetcher(origin + path, { redirect: 'error', cache: 'no-store', signal: AbortSignal.any([timeout, lifetime.signal, ...(config.signal ? [config.signal] : [])]),
        method: config.method ?? (input === undefined ? 'GET' : 'POST'), headers: { Origin: origin, ...(path.startsWith('/api/v1/rpc/ledger') ? { [LEDGER_API_HEADER]: LEDGER_API_VERSION } : {}), ...(credential && !config.pairing ? { Cookie: credential.cookie } : {}),
          ...(input === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrfToken ?? '' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      if(response.redirected||response.status>=300&&response.status<400){await response.body?.cancel();throw new RemoteClientError(502,'资料服务发生重定向，未将凭据发送到其他地址');}
      // Configuration errors never need a response body, which might echo submitted secrets.
      if (aiConfiguration && !response.ok) { await response.body?.cancel(); throw httpFailure(response); }
      if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw new RemoteClientError(502, '服务返回了非 JSON 响应'); }
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > (receiverSync ? MAX_AI_KEY_SYNC_BYTES : 32 * 1024 * 1024)) throw new RemoteClientError(502, '服务响应超过大小限制'); chunks.push(value); } } finally { await reader.cancel(); }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) throw httpFailure(response);
      return { body, response };
    } catch (error) { if (error instanceof RemoteClientError) throw error; throw new RemoteClientError(0, aiConfiguration ? '云端配置连接未完成；请重新读取状态核对，不会自动重发' : '连接未完成；写入结果可能尚未返回，请查询原操作编号'); }
  }
  async function getSession() {
    const value = parseRemote(RemoteSessionSchema,(await request('/api/v1/session')).body);
    if (!value.paired || !credential) { session = undefined; throw new RemoteClientError(401, '此设备尚未配对或授权已失效'); }
    if (value.device.id !== credential.deviceId || !sameRemoteIdentity(value.identity, credential.identity)) { session = undefined; throw new RemoteClientError(409, '服务身份或资料代际已变更，旧操作已隔离，不能自动重放'); }
    session = value;
    return { identity: value.identity, deviceId: value.device.id, aiConfigured: value.aiConfigured };
  }
  async function ready() { if (!session) await getSession(); return session!; }
  function configurationRevision(value: unknown) {
    const checked = AiConfigurationRevisionSchema.safeParse(value);
    if (!checked.success) throw new RemoteClientError(400, '请先读取云端配置状态，再进行修改');
    return checked.data;
  }
  async function configurationRequest(input?: unknown, method: 'GET' | 'PUT' | 'DELETE' = 'GET'): Promise<AiConfigurationStatus> {
    const response = await request('/api/v1/ai/config', input, { method });
    const checked = z.strictObject({ ok: z.literal(true), identity: RemoteIdentitySchema, configuration: AiConfigurationStatusSchema }).safeParse(response.body);
    if (!checked.success) throw new RemoteClientError(502, '云端配置响应无效；请重新读取状态核对，不会自动重发');
    if (!credential || !sameRemoteIdentity(credential.identity, checked.data.identity)) {
      session = undefined;
      throw new RemoteClientError(409, '云端资料身份已变化；请核对设备授权和配置，不会自动重发');
    }
    return checked.data.configuration;
  }
  return {
    origin, getSession,
    async syncAiKeyReceiver(input: { keyId: string; nonce: string }, config: { signal?: AbortSignal } = {}) {
      const current = await ready();
      const checked = AiKeySyncRequestSchema.safeParse({ ...input, identity: current.identity });
      if (!checked.success) throw new RemoteClientError(400, '密钥同步请求无效');
      const value = parseRemote(AiKeySyncResponseSchema, (await request('/api/v1/ai/receiver/sync', checked.data, { signal: config.signal })).body);
      if (!credential || !sameRemoteIdentity(credential.identity, current.identity) || !sameRemoteIdentity(current.identity, value.identity)
        || value.envelope.deviceId !== credential.deviceId || value.envelope.keyId !== input.keyId || value.envelope.nonce !== input.nonce) {
        throw new RemoteClientError(409, '密钥同步身份已变化，未采用本次响应');
      }
      return value;
    },
    // Credential configuration is deliberately outside RPC/write journals and has no retry.
    async getAiConfiguration() { await ready(); return configurationRequest(); },
    async updateAiConfiguration(apiKey: string, expectedRevision: z.infer<typeof AiConfigurationRevisionSchema>) {
      const revision = configurationRevision(expectedRevision), key = AiApiKeySchema.safeParse(apiKey);
      if (!key.success) throw new RemoteClientError(400, 'API Key 格式无效，请检查后重新填写');
      const current = await ready();
      return configurationRequest({ identity: current.identity, expectedRevision: revision, apiKey: key.data }, 'PUT');
    },
    async clearAiConfiguration(expectedRevision: z.infer<typeof AiConfigurationRevisionSchema>) {
      const revision = configurationRevision(expectedRevision), current = await ready();
      return configurationRequest({ identity: current.identity, expectedRevision: revision }, 'DELETE');
    },
    async pair(code: string, name: string) {
      if (credential) throw new RemoteClientError(409, '此凭据文件已有配对；重新配对请使用新的凭据文件');
      const { body, response } = await request('/api/v1/pair', PairRequestSchema.parse({ code, name }), { pairing: true });
      const value = parseRemote(RemoteSessionSchema,body);
      if (!value.paired) throw new RemoteClientError(502, '配对响应无效');
      const expected = origin.startsWith('https:') ? '__Host-planner_session=' : 'planner_dev_session=';
      const cookie = response.headers.getSetCookie().map(v => v.split(';')[0]!).find(v => v.startsWith(expected));
      const next = parseRemote(CredentialSchema,{ version: 1, origin, cookie, identity: value.identity, deviceId: value.device.id });
      store.write(next); credential = next; session = value;
      return { identity: value.identity, deviceId: value.device.id, aiConfigured: value.aiConfigured };
    },
    async rpc<M extends RemoteMethod>(method: M, input?: unknown, requestId: string = randomUUID()):Promise<z.output<typeof remoteOutputs[M]>> {
      if (method === 'restoreConfirm') throw new RemoteClientError(400, '恢复确认必须使用专用确认接口，不允许重放');
      const checked = remoteInputs[method].parse(input), current = await ready();
      const response = await request('/api/v1/rpc/' + method, { requestId, identity: current.identity, input: checked });
      if (!credential || !sameRemoteIdentity(credential.identity, current.identity)) throw new RemoteClientError(409, '资料已恢复，已丢弃原代际的迟到响应');
      return parseRemote(remoteOutputs[method], response.body) as z.output<typeof remoteOutputs[M]>;
    },
    async confirmRestore(input: unknown) {
      const checked = remoteInputs.restoreConfirm.parse(input), current = await ready();
      const result = parseRemote(remoteOutputs.restoreConfirm, (await request('/api/v1/rpc/restoreConfirm', { requestId: randomUUID(), identity: current.identity, input: checked })).body);
      if (result.ok) {
        const nextIdentity = result.data.identity;
        if (!credential || nextIdentity.dataInstanceId !== current.identity.dataInstanceId || nextIdentity.generation !== current.identity.generation + 1 || nextIdentity.protocolVersion !== current.identity.protocolVersion) throw new RemoteClientError(409, '恢复后的资料身份无效，请核对服务器状态');
        const next = { ...credential, identity: nextIdentity }; store.write(next); credential = next; session = undefined;
      }
      return result;
    },
    async operation(requestId: string) { await ready(); return parseRemote(RemoteOperationSchema,(await request('/api/v1/operations/' + encodeURIComponent(requestId))).body); },
    async sendDistilled(input: DistilledRequest, config: { signal?: AbortSignal } = {}) {
      const checked = DistilledRequestSchema.parse(input), current = await ready();
      if (!sameRemoteIdentity(current.identity, checked.identity)) throw new RemoteClientError(409, '提炼资料属于另一资料代际');
      const result = parseRemote(z.strictObject({ ok: z.literal(true), data: DistilledResultSchema }),(await request('/api/v1/distilled', checked, config)).body);
      return result.data;
    },
    async status() { await ready(); return (await request('/api/v1/status')).body; },
    close() { lifetime.abort(); localTransport?.close(); session = undefined; },
  };
}
export type NodeRemoteClient = ReturnType<typeof createNodeRemoteClient>;
