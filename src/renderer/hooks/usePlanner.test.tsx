// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapshotSchema, type ApiError, type ApiResult, type Snapshot, type PlannerChanges, type PlannerPatch } from '../../shared/contracts';
import type { PlannerClient } from '../../shared/client';
import { usePlanner } from './usePlanner';

afterEach(cleanup);
const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
const success = (): ApiResult<Snapshot> => ({ ok: true, data: structuredClone(snapshot) });
const failure = (message: string, code: ApiError['code'] = 'NETWORK'): ApiResult<never> => ({ ok: false, error: { code, message, retryable: code === 'NETWORK' } });
function fixture() {
  let changed = () => {};
  const read = vi.fn<() => Promise<ApiResult<Snapshot>>>().mockImplementation(async () => success());
  const api = { snapshot: read, onChanged: (listener: () => void) => { changed = listener; return () => {}; } } as unknown as PlannerClient;
  const hook = renderHook(() => usePlanner(api));
  return { ...hook, read, changed: () => changed() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('planner refresh recovery', () => {
  it('applies a confirmed write patch immediately without downloading another snapshot and locks only its target', async () => {
    const state = success(); if (!state.ok) throw Error();
    state.data.cursor = { streamId: '11111111-1111-4111-8111-111111111111', revision: 0 };
    const read = vi.fn(async () => state), changes = vi.fn<() => Promise<ApiResult<PlannerChanges>>>();
    const api = { snapshot: read, changes, onChanged: () => () => {} } as unknown as PlannerClient;
    const f = renderHook(() => usePlanner(api)); await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    const sync: PlannerPatch = { from: state.data.cursor, to: { ...state.data.cursor, revision: 1 }, entities: [], settings: { ...state.data.settings, campus: 'Saved campus' } };
    const write = deferred<ApiResult<string>>(); let pending!: Promise<string | undefined>;
    act(() => { pending = f.result.current.run(() => write.promise, undefined, { targets: ['settings'], label: '正在保存' }); });
    expect(f.result.current.isPending('settings')).toBe(true); expect(f.result.current.isPending('candidate:other')).toBe(false);
    expect(f.result.current.snapshot?.settings.campus).not.toBe('Saved campus');
    await act(async () => { write.resolve({ ok: true, data: 'saved', sync }); await pending; });
    expect(f.result.current.snapshot?.settings.campus).toBe('Saved campus');
    expect(f.result.current.isPending('settings')).toBe(false); expect(read).toHaveBeenCalledOnce(); expect(changes).not.toHaveBeenCalled();
  });

  it.each([1, 2])('uses one post-write snapshot for %i native change notifications and waits for its result', async notifications => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    const write = deferred<ApiResult<string>>(), read = deferred<ApiResult<Snapshot>>();
    f.read.mockReturnValueOnce(read.promise);
    let operation!: Promise<string | undefined>;
    act(() => { operation = f.result.current.run(() => write.promise); });
    act(() => { for (let i = 0; i < notifications; i += 1) f.changed(); });
    expect(f.read).toHaveBeenCalledTimes(1);
    await act(async () => { write.resolve({ ok: true, data: 'confirmed' }); });
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.result.current.busy).toBe(true);
    await act(async () => { read.resolve(success()); expect(await operation).toBe('confirmed'); });
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.result.current.busy).toBe(false);
  });

  it('does not reuse or apply a pre-write snapshot while the post-write read is pending', async () => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    const old = deferred<ApiResult<Snapshot>>(), fresh = deferred<ApiResult<Snapshot>>();
    f.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    act(() => f.changed());
    let operation!: Promise<string | undefined>;
    await act(async () => { operation = f.result.current.run(async () => { f.changed(); return { ok: true, data: 'saved' }; }); });
    expect(f.read).toHaveBeenCalledTimes(3);
    await act(async () => { old.resolve(failure('过时请求断线')); });
    expect(f.result.current.error).toBe('');
    expect(f.result.current.busy).toBe(true);
    await act(async () => { fresh.resolve(success()); await operation; });
    expect(f.result.current.busy).toBe(false);
    expect(f.result.current.error).toBe('');
  });

  it('refreshes a change received during the post-write read without extending the confirmed action', async () => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    const postWrite = deferred<ApiResult<Snapshot>>(), followup = deferred<ApiResult<Snapshot>>();
    f.read.mockReturnValueOnce(postWrite.promise).mockReturnValueOnce(followup.promise);
    let operation!: Promise<string | undefined>;
    await act(async () => { operation = f.result.current.run(async () => ({ ok: true, data: 'saved' })); });
    act(() => { f.changed(); f.changed(); });
    expect(f.read).toHaveBeenCalledTimes(2);
    await act(async () => { postWrite.resolve(success()); expect(await operation).toBe('saved'); });
    expect(f.read).toHaveBeenCalledTimes(3);
    expect(f.result.current.busy).toBe(false);
    const latest = success();
    if (latest.ok) latest.data.settings.model = 'synthetic-new-model';
    await act(async () => { followup.resolve(latest); });
    expect(f.result.current.snapshot?.settings.model).toBe('synthetic-new-model');
  });

  it('keeps a failed action error while processing changes deferred during that action', async () => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    await act(async () => {
      await f.result.current.run(async () => { f.changed(); return failure('写入结果未确认'); });
    });
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.result.current.error).toBe('写入结果未确认');
    expect(f.result.current.busy).toBe(false);
  });

  it('keeps the action controls busy until every active operation has finished refreshing', async () => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    const first = deferred<ApiResult<string>>(), second = deferred<ApiResult<string>>();
    let firstOperation!: Promise<string | undefined>, secondOperation!: Promise<string | undefined>;
    act(() => {
      firstOperation = f.result.current.run(() => first.promise);
      secondOperation = f.result.current.run(() => second.promise);
    });
    await act(async () => { first.resolve({ ok: true, data: 'first' }); await firstOperation; });
    expect(f.result.current.busy).toBe(true);
    await act(async () => { second.resolve({ ok: true, data: 'second' }); await secondOperation; });
    expect(f.result.current.busy).toBe(false);
  });

  it.each(['response', 'throw'] as const)('clears a %s read failure after the next background refresh succeeds', async mode => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    if (mode === 'response') f.read.mockResolvedValueOnce(failure('资料读取未完成'));
    else f.read.mockRejectedValueOnce(new Error('资料读取未完成'));
    await act(async () => { f.changed(); });
    expect(f.result.current.error).toBe('资料读取未完成');
    expect(f.result.current.errorCode).toBe('NETWORK');
    expect(f.result.current.snapshot).not.toBeNull();
    await act(async () => { f.changed(); });
    expect(f.result.current.error).toBe('');
    expect(f.result.current.errorCode).toBeNull();
  });

  it.each(['NETWORK', 'VALIDATION'] as const)('preserves an action %s error through both failed and recovered background reads', async code => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    const message = code === 'NETWORK' ? '写入结果尚未确认，请核对原操作' : '请补充项目名称';
    const save = vi.fn(async () => failure(message, code));
    await act(async () => { await f.result.current.run(save); });
    f.read.mockResolvedValueOnce(failure('后台读取失败'));
    await act(async () => { f.changed(); });
    expect(f.result.current.error).toBe(message);
    await act(async () => { f.changed(); });
    expect(f.result.current.error).toBe(message);
    expect(f.result.current.errorCode).toBe(code);
    expect(save).toHaveBeenCalledTimes(1);
    act(() => f.result.current.setError(''));
    expect(f.result.current.errorCode).toBeNull();
  });

  it('keeps a confirmed save successful when refresh fails, then clears only the refresh warning', async () => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    f.read.mockResolvedValueOnce(failure('资料读取未完成'));
    const receipt = { message: '已保存', id: 'synthetic-receipt' };
    const save = vi.fn(async () => ({ ok: true as const, data: receipt }));
    let result: typeof receipt | undefined;
    await act(async () => { result = await f.result.current.run(save, value => f.result.current.setNotice(value.message)); });
    expect(result).toEqual(receipt);
    expect(f.result.current.error).toContain('已收到处理结果');
    expect(f.result.current.notice).toBe('已保存');
    await act(async () => { f.changed(); });
    expect(f.result.current.error).toBe('');
    expect(f.result.current.notice).toBe('已保存');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not let an older failed read resurrect the banner after a newer successful read', async () => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    const old = deferred<ApiResult<Snapshot>>();
    f.read.mockReturnValueOnce(old.promise);
    act(() => f.changed());
    await act(async () => { f.changed(); });
    await act(async () => { old.resolve(failure('过时请求断线')); });
    expect(f.result.current.error).toBe('');
  });

  it('does not let an older successful read hide a newer read failure', async () => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    const old = deferred<ApiResult<Snapshot>>();
    f.read.mockReturnValueOnce(old.promise).mockResolvedValueOnce(failure('最新请求断线'));
    act(() => f.changed());
    await act(async () => { f.changed(); });
    await act(async () => { old.resolve(success()); });
    expect(f.result.current.error).toBe('最新请求断线');
  });

  it('still reports a failed read while the next automatic read remains in flight', async () => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.snapshot).not.toBeNull());
    const old = deferred<ApiResult<Snapshot>>(), next = deferred<ApiResult<Snapshot>>();
    f.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    act(() => { f.changed(); f.changed(); });
    await act(async () => { old.resolve(failure('资料读取未完成')); });
    expect(f.result.current.error).toBe('资料读取未完成');
    await act(async () => { next.resolve(success()); });
    expect(f.result.current.error).toBe('');
  });
});
