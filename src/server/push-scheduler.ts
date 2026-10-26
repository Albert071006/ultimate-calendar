import { createHash } from 'node:crypto';
import { collectReminders } from '../domain/reminders';
import { instantAt, nowInstant } from '../domain/time';
import { InstantSchema, type Instant, type Reminder, type Snapshot } from '../shared/contracts';
import type { PushPayload, PushSubscriptionInput } from '../shared/push';
import type { PushDelivery, PushStore } from './push-store';

export interface PushSendResult { statusCode: number; retryAfterMs?: number }
export type PushSend = (subscription: PushSubscriptionInput, payload: PushPayload, options: { ttl: number; topic: string }) => Promise<PushSendResult>;
export interface PushSchedulerOptions {
  snapshot: () => Snapshot;
  store: PushStore;
  send: PushSend;
  clock?: () => Instant;
  catchUpMs?: number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}
export interface PushTickResult { accepted: number; retried: number; cancelled: number; failed: number }
export function pushReminderTopic(id: string): string { return createHash('sha256').update(id).digest('base64url').slice(0, 32); }
export function pushReminderPayload(reminder: Reminder, showDetails: boolean, expiresAt: Instant): PushPayload {
  return { type: 'reminder', showDetails, id: reminder.id, title: showDetails ? reminder.title.slice(0, 200) : '终极日历',
    body: showDetails ? reminder.message : '有一项安排需要查看', tag: `uc-${pushReminderTopic(reminder.id)}`,
    url: `/?reminder=${encodeURIComponent(reminder.id)}`, scheduledAt: reminder.scheduledAt, expiresAt };
}

/** A rolling durable outbox intentionally overlaps scans. It cannot lose reminders to a cursor/file-write race. */
export function createPushScheduler(options: PushSchedulerOptions) {
  const { snapshot, store, send } = options; const clock = options.clock ?? nowInstant;
  const catchUpMs = options.catchUpMs ?? 15 * 60_000; const intervalMs = options.intervalMs ?? 30_000;
  if (!Number.isInteger(catchUpMs) || catchUpMs <= 0 || catchUpMs > 86_400_000) throw Error('推送补发范围必须在24小时内');
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 300_000) throw Error('推送检查间隔无效');
  let timer: ReturnType<typeof setInterval> | undefined; let running: Promise<PushTickResult> | undefined; let stopping = false;
  const readNow = () => InstantSchema.parse(clock());
  const eligible = (now: Instant) => collectReminders(snapshot(), instantAt(Date.parse(now) - catchUpMs), now);
  async function run(): Promise<PushTickResult> {
    const result: PushTickResult = { accepted: 0, retried: 0, cancelled: 0, failed: 0 };
    const scanAt = readNow(); store.reconcile(eligible(scanAt), scanAt, catchUpMs);
    for (let i = 0; i < 100 && !stopping; i++) {
      const claimed = store.claimDue(readNow(), 1, 60_000)[0]; if (!claimed) break;
      const at = readNow(); const current = store.currentDelivery(claimed.id, claimed.leaseToken, at);
      const reminder = current ? eligible(at).find(value => value.id === current.reminder.id) : undefined;
      if (!current || !reminder) {
        if (!reminder) store.cancelJob(claimed.reminder.id);
        store.settle(claimed.id, claimed.leaseToken, { kind: 'cancelled' }); result.cancelled++; continue;
      }
      const ttl = Math.floor((Date.parse(current.expiresAt) - Date.parse(at)) / 1000);
      if (ttl <= 0) { store.settle(current.id, current.leaseToken, { kind: 'expired' }); result.cancelled++; continue; }
      try {
        const response = await send(current.target.subscription, pushReminderPayload(reminder, current.target.showDetails, current.expiresAt), { ttl, topic: pushReminderTopic(reminder.id) });
        if (response.statusCode >= 200 && response.statusCode < 300) {
          store.settle(current.id, current.leaseToken, { kind: 'accepted' }); result.accepted++;
        } else handleFailure(current, response, result);
      } catch (error) {
        // Do not store provider bodies, URLs, keys or arbitrary exception strings in delivery diagnostics.
        const code = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 0;
        handleFailure(current, { statusCode: code }, result);
      }
    }
    return result;
  }
  function handleFailure(delivery: PushDelivery, response: PushSendResult, result: PushTickResult): void {
    const code = response.statusCode;
    if (code === 404 || code === 410) { store.disableSubscription(delivery.target.id); result.failed++; return; }
    if (code === 0 || code === 408 || code === 429 || code >= 500) {
      const backoff = Math.min(300_000, 5000 * 2 ** Math.min(delivery.attempts - 1, 6));
      const requested = Number.isFinite(response.retryAfterMs) ? Math.max(0, response.retryAfterMs!) : 0;
      const next = Date.parse(readNow()) + Math.max(backoff, requested);
      if (next >= Date.parse(delivery.expiresAt)) { store.settle(delivery.id, delivery.leaseToken, { kind: 'expired' }); result.failed++; }
      else { store.settle(delivery.id, delivery.leaseToken, { kind: 'retry', nextAttemptAt: instantAt(next), reason: code ? `HTTP ${code}` : 'network' }); result.retried++; }
      return;
    }
    store.settle(delivery.id, delivery.leaseToken, { kind: 'failed', reason: `HTTP ${code}` }); result.failed++;
  }
  function tick(): Promise<PushTickResult> {
    if (running) return running;
    if (stopping) return Promise.resolve({ accepted: 0, retried: 0, cancelled: 0, failed: 0 });
    running = run().finally(() => { running = undefined; }); return running;
  }
  return {
    tick,
    start() {
      if (timer) return; stopping = false;
      const check = () => { void tick().catch(error => options.onError?.(error)); };
      check(); timer = setInterval(check, intervalMs); timer.unref();
    },
    async stop() { stopping = true; if (timer) clearInterval(timer); timer = undefined; await running; },
  };
}
