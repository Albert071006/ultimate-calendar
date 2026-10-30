// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { BlockSchema, CandidateSchema, SnapshotSchema, SourceSchema, TaskSchema, type Snapshot } from '../shared/contracts';
import { Today } from './pages/today/Today';
import { TodayPage } from './mobile/pages/TodayPage';
import type { PlannerUI } from './hooks/usePlanner';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const metadata = { version: 1, createdAt: '2026-10-23T09:00:00+08:00', updatedAt: '2026-10-23T09:00:00+08:00' };
function fixture(): Snapshot {
  return SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
}
function lists(snapshot: Snapshot) {
  const mutate = vi.fn(), schedule = vi.fn(), editTask = vi.fn(), removeTask = vi.fn();
  const ui = { busy: false, mutate, snapshot, error: '', notice: '', undo: vi.fn() } as unknown as PlannerUI;
  // Today's to-do list replaced both the separate task page and the calendar's side task list.
  const page = render(<Today snapshot={snapshot} ui={ui} pendingCount={0} create={vi.fn()} openInbox={vi.fn()} openCandidate={vi.fn()} openRecord={vi.fn()} goCalendar={vi.fn()} editTask={editTask} schedule={schedule} removeTask={removeTask} />).container;
  return { containers: [page], page, mutate, schedule, editTask, removeTask };
}
function titles(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-task-id]')].map(row => (row.querySelector('.a2-task-title') ?? row.querySelector('span')!.firstChild)!.textContent!.trim());
}
function attentionLabel(row: HTMLElement) { return row.querySelector('.task-attention-label, .a2-task-meta .warn')?.textContent ?? ''; }
function item(container: HTMLElement, id: string) { return container.querySelector<HTMLElement>(`[data-task-id="${id}"]`)!; }

describe('unfinished task attention', () => {
  it('shows today activities before distant deadlines in both layouts and keeps all-filter ordering', () => {
    const now = Date.parse('2026-10-23T11:00:00+08:00');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const snapshot = fixture();
    snapshot.tasks = [
      { id: 'exam', title: '下月考试', deadline: { date: '2026-11-26', time: null } },
      { id: 'noon', title: '中午集合' }, { id: 'none', title: '时间待定的任务' },
    ].map(task => TaskSchema.parse({ ...metadata, ...task }));
    snapshot.blocks.push(BlockSchema.parse({ ...metadata, id: 'meeting', title: '中午集合', taskId: 'noon', kind: 'event', start: '2026-10-23T12:00:00+08:00', end: null }));
    const view = lists(snapshot);
    expect(titles(view.page)).toEqual(['中午集合', '下月考试', '时间待定的任务']);
    expect(item(view.page, 'noon').closest('.a2-group')?.classList.contains('today')).toBe(true);
    fireEvent.click(within(view.page).getByRole('button', { name: '全部' }));
    expect(titles(view.page)).toEqual(['中午集合', '下月考试', '时间待定的任务']);
    const mobile = render(<TodayPage snapshot={snapshot} ui={{ busy: false } as PlannerUI} now={now} pendingCount={0} unscheduledCount={0}
      select={vi.fn()} openCandidate={vi.fn()} openInbox={vi.fn()} openUnscheduled={vi.fn()} createTask={vi.fn()}
      actions={{ editTask: vi.fn(), schedule: vi.fn(), removeTask: vi.fn() }} />).container;
    expect([...mobile.querySelectorAll('[data-task-id]')].map(row => row.getAttribute('data-task-id'))).toEqual(['noon', 'exam', 'none']);
    expect(item(mobile, 'noon').closest('.m-group')?.classList.contains('group-today')).toBe(true);
    expect(view.mutate).not.toHaveBeenCalled();
  });

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
      expect(overdue.dataset.attention).toBe('overdue');
      expect(attentionLabel(overdue)).toMatch(/截止|逾期|DDL/);
      fireEvent.click(within(overdue).getByRole('button', { name: '修改 DDL' }));
      expect(view.editTask).toHaveBeenLastCalledWith('expired');
      expect(item(container, 'soon').dataset.attention).toBeUndefined();
    }
    fireEvent.click(within(view.page).getByRole('button', { name: '已完成' }));
    expect(titles(view.page)).toEqual(['完成的作业']);
    fireEvent.click(within(view.page).getByRole('button', { name: '全部' }));
    // "全部" keeps deadline groups and lists completed history last.
    expect(titles(view.page)).toEqual(['过期的报名', '今晚的小测', '提交报告', '读一本书', '完成的作业']);
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
    for (const container of view.containers) expect(container.querySelectorAll('[data-attention]')).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(31_000); });
    for (const container of view.containers) {
      expect(titles(container)).toEqual(['五点结束的会议', '五点截止', '只有开始时间的活动']);
      expect(item(container, 'deadline').dataset.attention).toBe('overdue');
      expect(item(container, 'meeting').dataset.attention).toBe('ended');
      expect(item(container, 'point').dataset.attention).toBeUndefined();
    }
    vi.setSystemTime(new Date('2026-10-23T17:15:00+08:00')); fireEvent.focus(window);
    for (const container of view.containers) {
      expect(titles(container)).toEqual(['五点结束的会议', '只有开始时间的活动', '五点截止']);
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
      expect(titles(container)).toEqual(['继续写报告', '周四活动室开会']);
      expect(item(container, 'meeting').dataset.attention).toBe('ended');
      const work = item(container, 'work');
      expect(work.dataset.attention).toBe('ended');
      fireEvent.click(within(work).getByRole('button', { name: '继续写报告 的更多操作' }));
      expect(within(work).getByRole('menuitem', { name: '查看安排' })).toBeTruthy();
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
    fireEvent.click(within(item(view.page, 'recurring')).getByRole('checkbox', { name: '完成 活动室值班' }));
    expect(view.mutate).toHaveBeenLastCalledWith([{ type: 'finishTask', id: 'recurring', expectedVersion: 1, completed: true }]);
    fireEvent.click(within(view.page).getByRole('button', { name: '全部' }));
    expect([...titles(view.page)].sort()).toEqual(snapshot.tasks.map(task => task.title).sort());
    expect(snapshot).toEqual(before);
  });
});
