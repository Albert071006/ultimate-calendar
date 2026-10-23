// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApiResult, DesktopAPI } from '../shared/contracts';
import { SnapshotSchema } from '../shared/contracts';
import type { UpdateState } from '../shared/update';
import { SoftwareUpdate } from './components/SoftwareUpdate';
import { useAppUpdates } from './hooks/useAppUpdates';
import { App } from './App';

afterEach(cleanup);

function updateState(patch: Partial<UpdateState> = {}): UpdateState {
  return { currentVersion: '0.3.3', status: 'idle', latestVersion: null, releaseNotes: '', progressPercent: null,
    checkedAt: null, message: '尚未检查更新', ...patch };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial = updateState()) {
  let listener: ((state: UpdateState) => void) | undefined;
  const unsubscribe = vi.fn();
  const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [],
    courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
  const updateSnapshot = vi.fn<() => Promise<ApiResult<UpdateState>>>(async () => ({ ok: true, data: initial }));
  const checkForUpdates = vi.fn<() => Promise<ApiResult<UpdateState>>>(async () => ({ ok: true, data: updateState({ message: '已是最新版本', checkedAt: '2026-10-23T12:00:00+08:00' }) }));
  const downloadUpdate = vi.fn<() => Promise<ApiResult<UpdateState>>>(async () => ({ ok: true, data: updateState({ status: 'downloaded', latestVersion: '0.3.4', message: '下载完成，可重启安装' }) }));
  const installUpdate = vi.fn<() => Promise<ApiResult<UpdateState>>>(async () => ({ ok: true, data: updateState({ status: 'installing', message: '正在安装更新' }) }));
  const api = { snapshot: async () => ({ ok: true, data: structuredClone(snapshot) }), onChanged: () => () => {}, onNavigate: () => () => {},
    updateSnapshot, checkForUpdates, downloadUpdate, installUpdate, onUpdateChanged: (next: (state: UpdateState) => void) => { listener = next; return unsubscribe; },
  } as unknown as DesktopAPI;
  function Harness({ busy = false }: { busy?: boolean }) { return <SoftwareUpdate updates={useAppUpdates(api)} plannerBusy={busy} />; }
  return { api, Harness, updateSnapshot, checkForUpdates, downloadUpdate, installUpdate, unsubscribe, emit: (state: UpdateState) => act(() => listener?.(state)) };
}

