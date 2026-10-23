// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BlockSchema, CandidateSchema, SnapshotSchema, SourceSchema, TaskSchema, type Snapshot } from '../shared/contracts';
import { DetailPanel } from './components/DetailPanel';
import { Tasks } from './components/Tasks';
import type { PlannerUI } from './hooks/usePlanner';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const metadata = { version: 1, createdAt: '2026-10-23T09:00:00+08:00', updatedAt: '2026-10-23T09:00:00+08:00' };
function fixture(): Snapshot {
  return SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
}
function lists(snapshot: Snapshot) {
  const mutate = vi.fn(), schedule = vi.fn(), editTask = vi.fn(), removeTask = vi.fn();
  const ui = { busy: false, mutate } as unknown as PlannerUI;
  render(<DetailPanel snapshot={snapshot} selection={null} ui={ui} schedule={schedule} editTask={editTask} removeTask={removeTask} edit={vi.fn()} close={vi.fn()} />);
  const rail = screen.getByRole('region', { name: '待办任务列表' });
  const page = render(<Tasks snapshot={snapshot} ui={ui} select={vi.fn()} create={vi.fn()} editTask={editTask} schedule={schedule} removeTask={removeTask} />).container;
  return { containers: [rail, page], rail, page, mutate, schedule, editTask, removeTask };
}
function titles(container: HTMLElement) {
  return within(container).queryAllByRole('button', { name: /^移除 / }).map(button => button.getAttribute('aria-label')!.replace(/^移除 /, ''));
}
function item(container: HTMLElement, id: string) { return container.querySelector<HTMLElement>(`[data-task-id="${id}"]`)!; }

