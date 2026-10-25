// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApiResult } from '../shared/contracts';
import type { BusyExportDesktopAPI, BusyExportPreview } from '../shared/busy-context';
import { BusyExportPanel } from './components/BusyExportPanel';

vi.mock('./calendar-layout', async importOriginal => ({ ...await importOriginal<typeof import('./calendar-layout')>(), todayDate: () => '2030-04-17' }));
afterEach(cleanup);

function preview(): BusyExportPreview {
  return { token: 'busy-preview-1', sourceKind: 'cloud', fromDate: '2030-04-17', toDate: '2030-04-23',
    counts: { intervals: 8, courses: 4, work: 3, events: 1 }, warnings: ['合成提醒：仍需核对临时安排'] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const host = {
    busyExportPreview: vi.fn<BusyExportDesktopAPI['busyExportPreview']>(async () => ({ ok: true, data: preview() })),
    busyExportSave: vi.fn<BusyExportDesktopAPI['busyExportSave']>(async () => ({ ok: true, data: { saved: true, filename: 'synthetic.calendar-busy.json' } })),
  };
  const onBusyChange = vi.fn(), onSaved = vi.fn();
  return { host, onBusyChange, onSaved, show: () => render(<BusyExportPanel host={host} onBusyChange={onBusyChange} onSaved={onSaved} />) };
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const input = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

describe('busy time export', () => {
  it('previews seven days with hidden titles without requiring a goal or saving automatically', async () => {
    const f = fixture(); f.show();
    expect(input('忙碌时间开始日期').value).toBe('2030-04-17');
    expect(input('忙碌时间结束日期').value).toBe('2030-04-23');
    expect(input('隐藏日程名称，仅保留忙碌时间').checked).toBe(true);
    expect(f.host.busyExportPreview).not.toHaveBeenCalled();
    expect(button('保存忙碌时间文件').disabled).toBe(true);
    fireEvent.click(button('预览忙碌时间'));
    await screen.findByRole('region', { name: '忙碌时间预览' });
    expect(f.host.busyExportPreview).toHaveBeenCalledExactlyOnceWith({ fromDate: '2030-04-17', toDate: '2030-04-23', includeBusyTitles: false, instructions: '' });
    expect(screen.getByText('忙碌区间').nextElementSibling?.textContent).toBe('8');
    expect(screen.getByText('课程时段').nextElementSibling?.textContent).toBe('4');
    expect(screen.getByText('执行时段').nextElementSibling?.textContent).toBe('3');
    expect(screen.getByText('固定活动').nextElementSibling?.textContent).toBe('1');
    expect(screen.getByText(/云端资料 · 2030-04-17 至 2030-04-23/)).toBeTruthy();
    expect(screen.getByText('合成提醒：仍需核对临时安排')).toBeTruthy();
    expect(f.host.busyExportSave).not.toHaveBeenCalled();
  });

  it('clears the save token when dates, requirements, or title visibility change', async () => {
    const f = fixture(); f.show();
    for (const change of [
      () => fireEvent.change(input('忙碌时间结束日期'), { target: { value: '2030-04-24' } }),
      () => fireEvent.change(input('规划要求（选填）'), { target: { value: '每天学习 45 分钟' } }),
      () => fireEvent.click(input('隐藏日程名称，仅保留忙碌时间')),
    ]) {
      fireEvent.click(button('预览忙碌时间')); await screen.findByRole('region', { name: '忙碌时间预览' });
      change();
      expect(screen.queryByRole('region', { name: '忙碌时间预览' })).toBeNull();
      expect(button('保存忙碌时间文件').disabled).toBe(true);
    }
    fireEvent.click(button('预览忙碌时间')); await screen.findByRole('region', { name: '忙碌时间预览' });
    expect(f.host.busyExportPreview).toHaveBeenLastCalledWith({ fromDate: '2030-04-17', toDate: '2030-04-24', includeBusyTitles: true, instructions: '每天学习 45 分钟' });
    expect(f.host.busyExportSave).not.toHaveBeenCalled();
  });

  it('validates the inclusive 366-day limit before calling the host', async () => {
    const f = fixture(); f.show();
    for (const value of ['', '2030-04-16', '2031-04-18']) {
      fireEvent.change(input('忙碌时间结束日期'), { target: { value } });
      expect(button('预览忙碌时间').disabled).toBe(true);
      fireEvent.click(button('预览忙碌时间'));
    }
    expect(f.host.busyExportPreview).not.toHaveBeenCalled();
    fireEvent.change(input('忙碌时间结束日期'), { target: { value: '2031-04-17' } });
    fireEvent.click(button('预览忙碌时间')); await screen.findByRole('region', { name: '忙碌时间预览' });
    expect(f.host.busyExportPreview).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate requests and parameter changes, then preserves a canceled native save for retry', async () => {
    const f = fixture(), pendingPreview = deferred<ApiResult<BusyExportPreview>>(), pendingSave = deferred<Awaited<ReturnType<BusyExportDesktopAPI['busyExportSave']>>>();
    f.host.busyExportPreview.mockReturnValueOnce(pendingPreview.promise); f.host.busyExportSave.mockReturnValueOnce(pendingSave.promise); f.show();
    fireEvent.click(button('预览忙碌时间')); fireEvent.click(button('正在预览忙碌时间…'));
    expect(f.host.busyExportPreview).toHaveBeenCalledTimes(1);
    expect(f.onBusyChange).toHaveBeenLastCalledWith(true);
    expect(input('忙碌时间开始日期').disabled).toBe(true);
    fireEvent.change(input('规划要求（选填）'), { target: { value: '读取时不能修改' } });
    expect(input('规划要求（选填）').value).toBe('');
    await act(async () => pendingPreview.resolve({ ok: true, data: preview() }));
    fireEvent.click(button('保存忙碌时间文件')); fireEvent.click(button('正在保存忙碌时间…'));
    expect(f.host.busyExportSave).toHaveBeenCalledExactlyOnceWith({ token: 'busy-preview-1' });
    expect(input('隐藏日程名称，仅保留忙碌时间').disabled).toBe(true);
    await act(async () => pendingSave.resolve({ ok: true, data: { saved: false } }));
    expect(screen.getByRole('status').textContent).toBe('已取消保存，可继续使用当前预览。');
    expect(f.onSaved).not.toHaveBeenCalled();
    expect(f.onBusyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(button('保存忙碌时间文件'));
    await waitFor(() => expect(f.onSaved).toHaveBeenCalledWith('已保存忙碌时间：synthetic.calendar-busy.json'));
    expect(f.host.busyExportSave).toHaveBeenCalledTimes(2);
    expect(button('保存忙碌时间文件').disabled).toBe(true);
  });

  it('clears stale previews on host failures and releases the parent busy lock', async () => {
    const f = fixture(); f.host.busyExportSave.mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: '资料已变化，请重新预览', retryable: true } }); f.show();
    fireEvent.click(button('预览忙碌时间')); await screen.findByRole('region', { name: '忙碌时间预览' });
    fireEvent.click(button('保存忙碌时间文件'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '资料已变化，请重新预览');
    expect(button('保存忙碌时间文件').disabled).toBe(true);
    expect(screen.queryByRole('region', { name: '忙碌时间预览' })).toBeNull();
    f.host.busyExportPreview.mockRejectedValueOnce(new Error('连接中断'));
    fireEvent.click(button('预览忙碌时间'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('连接中断'));
    expect(f.onBusyChange).toHaveBeenLastCalledWith(false);
    expect(f.onSaved).not.toHaveBeenCalled();
  });
});
