// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BlockSchema, SnapshotSchema, TaskSchema, type Snapshot } from '../shared/contracts';
import { EntityEditor } from './components/editor/EntityEditor';
import { DetailPopover } from './components/detail/DetailPopover';
import { MobileProvider } from './mobile/layout';
import { taskActionHandlers } from './task-actions';
import type { PlannerUI } from './hooks/usePlanner';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const at = '2026-10-23T09:00:00+08:00';
const metadata = { version: 1, createdAt: at, updatedAt: at };
function fixture(mode?: 'single' | 'multiple'): Snapshot {
  return SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], goals: [], courses: [], courseExceptions: [], preferences: [],
    feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false },
    tasks: [TaskSchema.parse({ ...metadata, id: 'task', title: '示例作业', ...(mode ? { scheduleMode: mode } : {}) })],
    blocks: [BlockSchema.parse({ ...metadata, id: 'slot', title: '写示例作业', taskId: 'task', kind: 'work', start: '2026-10-24T15:00:00+08:00', end: '2026-10-24T16:30:00+08:00' })],
  });
}
function fakeUI() {
  const mutate = vi.fn(async (_mutations: unknown[]) => ({ status: 'applied' }));
  return { mutate, ui: { busy: false, mutate } as unknown as PlannerUI };
}

describe('explicit task scheduling mode', () => {
  it.each([false, true])('saves the task as multiple only when selected (%s)', async multiple => {
    const { ui, mutate } = fakeUI();
    render(<EntityEditor target={{ entity: 'task' }} snapshot={fixture()} ui={ui} onClose={vi.fn()} />);
    const checkbox = screen.getByRole('checkbox', { name: '安排多个时段' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新的示例作业' } });
    if (multiple) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    expect(mutate.mock.calls[0]![0]).toMatchObject([{ type: 'create', entity: 'task', values: { scheduleMode: multiple ? 'multiple' : 'single' } }]);
  });

  it('shows a legacy task with two existing arrangements as multiple', () => {
    const snapshot = fixture();
    snapshot.blocks.push({ ...snapshot.blocks[0]!, id: 'slot-two', start: '2026-10-25T15:00:00+08:00', end: '2026-10-25T16:30:00+08:00' });
    render(<EntityEditor target={{ entity: 'task', id: 'task' }} snapshot={snapshot} ui={fakeUI().ui} onClose={vi.fn()} />);
    expect((screen.getByRole('checkbox', { name: '安排多个时段' }) as HTMLInputElement).checked).toBe(true);
  });

  it.each([false, true])('requires an explicit choice before adding a second slot and saves it atomically (notice draft %s)', async notice => {
    const { ui, mutate } = fakeUI();
    const snapshot = fixture();
    if (notice) snapshot.tasks[0]!.candidateId = 'candidate';
    render(<EntityEditor target={{ entity: 'block', draft: { date: '2026-10-25', time: '15:00', taskId: 'task',
      ...(notice ? { kind: 'event', noticeTaskVersion: 1 } : {}),
    } }} snapshot={snapshot} ui={ui} onClose={vi.fn()} />);
    const checkbox = screen.getByRole('checkbox', { name: '为此任务安排多个时段' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('alert');
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    expect(mutate.mock.calls[0]![0]).toMatchObject([
      { type: 'update', entity: 'task', id: 'task', expectedVersion: 1, values: { scheduleMode: 'multiple' } },
      { type: 'create', entity: 'block', values: { taskId: 'task', start: '2026-10-25T15:00:00+08:00' } },
    ]);
  });

  it('does not carry an opt-in checkbox to another task', async () => {
    const snapshot = fixture();
    snapshot.tasks.push({ ...snapshot.tasks[0]!, id: 'other', title: '另一项作业' });
    snapshot.blocks.push({ ...snapshot.blocks[0]!, id: 'other-slot', taskId: 'other' });
    const { ui, mutate } = fakeUI();
    render(<EntityEditor target={{ entity: 'block', draft: { date: '2026-10-25', time: '15:00', taskId: 'task' } }} snapshot={snapshot} ui={ui} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '为此任务安排多个时段' }));
    fireEvent.change(screen.getByLabelText('关联任务'), { target: { value: 'other' } });
    expect((screen.getByRole('checkbox', { name: '为此任务安排多个时段' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('alert');
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('one slot by default in both calendar shells', () => {
  it('moves the single existing arrangement when a task is dropped at another time, preserving its duration', () => {
    const editRecord = vi.fn();
    const actions = taskActionHandlers({ snapshot: fixture(), ui: fakeUI().ui, select: vi.fn(), editRecord });
    actions.schedule({ taskId: 'task', date: '2026-10-25', time: '18:00', end: '2026-10-25T18:30' });
    expect(editRecord).toHaveBeenCalledWith({ entity: 'block', id: 'slot', draft: { taskId: 'task', blockId: 'slot', date: '2026-10-25', time: '18:00', end: '2026-10-25T19:30' } });
  });

  it('opens a separate new slot only for multiple mode, otherwise opens the task setting', () => {
    const editRecord = vi.fn();
    const options = { ui: fakeUI().ui, select: vi.fn(), editRecord, defaultSlot: () => ({ date: '2026-10-25', time: '18:00' }) };
    taskActionHandlers({ ...options, snapshot: fixture() }).scheduleAdditionalTask('task');
    expect(editRecord).toHaveBeenLastCalledWith({ entity: 'task', id: 'task' });
    taskActionHandlers({ ...options, snapshot: fixture('multiple') }).scheduleAdditionalTask('task');
    expect(editRecord).toHaveBeenLastCalledWith({ entity: 'block', draft: { taskId: 'task', date: '2026-10-25', time: '18:00' } });
  });

  it.each([false, true])('provides the explicit extra-slot action in task details (mobile %s)', mobile => {
    const scheduleAdditional = vi.fn();
    render(<MobileProvider mobile={mobile}><DetailPopover snapshot={fixture('multiple')} selection={{ entity: 'task', id: 'task' }} ui={fakeUI().ui} close={vi.fn()}
      actions={{ edit: vi.fn(), editTask: vi.fn(), schedule: vi.fn(), scheduleAdditional, removeTask: vi.fn() }} /></MobileProvider>);
    fireEvent.click(screen.getByRole('button', { name: '再安排一个时段' }));
    expect(scheduleAdditional).toHaveBeenCalledWith('task');
  });
});
