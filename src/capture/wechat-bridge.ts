import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BridgeHealth, BridgeOptions } from './bridge';
import type { CaptureBridge, CaptureBridgeFactory } from './service';
import { readWechatMediaLocation } from './wechat-media';
import { AttachmentDownloadError } from './download';

export interface WechatReaderRuntime {
  python: string;
  worker: string;
  workdir: string;
  requestTimeoutMs?: number;
}
const identitySchema = z.object({ accountId: z.string().min(8).max(1024).startsWith('wechat:'), nickname: z.string().max(200).default('') });
const groupsSchema = z.array(z.object({ id: z.string().min(1).max(1024).endsWith('@chatroom'), name: z.string().max(1000) })).max(10000);
const historySchema = z.object({ messages: z.array(z.record(z.string(), z.unknown())).max(100), nextCursor: z.string().max(2000).nullable(), complete: z.literal(false) });
const mediaSchema = z.object({ status: z.literal('ready'), path: z.string().max(4096), name: z.string().min(1).max(1000), size: z.number().int().min(1).max(25 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const packetSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.string(), ok: z.literal(true), data: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: z.object({ code: z.string().max(100), message: z.string().max(2000) }) }),
]);
type Pending = { resolve(value: unknown): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> };

/** Private stdin/stdout RPC. Only bounded reads exist; no shell, send, key or arbitrary-path API. */
export function createWechatBridgeFactory(runtime: WechatReaderRuntime): CaptureBridgeFactory {
  return (options: BridgeOptions): CaptureBridge => {
    let child: ChildProcessWithoutNullStreams | null = null;
    let generation = 0, active = false, buffer = '';
    let accountId: string | null = options.expectedAccountId ?? null;
    let health: BridgeHealth = { state: 'stopped', connected: false, online: false, accountId: null, maskedAccount: null, nickname: null, lastEventAt: null, error: null };
    const pending = new Map<string, Pending>();
    const sources = new Map<string, { images: Set<string>; files: Set<string> }>();
    const publish = (next: Partial<BridgeHealth>) => { health = { ...health, ...next }; options.onHealth?.({ ...health }); };
    function shutdown() {
      ++generation; active = false; buffer = ''; sources.clear();
      const workerProcess = child; child = null;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('微信只读采集连接已停止')); }
      pending.clear();
      if (workerProcess) {
        // EOF lets the reader's finally remove its private decrypted cache on Windows.
        workerProcess.stdin.end();
        const deadline = setTimeout(() => { if (workerProcess.exitCode === null) workerProcess.kill(); }, 5000);
        deadline.unref(); workerProcess.once('exit', () => clearTimeout(deadline));
      }
    }
    function failed(message = '微信只读读取失败，请确认微信已登录后重新连接') {
      shutdown(); publish({ state: 'error', connected: false, online: false, error: message });
    }
    function rpc(action: 'status' | 'groups' | 'history' | 'media', fields: Record<string, unknown> = {}): Promise<unknown> {
      if (!child || !active) return Promise.reject(Error('微信只读组件尚未连接'));
      if (pending.size >= 4) return Promise.reject(Error('微信只读组件正在处理请求'));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('微信只读读取超时')); failed('微信只读读取超时，请确认客户端状态后重新连接'); }, runtime.requestTimeoutMs ?? 180_000);
        pending.set(id, { resolve, reject, timer });
        child!.stdin.write(JSON.stringify({ id, action, ...(accountId ? { accountId } : {}), ...fields }) + '\n', error => {
          if (error && pending.has(id)) failed();
        });
      });
    }
    async function verifyIdentity() {
      const value = identitySchema.parse(await rpc('status'));
      if (!active) throw Error('微信读取已停止');
      if (accountId && accountId !== value.accountId) {
        shutdown(); publish({ state: 'account-mismatch', connected: false, online: false, error: '微信账号已改变，请解除原账号绑定后重新连接', accountId: value.accountId, nickname: value.nickname });
        throw Error('微信账号已改变');
      }
      accountId = value.accountId;
      publish({ state: 'online', connected: true, online: true, accountId, nickname: value.nickname, maskedAccount: `微信 · ${accountId.slice(-4)}`, error: null });
      return accountId;
    }
    function rememberMessage(message: Record<string, unknown>): boolean {
      if (!accountId || message.self_id !== accountId || typeof message.group_id !== 'string' || !options.isGroupSelected(accountId, message.group_id) || typeof message.message_id !== 'string' || !Array.isArray(message.message)) return false;
      const source = { images: new Set<string>(), files: new Set<string>() };
      for (const item of message.message) {
        if (!item || typeof item !== 'object' || !item.data || typeof item.data !== 'object') continue;
        const file = item.data.file;
        if (typeof file !== 'string' || file.length > 2000 || !/^wm1:[A-Za-z0-9_-]+=*$/.test(file)) continue;
        if (item.type === 'image') source.images.add(file);
        if (item.type === 'file') source.files.add(file);
      }
      const key = JSON.stringify([message.group_id, message.message_id]); sources.delete(key); sources.set(key, source);
      while (sources.size > 5000) sources.delete(sources.keys().next().value!);
      return true;
    }
    async function media(kind: 'image' | 'file', groupId: string, messageId: string, locatorId: string) {
      const bound = await verifyIdentity();
      const source = sources.get(JSON.stringify([groupId, messageId]));
      if (!options.isGroupSelected(bound, groupId) || !(kind === 'image' ? source?.images : source?.files)?.has(locatorId)) throw new AttachmentDownloadError('微信附件不属于已授权的群消息');
      const result = mediaSchema.parse(await rpc('media', { groupId, messageId, kind, locatorId }));
      if (!active || !health.online || !options.isGroupSelected(bound, groupId)) throw new AttachmentDownloadError('微信群已停止采集，未读取附件');
      try {
        const location = await readWechatMediaLocation(runtime.workdir, result);
        if (!active || !health.online || !options.isGroupSelected(bound, groupId)) throw Error();
        return location;
      } catch { throw new AttachmentDownloadError('微信附件缓存校验未通过，未读取文件'); }
    }
    const unsupported = async (): Promise<never> => { throw new AttachmentDownloadError('此微信消息类型尚不支持自动展开，请在微信查看', 'unsupported'); };
    return {
      async start() {
        shutdown(); active = true;
        publish({ state: 'connecting', connected: false, online: false, error: null });
        if (!runtime.python || !isAbsolute(runtime.python) || !isAbsolute(runtime.worker) || !isAbsolute(runtime.workdir) || !existsSync(runtime.python) || !existsSync(runtime.worker)) {
          failed('微信只读采集组件尚未配置，请先安装本机微信读取运行环境'); return { ...health };
        }
        const currentGeneration = generation;
        try {
          child = spawn(runtime.python, [runtime.worker, '--workdir', runtime.workdir], { windowsHide: true, shell: false, stdio: 'pipe', env: { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' } });
          const workerProcess = child;
          workerProcess.stdout.setEncoding('utf8');
          workerProcess.stdout.on('data', (chunk: string) => {
            if (!active || currentGeneration !== generation) return;
            buffer += chunk;
            if (buffer.length > 12 * 1024 * 1024) { failed('微信读取结果超过单次大小限制'); return; }
            let end: number;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              if (!line.trim()) continue;
              try {
                const packet = packetSchema.parse(JSON.parse(line));
                const request = pending.get(packet.id); if (!request) continue;
                pending.delete(packet.id); clearTimeout(request.timer);
                if (packet.ok) request.resolve(packet.data);
                else {
                  // Only controlled categories are surfaced; raw exceptions may contain paths or plaintext.
                  if (/ACCOUNT|IDENTITY/.test(packet.error.code)) {
                    request.reject(Error('微信账号验证失败')); shutdown();
                    publish({ state: 'account-mismatch', online: false, connected: false, error: '微信账号已改变或无法验证，请重新连接' });
                  } else {
                    if (packet.error.code === 'TOO_LARGE') request.reject(new AttachmentDownloadError('微信附件超过 25 MB 自动读取上限，请手动查看', 'too-large'));
                    else if (packet.error.code === 'UNSUPPORTED') request.reject(new AttachmentDownloadError('此微信附件格式尚不支持自动读取，请手动查看', 'unsupported'));
                    else if (/NOT_DOWNLOADED|MEDIA_PENDING|IMAGE_KEY_UNAVAILABLE|READ_PENDING/.test(packet.error.code)) request.reject(new AttachmentDownloadError('微信附件尚未在本机完整下载，请在微信中打开或下载后重试；系统会稍后再检查', 'failed', true));
                    else request.reject(new AttachmentDownloadError('微信本机资料暂时无法读取，请确认微信已登录', 'failed', /NOT_LOGGED_IN|NOT_RUNNING|READ_FAILED/.test(packet.error.code)));
                    if (packet.error.code !== 'IMAGE_KEY_UNAVAILABLE' && /NOT_LOGGED_IN|NOT_RUNNING|KEY|DATABASE|INTERNAL/.test(packet.error.code)) failed();
                  }
                }
              } catch { failed('微信只读组件返回格式无效，已停止连接'); return; }
            }
          });
          // Drain diagnostics without retaining or exposing potentially private upstream exception text.
          workerProcess.stderr.on('data', () => {});
          workerProcess.on('error', () => { if (active && currentGeneration === generation) failed('微信只读组件未能启动，请检查本机运行环境'); });
          workerProcess.on('exit', () => { if (active && currentGeneration === generation) failed('微信只读组件已退出，请确认微信已登录后重新连接'); });
          await verifyIdentity();
        } catch { if (active) failed(); }
        return { ...health };
      },
      stop() { shutdown(); publish({ state: 'stopped', online: false, connected: false, error: null }); },
      async getGroups() {
        await verifyIdentity();
        const result = groupsSchema.parse(await rpc('groups'));
        if (!active || !health.online) throw Error('微信连接状态已改变');
        if (new Set(result.map(group => group.id)).size !== result.length) throw Error('微信群标识重复');
        return result;
      },
      async history(groupId, cursor = null, count = 100) {
        const bound = await verifyIdentity();
        if (!groupId.endsWith('@chatroom') || !options.isGroupSelected(bound, groupId)) throw Error('该微信群未获准采集');
        const result = historySchema.parse(await rpc('history', { groupId, cursor, limit: Math.min(100, Math.max(1, count)) }));
        if (!active || !health.online || !options.isGroupSelected(bound, groupId)) throw Error('该微信群已停止采集');
        if (result.messages.some(message => message.group_id !== groupId || message.message_type === 'private')) throw Error('微信返回消息不属于所选群');
        for (const message of result.messages) rememberMessage({ ...message, self_id: bound });
        return result;
      },
      rememberMessage, getReferencedMessage: unsupported, getForward: unsupported,
      getImage: (groupId, messageId, file) => media('image', groupId, messageId, file),
      getFileUrl: (groupId, messageId, file) => media('file', groupId, messageId, file),
    };
  };
}
