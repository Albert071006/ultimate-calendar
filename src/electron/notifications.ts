import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { InstantSchema, ReminderSchema, type Reminder } from '../shared/contracts';
import type { Repository } from '../storage/repository';
import { collectReminders } from '../domain/reminders';
import { nowInstant, instantAt } from '../domain/time';
import { atomicWrite } from './key-store';
const CursorSchema = z.strictObject({ lastCheck: InstantSchema, pending: z.array(ReminderSchema).default([]) });
/** Deferred items remain in the queue; only a new reminder or explicit tray action permits another dialog. */
export function createReminderSummary() {
  const items = new Map<string, Reminder>(); let deferred = false; let displaying = false;
  return {
    has(id: string) { return items.has(id); },
    enqueue(reminders: Reminder[]) { for (const r of reminders) if (!items.has(r.id)) { items.set(r.id, r); deferred = false; } },
    begin(explicit = false): Reminder[] { if (displaying || (!explicit && deferred)) return []; if (!items.size) return []; displaying = true; return [...items.values()]; },
    finish(ids: string[], postpone: boolean) { if (!postpone) for (const id of ids) items.delete(id); deferred = postpone; displaying = false; },
  };
}
export function createReminderScheduler(repository: Repository, cursorPath: string) {
  let previous = nowInstant(); let pending: Reminder[] = []; let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> { const result = queue.then(work); queue = result.catch(() => {}); return result; }
  return {
    async initialize() {
      try { const state = CursorSchema.parse(JSON.parse(await readFile(cursorPath, 'utf8'))); previous = state.lastCheck; pending = state.pending; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') previous = instantAt(Date.now() - 86400_000); }
    },
    check(now: string): Promise<Reminder[]> {
      return serialized(async () => {
        InstantSchema.parse(now);
        const sent = new Set(repository.read().receipts);
        const candidates = Date.parse(now) < Date.parse(previous) ? [] : collectReminders(repository.snapshot(), previous, now);
        const next = [...new Map([...pending, ...candidates].filter(r => !sent.has(r.id)).map(r => [r.id, r])).values()];
        // Persist recoverable delivery content before advancing the cursor. No sent receipt is consumed here.
        await atomicWrite(cursorPath, JSON.stringify({ lastCheck: now, pending: next })); previous = now; pending = next;
        return structuredClone(next);
      });
    },
    acknowledge(ids: string[]): Promise<void> {
      return serialized(async () => {
        const accepted = new Set(ids); repository.claimReminders(pending.filter(r => accepted.has(r.id)));
        const next = pending.filter(r => !accepted.has(r.id));
        // Receipts are durable after presentation. If this cleanup fails, the next check filters by those receipts.
        await atomicWrite(cursorPath, JSON.stringify({ lastCheck: previous, pending: next })); pending = next;
      });
    },
  };
}
