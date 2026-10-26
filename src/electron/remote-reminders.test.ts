import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskSchema } from '../shared/contracts';
import { emptyState, stateSnapshot } from '../storage/repository';
import { createRemoteReminderScheduler } from './remote-reminders';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const identity = { protocolVersion: 1 as const, dataInstanceId: '11111111-1111-4111-8111-111111111111', generation: 1 };
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T18:00:00+08:00'));
  const directory = mkdtempSync(join(tmpdir(), 'remote-reminders-')); roots.push(directory);
  const state = emptyState(); state.settings.taskLeadMinutes = [60];
  state.entities.task.push(TaskSchema.parse({ id: 'synthetic-remote-task', title: '合成云端提醒任务', version: 1, createdAt: '2025-12-31T12:00:00+08:00', updatedAt: '2025-12-31T12:00:00+08:00', deadline: { date: '2026-01-01', time: '20:00' } }));
  return { directory, snapshot: stateSnapshot(state) };
}
describe('remote desktop reminder presentation state', () => {
  it('persists pending and acknowledged reminders without creating a planner database', async () => {
    const f = fixture(), first = createRemoteReminderScheduler({ directory: f.directory, identity });
    await first.initialize(); first.updateSnapshot(f.snapshot);
    const reminders = await first.check('2026-01-01T19:00:00+08:00'); expect(reminders).toHaveLength(1);
    const restarted = createRemoteReminderScheduler({ directory: f.directory, identity }); await restarted.initialize(); restarted.updateSnapshot(f.snapshot);
    expect(await restarted.check('2026-01-01T19:00:01+08:00')).toHaveLength(1);
    await restarted.acknowledge(reminders.map(value => value.id));
    const again = createRemoteReminderScheduler({ directory: f.directory, identity }); await again.initialize(); again.updateSnapshot(f.snapshot);
    expect(await again.check('2026-01-01T19:00:02+08:00')).toEqual([]);
    expect(existsSync(join(f.directory, 'planner.sqlite'))).toBe(false);
    expect(readdirSync(f.directory).every(name => /^cloud-reminder-(?:cursor|receipts)-[a-f0-9]{64}\.json$/.test(name))).toBe(true);
  });
  it('does not advance the cursor before a snapshot has arrived', async () => {
    const f = fixture(), scheduler = createRemoteReminderScheduler({ directory: f.directory, identity });
    await scheduler.initialize(); expect(await scheduler.check('2026-01-01T19:00:00+08:00')).toEqual([]); expect(readdirSync(f.directory)).toEqual([]);
    scheduler.updateSnapshot(f.snapshot); expect(await scheduler.check('2026-01-01T19:00:01+08:00')).toHaveLength(1);
  });
  it('isolates receipt files between cloud generations', async () => {
    const f = fixture(), old = createRemoteReminderScheduler({ directory: f.directory, identity }); old.updateSnapshot(f.snapshot);
    const due = await old.check('2026-01-01T19:00:00+08:00'); await old.acknowledge(due.map(item => item.id));
    const next = createRemoteReminderScheduler({ directory: f.directory, identity: { ...identity, generation: 2 } }); next.updateSnapshot(f.snapshot);
    expect(await next.check('2026-01-01T19:00:00+08:00')).toHaveLength(1); expect(readdirSync(f.directory)).toHaveLength(3);
  });
  it('preserves malformed receipts and refuses silently resending them', async () => {
    const f = fixture(), scheduler = createRemoteReminderScheduler({ directory: f.directory, identity }); scheduler.updateSnapshot(f.snapshot);
    const due = await scheduler.check('2026-01-01T19:00:00+08:00'); await scheduler.acknowledge(due.map(item => item.id));
    const path = join(f.directory, readdirSync(f.directory).find(name => name.startsWith('cloud-reminder-receipts-'))!);
    writeFileSync(path, 'invalid-receipts');
    const restored = createRemoteReminderScheduler({ directory: f.directory, identity }); restored.updateSnapshot(f.snapshot);
    await expect(restored.check('2026-01-01T19:01:00+08:00')).rejects.toThrow(/未清空/); expect(readFileSync(path, 'utf8')).toBe('invalid-receipts');
  });
});
