import { lookup } from 'node:dns';
import { Agent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import webpush, { type RequestDetails } from 'web-push';
import { PushPayloadSchema, PushSubscriptionInputSchema, isAllowedPushEndpoint } from '../shared/push';
import type { PushStore } from './push-store';
import type { PushSend, PushSendResult } from './push-scheduler';

/** Defense in depth against resolver manipulation: no private, local, metadata or mapped/private addresses. */
export function isPublicPushAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
  }
  // Only global-unicast IPv6. IPv4-mapped, ULA, link-local, loopback and documentation ranges are rejected.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:0?db8:/i.test(address);
}
function publicHostname(host: string): boolean {
  return !isIP(host) && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|invalid|test|lan|home|onion)$/i.test(host);
}
export function validateVapidSubject(value: string): string {
  if (!value || value.length > 500 || /\s/.test(value)) throw Error('必须配置有效的公开VAPID联系地址');
  const url = new URL(value);
  if (url.protocol === 'mailto:') {
    const match = /^([^@\s]+)@([^@\s]+)$/.exec(url.pathname);
    if (!match || !publicHostname(match[2]!) || url.search || url.hash) throw Error('VAPID邮箱必须为有效的公开联系地址');
    return value;
  }
  if (url.protocol !== 'https:' || !publicHostname(url.hostname) || url.username || url.password || (url.port && url.port !== '443') || url.pathname !== '/' || url.search || url.hash) throw Error('VAPID地址必须为公开HTTPS站点的origin或mailto邮箱');
  return url.origin;
}

export type PushHttpRequest = (endpoint: string, details: RequestDetails) => Promise<PushSendResult>;
const safeLookup: typeof lookup = ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
  // Host validation is repeated here so the agent cannot resolve an unapproved name.
  if (!isAllowedPushEndpoint(`https://${hostname}/${hostname === 'fcm.googleapis.com' ? 'fcm/send/' : hostname === 'updates.push.services.mozilla.com' ? 'wpush/v2/' : ''}dns-check`)) { callback(Error('推送域名无效')); return; }
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) { callback(error); return; }
    if (!addresses.length || addresses.some(item => !isPublicPushAddress(item.address))) { callback(Error('推送地址解析到非公开网络')); return; }
    if (options && typeof options === 'object' && 'all' in options && options.all) callback(null, addresses);
    else { const preferred = addresses.find(item => item.family === 4) ?? addresses[0]!; callback(null, preferred.address, preferred.family); }
  });
}) as typeof lookup;

function createHttpRequest(): { request: PushHttpRequest; close(): void } {
  const agent = new Agent({ keepAlive: true, lookup: safeLookup });
  return {
    request(endpoint, details) {
      return new Promise((resolve, reject) => {
        // HTTPS request deliberately does not follow redirects, and never accepts a proxy from request input.
        const req = httpsRequest(endpoint, { method: details.method, headers: details.headers, agent }, response => {
          const value = response.headers['retry-after']; const text = Array.isArray(value) ? value[0] : value;
          const seconds = text && /^\d+$/.test(text) ? Number(text) * 1000 : text ? Date.parse(text) - Date.now() : undefined;
          response.resume(); response.on('error', reject);
          response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, ...(seconds !== undefined && Number.isFinite(seconds) ? { retryAfterMs: Math.max(0, seconds) } : {}) }));
        });
        // An absolute deadline also stops slow-drip responses; the lease exceeds this bound.
        const deadline = setTimeout(() => req.destroy(Error('推送请求超时')), 15_000); deadline.unref();
        req.on('error', reject); req.on('close', () => clearTimeout(deadline));
        req.end(details.body ?? undefined);
      });
    },
    close() { agent.destroy(); },
  };
}

export function createWebPushTransport(options: { store: PushStore; subject: string; request?: PushHttpRequest }) {
  const subject = validateVapidSubject(options.subject);
  const keys = options.store.getOrCreateVapidKeys(() => webpush.generateVAPIDKeys());
  const http = options.request ? { request: options.request, close() {} } : createHttpRequest();
  const send: PushSend = async (value, payload, config) => {
    const subscription = PushSubscriptionInputSchema.parse(value);
    if (!Number.isInteger(config.ttl) || config.ttl < 1 || config.ttl > 86_400 || !/^[A-Za-z0-9_-]{1,32}$/.test(config.topic)) throw Error('推送有效期或主题无效');
    const details = webpush.generateRequestDetails(subscription, JSON.stringify(PushPayloadSchema.parse(payload)), {
      vapidDetails: { ...keys, subject }, TTL: config.ttl, topic: config.topic, urgency: 'high', contentEncoding: 'aes128gcm',
    });
    if (!isAllowedPushEndpoint(details.endpoint) || details.endpoint !== subscription.endpoint) throw Error('推送目标改变');
    return http.request(subscription.endpoint, details);
  };
  return { send, publicKey: keys.publicKey, close: http.close };
}
