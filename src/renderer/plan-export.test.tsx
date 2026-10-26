// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GoalSchema, SnapshotSchema, type ApiResult, type DesktopAPI } from '../shared/contracts';
import type { PlanExportDesktopAPI, PlanExportPreview, PlanExportRequest } from '../shared/plan-context';
import type { PlannerUI } from './hooks/usePlanner';
import { PlanExportDialog } from './components/PlanExportDialog';
import { DetailPopover } from './components/detail/DetailPopover';
import { Goals } from './pages/me/Goals';
import { MobileProvider } from './mobile/layout';
import { App } from './App';

vi.mock('./calendar-layout', async importOriginal => ({ ...await importOriginal<typeof import('./calendar-layout')>(), todayDate: () => '2030-04-17' }));
afterEach(cleanup);

const goal = { id: 'synthetic-goal', title: '合成学习目标' };
function preview(patch: Partial<PlanExportPreview> = {}): PlanExportPreview {
  return { token: 'export-preview-1', title: goal.title, sourceKind: 'cloud', fromDate: '2030-04-17', toDate: '2030-04-23',
    counts: { tasks: 6, completedTasks: 2, blocks: 2, resources: 3, busyIntervals: 8 }, warnings: [], ...patch };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial = preview()) {
  const host = {
    planExportPreview: vi.fn<(request: PlanExportRequest) => Promise<ApiResult<PlanExportPreview>>>(async () => ({ ok: true, data: initial })),
    planExportSave: vi.fn<PlanExportDesktopAPI['planExportSave']>(async () => ({ ok: true, data: { saved: true, filename: 'synthetic-goal.calendar-context.json' } })),
  };
  const onClose = vi.fn(), onSaved = vi.fn();
  return { host, onClose, onSaved, show: () => render(<PlanExportDialog host={host} goal={goal} onClose={onClose} onSaved={onSaved} />) };
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const input = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
function snapshot() {
  return SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [],
    goals: [GoalSchema.parse({ ...goal, version: 1, createdAt: '2030-04-17T09:00:00+08:00', updatedAt: '2030-04-17T09:00:00+08:00' })],
    courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
}

describe('goal context export', () => {
  it('defaults to seven days with hidden busy titles and previews only after an explicit action', async () => {
    const f = fixture(); f.show();
    expect(input('规划开始日期').value).toBe('2030-04-17');
    expect(input('规划结束日期').value).toBe('2030-04-23');
    expect(input('隐藏其他日程名称，仅提供忙碌时间').checked).toBe(true);
    expect(f.host.planExportPreview).not.toHaveBeenCalled();
    expect(button('保存上下文文件').disabled).toBe(true);
    fireEvent.click(button('预览导出内容'));
    const content = await screen.findByRole('region', { name: '导出内容预览' });
    expect(f.host.planExportPreview).toHaveBeenCalledExactlyOnceWith({ goalId: goal.id, fromDate: '2030-04-17', toDate: '2030-04-23', includeBusyTitles: false, instructions: '' });
    expect(within(content).getByText('云端资料')).toBeTruthy();
    expect(within(content).getByText('关联任务').nextElementSibling?.textContent).toBe('6');
    expect(within(content).getByText('已完成任务').nextElementSibling?.textContent).toBe('2');
    expect(within(content).getByText('已有时段').nextElementSibling?.textContent).toBe('2');
    expect(within(content).getByText('忙碌区间').nextElementSibling?.textContent).toBe('8');
    expect(within(content).getByText('资料引用').nextElementSibling?.textContent).toBe('3');
    expect(screen.getByText(/不会上传给外部智能体，也不会调用 AI/)).toBeTruthy();
    expect(f.host.planExportSave).not.toHaveBeenCalled();
    fireEvent.click(button('取消'));
    expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(f.host.planExportSave).not.toHaveBeenCalled();
  });

  it('invalidates a preview whenever dates, instructions, or title privacy change', async () => {
    const f = fixture(); f.show();
    for (const change of [
      () => fireEvent.change(input('规划结束日期'), { target: { value: '2030-04-24' } }),
      () => fireEvent.change(input('续排要求（选填）'), { target: { value: '只补充四个学习时段' } }),
      () => fireEvent.click(input('隐藏其他日程名称，仅提供忙碌时间')),
    ]) {
      fireEvent.click(button('预览导出内容')); await screen.findByRole('region', { name: '导出内容预览' });
      change();
      expect(screen.queryByRole('region', { name: '导出内容预览' })).toBeNull();
      expect(button('保存上下文文件').disabled).toBe(true);
    }
    fireEvent.click(button('预览导出内容')); await screen.findByRole('region', { name: '导出内容预览' });
    expect(f.host.planExportPreview).toHaveBeenLastCalledWith({ goalId: goal.id, fromDate: '2030-04-17', toDate: '2030-04-24', includeBusyTitles: true, instructions: '只补充四个学习时段' });
    expect(f.host.planExportSave).not.toHaveBeenCalled();
  });

  it('rejects an empty, reversed, or longer than 366-day range and accepts the inclusive maximum', async () => {
    const f = fixture(); f.show();
    for (const value of ['', '2030-04-16', '2031-04-18']) {
      fireEvent.change(input('规划结束日期'), { target: { value } });
      expect(button('预览导出内容').disabled).toBe(true);
      fireEvent.click(button('预览导出内容'));
    }
    expect(f.host.planExportPreview).not.toHaveBeenCalled();
    fireEvent.change(input('规划结束日期'), { target: { value: '2031-04-17' } });
    expect(button('预览导出内容').disabled).toBe(false);
    fireEvent.click(button('预览导出内容')); await screen.findByRole('region', { name: '导出内容预览' });
    expect(f.host.planExportPreview).toHaveBeenCalledTimes(1);
  });

  it('locks parameters, close actions, and duplicate requests while previewing or saving', async () => {
    const f = fixture(), pendingPreview = deferred<ApiResult<PlanExportPreview>>(), pendingSave = deferred<Awaited<ReturnType<PlanExportDesktopAPI['planExportSave']>>>();
    f.host.planExportPreview.mockReturnValueOnce(pendingPreview.promise); f.host.planExportSave.mockReturnValueOnce(pendingSave.promise); f.show();
    fireEvent.click(button('预览导出内容')); fireEvent.click(button('正在预览…'));
    expect(f.host.planExportPreview).toHaveBeenCalledTimes(1);
    expect(input('规划开始日期').disabled).toBe(true);
    expect(input('续排要求（选填）').disabled).toBe(true);
    expect(input('隐藏其他日程名称，仅提供忙碌时间').disabled).toBe(true);
    fireEvent.change(input('续排要求（选填）'), { target: { value: '不可在读取时更改' } });
    expect(input('续排要求（选填）').value).toBe('');
    fireEvent.click(button('关闭')); fireEvent.keyDown(document, { key: 'Escape' }); fireEvent.mouseDown(document.querySelector('.modal-backdrop')!);
    expect(f.onClose).not.toHaveBeenCalled();
    await act(async () => pendingPreview.resolve({ ok: true, data: preview() }));
    fireEvent.click(button('保存上下文文件')); fireEvent.click(button('正在保存…'));
    expect(f.host.planExportSave).toHaveBeenCalledExactlyOnceWith({ token: 'export-preview-1' });
    expect(button('关闭').disabled).toBe(true);
    expect(input('规划结束日期').disabled).toBe(true);
    fireEvent.click(button('取消')); fireEvent.keyDown(document, { key: 'Escape' });
    expect(f.onClose).not.toHaveBeenCalled();
    await act(async () => pendingSave.resolve({ ok: true, data: { saved: true, filename: 'synthetic.calendar-context.json' } }));
    expect(screen.getByRole('status').textContent).toBe('已保存上下文文件：synthetic.calendar-context.json');
    expect(f.onSaved).toHaveBeenCalledWith('已保存上下文文件：synthetic.calendar-context.json');
    expect(button('保存上下文文件').disabled).toBe(true);
  });

  it('allows retry after canceling the native save dialog without reporting a saved file', async () => {
    const f = fixture(preview({ sourceKind: 'local' }));
    f.host.planExportSave.mockResolvedValueOnce({ ok: true, data: { saved: false } }); f.show();
    fireEvent.click(button('预览导出内容')); await screen.findByText('本机资料');
    fireEvent.click(button('保存上下文文件'));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '已取消保存，未生成上下文文件。');
    expect(f.onSaved).not.toHaveBeenCalled();
    expect(button('保存上下文文件').disabled).toBe(false);
    fireEvent.click(button('保存上下文文件'));
    await waitFor(() => expect(f.onSaved).toHaveBeenCalledTimes(1));
    expect(f.host.planExportSave).toHaveBeenCalledTimes(2);
  });

  it('requires another preview after stale data or save failures', async () => {
    const f = fixture(preview({ warnings: ['尚有未安排任务'] }));
    f.host.planExportSave.mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: '资料已变化，请重新预览', retryable: true } }); f.show();
    fireEvent.click(button('预览导出内容')); await screen.findByText('尚有未安排任务');
    fireEvent.click(button('保存上下文文件'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '资料已变化，请重新预览');
    expect(button('保存上下文文件').disabled).toBe(true);
    expect(screen.queryByRole('region', { name: '导出内容预览' })).toBeNull();
    expect(f.onSaved).not.toHaveBeenCalled();
    f.host.planExportPreview.mockResolvedValueOnce({ ok: false, error: { code: 'NETWORK', message: '连接失败，请重试', retryable: true } });
    fireEvent.click(button('预览导出内容'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('连接失败，请重试'));
    expect(f.host.planExportSave).toHaveBeenCalledTimes(1);
  });

  it('opens from the goal list and detail card without mutating data or tying the dialog to the popover', async () => {
    const f = fixture(), mutate = vi.fn(), snapshotRead = vi.fn(async () => ({ ok: true, data: snapshot() }));
    const api = { ...f.host, snapshot: snapshotRead, mutate, onChanged: () => () => {}, onNavigate: () => () => {} } as unknown as DesktopAPI;
    render(<App api={api} />);
    fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '我的' }));
    const goals = await screen.findByRole('region', { name: '目标' });
    fireEvent.click(within(goals).getByRole('button', { name: '导出给外部智能体' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '导出给外部智能体' })).getByRole('button', { name: '关闭' }));
    fireEvent.click(within(goals).getByRole('button', { name: goal.title }));
    fireEvent.click(within(screen.getByLabelText('目标详情')).getByRole('button', { name: '导出给外部智能体' }));
    expect(screen.queryByLabelText('目标详情')).toBeNull();
    fireEvent.mouseDown(input('续排要求（选填）'));
    expect(screen.getByRole('dialog', { name: '导出给外部智能体' })).toBeTruthy();
    fireEvent.click(button('预览导出内容')); await screen.findByRole('region', { name: '导出内容预览' });
    fireEvent.click(button('保存上下文文件')); await within(screen.getByRole('dialog', { name: '导出给外部智能体' })).findByRole('status');
    expect(snapshotRead).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('hides unavailable desktop capabilities and all phone export buttons', async () => {
    const base = { snapshot: async () => ({ ok: true, data: snapshot() }), onChanged: () => () => {}, onNavigate: () => () => {} };
    const older = render(<App api={base as unknown as DesktopAPI} />);
    fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '我的' }));
    await screen.findByRole('region', { name: '目标' });
    expect(screen.queryByRole('button', { name: '导出给外部智能体' })).toBeNull();
    older.unmount();
    const ui = { busy: false } as PlannerUI, exportGoal = vi.fn();
    render(<MobileProvider mobile><Goals snapshot={snapshot()} ui={ui} select={vi.fn()} create={vi.fn()} exportGoal={exportGoal} />
      <DetailPopover snapshot={snapshot()} selection={{ entity: 'goal', id: goal.id }} ui={ui} close={vi.fn()} actions={{ edit: vi.fn(), editTask: vi.fn(), schedule: vi.fn(), removeTask: vi.fn(), exportGoal }} /></MobileProvider>);
    expect(screen.queryByRole('button', { name: '导出给外部智能体' })).toBeNull();
  });
});
