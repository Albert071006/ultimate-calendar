// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BlockSchema, SnapshotSchema, TaskSchema, type DesktopAPI, type Snapshot } from '../shared/contracts';
import { EntityEditor } from './components/DetailPanel';
import type { PlannerUI } from './hooks/usePlanner';
import { nextTaskEvent, taskEventSummary } from './task-schedule';
import { App } from './App';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const metadata = { version: 1, createdAt: '2026-10-23T09:00:00+08:00', updatedAt: '2026-10-23T09:00:00+08:00' };
function fixture(): Snapshot {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T19:00:00+08:00'));
  const snapshot = SnapshotSchema.parse({
    schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [],
    preferences: [], feedback: [], settings: { termStart: '2026-08-31', termWeeks: 20 }, journal: [], tokenUsage: [],
    keyStatus: { configured: false, sessionOnly: false },
  });
  snapshot.tasks = [
    { id: 'thursday', title: '活动室周四晚上九点半开会' },
    { id: 'done', title: '已完成任务', status: 'done' },
    { id: 'expired', title: '过期DDL', deadline: { date: '2026-10-22', time: null } },
    { id: 'duty', title: '双周周二晚活动室值班检查', reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null } },
  ].map(task => TaskSchema.parse({ ...metadata, ...task }));
  snapshot.blocks = [BlockSchema.parse({
    ...metadata, id: 'past-meeting', title: snapshot.tasks[0]!.title, taskId: 'thursday',
    kind: 'event', start: '2026-10-22T21:30:00+08:00', end: null,
  })];
  return snapshot;
}
function fakeUI() {
  const mutate = vi.fn(async () => ({ status: 'preview' }));
  return { mutate, ui: { busy: false, mutate } as unknown as PlannerUI };
}
function input(label: string) { return screen.getByLabelText(label) as HTMLInputElement; }

