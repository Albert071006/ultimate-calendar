// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BlockSchema, CandidateSchema, CourseSchema, SnapshotSchema, TaskSchema, type DesktopAPI, type Snapshot } from '../shared/contracts';
import { App } from './App';
import { Today } from './pages/today/Today';
import type { PlannerUI } from './hooks/usePlanner';

vi.mock('./calendar-layout', async importOriginal => ({ ...await importOriginal<typeof import('./calendar-layout')>(), todayDate: () => '2026-10-22' }));
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-22T14:20:00+08:00')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const metadata = { version: 1, createdAt: '2026-10-01T09:00:00+08:00', updatedAt: '2026-10-01T09:00:00+08:00' };
function empty(): Snapshot {
  return SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: { termStart: '2026-08-31' }, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
}
function app(snapshot = empty()) {
  const api = { snapshot: vi.fn(async () => ({ ok: true, data: snapshot })), onChanged: () => () => {}, onNavigate: () => () => {}, command: vi.fn() } as unknown as DesktopAPI;
  return render(<App api={api} />);
}
function today(snapshot: Snapshot) {
  const ui = { busy: false, mutate: vi.fn(), snapshot, error: '', notice: '', undo: vi.fn() } as unknown as PlannerUI;
  const props = { create: vi.fn(), openInbox: vi.fn(), openCandidate: vi.fn(), openRecord: vi.fn(), goCalendar: vi.fn(), editTask: vi.fn(), schedule: vi.fn(), removeTask: vi.fn() };
  return { ...render(<Today snapshot={snapshot} ui={ui} pendingCount={snapshot.candidates.length} {...props} />), ui, props };
}

it('offers five sections with the pending count and keeps the assistant to one line until used', async () => {
  const snapshot = empty();
  snapshot.candidates.push(CandidateSchema.parse({ ...metadata, id: 'c', title: '讲座', sourceIds: ['s'] }));
  const { container } = app(snapshot);
  const nav = await screen.findByRole('navigation', { name: '主导航' });
  await screen.findByLabelText('自然语言指令');
  expect(within(nav).getAllByRole('button').map(button => button.textContent)).toEqual(['今天', '日历', '待判断1', '账单', '我的']);
  expect(container.querySelector('.a2-assist-panel')).toBeNull();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  expect(container.querySelector('.a2-assist-panel')).not.toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText('自然语言指令'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(container.querySelector('.a2-assist-panel')).toBeNull();
});

it('lays out today as a timeline beside tasks grouped by arrangement or deadline', () => {
  const snapshot = empty();
  snapshot.courses.push(CourseSchema.parse({ ...metadata, id: 'english', title: '大学英语', weekday: 4, startTime: '10:05', endTime: '11:40', firstWeek: 1, lastWeek: 18, termStart: '2026-08-31', color: '#b4416a' }));
  snapshot.tasks.push(...[
    { id: 'listen', title: '四级听力第 3 套', courseId: 'english' },
    { id: 'report', title: '实验报告', deadline: { date: '2026-10-21', time: '23:59' } },
    { id: 'pick', title: '选课确认', deadline: { date: '2026-10-22', time: '23:59' } },
    { id: 'mock', title: '四级模拟卷', deadline: { date: '2026-10-25', time: null } },
    { id: 'award', title: '奖学金材料', deadline: { date: '2026-10-30', time: null } },
  ].map(task => TaskSchema.parse({ ...metadata, ...task })));
  snapshot.blocks.push(BlockSchema.parse({ ...metadata, id: 'b', title: '四级听力练习', kind: 'work', taskId: 'listen', start: '2026-10-22T15:00:00+08:00', end: '2026-10-22T16:30:00+08:00' }));
  const { container } = today(snapshot);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('10月22日 星期四第 8 周');
  const items = [...container.querySelectorAll<HTMLElement>('.a2-tl-item')];
  expect(items.map(item => item.querySelector('.bt')!.firstChild!.textContent)).toEqual(['大学英语', '四级听力练习', '选课确认']);
  expect(items[0]!.classList.contains('past')).toBe(true);
  expect(items[1]!.classList.contains('next')).toBe(true);
  expect(items[1]!.textContent).toContain('40 分钟后');
  expect(items[1]!.style.getPropertyValue('--c')).toBe('#b4416a');
  expect(container.querySelector('.a2-tl-now')!.nextElementSibling).toBe(items[1]);
  expect([...container.querySelectorAll('.a2-group h3')].map(h => h.textContent)).toEqual(['已过时间 1', '今天 2', '本周 1', '以后 1']);
  expect(screen.queryByRole('button', { name: /条通知等你判断/ })).toBeNull();
});

it('states plainly when today has nothing scheduled or to do', () => {
  today(empty());
  expect(screen.getByRole('heading', { name: '今天没有课程和安排' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '没有待办任务' })).toBeTruthy();
});
