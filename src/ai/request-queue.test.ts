import { describe, expect, it } from 'vitest';
import { createModelRequestQueue } from './request-queue';

describe('shared paid model request queue', () => {
  it('serializes manual and background jobs, retaining FIFO order and releasing after failure', async () => {
    const queue = createModelRequestQueue(); const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const background = queue.run(async () => { calls.push('background-start'); await gate; calls.push('background-end'); return 'background'; });
    const manual = queue.run(async () => { calls.push('manual'); throw Error('synthetic failure'); });
    const caught = manual.catch(error => error.message);
    const later = queue.run(async () => { calls.push('later'); return 'later'; });
    await Promise.resolve();
    expect(calls).toEqual(['background-start']); expect(queue.busy()).toBe(true); expect(queue.pending()).toBe(2);
    release(); expect(await background).toBe('background'); expect(await caught).toBe('synthetic failure'); expect(await later).toBe('later');
    expect(calls).toEqual(['background-start', 'background-end', 'manual', 'later']); expect(queue.busy()).toBe(false);
  });
});
