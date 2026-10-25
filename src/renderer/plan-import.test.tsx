// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ApiResult, DesktopAPI } from '../shared/contracts';
import { SnapshotSchema } from '../shared/contracts';
import type { PlanImportPreview, PlanImportResult } from '../shared/plan-import';
import { PlanImportDialog } from './components/PlanImportDialog';
import { App } from './App';

afterEach(cleanup);

function preview(patch: Partial<PlanImportPreview> = {}): PlanImportPreview {
  return { token: 'preview-1', planId: 'study-week-1', title: '一周学习计划', expiresAt: '2026-11-01T20:00:00+08:00',
    rows: [
      { kind: 'goal', localId: 'goal-1', title: '掌握基础知识', state: 'existing', detail: '已存在，不会重复创建' },
      { kind: 'task', localId: 'task-1', title: '阅读第一章', state: 'new', detail: '目标：掌握基础知识 · 截止：2026-11-04 21:00' },
      { kind: 'block', localId: 'block-1', title: '第一章学习时段', state: 'new', detail: '任务：阅读第一章 · 资料：课程笔记', start: '2026-11-02T19:00:00+08:00', end: '2026-11-02T20:00:00+08:00' },
    ], conflicts: [], warnings: [], resources: [{ id: 'notes', kind: 'web', name: '课程笔记', url: 'https://example.com/course' }], ...patch };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial = preview()) {
  const host = {
    planImportOpen: vi.fn<() => Promise<ApiResult<PlanImportPreview | null>>>(async () => ({ ok: true, data: initial })),
    planImportConfirm: vi.fn<(request: { token: string; allowConflicts?: boolean }) => Promise<ApiResult<PlanImportResult>>>(async () => ({ ok: true, data: { status: 'complete', message: '计划已导入', applied: 2, remaining: 0 } })),
    planImportTemplate: vi.fn(async () => ({ ok: true as const, data: { saved: true } })),
  };
  const ui = { refresh: vi.fn(async () => {}), setNotice: vi.fn() }, onClose = vi.fn();
  const show = () => render(<PlanImportDialog host={host} ui={ui} onClose={onClose} />);
  return { host, ui, onClose, show };
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('JSON plan import', () => {
  it('opens a preview without writing, displays associations and resources, and cancels without writing', async () => {
    const f = fixture(); f.show();
    fireEvent.click(button('选择 JSON 文件'));
    expect(await screen.findByText('一周学习计划')).toBeTruthy();
    expect(screen.getByText('目标：掌握基础知识 · 截止：2026-11-04 21:00')).toBeTruthy();
    expect(screen.getByText(/开始：2026\/11\/02 19:00/)).toBeTruthy();
    expect(screen.getByText('https://example.com/course')).toBeTruthy();
    expect(screen.getByLabelText('条目统计').textContent).toBe('待新增 2已存在 1需处理 0');
    expect(f.host.planImportConfirm).not.toHaveBeenCalled();
    fireEvent.click(button('取消'));
    expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(f.host.planImportConfirm).not.toHaveBeenCalled();
  });

  it('keeps a canceled picker harmless and saves a template without importing', async () => {
    const f = fixture(); f.host.planImportOpen.mockResolvedValueOnce({ ok: true, data: null }); f.show();
    fireEvent.click(button('选择 JSON 文件'));
    await waitFor(() => expect(button('选择 JSON 文件').disabled).toBe(false));
    expect(screen.getByText('还未选择计划文件')).toBeTruthy();
    expect(button('确认批量导入').disabled).toBe(true);
    fireEvent.click(button('保存示例文件'));
    expect(await screen.findByText('示例 JSON 已保存，可交给外部智能体按相同格式生成计划。')).toBeTruthy();
    expect(f.host.planImportTemplate).toHaveBeenCalledTimes(1);
    expect(f.host.planImportConfirm).not.toHaveBeenCalled();
  });

  it('requires acknowledging conflicts and blocks closing, replacing files, and duplicate submission while writing', async () => {
    const f = fixture(preview({ conflicts: ['学习时段与已有课程重叠'] })), request = deferred<ApiResult<PlanImportResult>>();
    f.host.planImportConfirm.mockReturnValueOnce(request.promise); f.show();
    fireEvent.click(button('选择 JSON 文件')); await screen.findByText('一周学习计划');
    expect(button('确认批量导入').disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: '我已核对以上时间冲突，仍按文件导入' }));
    fireEvent.click(button('确认批量导入'));
    fireEvent.click(button('正在导入，请稍候…'));
    expect(f.host.planImportConfirm).toHaveBeenCalledExactlyOnceWith({ token: 'preview-1', allowConflicts: true });
    expect(button('关闭').disabled).toBe(true);
    expect(button('重新选择 JSON 文件').disabled).toBe(true);
    expect(button('保存示例文件').disabled).toBe(true);
    fireEvent.click(button('关闭')); fireEvent.click(button('取消'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.querySelector('.modal-backdrop')!);
    expect(f.onClose).not.toHaveBeenCalled();
    await act(async () => request.resolve({ ok: true, data: { status: 'complete', message: '计划已导入', applied: 2, remaining: 0 } }));
    expect(f.ui.refresh).toHaveBeenCalledTimes(1);
    expect(f.ui.setNotice).toHaveBeenCalledWith('计划已导入');
    expect(f.onClose).toHaveBeenCalledTimes(1);
  });

  it('never confirms a blocked plan or an entirely existing plan', async () => {
    const f = fixture(preview({ rows: [{ kind: 'task', localId: 'task-1', title: '阅读第一章', state: 'blocked', detail: '关联目标不存在' }] }));
    f.show(); fireEvent.click(button('选择 JSON 文件'));
    expect(await screen.findByText('关联目标不存在')).toBeTruthy();
    expect(button('确认批量导入').disabled).toBe(true);
    fireEvent.click(button('确认批量导入'));
    f.host.planImportOpen.mockResolvedValueOnce({ ok: true, data: preview({ rows: [{ kind: 'task', localId: 'task-1', title: '阅读第一章', state: 'existing', detail: '已保存' }] }) });
    fireEvent.click(button('重新选择 JSON 文件'));
    expect(await screen.findByText('这些条目已全部存在，无需再次导入。')).toBeTruthy();
    expect(button('确认批量导入').disabled).toBe(true);
    expect(f.host.planImportConfirm).not.toHaveBeenCalled();
  });

  it('verifies a previously saved operation despite blocked rows and conflicts without authorizing new conflict writes', async () => {
    const f = fixture(preview({ token: 'pending-operation-preview', canVerifyPending: true,
      rows: [{ kind: 'block', localId: 'block-1', title: '第一章学习时段', state: 'blocked', detail: '后续资料已变化，先核对上次保存结果' }],
      conflicts: ['学习时段与已有课程重叠'] }));
    const request = deferred<ApiResult<PlanImportResult>>(); f.host.planImportConfirm.mockReturnValueOnce(request.promise);
    f.show(); fireEvent.click(button('选择 JSON 文件')); await screen.findByText('一周学习计划');
    expect(screen.getByText('只核对上次已保存的结果，不继续新增；之后重新导出最新计划。')).toBeTruthy();
    expect(screen.queryByText(/暂时无法导入/)).toBeNull();
    const acknowledgement = screen.getByRole('checkbox') as HTMLInputElement;
    expect(acknowledgement.disabled).toBe(true); expect(acknowledgement.checked).toBe(false);
    expect(button('仅核对已保存操作').disabled).toBe(false);
    fireEvent.click(acknowledgement); fireEvent.click(button('仅核对已保存操作'));
    expect(f.host.planImportConfirm).toHaveBeenCalledExactlyOnceWith({ token: 'pending-operation-preview', allowConflicts: false });
    expect(button('正在核对，请稍候…').disabled).toBe(true);
    await act(async () => request.resolve({ ok: true, data: { status: 'partial', message: '已核对，请重新导出最新计划', applied: 1, remaining: 1,
      preview: preview({ canVerifyPending: false, rows: [{ kind: 'block', localId: 'block-2', title: '后续学习时段', state: 'blocked', detail: '请重新导出' }] }) } }));
    expect(screen.queryByRole('button', { name: '仅核对已保存操作' })).toBeNull();
    expect(button('继续导入未完成条目').disabled).toBe(true);
    expect(f.ui.refresh).toHaveBeenCalledTimes(1);
  });

  it('presents partial verification as verification instead of continuing new imports', async () => {
    const f = fixture(preview({ conflicts: ['学习时段与已有课程重叠'] }));
    f.host.planImportConfirm.mockResolvedValueOnce({ ok: true, data: { status: 'partial', message: '上次保存结果待核对', applied: 1, remaining: 1,
      preview: preview({ token: 'verify-partial', canVerifyPending: true, rows: [{ kind: 'task', localId: 'task-1', title: '阅读第一章', state: 'existing', detail: '已保存，待核对' }], conflicts: ['资料已变化'] }) } });
    f.show(); fireEvent.click(button('选择 JSON 文件')); await screen.findByText('一周学习计划');
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(button('确认批量导入'));
    await screen.findByText('请先核对上次已保存的结果。');
    expect(screen.queryByText('请核对最新预览，再继续导入未完成的条目。')).toBeNull();
    expect(screen.queryByText('这些条目已全部存在，无需再次导入。')).toBeNull();
    await waitFor(() => expect(button('仅核对已保存操作').disabled).toBe(false));
    fireEvent.click(button('仅核对已保存操作'));
    expect(f.host.planImportConfirm).toHaveBeenLastCalledWith({ token: 'verify-partial', allowConflicts: false });
    await waitFor(() => expect(f.onClose).toHaveBeenCalledTimes(1));
  });

  it('uses a new partial-result preview for continuation and requires renewed conflict acknowledgement', async () => {
    const initial = preview({ conflicts: ['学习时段与已有课程重叠'] });
    const f = fixture(initial);
    f.host.planImportConfirm.mockResolvedValueOnce({ ok: true, data: { status: 'partial', message: '连接中断，部分条目已保存', applied: 1, remaining: 1,
      preview: preview({ token: 'preview-2', rows: initial.rows.map(row => row.kind === 'task' ? { ...row, state: 'existing' } : row), conflicts: initial.conflicts }) } });
    f.show(); fireEvent.click(button('选择 JSON 文件')); await screen.findByText('一周学习计划');
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(button('确认批量导入'));
    expect(await screen.findByText('已保存 1 条 · 未完成 1 条')).toBeTruthy();
    await waitFor(() => expect(button('关闭').disabled).toBe(false));
    expect(f.onClose).not.toHaveBeenCalled();
    expect(button('继续导入未完成条目').disabled).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(button('继续导入未完成条目'));
    await waitFor(() => expect(f.onClose).toHaveBeenCalledTimes(1));
    expect(f.host.planImportConfirm).toHaveBeenLastCalledWith({ token: 'preview-2', allowConflicts: true });
    expect(f.ui.refresh).toHaveBeenCalledTimes(2);
  });

  it('requires reselecting the original file when partial success has no fresh preview', async () => {
    const f = fixture();
    f.host.planImportConfirm.mockResolvedValueOnce({ ok: true, data: { status: 'partial', message: '无法重新读取资料', applied: 1, remaining: 1 } });
    f.show(); fireEvent.click(button('选择 JSON 文件')); await screen.findByText('一周学习计划');
    fireEvent.click(button('确认批量导入'));
    expect(await screen.findByText('请重新选择同一份原始 JSON 文件，核对预览后继续。')).toBeTruthy();
    expect(button('确认批量导入').disabled).toBe(true);
    await waitFor(() => expect(button('选择 JSON 文件').disabled).toBe(false));
    fireEvent.click(button('选择 JSON 文件')); await screen.findByText('一周学习计划');
    expect(screen.queryByLabelText('导入进度')).toBeNull();
    expect(f.host.planImportConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows API failures without treating them as a successful import', async () => {
    const f = fixture(); f.host.planImportConfirm.mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: '预览已过期，请重新选择原文件', retryable: true } });
    f.show(); fireEvent.click(button('选择 JSON 文件')); await screen.findByText('一周学习计划');
    fireEvent.click(button('确认批量导入'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '预览已过期，请重新选择原文件');
    expect(f.ui.refresh).not.toHaveBeenCalled();
    expect(f.onClose).not.toHaveBeenCalled();
  });

  it('clears an old preview when a replacement file fails validation', async () => {
    const f = fixture(); f.show();
    fireEvent.click(button('选择 JSON 文件')); await screen.findByText('一周学习计划');
    f.host.planImportOpen.mockResolvedValueOnce({ ok: false, error: { code: 'VALIDATION', message: '计划文件格式错误', retryable: false } });
    fireEvent.click(button('重新选择 JSON 文件'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '计划文件格式错误');
    expect(screen.queryByText('一周学习计划')).toBeNull();
    expect(button('确认批量导入').disabled).toBe(true);
    expect(f.host.planImportConfirm).not.toHaveBeenCalled();
  });

  it('exposes the navigation entry only with a complete desktop import bridge', async () => {
    const f = fixture(), snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
    const base = { snapshot: async () => ({ ok: true, data: snapshot }), onChanged: () => () => {}, onNavigate: () => () => {} };
    const old = render(<App api={base as unknown as DesktopAPI} />);
    expect(within(screen.getByRole('navigation', { name: '主导航' })).queryByRole('button', { name: '导入计划' })).toBeNull();
    old.unmount();
    render(<App api={{ ...base, ...f.host } as unknown as DesktopAPI} />);
    fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', { name: '导入计划' }));
    expect(screen.getByRole('dialog', { name: '导入计划' })).toBeTruthy();
    expect(f.host.planImportOpen).not.toHaveBeenCalled();
    expect(f.host.planImportConfirm).not.toHaveBeenCalled();
  });
});
