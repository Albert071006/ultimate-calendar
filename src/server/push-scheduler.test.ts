import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockSchema, type Instant } from '../shared/contracts';
import { emptyState, stateSnapshot } from '../storage/repository';
import { createPushStore, type PushStore } from './push-store';
import { createPushScheduler, pushReminderTopic, type PushSend } from './push-scheduler';

const stores: PushStore[] = []; const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(path = ':memory:') {
  const store = createPushStore(path); stores.push(store); let now: Instant = '2030-01-02T10:00:00+08:00';
  const snapshot = stateSnapshot(emptyState());
  snapshot.blocks.push(BlockSchema.parse({ id: 'synthetic-block', version: 1, createdAt: '2030-01-01T00:00:00+08:00', updatedAt: '2030-01-01T00:00:00+08:00',
    title: '不能默认出现在锁屏的合成标题', start: now, end: null, kind: 'event', reminders: { leadMinutes: [0] } }));
  function subscribe(device = 'one', details = false) {
    return store.upsertSubscription(device, { endpoint: `https://fcm.googleapis.com/fcm/send/${device}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }, { showDetails: details }, '2030-01-01T00:00:00+08:00');
  }
  subscribe();
  return { store, snapshot, subscribe, setNow: (value: Instant) => { now = value; }, clock: () => now };
}

describe('push scheduler', () => {
  it('sends a private lock screen payload once with stable topic, tag and bounded TTL', async () => {
    const f = fixture(); const send = vi.fn<PushSend>(async () => ({ statusCode: 201 })); const scheduler = createPushScheduler({ ...f, snapshot: () => f.snapshot, send });
    expect((await scheduler.tick()).accepted).toBe(1); expect((await scheduler.tick()).accepted).toBe(0);
    const [, payload, config] = send.mock.calls[0]!;
    expect(payload.showDetails).toBe(false); expect(payload.title).toBe('终极日历'); expect(payload.body).toBe('有一项安排需要查看'); expect(JSON.stringify(payload)).not.toContain('合成标题');
    expect(config).toEqual({ ttl: 900, topic: pushReminderTopic(payload.id) }); expect(config.topic).toHaveLength(32); expect(payload.tag).toBe(`uc-${config.topic}`);
    expect(payload.url).toMatch(/^\/\?reminder=/);
  });

  it('keeps independent device results, honors Retry-After and disables gone subscriptions', async () => {
    const f = fixture(); f.subscribe('two');
    const send = vi.fn<PushSend>(async target => target.endpoint.endsWith('/one') ? { statusCode: 201 } : { statusCode: 429, retryAfterMs: 60_000 });
    const scheduler = createPushScheduler({ ...f, snapshot: () => f.snapshot, send }); expect(await scheduler.tick()).toMatchObject({ accepted: 1, retried: 1 });
    f.setNow('2030-01-02T10:00:30+08:00'); await scheduler.tick(); expect(send).toHaveBeenCalledTimes(2);
    send.mockImplementation(async () => ({ statusCode: 410 })); f.setNow('2030-01-02T10:01:00+08:00'); await scheduler.tick();
    expect(send).toHaveBeenCalledTimes(3); expect(f.store.listSubscriptions('two')[0]!.active).toBe(false);
    expect(f.store.listSubscriptions('one')[0]!.active).toBe(true);
  });

  it.each(['cancel', 'complete', 'delete', 'reschedule', 'disable'] as const)('revalidates %s before retrying a durable pending reminder', async action => {
    const f = fixture(); const send = vi.fn<PushSend>(async () => { throw Error('合成网络中断'); }); const scheduler = createPushScheduler({ ...f, snapshot: () => f.snapshot, send });
    expect((await scheduler.tick()).retried).toBe(1);
    const block = f.snapshot.blocks[0]!;
    if (action === 'cancel') block.cancelled = true;
    if (action === 'complete') block.completed = true;
    if (action === 'delete') f.snapshot.blocks = [];
    if (action === 'reschedule') block.start = '2030-01-02T11:00:00+08:00';
    if (action === 'disable') f.snapshot.settings.remindersEnabled = false;
    f.setNow('2030-01-02T10:00:10+08:00'); await scheduler.tick(); expect(send).toHaveBeenCalledTimes(1);
  });

  it('creates only the new point after a future reschedule and refreshes payload detail preferences', async () => {
    const f = fixture(); const send = vi.fn<PushSend>(async () => ({ statusCode: 201 })); const scheduler = createPushScheduler({ ...f, snapshot: () => f.snapshot, send });
    await scheduler.tick(); f.snapshot.blocks[0]!.start = '2030-01-02T11:00:00+08:00';
    f.subscribe('one', true); f.setNow('2030-01-02T11:00:00+08:00'); await scheduler.tick();
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1]![1].showDetails).toBe(true); expect(send.mock.calls[1]![1].title).toBe(f.snapshot.blocks[0]!.title);
    expect(send.mock.calls[1]![1].id).not.toBe(send.mock.calls[0]![1].id);
  });

  it('uses fresh snapshot for the next device after a cancellation during an in-flight send', async () => {
    const f = fixture(); f.subscribe('two'); let release!: () => void;
    const send = vi.fn<PushSend>(async () => { await new Promise<void>(resolve => { release = resolve; }); return { statusCode: 201 }; });
    const scheduler = createPushScheduler({ ...f, snapshot: () => f.snapshot, send }); const tick = scheduler.tick();
    expect(send).toHaveBeenCalledTimes(1); f.snapshot.blocks[0]!.cancelled = true; release(); await tick;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping ticks and catches up after restart without duplicate accepted sends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-push-scheduler-')); roots.push(root); const path = join(root, 'notifications.sqlite');
    const f = fixture(path); let release!: () => void;
    const send = vi.fn<PushSend>(async () => { await new Promise<void>(resolve => { release = resolve; }); return { statusCode: 201 }; });
    f.setNow('2030-01-02T10:10:00+08:00'); const scheduler = createPushScheduler({ ...f, snapshot: () => f.snapshot, send });
    const first = scheduler.tick(); expect(scheduler.tick()).toBe(first); release(); await first; f.store.close();
    const reopened = createPushStore(path); stores.push(reopened); const after = createPushScheduler({ store: reopened, snapshot: () => f.snapshot, send, clock: f.clock });
    await after.tick(); expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not replay after the 15-minute grace or allow a grace over 24 hours', async () => {
    const f = fixture(); const send = vi.fn<PushSend>(async () => ({ statusCode: 201 }));
    f.setNow('2030-01-02T10:15:00+08:00'); await createPushScheduler({ ...f, snapshot: () => f.snapshot, send }).tick(); expect(send).not.toHaveBeenCalled();
    expect(() => createPushScheduler({ ...f, snapshot: () => f.snapshot, send, catchUpMs: 86_400_001 })).toThrow('24小时');
  });

  it('persists a failed delivery across restart and sends only the latest title on retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uc-push-retry-')); roots.push(root); const path = join(root, 'notifications.sqlite');
    const f = fixture(path); const send = vi.fn<PushSend>(async () => ({ statusCode: 503 }));
    const first = createPushScheduler({ ...f, snapshot: () => f.snapshot, send }); expect((await first.tick()).retried).toBe(1); f.store.close();
    const reopened = createPushStore(path); stores.push(reopened); f.snapshot.blocks[0]!.title = '修改后的合成标题';
    reopened.upsertSubscription('one', { endpoint: 'https://fcm.googleapis.com/fcm/send/one', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } }, { showDetails: true }, f.clock());
    f.setNow('2030-01-02T10:00:06+08:00'); send.mockImplementation(async () => ({ statusCode: 201 }));
    const restarted = createPushScheduler({ store: reopened, snapshot: () => f.snapshot, clock: f.clock, send });
    expect((await restarted.tick()).accepted).toBe(1); expect(send.mock.calls[1]![1].title).toBe('修改后的合成标题');
    f.snapshot.blocks[0]!.title = '再修改不重复通知'; await restarted.tick(); expect(send).toHaveBeenCalledTimes(2);
  });

  it('retains exact scheduling semantics, suppressing date-only [] and creation-time points', async () => {
    const f = fixture(); const send = vi.fn<PushSend>(async () => ({ statusCode: 201 }));
    f.snapshot.blocks[0]!.createdAt = f.clock();
    await createPushScheduler({ ...f, snapshot: () => f.snapshot, send }).tick(); expect(send).not.toHaveBeenCalled();
  });
});