describe('unfinished task attention', () => {
  it('retains overdue tasks in deadline order with direct deadline editing and keeps completed history separate', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T16:00:00+08:00'));
    const snapshot = fixture();
    snapshot.tasks = [
      { id: 'unscheduled', title: '读一本书' },
      { id: 'later', title: '提交报告', deadline: { date: '2026-10-24', time: '12:00' } },
      { id: 'done', title: '完成的作业', status: 'done', deadline: { date: '2026-10-23', time: '17:00' } },
      { id: 'expired', title: '过期的报名', deadline: { date: '2026-10-23', time: '15:59' } },
      { id: 'soon', title: '今晚的小测', deadline: { date: '2026-10-23', time: '18:30' } },
    ].map(task => TaskSchema.parse({ ...metadata, ...task }));
    const view = lists(snapshot);
    for (const container of view.containers) {
      expect(titles(container)).toEqual(['过期的报名', '今晚的小测', '提交报告', '读一本书']);
      const overdue = item(container, 'expired');
      expect(overdue.classList.contains('task-needs-attention')).toBe(true);
      expect(overdue.dataset.attention).toBe('overdue');
      expect(overdue.querySelector('.task-attention-label')!.textContent).toMatch(/截止|逾期|DDL/);
      fireEvent.click(within(overdue).getByRole('button', { name: '修改 DDL' }));
      expect(view.editTask).toHaveBeenLastCalledWith('expired');
      expect(item(container, 'soon').dataset.attention).toBeUndefined();
    }
    fireEvent.click(within(view.page).getByRole('button', { name: '已完成' }));
    expect(titles(view.page)).toEqual(['完成的作业']);
    fireEvent.click(within(view.page).getByRole('button', { name: '全部' }));
    expect(titles(view.page)).toEqual(snapshot.tasks.map(task => task.title));
    expect(view.mutate).not.toHaveBeenCalled();
    expect(view.removeTask).not.toHaveBeenCalled();
  });

  it('marks elapsed deadlines and activities while open and on focus without removing or completing anything', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T16:59:50+08:00'));
    const snapshot = fixture();
    snapshot.tasks = [
      { id: 'deadline', title: '五点截止', deadline: { date: '2026-10-23', time: '17:00' } },
      { id: 'meeting', title: '五点结束的会议' }, { id: 'point', title: '只有开始时间的活动' },
    ].map(task => TaskSchema.parse({ ...metadata, ...task }));
    snapshot.blocks = [
      { id: 'meeting-event', taskId: 'meeting', start: '2026-10-23T16:00:00+08:00', end: '2026-10-23T17:00:00+08:00' },
      { id: 'point-event', taskId: 'point', start: '2026-10-23T16:45:00+08:00', end: null },
    ].map(block => BlockSchema.parse({ ...metadata, title: block.id, kind: 'event', ...block }));
    const before = structuredClone(snapshot), view = lists(snapshot);
    expect(view.rail.querySelectorAll('.task-needs-attention')).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(31_000); });
    for (const container of view.containers) {
      expect(titles(container)).toEqual(snapshot.tasks.map(task => task.title));
      expect(item(container, 'deadline').dataset.attention).toBe('overdue');
      expect(item(container, 'meeting').dataset.attention).toBe('ended');
      expect(item(container, 'point').dataset.attention).toBeUndefined();
    }
    vi.setSystemTime(new Date('2026-10-23T17:15:00+08:00')); fireEvent.focus(window);
    for (const container of view.containers) {
      expect(titles(container)).toEqual(snapshot.tasks.map(task => task.title));
      expect(item(container, 'point').dataset.attention).toBe('ended');
    }
    expect(snapshot).toEqual(before); expect(view.mutate).not.toHaveBeenCalled(); expect(view.removeTask).not.toHaveBeenCalled();
  });

  it('keeps grounded old notices and unfinished work and edits the existing work arrangement', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T16:00:00+08:00'));
    const snapshot = fixture();
    snapshot.sources.push(SourceSchema.parse({ ...metadata, id: 'source-meeting', kind: 'text', text: '周四晚上九点半，活动室开个会哈', sentAt: '2026-10-21T00:28:53+08:00', importedAt: metadata.createdAt, status: 'succeeded' }));
    snapshot.candidates.push(CandidateSchema.parse({ ...metadata, id: 'notice-meeting', title: '周四活动室开会', sourceIds: ['source-meeting'], sourceQuote: '周四晚上九点半，活动室开个会哈', temporalEvidence: [{ field: 'eventStart', basis: 'relative', quote: '周四晚上九点半，活动室开个会哈' }], status: 'accepted', taskId: 'meeting', eventStart: null, eventEnd: null }));
    snapshot.tasks = [{ id: 'meeting', title: '周四活动室开会', candidateId: 'notice-meeting' }, { id: 'work', title: '继续写报告' }].map(task => TaskSchema.parse({ ...metadata, ...task }));
    snapshot.blocks.push(BlockSchema.parse({ ...metadata, id: 'past-work', title: '报告写作时段', taskId: 'work', kind: 'work', start: '2026-10-22T19:00:00+08:00', end: '2026-10-22T20:00:00+08:00' }));
    const before = structuredClone(snapshot), view = lists(snapshot);
    for (const container of view.containers) {
      expect(titles(container)).toEqual(['周四活动室开会', '继续写报告']);
      expect(item(container, 'meeting').dataset.attention).toBe('ended');
      const work = item(container, 'work');
      expect(work.dataset.attention).toBe('ended');
      expect(within(work).getByRole('button', { name: '查看安排' })).toBeTruthy();
      fireEvent.click(within(work).getByRole('button', { name: '重新安排' }));
      expect(view.schedule).toHaveBeenLastCalledWith('work', 'past-work');
    }
    expect(snapshot).toEqual(before); expect(view.mutate).not.toHaveBeenCalled();
  });

  it('retires only explicitly resolved event tasks and targets an ended occurrence even with another upcoming', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T16:00:00+08:00'));
    const snapshot = fixture();
    snapshot.tasks = [ { id: 'recurring', title: '活动室值班' }, { id: 'cancelled', title: '已取消的值班' }, { id: 'finished-event', title: '完成的活动' }, { id: 'work', title: '尚未完成的报告' } ].map(task => TaskSchema.parse({ ...metadata, ...task }));
    snapshot.blocks = [
      { id: 'past', taskId: 'recurring', kind: 'event', start: '2026-10-20T20:40:00+08:00', end: null },
      { id: 'future', taskId: 'recurring', kind: 'event', start: '2026-11-03T20:40:00+08:00', end: null },
      { id: 'cancelled-event', taskId: 'cancelled', kind: 'event', start: '2026-10-20T20:40:00+08:00', end: null, cancelled: true },
      { id: 'completed-event', taskId: 'finished-event', kind: 'event', start: '2026-11-03T20:40:00+08:00', end: null, completed: true },
      { id: 'completed-work', taskId: 'work', kind: 'work', start: '2026-10-22T19:00:00+08:00', end: '2026-10-22T20:00:00+08:00', completed: true },
    ].map(block => BlockSchema.parse({ ...metadata, title: block.id, ...block }));
    const before = structuredClone(snapshot), view = lists(snapshot);
    for (const container of view.containers) {
      expect(titles(container)).toEqual(['活动室值班', '尚未完成的报告']);
      const recurring = item(container, 'recurring');
      expect(recurring.dataset.attention).toBe('ended');
      fireEvent.click(within(recurring).getByRole('button', { name: /重新安排|调整时间/ }));
      expect(view.schedule).toHaveBeenLastCalledWith('recurring', 'past');
      expect(item(container, 'work').dataset.attention).toBeUndefined();
    }
    fireEvent.click(within(item(view.rail, 'recurring')).getByRole('button', { name: '完成任务 活动室值班' }));
    expect(view.mutate).toHaveBeenLastCalledWith([{ type: 'finishTask', id: 'recurring', expectedVersion: 1, completed: true }]);
    fireEvent.click(within(view.page).getByRole('button', { name: '全部' }));
    expect(titles(view.page)).toEqual(snapshot.tasks.map(task => task.title));
    expect(snapshot).toEqual(before);
  });
});
