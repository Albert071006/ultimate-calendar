import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupScheduler } from './backup-scheduler';

afterEach(() => vi.useRealTimers());
describe('background backup deadlines and recovery', () => {
  it('does not slide the first dirty deadline and preserves writes arriving during an export', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let release: (path: string) => void = () => {};
    const run = vi.fn(() => new Promise<string>(done => { release = done; }));
    const scheduler = createBackupScheduler({ run });
    scheduler.markDirty(); await vi.advanceTimersByTimeAsync(59_000); scheduler.markDirty();
    expect(run).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1_000); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); scheduler.markDirty();
    release('first.json'); await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.status()).toMatchObject({ pending: true, pendingSince: '1970-01-01T00:01:10.000Z', running: false });
    await vi.advanceTimersByTimeAsync(59_000); scheduler.markDirty(); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); expect(run).toHaveBeenCalledTimes(2);
    release('second.json'); await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.status().pending).toBe(false); await scheduler.close();
  });
  it('keeps the dirty state after failure, retries in the background and flushes immediately on close', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const failure = vi.fn(), run = vi.fn().mockRejectedValueOnce(Error('synthetic disk failure')).mockResolvedValue('complete.json');
    const scheduler = createBackupScheduler({ run, onFailure: failure });
    scheduler.markDirty(); await vi.advanceTimersByTimeAsync(60_000);
    expect(failure).toHaveBeenCalledOnce(); expect(scheduler.status()).toMatchObject({ pending: true, running: false });
    await vi.advanceTimersByTimeAsync(14_999); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2); expect(scheduler.status().pending).toBe(false);
    scheduler.markDirty(); await scheduler.close(); expect(run).toHaveBeenCalledTimes(3);
  });
  it('cancels a stuck worker at the shutdown deadline without claiming the pending state is backed up', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const scheduler = createBackupScheduler({ run: signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })) });
    scheduler.markDirty(); const closing = scheduler.close(1000);
    const outcome = expect(closing).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(1000); await outcome;
    expect(scheduler.status()).toMatchObject({ pending: true, running: false });
  });
});
