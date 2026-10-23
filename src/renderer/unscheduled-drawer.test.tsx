// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BlockSchema, SnapshotSchema, TaskSchema, type DesktopAPI, type Snapshot } from '../shared/contracts';
import { App } from './App';

vi.mock('./calendar-layout', async importOriginal => ({ ...await importOriginal<typeof import('./calendar-layout')>(), todayDate: () => '2026-10-22' }));
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-22T14:20:00+08:00')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const metadata = { version: 1, createdAt: '2026-10-01T09:00:00+08:00', updatedAt: '2026-10-01T09:00:00+08:00' };
function snapshot(): Snapshot {
  const state = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
  state.tasks = [
    { id: 'report', title: '实验报告', deadline: { date: '2026-10-21', time: '23:59' } },
    { id: 'pick', title: '选课确认', deadline: { date: '2026-10-22', time: '23:59' } },
    { id: 'mock', title: '四级模拟卷', deadline: { date: '2026-10-25', time: null } },
    { id: 'award', title: '奖学金材料', deadline: { date: '2026-10-30', time: null } },
    { id: 'notes', title: '整理错题' },
    { id: 'arranged', title: '已安排的任务', deadline: { date: '2026-10-23', time: null } },
  ].map(task => TaskSchema.parse({ ...metadata, ...task }));
  state.blocks.push(BlockSchema.parse({ ...metadata, id: 'b', title: '写作', kind: 'work', taskId: 'arranged', start: '2026-10-22T19:00:00+08:00', end: '2026-10-22T20:00:00+08:00' }));
  return state;
}
async function drawer(state = snapshot()) {
  const api = { snapshot: vi.fn(async () => ({ ok: true, data: state })), onChanged: () => () => {}, onNavigate: () => () => {} } as unknown as DesktopAPI;
  render(<App api={api} />);
  return screen.findByRole('complementary', { name: '未安排任务' });
}

it('lists unscheduled tasks by deadline with urgency marks and carries them as drag payloads', async () => {
  const panel = await drawer();
  const cards = [...panel.querySelectorAll<HTMLElement>('article')];
  expect(cards.map(card => card.dataset.taskId)).toEqual(['report', 'pick', 'mock', 'award', 'notes']);
  expect(cards.map(card => [...card.classList].find(name => name.startsWith('lvl-')))).toEqual(['lvl-over', 'lvl-today', 'lvl-week', 'lvl-later', 'lvl-none']);
  expect(within(cards[0]!).getByText('截止 周三 23:59')).toBeTruthy();
  expect(within(cards[3]!).getByText('截止 10月30日')).toBeTruthy();
  const data = { setData: vi.fn() };
  fireEvent.dragStart(cards[1]!, { dataTransfer: data });
  expect(data.setData).toHaveBeenCalledWith('application/x-planner', JSON.stringify({ kind: 'task', id: 'pick' }));
  expect(screen.getByRole('button', { name: /未安排 5/ }).getAttribute('aria-pressed')).toBe('true');
});

it('collapses into the toolbar toggle and shows a plain empty state', async () => {
  const state = snapshot(); state.tasks = state.tasks.filter(task => task.id === 'arranged');
  const panel = await drawer(state);
  expect(within(panel).getByRole('heading', { name: '没有未安排的任务' })).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: '收起未安排' }));
  expect(screen.queryByRole('complementary', { name: '未安排任务' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /未安排 0/ }));
  expect(screen.getByRole('complementary', { name: '未安排任务' })).toBeTruthy();
});
