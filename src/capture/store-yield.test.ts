import { afterEach, describe, expect, it } from 'vitest';
import { createCaptureStore, type CaptureStore } from './store';

const stores: CaptureStore[] = [];
const at = (second: number) => `2032-11-01T12:00:${String(second).padStart(2, '0')}+08:00`;
function setup() {
  const store = createCaptureStore(':memory:'); stores.push(store);
  store.saveConfig({ ...store.config(), enabled: true, accountId: '100', groupIds: ['200', '300'] });
  return store;
}
function enqueue(store: CaptureStore, id: string, second: number, origin: 'live' | 'history' = 'live') {
  store.ingest([{ accountId: '100', groupId: id === 'second' ? '300' : '200', messageId: id,
    text: '合成通知', sentAt: at(second), origin }], at(second));
  return store.sealBatches({ now: at(second), force: true })[0]!;
}
const checkpoint = { version: 2, completed: [{ key: 'saved-fragment', value: { candidates: [] } }], final: false };
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('capture checkpoint queue rotation', () => {
  it('retains paid progress and rotates behind another waiting group without recording a failure', () => {
    const store = setup(), first = enqueue(store, 'first', 0), second = enqueue(store, 'second', 1);
    expect(store.claimBatch(at(2))?.id).toBe(first.id);
    store.startAttempt(first.id, 'saved-input', at(3));
    store.checkpointResult(first.id, checkpoint, undefined, at(4));
    const before = store.batch(first.id)!;
    const yielded = store.yieldBatch(first.id, at(5));
    expect(yielded).toEqual({ ...before, status: 'pending', updatedAt: at(5) });
    expect(yielded.attempts).toMatchObject([{ status: 'succeeded', finishedAt: at(4), error: null }]);
    expect(store.claimBatch(at(6))?.id).toBe(second.id);
    store.saveResult(second.id, { candidates: [] }, at(7)); store.markApplied(second.id, at(7));
    expect(store.claimBatch(at(8))).toMatchObject({ id: first.id, result: checkpoint, inputFingerprint: 'saved-input' });
  });

  it('never yields an unpaid preparation, in-flight response, or final result', () => {
    const store = setup(), first = enqueue(store, 'first', 0); store.claimBatch(at(1));
    expect(() => store.yieldBatch(first.id, at(2))).toThrow('仅已保存分片进度');
    store.startAttempt(first.id, 'input', at(2));
    store.savePendingResponse(first.id, { ...checkpoint, pendingResponse: { key: 'next', value: {} } }, at(3));
    expect(() => store.yieldBatch(first.id, at(4))).toThrow('仅已保存分片进度');
    expect(store.batch(first.id)?.status).toBe('requesting');
    store.checkpointResult(first.id, { ...checkpoint, pendingResponse: { key: 'next', value: {} } }, undefined, at(4));
    expect(() => store.yieldBatch(first.id, at(5))).toThrow('仅已保存分片进度');
    store.checkpointResult(first.id, { ...checkpoint, final: true }, undefined, at(5));
    expect(() => store.yieldBatch(first.id, at(6))).toThrow('仅已保存分片进度');
  });

  it('keeps result-ready ahead of queued work even when its update is newer', () => {
    const store = setup(), first = enqueue(store, 'first', 0), second = enqueue(store, 'second', 1);
    store.claimBatch(at(2)); store.checkpointResult(first.id, checkpoint, undefined, at(3)); store.yieldBatch(first.id, at(4));
    expect(store.claimBatch(at(5))?.id).toBe(second.id);
    store.saveResult(second.id, { candidates: [] }, at(6));
    expect(store.claimBatch(at(7))).toMatchObject({ id: second.id, status: 'result-ready' });
  });

  it('preserves the three-live-to-one-history policy while partial batches rotate', () => {
    const store = setup(), history = enqueue(store, 'old', 0, 'history'), live = enqueue(store, 'first', 1);
    const origins: string[] = [];
    for (let n = 0; n < 4; n++) {
      const batch = store.claimBatch(at(2 + n * 3))!; origins.push(batch.origin);
      store.checkpointResult(batch.id, checkpoint, undefined, at(3 + n * 3)); store.yieldBatch(batch.id, at(4 + n * 3));
    }
    expect(origins).toEqual(['live', 'live', 'live', 'history']);
    expect(store.batch(history.id)?.status).toBe('pending'); expect(store.batch(live.id)?.status).toBe('pending');
  });
});
