// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BlockSchema, CandidateSchema, CourseSchema, SnapshotSchema, TaskSchema, type DesktopAPI, type Snapshot } from '../shared/contracts';
import { App } from './App';

vi.mock('./calendar-layout', async importOriginal => ({ ...await importOriginal<typeof import('./calendar-layout')>(), todayDate: () => '2026-10-22' }));
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-22T09:00:00+08:00')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const metadata = { version: 1, createdAt: '2026-10-01T09:00:00+08:00', updatedAt: '2026-10-01T09:00:00+08:00' };
function snapshot(): Snapshot {
  const state = SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: { termStart: '2026-09-28', termWeeks: 18 }, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
  const course = (id: string, title: string, weekday: number, startTime: string, color: string) =>
    CourseSchema.parse({ ...metadata, id, title, weekday, startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, '0')}:35`, termStart: '2026-09-28', firstWeek: 1, lastWeek: 18, color });
  // Thursdays carry two courses; Wednesdays and weekends have none.
  state.courses = [course('math', '合成高数', 4, '08:00', '#3b5b9a'), course('eng', '合成英语', 4, '10:05', '#23807a'), course('math-mon', '合成高数', 1, '08:00', '#3b5b9a')];
  state.tasks = [
    { id: 'pick', title: '合成选课确认', deadline: { date: '2026-10-22', time: '23:59' } },
    { id: 'loose', title: '合成整理笔记' },
  ].map(task => TaskSchema.parse({ ...metadata, ...task }));
  const block = (id: string, start: string, end: string) => BlockSchema.parse({ ...metadata, id, title: id, kind: 'event', start, end });
  state.blocks = [
    block('合成例会', '2026-10-22T15:00:00+08:00', '2026-10-22T16:00:00+08:00'),
    ...['18:00', '19:00', '20:00', '21:00', '22:00'].map((time, i) => block(`合成周三活动${i + 1}`, `2026-10-21T${time}:00+08:00`, `2026-10-21T${time.slice(0, 2)}:30:00+08:00`)),
  ];
  state.candidates = [CandidateSchema.parse({ ...metadata, id: 'talk', title: '合成图书馆讲座', sourceIds: ['s'], eventStart: '2026-10-22T19:00:00+08:00', eventEnd: '2026-10-22T20:30:00+08:00', location: '合成报告厅' })];
  return state;
}
function setup() {
  const state = snapshot();
  const mutate = vi.fn(async (_request: unknown) => ({ ok: true, data: { status: 'applied', operationId: 'x', snapshot: state } }));
  const api = { snapshot: vi.fn(async () => ({ ok: true, data: state })), mutate, onChanged: () => () => {}, onNavigate: () => () => {} } as unknown as DesktopAPI;
  const view = render(<App api={api} />);
  return { ...view, mutate };
}
const switchTo = (name: '日' | '周' | '月') => fireEvent.click(within(screen.getByRole('group', { name: '视图' })).getByRole('button', { name }));

it('keeps day-view sessions on a narrower layer and shows the day sidebar above the drawer', async () => {
  const { container, mutate } = setup();
  await screen.findByRole('complementary', { name: '未安排任务' });
  switchTo('日');
  expect(container.querySelector('.a2-cal.view-day')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^合成例会/ }).closest('.a2-ev-layer')).toBeTruthy();
  expect(container.querySelector('.a2-days')!.textContent).toContain('2 节课 · 1 项活动');
  const side = screen.getByRole('complementary', { name: '今天概览' });
  const deadlines = within(side).getByRole('region', { name: '今天截止' });
  expect(deadlines.textContent).toContain('23:59');
  expect(within(deadlines).getByRole('button', { name: /合成选课确认/ }).textContent).toContain('未安排');
  const pending = within(side).getByRole('region', { name: '待决定' });
  expect(pending.textContent).toContain('19:00–20:30 · 合成报告厅');
  fireEvent.click(within(pending).getByRole('button', { name: '参加' }));
  expect(mutate.mock.calls[0]![0]).toMatchObject({ mutations: [{ type: 'acceptCandidate', id: 'talk', expectedVersion: 1 }] });
  expect(within(side).getByRole('complementary', { name: '未安排任务' })).toBeTruthy();
  fireEvent.click(within(pending).getByRole('button', { name: '稍后' }));
  expect(screen.getByRole('heading', { name: '待判断', level: 1 })).toBeTruthy();
});

it('draws courses as dots beside the date, caps each day at three items and opens the day from the date', async () => {
  const { container } = setup();
  await screen.findByRole('complementary', { name: '未安排任务' });
  switchTo('月');
  const cell = (day: string) => container.querySelector<HTMLElement>(`.a2-m-cell[data-day="${day}"]`)!;
  expect(container.querySelectorAll('.a2-m-cell')).toHaveLength(35);
  expect(cell('2026-09-28').classList.contains('out')).toBe(true);
  expect(screen.getByText('第 1 – 5 周')).toBeTruthy();
  expect(cell('2026-10-22').classList.contains('today')).toBe(true);
  // Two Thursday courses become two dots and never list items; Wednesday has no course dots.
  expect(cell('2026-10-22').querySelectorAll('.a2-m-dots i')).toHaveLength(2);
  expect(within(cell('2026-10-22')).queryByRole('button', { name: /合成高数/ })).toBeNull();
  expect(cell('2026-10-21').querySelector('.a2-m-dots')).toBeNull();
  expect(cell('2026-10-19').querySelectorAll('.a2-m-dots i')).toHaveLength(1);
  const wednesday = within(cell('2026-10-21'));
  expect(cell('2026-10-21').querySelectorAll('.month-item')).toHaveLength(3);
  fireEvent.click(wednesday.getByRole('button', { name: '还有 2 项' }));
  expect(within(screen.getByRole('group', { name: '视图' })).getByRole('button', { name: '日' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('10月21日 星期三第 4 周');
  switchTo('月');
  fireEvent.click(screen.getByRole('button', { name: '打开 10月22日' }));
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('10月22日 星期四第 4 周');
});