describe('task selection and recurring schedule editor', () => {
  it('excludes ended activities, completed tasks and expired deadlines from a new task association', () => {
    const snapshot = fixture();
    const { ui } = fakeUI();
    render(<EntityEditor target={{ entity: 'block' }} snapshot={snapshot} ui={ui} onClose={vi.fn()} />);
    const selection = screen.getByLabelText('关联任务');
    expect(within(selection).getAllByRole('option').map(o => o.textContent)).toEqual(['无', '双周周二晚活动室值班检查']);
    expect(snapshot.tasks).toHaveLength(4);
  });

  it('preserves the current historical association when editing its existing event', async () => {
    const snapshot = fixture();
    const { ui, mutate } = fakeUI();
    render(<EntityEditor target={{ entity: 'block', id: 'past-meeting' }} snapshot={snapshot} ui={ui} onClose={vi.fn()} />);
    expect((screen.getByLabelText('关联任务') as HTMLSelectElement).value).toBe('thursday');
    expect(within(screen.getByLabelText('关联任务')).queryByText('已完成任务')).toBeNull();
    expect(screen.queryByLabelText('重复')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(mutate.mock.calls[0]).toEqual([[expect.objectContaining({ type: 'update', entity: 'block', id: 'past-meeting', values: expect.objectContaining({ taskId: 'thursday' }) })]]);
  });

  it('can repeat from a blank calendar editor and updates title and inherited reminders when choosing a different task', async () => {
    const snapshot = fixture();
    snapshot.tasks.push(TaskSchema.parse({ ...metadata, id: 'study', title: '每周英语学习', reminders: { enabled: false, leadMinutes: [10], dateOnlyTime: null } }));
    const { ui, mutate } = fakeUI();
    render(<EntityEditor target={{ entity: 'block' }} snapshot={snapshot} ui={ui} onClose={vi.fn()} />);
    expect(input('名称').value).toBe('');
    fireEvent.change(screen.getByLabelText('重复'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('关联任务'), { target: { value: 'duty' } });
    expect(input('名称').value).toBe('双周周二晚活动室值班检查');
    expect(input('名称').readOnly).toBe(true);
    expect(input('提前分钟（逗号分隔；空白继承全局；0 为准时）').value).toBe('30');
    expect(input('启用提醒').checked).toBe(true);
    fireEvent.change(screen.getByLabelText('关联任务'), { target: { value: 'study' } });
    expect(input('名称').value).toBe('每周英语学习');
    expect(input('提前分钟（逗号分隔；空白继承全局；0 为准时）').value).toBe('10');
    expect(input('启用提醒').checked).toBe(false);
    expect(input('名称').form!.checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存并预览' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]).toEqual([[expect.objectContaining({
      type: 'scheduleRecurringTask', id: 'study', expectedVersion: 1,
      reminders: { enabled: false, leadMinutes: [10], dateOnlyTime: null },
    })]]);
  });

  it('defaults to the semester end and thirty minutes, inherits task reminders and submits an academic even-week preview', async () => {
    const snapshot = fixture();
    const { ui, mutate } = fakeUI();
    const onClose = vi.fn();
    render(<EntityEditor target={{ entity: 'block', recurring: true, draft: { date: '2026-10-23', time: '20:40', taskId: 'duty', kind: 'event', location: '活动室' } }} snapshot={snapshot} ui={ui} onClose={onClose} />);
    expect(input('开始日期').value).toBe('2026-10-23');
    expect(input('结束日期').value).toBe('2027-01-17');
    expect(input('每次时长（分钟）').value).toBe('30');
    expect(input('提前分钟（逗号分隔；空白继承全局；0 为准时）').value).toBe('30');
    fireEvent.change(screen.getByLabelText('重复'), { target: { value: 'even-weeks' } });
    expect(input('第一教学周周一').value).toBe('2026-08-31');
    fireEvent.change(screen.getByLabelText('星期'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并预览' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]).toEqual([[{
      type: 'scheduleRecurringTask', id: 'duty', expectedVersion: 1,
      rule: { frequency: 'even-weeks', fromDate: '2026-10-23', untilDate: '2027-01-17', weekday: 2, time: '20:40', durationMinutes: 30, termStart: '2026-08-31' },
      location: '活动室', reminders: { enabled: true, leadMinutes: [30], dateOnlyTime: null },
    }]]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(snapshot.blocks).toHaveLength(1);
  });

  it('offers recurrence for an existing task from both the rail and task page', async () => {
    const snapshot = fixture();
    const api = { snapshot: vi.fn(async () => ({ ok: true, data: snapshot })), onChanged: () => () => {}, onNavigate: () => () => {} } as unknown as DesktopAPI;
    render(<App api={api} />);
    const rail = await screen.findByRole('region', { name: '待办任务列表' });
    fireEvent.click(within(rail).getByRole('button', { name: '重复安排' }));
    let dialog = await screen.findByRole('dialog', { name: '重复安排' });
    expect((within(dialog).getByLabelText('关联任务') as HTMLSelectElement).value).toBe('duty');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '任务' }));
    const row = screen.getByRole('button', { name: /双周周二晚活动室值班检查.*未设截止/ }).closest('article')!;
    fireEvent.click(within(row).getByRole('button', { name: '重复安排' }));
    dialog = await screen.findByRole('dialog', { name: '重复安排' });
    expect((within(dialog).getByLabelText('关联任务') as HTMLSelectElement).value).toBe('duty');
  });

  it('shows the next outstanding occurrence and counts remaining activities', () => {
    fixture();
    const events = ['2026-10-20', '2026-11-03', '2026-11-17'].map((date, i) => BlockSchema.parse({
      ...metadata, id: `duty-${i}`, title: '值班', taskId: 'duty', kind: 'event', start: `${date}T20:40:00+08:00`, end: `${date}T21:10:00+08:00`,
    }));
    expect(nextTaskEvent(events, Date.now())?.id).toBe('duty-1');
    expect(taskEventSummary(events, Date.now())).toContain('2026-11-03 20:40');
    expect(taskEventSummary(events, Date.now())).toContain('剩余2次');
    events[1]!.completed = true;
    expect(nextTaskEvent(events, Date.now())?.id).toBe('duty-2');
  });
});
