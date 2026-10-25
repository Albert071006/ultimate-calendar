import { afterEach, describe, expect, it, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { isAllowedPushEndpoint, PushPayloadSchema, PushSubscriptionInputSchema } from '../shared/push';
import { createPushStore, type PushStore } from './push-store';
import { createWebPushTransport, isPublicPushAddress, validateVapidSubject, type PushHttpRequest } from './web-push-transport';
import type { PushPayload } from '../shared/push';

const stores: PushStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const payload: PushPayload = { type: 'reminder', showDetails: false, id: 'synthetic', title: '终极日历', body: '有一项安排需要查看', tag: 'uc-synthetic', url: '/', scheduledAt: '2030-01-01T10:00:00+08:00', expiresAt: '2030-01-01T10:15:00+08:00' };

describe('web push provider boundary', () => {
  it.each(['https://web.push.apple.com/token', 'https://fcm.googleapis.com/fcm/send/token', 'https://updates.push.services.mozilla.com/wpush/v2/token'])('allows the production browser provider %s', endpoint => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });
  it.each(['http://web.push.apple.com/token', 'https://web.push.apple.com.evil.invalid/token', 'https://evil.invalid@web.push.apple.com/token', 'https://web.push.apple.com:8443/token', 'https://127.0.0.1/token', 'https://169.254.169.254/latest/meta-data/', 'https://fcm.googleapis.com/anything', 'https://web.push.apple.com/token#fragment', 'https://updates.push.services.mozilla.com/token'])('rejects arbitrary or disguised endpoints %s', endpoint => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
  it.each(['127.0.0.1', '10.2.3.4', '169.254.169.254', '172.16.1.1', '192.168.1.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '2001:db8::1'])('rejects nonpublic DNS address %s', address => expect(isPublicPushAddress(address)).toBe(false));
  it('allows public addresses only and validates an explicit VAPID contact', () => {
    expect(isPublicPushAddress('142.250.1.1')).toBe(true); expect(isPublicPushAddress('2607:f8b0:4000::1')).toBe(true);
    expect(validateVapidSubject('https://calendar.example.org/')).toBe('https://calendar.example.org'); expect(validateVapidSubject('mailto:owner@example.org')).toBe('mailto:owner@example.org');
    for (const subject of ['', 'https://localhost', 'https://127.0.0.1', 'https://calendar.internal', 'mailto:me@localhost', 'https://example.org/contact', 'http://example.org']) expect(() => validateVapidSubject(subject)).toThrow();
    const { showDetails: _show, ...oldPayload } = payload; expect(PushPayloadSchema.parse(oldPayload).showDetails).toBe(false);
    expect(PushPayloadSchema.safeParse({ ...payload, url: '//external.invalid/' }).success).toBe(false);
  });

  it('uses persisted VAPID and encrypts private payloads without making real network requests', async () => {
    const store = createPushStore(':memory:'); stores.push(store); const request = vi.fn<PushHttpRequest>(async () => ({ statusCode: 201 }));
    const first = createWebPushTransport({ store, subject: 'mailto:owner@example.org', request });
    const second = createWebPushTransport({ store, subject: 'https://calendar.example.org', request }); expect(second.publicKey).toBe(first.publicKey);
    const curve = createECDH('prime256v1'); curve.generateKeys();
    const subscription = { endpoint: 'https://web.push.apple.com/synthetic', keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    expect(PushSubscriptionInputSchema.parse(subscription)).toEqual(subscription);
    expect(await first.send(subscription, payload, { ttl: 900, topic: 'stable_synthetic' })).toEqual({ statusCode: 201 });
    const [endpoint, details] = request.mock.calls[0]!; expect(endpoint).toBe(subscription.endpoint); expect(details.method).toBe('POST');
    expect(details.headers.TTL).toBe(900); expect(details.headers.Topic).toBe('stable_synthetic'); expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(details.body?.toString()).not.toContain(payload.body);
    await expect(first.send({ ...subscription, endpoint: 'https://localhost/private' }, payload, { ttl: 900, topic: 'x' })).rejects.toThrow();
    await expect(first.send(subscription, payload, { ttl: 100_000, topic: 'x' })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1); first.close(); second.close();
  });
});
