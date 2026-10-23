// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SnapshotSchema } from '../shared/contracts';
import type { PlannerUI } from './hooks/usePlanner';
import { Settings } from './components/Settings';

afterEach(cleanup);

describe('settings durable history', () => {
  it('starts collapsed, exposes specific changes on demand, and preserves undo controls and newest-first order', () => {
    const snapshot = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, tokenUsage: [], keyStatus: { configured: false, sessionOnly: false }, journal: [
      { id: 'newer', operationId: 'rename', createdAt: '2026-01-11T12:00:00+08:00', origin: 'ai', message: '已保存，可撤销', changes: [{ entity: 'block', id: 'event', action: 'update', beforeVersion: 1, afterVersion: 2, title: '新名称' }], undoneAt: null, undoable: true, displayTitle: '重命名活动「原名称」→「新名称」', displayDetails: ['修改活动「新名称」：标题 原名称 → 新名称'] },
      { id: 'older', operationId: 'create', createdAt: '2026-01-10T12:00:00+08:00', origin: 'manual', message: '已保存，可撤销', changes: [{ entity: 'task', id: 'task', action: 'create', beforeVersion: null, afterVersion: 1, title: '交作业' }], undoneAt: '2026-01-10T13:00:00+08:00', undoable: true },
    ] });
    const undo = vi.fn(async () => {});
    const ui = { client: undefined, host: undefined, busy: false, undo } as unknown as PlannerUI;
    const { container } = render(<Settings snapshot={snapshot} ui={ui} courses={() => {}} />);
    const history = container.querySelector('details.operation-history') as HTMLDetailsElement;
    expect(history.open).toBe(false);
    fireEvent.click(screen.getByText('持久操作历史'));
    expect(history.open).toBe(true);
    const rows = history.querySelectorAll('.history-row');
    expect(rows[0]?.querySelector('strong')?.textContent).toBe('重命名活动「原名称」→「新名称」');
    expect(rows[1]?.querySelector('strong')?.textContent).toBe('新增「交作业」');
    const details = rows[0]!.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(within(rows[0] as HTMLElement).getByText('查看具体变更'));
    expect(details.open).toBe(true);
    expect(within(details).getByText('修改活动「新名称」：标题 原名称 → 新名称')).toBeTruthy();
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: '撤销此操作' }));
    expect(undo).toHaveBeenCalledWith('newer');
    expect((within(rows[1] as HTMLElement).getByRole('button', { name: '撤销此操作' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('持久操作历史'));
    expect(history.open).toBe(false);
  });
});
