import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createRemoteService } from './service';
import { createRemoteHttpServer } from './http';
import { createPushStore } from './push-store';
import { createPushHttpExtension } from './push-http';
import type { PushSend } from './push-scheduler';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = 'http://localhost:3221';
const subscription = { endpoint: 'https://web.push.apple.com/synthetic', expirationTime: null, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
async function setup(enabled = true) {
  const folder = mkdtempSync(join(tmpdir(), 'uc-push-http-')); cleanup.push(async () => { rmSync(folder, { recursive: true, force: true }); });
  const service = createRemoteService({ dataDirectory: folder, getApiKey: async () => null });
  const store = createPushStore(join(folder, 'notifications.sqlite')); const send = vi.fn<PushSend>(async () => ({ statusCode: 201 }));
  const http = createRemoteHttpServer({ service, origin, secureCookie: false, extension: createPushHttpExtension({ store, publicKey: enabled ? 'B'.repeat(87) : null, send }), onRevokeDevice: id => store.revokeDevice(id) });
  const port = await http.listen(0);
  cleanup.push(async () => { await http.close(); store.close(); await service.close(); });
  const call = (path: string, method = 'GET', headers: Record<string, string> = {}, value?: unknown): Promise<{ status: number; body: Record<string, unknown>; cookie?: string }> => new Promise((done, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}${path}`, { method, headers: { Host: 'localhost:3221', ...headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => done({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), cookie: response.headers['set-cookie']?.[0]?.split(';')[0] }));
    }); req.on('error', reject); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
  async function pair() {
    const response = await call('/api/v1/pair', 'POST', { Origin: origin, 'Content-Type': 'application/json' }, { code: service.state.createPairingCode(), name: '虚构手机' });
    expect(response.status).toBe(200);
    return { session: response.body, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: response.cookie!, 'x-csrf-token': String(response.body.csrfToken) } };
  }
  return { store, send, call, pair };
}

describe('authenticated push HTTP extension', () => {
  it('requires session and CSRF before accepting a browser subscription, exposing no endpoint or key material', async () => {
    const f = await setup(); expect((await f.call('/api/v1/push')).status).toBe(401);
    const { headers } = await f.pair(); const { 'x-csrf-token': _csrf, ...noCsrf } = headers;
    expect((await f.call('/api/v1/push/subscribe', 'POST', noCsrf, { subscription })).status).toBe(403);
    expect((await f.call('/api/v1/push/subscribe', 'POST', headers, { subscription, deviceId: 'spoofed' })).status).toBe(400);
    const response = await f.call('/api/v1/push/subscribe', 'POST', headers, { subscription }); expect(response.status).toBe(200);
    expect(response.body.subscription).toMatchObject({ showDetails: false, active: true });
    const status = await f.call('/api/v1/push', 'GET', headers); expect(status.status).toBe(200);
    expect(status.body.enabled).toBe(true); expect(JSON.stringify(status.body)).not.toContain(subscription.endpoint); expect(JSON.stringify(status.body)).not.toContain('p256dh');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('limits payloads, rejects unsupported provider URLs and binds unsubscribe/test to the device', async () => {
    const f = await setup(); const one = await f.pair(); const two = await f.pair();
    expect((await f.call('/api/v1/push/subscribe', 'POST', one.headers, { subscription: { ...subscription, endpoint: 'https://169.254.169.254/latest/meta-data/' } })).status).toBe(400);
    expect((await f.call('/api/v1/push/subscribe', 'POST', one.headers, { subscription, junk: 'A'.repeat(20_000) })).status).toBe(413);
    const saved = await f.call('/api/v1/push/subscribe', 'POST', one.headers, { subscription, showDetails: true });
    const id = String((saved.body.subscription as Record<string, unknown>).id);
    expect((await f.call('/api/v1/push/subscribe', 'POST', two.headers, { subscription })).status).toBe(409);
    expect((await f.call('/api/v1/push/test', 'POST', two.headers, { subscriptionId: id })).status).toBe(404);
    expect((await f.call('/api/v1/push/unsubscribe', 'POST', two.headers, { subscriptionId: id })).status).toBe(200);
    expect((await f.call('/api/v1/push/test', 'POST', one.headers, { subscriptionId: id })).body).toEqual({ accepted: true });
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0]![1].body).toBe('有一项安排需要查看');
    await f.call('/api/v1/push/unsubscribe', 'POST', one.headers, { subscriptionId: id });
    expect((await f.call('/api/v1/push/test', 'POST', one.headers, { subscriptionId: id })).status).toBe(404);
  });

  it('deletes device subscriptions on logout and returns an explicit disabled status without VAPID', async () => {
    const f = await setup(); const { headers, session } = await f.pair();
    await f.call('/api/v1/push/subscribe', 'POST', headers, { subscription });
    const device = session.device as { id: string }; expect(f.store.listSubscriptions(device.id)).toHaveLength(1);
    expect((await f.call('/api/v1/logout', 'POST', headers, {})).status).toBe(200); expect(f.store.listSubscriptions(device.id)).toEqual([]);
    const disabled = await setup(false); const paired = await disabled.pair();
    expect((await disabled.call('/api/v1/push', 'GET', paired.headers)).body).toMatchObject({ enabled: false, publicKey: null });
    expect((await disabled.call('/api/v1/push/subscribe', 'POST', paired.headers, { subscription })).status).toBe(503);
  });
});
