import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPushStore, type PushStore } from './push-store';
import type { Reminder } from '../shared/contracts';
import type { PushSubscriptionInput } from '../shared/push';

const stores: PushStore[] = []; const roots: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const created = '2030-01-01T00:00:00+08:00'; const now = '2030-01-02T10:00:00+08:00';
const later = '2030-01-02T10:02:00+08:00';
function open(path = ':memory:') { const store = createPushStore(path); stores.push(store); return store; }
function subscription(token: string): PushSubscriptionInput { return { endpoint: `https://fcm.googleapis.com/fcm/send/${token}`, expirationTime: null, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }; }
const reminder: Reminder = { id: 'block:b:2030-01-02T10:00:00+08:00:2030-01-02T10:00:00+08:00', refId: 'b', refKind: 'block', title: '合成活动', dueAt: now, scheduledAt: now, dateOnly: false, message: '即将到期或开始' };

describe('persistent push store', () => {
  it('owns subscriptions by authenticated device and removes only owned records', () => {
    const store = open(); const a = store.upsertSubscription('device-a', subscription('a'), {}, created);
    expect(a.showDetails).toBe(false);
    expect(() => store.upsertSubscription('device-b', subscription('a'), {}, created)).toThrow('另一台设备');
    expect(() => store.upsertSubscription('device-b', { ...subscription('a'), endpoint: 'https://FCM.GOOGLEAPIS.COM:443/fcm/send/a' }, {}, created)).toThrow('另一台设备');
    expect(store.removeSubscription('device-b', a.id)).toBe(false);
    store.upsertSubscription('device-b', subscription('b'), {}, created);
    store.revokeDevice('device-a'); expect(store.listSubscriptions('device-a')).toEqual([]); expect(store.listSubscriptions('device-b')).toHaveLength(1);
  });

  it('claims independently for each subscription and survives process restart without replay', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-push-')); roots.push(root); const path = join(root, 'notifications.sqlite');
    const store = open(path); store.upsertSubscription('one', subscription('one'), {}, created); store.upsertSubscription('two', subscription('two'), {}, created);
    store.reconcile([reminder], now, 900_000); const first = store.claimDue(now, 1)[0]!;
    expect(store.settle(first.id, first.leaseToken, { kind: 'accepted' })).toBe(true); store.close();
    const reopened = open(path); reopened.reconcile([reminder], now, 900_000); const second = reopened.claimDue(now);
    expect(second).toHaveLength(1); expect(second[0]!.target.id).not.toBe(first.target.id);
    reopened.settle(second[0]!.id, second[0]!.leaseToken, { kind: 'accepted' });
    reopened.reconcile([reminder], later, 900_000); expect(reopened.claimDue(later)).toEqual([]);
  });

  it('allows one lease and recovers a crashed worker without accepting its obsolete token', () => {
    const store = open(); store.upsertSubscription('a', subscription('a'), {}, created); store.reconcile([reminder], now, 900_000);
    const abandoned = store.claimDue(now)[0]!; expect(store.claimDue(now)).toEqual([]);
    const recovered = store.claimDue(later)[0]!; expect(recovered.id).toBe(abandoned.id); expect(recovered.attempts).toBe(2);
    expect(store.settle(abandoned.id, abandoned.leaseToken, { kind: 'accepted' })).toBe(false);
    expect(store.settle(recovered.id, recovered.leaseToken, { kind: 'accepted' })).toBe(true);
  });

  it('reconciles cancellation, refreshes title and does not replay to newly subscribing devices', () => {
    const store = open(); store.upsertSubscription('a', subscription('a'), {}, created); store.reconcile([reminder], now, 900_000);
    store.reconcile([], now, 900_000); expect(store.claimDue(now)).toEqual([]);
    store.reconcile([{ ...reminder, title: '合成修改标题' }], later, 900_000);
    expect(store.claimDue(later)[0]!.reminder.title).toBe('合成修改标题');
    store.upsertSubscription('new', subscription('new'), {}, later); store.reconcile([reminder], later, 900_000); expect(store.claimDue(later)).toEqual([]);
  });

  it('persists VAPID once and never replaces invalid stored keys silently', () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-push-key-')); roots.push(root); const path = join(root, 'notifications.sqlite');
    const keys = { publicKey: 'B'.repeat(87), privateKey: 'C'.repeat(43) }; const store = open(path);
    expect(store.getPublicVapidKey()).toBeNull(); expect(store.getOrCreateVapidKeys(() => keys)).toEqual(keys); store.close();
    const reopened = open(path); expect(reopened.getOrCreateVapidKeys(() => { throw Error('不应重新生成'); })).toEqual(keys); expect(reopened.getPublicVapidKey()).toBe(keys.publicKey);
  });

  it('expires jobs and invalidates leases when a device is revoked', () => {
    const store = open(); store.upsertSubscription('a', subscription('a'), {}, created); store.reconcile([reminder], now, 900_000);
    const item = store.claimDue(now)[0]!; store.revokeDevice('a'); expect(store.currentDelivery(item.id, item.leaseToken, now)).toBeNull();
    expect(store.settle(item.id, item.leaseToken, { kind: 'accepted' })).toBe(false);
    store.upsertSubscription('b', subscription('b'), {}, created); store.reconcile([reminder], '2030-01-02T10:16:00+08:00', 900_000);
    expect(store.claimDue('2030-01-02T10:16:00+08:00')).toEqual([]);
  });
});
