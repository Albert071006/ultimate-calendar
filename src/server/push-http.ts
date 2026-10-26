import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PushSubscribeRequestSchema, PushUnsubscribeRequestSchema, type PushPayload } from '../shared/push';
import { nowInstant, instantAt } from '../domain/time';
import { type RemoteHttpContext, sendJson } from './http';
import { RemoteFault } from './state';
import { PushSubscriptionConflict, type PushStore } from './push-store';
import { pushReminderTopic, type PushSend } from './push-scheduler';

async function readPushBody(request: IncomingMessage): Promise<unknown> {
  const limit = 16 * 1024;
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new RemoteFault(415, '请求必须使用 application/json');
  if (Number(request.headers['content-length']) > limit) throw new RemoteFault(413, '推送请求内容过大');
  const buffers: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.length;
    if (bytes > limit) throw new RemoteFault(413, '推送请求内容过大'); buffers.push(value);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw new RemoteFault(400, '请求 JSON 无效'); }
}

/** Install only as createRemoteHttpServer.extension: that boundary authenticates Host/Origin/session/CSRF first. */
export function createPushHttpExtension(options: { store: PushStore; publicKey: string | null; send?: PushSend }) {
  return async (request: IncomingMessage, response: ServerResponse, context: RemoteHttpContext): Promise<boolean> => {
    const path = new URL(request.url ?? '/', 'http://push-route.invalid').pathname;
    if (!['/api/v1/push', '/api/v1/push/subscribe', '/api/v1/push/unsubscribe', '/api/v1/push/test'].includes(path)) return false;
    const method = request.method ?? 'GET'; const deviceId = context.device.id;
    if (path === '/api/v1/push' && method === 'GET') {
      sendJson(response, 200, { enabled: options.publicKey !== null, publicKey: options.publicKey, subscriptions: options.store.listSubscriptions(deviceId) }); return true;
    }
    if (path === '/api/v1/push' || method !== 'POST') throw new RemoteFault(405, '推送接口不支持此方法');
    if (path === '/api/v1/push/unsubscribe') {
      const input = PushUnsubscribeRequestSchema.parse(await readPushBody(request));
      // Return the same result for an unknown or another device's subscription.
      options.store.removeSubscription(deviceId, input.subscriptionId); sendJson(response, 200, { ok: true }); return true;
    }
    if (!options.publicKey) throw new RemoteFault(503, '服务端尚未配置推送联系地址');
    if (path === '/api/v1/push/subscribe') {
      const input = PushSubscribeRequestSchema.parse(await readPushBody(request));
      if (input.subscription.expirationTime != null && input.subscription.expirationTime <= Date.now()) throw new RemoteFault(400, '浏览器推送订阅已过期');
      try { sendJson(response, 200, { subscription: options.store.upsertSubscription(deviceId, input.subscription, { showDetails: input.showDetails }) }); }
      catch (error) { if (error instanceof PushSubscriptionConflict) throw new RemoteFault(409, error.message); throw error; }
      return true;
    }
    const input = PushUnsubscribeRequestSchema.parse(await readPushBody(request));
    const subscription = options.store.getSubscription(deviceId, input.subscriptionId);
    if (!subscription || !subscription.active) throw new RemoteFault(404, '此设备没有有效的推送订阅');
    if (!options.send) throw new RemoteFault(503, '服务端尚未启用推送发送');
    const at = nowInstant(); const id = `test:${randomUUID()}`;
    const payload: PushPayload = { type: 'reminder', showDetails: false, id, title: '终极日历', body: '有一项安排需要查看', tag: 'uc-push-test', url: '/', scheduledAt: at, expiresAt: instantAt(Date.parse(at) + 60_000) };
    let status: number;
    try { status = (await options.send(subscription.subscription, payload, { ttl: 60, topic: pushReminderTopic('uc-push-test') })).statusCode; }
    catch { throw new RemoteFault(503, '推送暂未发送成功，请稍后重试'); }
    if (status === 404 || status === 410) { options.store.disableSubscription(subscription.id); throw new RemoteFault(410, '浏览器推送订阅已失效，请重新订阅'); }
    if (status < 200 || status >= 300) throw new RemoteFault(503, '推送暂未发送成功，请稍后重试');
    sendJson(response, 200, { accepted: true }); return true;
  };
}