describe('software updates', () => {
  it('explains unavailable isolated builds and tolerates older desktop bridges without update methods', async () => {
    const f = fixture(updateState({ status: 'unavailable', message: '隔离资料环境不检查或安装更新' }));
    const view = render(<f.Harness />);
    expect(await screen.findByText('隔离资料环境不检查或安装更新')).toBeTruthy();
    expect((screen.getByRole('button', { name: '检查更新' }) as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
    function OldBridge() { return <SoftwareUpdate updates={useAppUpdates({} as DesktopAPI)} />; }
    render(<OldBridge />);
    expect(screen.getByText('当前环境未接入软件更新，请使用安装版查看。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '检查更新' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('checks once, displays the result and does not silently download it', async () => {
    const f = fixture(), request = deferred<ApiResult<UpdateState>>();
    f.checkForUpdates.mockReturnValueOnce(request.promise);
    render(<f.Harness />);
    await screen.findByText('终极日历 · v0.3.3');
    const check = screen.getByRole('button', { name: '检查更新' });
    fireEvent.click(check); fireEvent.click(check);
    expect(f.checkForUpdates).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: '正在检查…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => request.resolve({ ok: true, data: updateState({ status: 'available', latestVersion: '0.3.4',
      releaseNotes: '改善时间安排\n修复重复提醒', message: '发现新版本', checkedAt: '2026-10-23T12:00:00+08:00' }) }));
    expect(screen.getByRole('button', { name: '下载 v0.3.4' })).toBeTruthy();
    expect(screen.getByText(/上次检查：2026-10-23 12:00/)).toBeTruthy();
    expect((screen.getByText('更新说明 · v0.3.4').parentElement as HTMLDetailsElement).open).toBe(false);
    expect(f.downloadUpdate).not.toHaveBeenCalled();
    expect(f.installUpdate).not.toHaveBeenCalled();
  });

  it('shows download progress and keeps newer events instead of a late action result', async () => {
    const f = fixture(updateState({ status: 'available', latestVersion: '0.3.4', message: '发现新版本' }));
    const request = deferred<ApiResult<UpdateState>>(); f.downloadUpdate.mockReturnValueOnce(request.promise);
    render(<f.Harness />);
    fireEvent.click(await screen.findByRole('button', { name: '下载 v0.3.4' }));
    f.emit(updateState({ status: 'downloading', latestVersion: '0.3.4', message: '正在下载', progressPercent: 42 }));
    expect(screen.getByRole('progressbar', { name: '更新下载进度' }).getAttribute('value')).toBe('42');
    expect((screen.getByRole('button', { name: '检查更新' }) as HTMLButtonElement).disabled).toBe(true);
    f.emit(updateState({ status: 'downloaded', latestVersion: '0.3.4', message: '下载完成，可重启安装' }));
    await act(async () => request.resolve({ ok: true, data: updateState({ status: 'downloading', message: '较早的下载状态' }) }));
    expect(screen.getByText('下载完成，可重启安装')).toBeTruthy();
    expect(screen.queryByText('较早的下载状态')).toBeNull();
    expect((screen.getByRole('button', { name: '重启并安装' }) as HTMLButtonElement).disabled).toBe(false);
    expect(f.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps an in-progress edit and exposes an update entry without automatically opening another dialog', async () => {
    const f = fixture(); render(<App api={f.api} />);
    fireEvent.click(await screen.findByRole('button', { name: '＋ 新建任务' }));
    const editor = screen.getByRole('dialog', { name: '新建任务' });
    const field = within(editor).getByLabelText('名称') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '未保存的安排草稿' } });
    f.emit(updateState({ status: 'available', latestVersion: '0.3.4', message: '发现新版本' }));
    expect(screen.queryByRole('dialog', { name: '软件更新' })).toBeNull();
    expect(field.value).toBe('未保存的安排草稿');
    fireEvent.click(screen.getByRole('button', { name: '新版本 0.3.4' }));
    const dialog = screen.getByRole('dialog', { name: '软件更新' });
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(screen.getByRole('dialog', { name: '新建任务' })).toBe(editor);
    expect(field.value).toBe('未保存的安排草稿');
  });

  it('warns about unsaved drafts before restart and preserves a retry after a failed installation', async () => {
    const f = fixture(updateState({ status: 'downloaded', latestVersion: '0.3.4', message: '下载完成' }));
    f.installUpdate.mockResolvedValueOnce({ ok: false, error: { code: 'STORAGE', message: '备份未完成，请重试', retryable: true } });
    render(<f.Harness />);
    fireEvent.click(await screen.findByRole('button', { name: '重启并安装' }));
    expect(screen.getByText(/未保存内容不会保留/)).toBeTruthy();
    expect(f.installUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回保存' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重启并安装' }));
    fireEvent.click(screen.getByRole('button', { name: '已保存，重启安装' }));
    await waitFor(() => expect(f.installUpdate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole('button', { name: '已保存，重启安装' }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('备份未完成，请重试');
    fireEvent.click(screen.getByRole('button', { name: '已保存，重启安装' }));
    await waitFor(() => expect(f.installUpdate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not install while an application operation is still running', async () => {
    const f = fixture(updateState({ status: 'downloaded', latestVersion: '0.3.4' }));
    render(<f.Harness busy />);
    const button = await screen.findByRole('button', { name: '重启并安装' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(f.installUpdate).not.toHaveBeenCalled();
  });

  it('allows recovery from a download error and treats release notes as text', async () => {
    const f = fixture(updateState({ status: 'error', latestVersion: '0.3.4', message: '连接中断，请重试',
      releaseNotes: '<script>window.fakeReleaseCode = true</script>' }));
    const view = render(<f.Harness />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '连接中断，请重试');
    expect(view.container.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试下载' }));
    expect(await screen.findByRole('button', { name: '重启并安装' })).toBeTruthy();
    expect(f.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale initial snapshot and releases the update subscription on unmount', async () => {
    const f = fixture(), request = deferred<ApiResult<UpdateState>>(); f.updateSnapshot.mockReturnValueOnce(request.promise);
    const view = render(<f.Harness />);
    f.emit(updateState({ status: 'downloaded', latestVersion: '0.3.4', message: '下载完成' }));
    await act(async () => request.resolve({ ok: true, data: updateState({ message: '过时的状态' }) }));
    expect(screen.queryByText('过时的状态')).toBeNull();
    expect(screen.getByRole('button', { name: '重启并安装' })).toBeTruthy();
    view.unmount(); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
