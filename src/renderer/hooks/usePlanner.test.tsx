// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnapshotSchema, type ApiError, type ApiResult, type Snapshot } from '../../shared/contracts';
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
