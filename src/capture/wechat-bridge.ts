import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BridgeHealth, BridgeOptions } from './bridge';
import type { CaptureBridge, CaptureBridgeFactory } from './service';

export interface WechatReaderRuntime {
  python: string;
  worker: string;
  workdir: string;
  requestTimeoutMs?: number;
}
const identitySchema = z.object({ accountId: z.string().min(8).max(1024).startsWith('wechat:'), nickname: z.string().max(200).default('') });
const groupsSchema = z.array(z.object({ id: z.string().min(1).max(1024).endsWith('@chatroom'), name: z.string().max(1000) })).max(10000);
const historySchema = z.object({ messages: z.array(z.record(z.string(), z.unknown())).max(100), nextCursor: z.string().max(2000).nullable(), complete: z.literal(false) });
const packetSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.string(), ok: z.literal(true), data: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: z.object({ code: z.string().max(100), message: z.string().max(2000) }) }),
]);
type Pending = { resolve(value: unknown): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> };

/** Private stdin/stdout RPC. Only three read operations exist; no shell, send, key or arbitrary-path API. */
export function createWechatBridgeFactory(runtime: WechatReaderRuntime): CaptureBridgeFactory {
  return (options: BridgeOptions): CaptureBridge => {
    let child: ChildProcessWithoutNullStreams | null = null;
    let generation = 0, active = false, buffer = '';
    let accountId: string | null = options.expectedAccountId ?? null;
    let health: BridgeHealth = { state: 'stopped', connected: false, online: false, accountId: null, maskedAccount: null, nickname: null, lastEventAt: null, error: null };
    const pending = new Map<string, Pending>();
    const publish = (next: Partial<BridgeHealth>) => { health = { ...health, ...next }; options.onHealth?.({ ...health }); };
    function shutdown() {
      ++generation; active = false; buffer = '';
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
    function rpc(action: 'status' | 'groups' | 'history', fields: Record<string, unknown> = {}): Promise<unknown> {
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
    const unsupported = async (): Promise<never> => { throw Error('微信初版仅自动读取本机群文字；此附件请在微信中查看'); };
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
                    request.reject(Error('微信本机资料暂时无法读取，请确认微信已登录'));
                    if (/NOT_LOGGED_IN|NOT_RUNNING|KEY|DATABASE|INTERNAL/.test(packet.error.code)) failed();
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
        return result;
      },
      rememberMessage() { return false; }, getReferencedMessage: unsupported, getForward: unsupported, getImage: unsupported, getFileUrl: unsupported,
    };
  };
}
