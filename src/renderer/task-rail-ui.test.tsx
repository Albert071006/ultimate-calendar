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
  return SnapshotSchema.parse({
    schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [],
    courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [],
    keyStatus: { configured: false, sessionOnly: false },
  });
}

function callbacks() {
  const mutate = vi.fn();
  return {
    ui: { busy: false, mutate } as unknown as PlannerUI,
    mutate, removeTask: vi.fn(), schedule: vi.fn(), edit: vi.fn(), close: vi.fn(),
  };
}

function railTitles(rail: HTMLElement) {
  return within(rail).queryAllByRole('button', { name: /^移除 / })
    .map(button => button.getAttribute('aria-label')!.replace(/^移除 /, ''));
}

describe('active task lists', () => {
  it('orders by nearest deadline and hides completed or expired tasks from both the sidebar and pending page while retaining history', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T16:00:00+08:00'));
    const snapshot = fixture();
    snapshot.tasks = [
      { id: 'unscheduled', title: '读一本书' },
      { id: 'later', title: '提交报告', deadline: { date: '2026-10-24', time: '12:00' } },
      { id: 'done', title: '完成的作业', status: 'done', deadline: { date: '2026-10-23', time: '17:00' } },
      { id: 'expired', title: '过期的报名', deadline: { date: '2026-10-23', time: '15:59' } },
      { id: 'soon', title: '今晚的小测', deadline: { date: '2026-10-23', time: '18:30' } },
    ].map(task => TaskSchema.parse({ ...metadata, ...task }));
    const handlers = callbacks();
    render(<DetailPanel snapshot={snapshot} selection={null} {...handlers} />);
    const rail = screen.getByRole('region', { name: '待办任务列表' });
    expect(screen.getByRole('heading', { name: '待办任务', level: 3 })).toBeTruthy();
    expect(screen.queryByText('一次，专注一件事')).toBeNull();
    expect(screen.queryByText('点击日历、任务或候选事项，查看时间与来源。')).toBeNull();
    expect(railTitles(rail)).toEqual(['今晚的小测', '提交报告', '读一本书']);
    expect(within(rail).getByText(/截止.*2026-10-23.*18:30/)).toBeTruthy();

    const taskPage = render(<Tasks snapshot={snapshot} ui={handlers.ui} select={vi.fn()} create={vi.fn()} schedule={handlers.schedule} removeTask={handlers.removeTask} />);
    expect(railTitles(taskPage.container)).toEqual(['今晚的小测', '提交报告', '读一本书']);
    expect(within(taskPage.container).queryByRole('button', { name: /过期的报名.*截止/ })).toBeNull();
    fireEvent.click(within(taskPage.container).getByRole('button', { name: '全部' }));
    expect(within(taskPage.container).getByRole('button', { name: /过期的报名.*截止/ })).toBeTruthy();
    fireEvent.click(within(taskPage.container).getByRole('button', { name: '已完成' }));
    expect(within(taskPage.container).getByRole('button', { name: /完成的作业.*截止/ })).toBeTruthy();
    expect(within(taskPage.container).queryByRole('button', { name: /过期的报名.*截止/ })).toBeNull();
    expect(snapshot.tasks).toHaveLength(5);
    expect(handlers.mutate).not.toHaveBeenCalled();
    expect(handlers.removeTask).not.toHaveBeenCalled();
  });

  it('automatically hides newly expired tasks while open and on returning to the window without deleting records', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T16:59:50+08:00'));
    const snapshot = fixture();
    snapshot.tasks = [
      { id: 'soon', title: '五点截止', deadline: { date: '2026-10-23', time: '17:00' } },
      { id: 'later', title: '稍后截止', deadline: { date: '2026-10-23', time: '17:10' } },
      { id: 'no-deadline', title: '没有截止' },
    ].map(task => TaskSchema.parse({ ...metadata, ...task }));
    const handlers = callbacks();
    render(<DetailPanel snapshot={snapshot} selection={null} {...handlers} />);
    const rail = screen.getByRole('region', { name: '待办任务列表' });
    expect(railTitles(rail)).toEqual(['五点截止', '稍后截止', '没有截止']);

    act(() => { vi.advanceTimersByTime(31_000); });
    expect(railTitles(rail)).toEqual(['稍后截止', '没有截止']);
    vi.setSystemTime(new Date('2026-10-23T17:11:00+08:00'));
    fireEvent.focus(window);
    expect(railTitles(rail)).toEqual(['没有截止']);
    expect(snapshot.tasks).toHaveLength(3);
    expect(snapshot.tasks.every(task => task.status === 'open')).toBe(true);
    expect(handlers.mutate).not.toHaveBeenCalled();
    expect(handlers.removeTask).not.toHaveBeenCalled();
  });

  it('hides the previous day’s grounded notification from pending lists but keeps it in all tasks and preserves unfinished work', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T16:00:00+08:00'));
    const snapshot = fixture();
    snapshot.sources.push(SourceSchema.parse({
      ...metadata, id: 'source-meeting', kind: 'text', text: '周四晚上九点半，活动室开个会哈',
      sentAt: '2026-10-21T00:28:53+08:00', importedAt: metadata.createdAt, status: 'succeeded',
    }));
    snapshot.candidates.push(CandidateSchema.parse({
      ...metadata, id: 'notice-meeting', title: '周四活动室开会', sourceIds: ['source-meeting'],
      sourceQuote: '周四晚上九点半，活动室开个会哈',
      temporalEvidence: [{ field: 'eventStart', basis: 'relative', quote: '周四晚上九点半，活动室开个会哈' }],
      status: 'accepted', taskId: 'meeting', eventStart: null, eventEnd: null,
    }));
    snapshot.tasks = [
      { id: 'meeting', title: '周四活动室开会', candidateId: 'notice-meeting' },
      { id: 'work', title: '继续写报告' },
    ].map(task => TaskSchema.parse({ ...metadata, ...task }));
    snapshot.blocks.push(BlockSchema.parse({
      ...metadata, id: 'past-work', title: '报告写作时段', taskId: 'work', kind: 'work',
      start: '2026-10-22T19:00:00+08:00', end: '2026-10-22T20:00:00+08:00',
    }));
    const handlers = callbacks();
    render(<DetailPanel snapshot={snapshot} selection={null} {...handlers} />);
    expect(railTitles(screen.getByRole('region', { name: '待办任务列表' }))).toEqual(['继续写报告']);
    const taskPage = render(<Tasks snapshot={snapshot} ui={handlers.ui} select={vi.fn()} create={vi.fn()} schedule={handlers.schedule} removeTask={handlers.removeTask} />);
    expect(railTitles(taskPage.container)).toEqual(['继续写报告']);
    expect(within(taskPage.container).queryByRole('button', { name: /周四活动室开会.*未设截止/ })).toBeNull();
    fireEvent.click(within(taskPage.container).getByRole('button', { name: '全部' }));
    expect(within(taskPage.container).getByRole('button', { name: /周四活动室开会.*未设截止/ })).toBeTruthy();
    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.candidates[0]!.eventStart).toBeNull();
    expect(handlers.mutate).not.toHaveBeenCalled();
    expect(handlers.removeTask).not.toHaveBeenCalled();
  });

  it('refreshes ended fixed activities and applies the thirty-minute default when an end time is missing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T16:59:50+08:00'));
    const snapshot = fixture();
    snapshot.tasks = [
      { id: 'meeting', title: '下午会议' },
      { id: 'point', title: '今天的活动' },
    ].map(task => TaskSchema.parse({ ...metadata, ...task }));
    snapshot.blocks = [
      { id: 'meeting-event', title: '下午会议', taskId: 'meeting', start: '2026-10-23T16:00:00+08:00', end: '2026-10-23T17:00:00+08:00' },
      { id: 'point-event', title: '今天的活动', taskId: 'point', start: '2026-10-23T16:45:00+08:00', end: null },
    ].map(block => BlockSchema.parse({ ...metadata, kind: 'event', ...block }));
    const handlers = callbacks();
    render(<DetailPanel snapshot={snapshot} selection={null} {...handlers} />);
    const rail = screen.getByRole('region', { name: '待办任务列表' });
    expect(railTitles(rail)).toEqual(['下午会议', '今天的活动']);
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(railTitles(rail)).toEqual(['今天的活动']);
    vi.setSystemTime(new Date('2026-10-23T17:15:00+08:00'));
    fireEvent.focus(window);
    expect(railTitles(rail)).toEqual([]);
    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.blocks).toHaveLength(2);
    expect(handlers.mutate).not.toHaveBeenCalled();
    expect(handlers.removeTask).not.toHaveBeenCalled();
  });

  it('hides Thursday’s saved meeting and exhausted activity series from pending tasks but retains future occurrences and history', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T16:00:00+08:00'));
    const snapshot = fixture();
    snapshot.tasks = [
      { id: 'thursday', title: '活动室周四晚上九点半开会' },
      { id: 'recurring', title: '双周周二晚活动室值班检查' },
      { id: 'cancelled', title: '已取消的值班' },
      { id: 'finished-event', title: '提前完成的活动' },
      { id: 'todo', title: '没有日期的普通待办' },
    ].map(task => TaskSchema.parse({ ...metadata, ...task }));
    snapshot.blocks = [
      { id: 'thursday-event', taskId: 'thursday', start: '2026-10-22T21:30:00+08:00', end: null },
      { id: 'duty-past', taskId: 'recurring', start: '2026-10-20T20:40:00+08:00' },
      { id: 'duty-future', taskId: 'recurring', start: '2026-11-03T20:40:00+08:00' },
      { id: 'cancelled-past', taskId: 'cancelled', start: '2026-10-20T20:40:00+08:00' },
      { id: 'cancelled-future', taskId: 'cancelled', start: '2026-11-03T20:40:00+08:00', cancelled: true },
      { id: 'completed-future', taskId: 'finished-event', start: '2026-11-03T20:40:00+08:00', completed: true },
    ].map(block => BlockSchema.parse({ ...metadata, kind: 'event', title: block.id, end: null, ...block }));
    const before = structuredClone(snapshot);
    const handlers = callbacks();
    const page = render(<Tasks snapshot={snapshot} ui={handlers.ui} select={vi.fn()} create={vi.fn()} schedule={handlers.schedule} removeTask={handlers.removeTask} />);
    expect(railTitles(page.container)).toEqual(['双周周二晚活动室值班检查', '没有日期的普通待办']);

    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(railTitles(page.container)).toEqual(snapshot.tasks.map(task => task.title));
    const historicalMeeting = screen.getByRole('button', { name: /活动室周四晚上九点半开会.*默认30分钟/ });
    expect(historicalMeeting.textContent).toContain('2026-10-22 22:00');
    fireEvent.click(screen.getByRole('button', { name: '已完成' }));
    expect(railTitles(page.container)).toEqual([]);
    expect(snapshot).toEqual(before);
    expect(handlers.mutate).not.toHaveBeenCalled();
    expect(handlers.removeTask).not.toHaveBeenCalled();
  });

  it('refreshes pending tasks after deadlines and activity ends without a restart or changing completion status', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T16:59:50+08:00'));
    const snapshot = fixture();
    snapshot.tasks = [
      { id: 'deadline', title: '五点截止', deadline: { date: '2026-10-23', time: '17:00' } },
      { id: 'meeting', title: '五点结束的会议' },
      { id: 'start-only', title: '只有开始时间的活动' },
      { id: 'todo', title: '无日期待办' },
    ].map(task => TaskSchema.parse({ ...metadata, ...task }));
    snapshot.blocks = [
      { id: 'meeting-event', taskId: 'meeting', start: '2026-10-23T16:00:00+08:00', end: '2026-10-23T17:00:00+08:00' },
      { id: 'start-only-event', taskId: 'start-only', start: '2026-10-23T16:45:00+08:00', end: null },
    ].map(block => BlockSchema.parse({ ...metadata, kind: 'event', title: block.id, ...block }));
    const before = structuredClone(snapshot);
    const handlers = callbacks();
    const page = render(<Tasks snapshot={snapshot} ui={handlers.ui} select={vi.fn()} create={vi.fn()} schedule={handlers.schedule} removeTask={handlers.removeTask} />);
    expect(railTitles(page.container)).toEqual(['五点截止', '五点结束的会议', '只有开始时间的活动', '无日期待办']);

    act(() => { vi.advanceTimersByTime(31_000); });
    expect(railTitles(page.container)).toEqual(['只有开始时间的活动', '无日期待办']);
    vi.setSystemTime(new Date('2026-10-23T17:15:00+08:00'));
    fireEvent.focus(window);
    expect(railTitles(page.container)).toEqual(['无日期待办']);
    fireEvent.click(screen.getByRole('button', { name: '全部' }));
    expect(railTitles(page.container)).toEqual(snapshot.tasks.map(task => task.title));
    expect(snapshot).toEqual(before);
    expect(handlers.mutate).not.toHaveBeenCalled();
    expect(handlers.removeTask).not.toHaveBeenCalled();
  });
});
