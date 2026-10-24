// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BlockSchema, CandidateSchema, CourseSchema, SnapshotSchema, TaskSchema, type Snapshot } from '../shared/contracts';
import { Calendar } from './components/Calendar';
import { DAY_HEIGHT, minutePosition } from './calendar-timeline';

const date = '2026-10-23';
const metadata = { version: 1, createdAt: '2026-10-22T08:00:00+08:00', updatedAt: '2026-10-22T08:00:00+08:00' };
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-22T08:00:00+08:00')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function snapshot(): Snapshot {
  return SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: { showPending: true }, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
}
function block(id = 'block-1', start = `${date}T08:30:00+08:00`, end = `${date}T10:05:00+08:00`) {
  return BlockSchema.parse({ ...metadata, id, title: '报告准备', start, end, kind: 'work' });
}
function setup(state = snapshot()) {
  const schedule = vi.fn(), select = vi.fn();
  const result = render(<Calendar snapshot={state} date={date} setDate={() => {}} select={select} schedule={schedule} courses={() => {}} />);
  const viewport = result.container.querySelector('.time-scroll') as HTMLDivElement;
  const grid = result.container.querySelector('.time-grid')!;
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 });
  vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => ({ top: 100, bottom: 700, left: 0, right: 1050, width: 1050, height: 600, x: 0, y: 100, toJSON() {} }));
  for (const [index, column] of [...result.container.querySelectorAll<HTMLDivElement>('[data-day]')].entries()) {
    vi.spyOn(column, 'getBoundingClientRect').mockImplementation(() => ({ top: 100 - viewport.scrollTop, bottom: 100 - viewport.scrollTop + DAY_HEIGHT,
      left: 52 + index * 140, right: 192 + index * 140, width: 140, height: DAY_HEIGHT, x: 52 + index * 140, y: 100 - viewport.scrollTop, toJSON() {} }));
  }
  const column = (day = date) => result.container.querySelector<HTMLDivElement>(`[data-day="${day}"]`)!;
  const point = (minute: number, day = date) => { const rect = column(day).getBoundingClientRect(); return { pointerId: 1, button: 0, isPrimary: true, clientX: rect.left + 40, clientY: rect.top + minutePosition(minute) }; };
  const drag = (target: Element, from: number, to: number, fromDay = date, toDay = fromDay) => {
    fireEvent.pointerDown(target, point(from, fromDay)); fireEvent.pointerMove(grid, point(to, toDay)); fireEvent.pointerUp(grid, point(to, toDay));
  };
  return { ...result, schedule, select, viewport, grid, column, point, drag };
}

describe('continuous minute calendar', () => {
  it('shows the selected teaching week only inside the configured term', () => {
    const state = snapshot(); state.settings.termStart = '2026-08-31'; state.settings.termWeeks = 20;
    const ui = setup(state);
    expect(screen.getByText('第 8 周')).toBeTruthy();
    ui.rerender(<Calendar snapshot={state} date="2026-08-30" setDate={() => {}} select={ui.select} schedule={ui.schedule} courses={() => {}} />);
    expect(ui.container.querySelector('.calendar-term-week')).toBeNull();
    ui.rerender(<Calendar snapshot={state} date="2027-01-18" setDate={() => {}} select={ui.select} schedule={ui.schedule} courses={() => {}} />);
    expect(ui.container.querySelector('.calendar-term-week')).toBeNull();
  });

  it('positions 08:30–10:05 and 10:25–12:00 exactly and separates collisions without half-hour cells', () => {
    const state = snapshot();
    for (const [id, title, startTime, endTime] of [['c1', '第一节课', '08:30', '10:05'], ['c2', '第二节课', '10:25', '12:00']]) {
      state.courses.push(CourseSchema.parse({ ...metadata, id, title, termStart: '2026-10-19', weekday: 5, firstWeek: 1, lastWeek: 2, parity: 'odd', startTime, endTime }));
    }
    state.blocks.push(block('overlap', `${date}T09:00:00+08:00`, `${date}T09:30:00+08:00`));
    const ui = setup(state);
    const first = screen.getByRole('button', { name: /第一节课.*08:30–10:05/ }).parentElement!;
    const second = screen.getByRole('button', { name: /第二节课.*10:25–12:00/ }).parentElement!;
    expect(parseFloat(first.style.top)).toBe(minutePosition(510)); expect(parseFloat(first.style.height)).toBe(minutePosition(95));
    expect(parseFloat(second.style.top)).toBe(minutePosition(625)); expect(parseFloat(second.style.height)).toBe(minutePosition(95));
    expect(first.style.width).toContain('50%'); expect(second.style.width).toContain('100%');
    expect(ui.container.querySelectorAll('.slot')).toHaveLength(0);
  });

  it('clicks an arbitrary minute and carries a precise end into the confirmation form', () => {
    const ui = setup(); ui.viewport.scrollTop = 850;
    ui.drag(ui.column(), 625, 625);
    expect(ui.schedule).toHaveBeenCalledWith({ date, time: '10:25', end: `${date}T10:55` });
    ui.schedule.mockClear(); ui.drag(ui.column(), 1439, 1439);
    expect(ui.schedule).toHaveBeenCalledWith({ date, time: '23:59', end: '2026-10-24T00:00' });
  });

  it('selects a minute-accurate range in either direction and retains the coordinate after scrolling', () => {
    const ui = setup();
    ui.drag(ui.column(), 510, 605); ui.drag(ui.column(), 605, 510);
    expect(ui.schedule.mock.calls.map(call => call[0])).toEqual([
      { date, time: '08:30', end: `${date}T10:05` }, { date, time: '08:30', end: `${date}T10:05` },
    ]);
    ui.schedule.mockClear(); const point = ui.point(510);
    fireEvent.pointerDown(ui.column(), point); ui.viewport.scrollTop += minutePosition(10);
    fireEvent.pointerMove(ui.grid, point); fireEvent.pointerUp(ui.grid, point);
    expect(ui.schedule).toHaveBeenCalledWith({ date, time: '08:30', end: `${date}T08:40` });
  });

  it('cancels pointer gestures instead of opening or saving an accidental draft', () => {
    const ui = setup(); fireEvent.pointerDown(ui.column(), ui.point(625)); fireEvent.pointerMove(ui.grid, ui.point(630));
    fireEvent.keyDown(window, { key: 'Escape' }); fireEvent.pointerUp(ui.grid, ui.point(630));
    expect(ui.schedule).not.toHaveBeenCalled(); expect(ui.container.querySelector('.timeline-preview')).toBeNull();
    fireEvent.pointerDown(ui.column(), ui.point(625)); fireEvent.pointerCancel(ui.grid, { pointerId: 1 });
    expect(ui.schedule).not.toHaveBeenCalled(); expect(ui.container.querySelector('.timeline-preview')).toBeNull();
  });

  it('moves a block by one minute while preserving its original 95-minute duration and grab offset', () => {
    const state = snapshot(); state.blocks.push(block()); const ui = setup(state);
    const event = screen.getByRole('button', { name: /报告准备.*08:30–10:05/ });
    ui.drag(event, 540, 541);
    expect(ui.schedule).toHaveBeenCalledWith({ date, time: '08:31', end: `${date}T10:06`, blockId: 'block-1' });
    fireEvent.click(event, { detail: 1 }); expect(ui.select).not.toHaveBeenCalled();
    ui.schedule.mockClear(); ui.drag(event, 540, 540, date, '2026-10-24');
    expect(ui.schedule).toHaveBeenCalledWith({ date: '2026-10-24', time: '08:30', end: '2026-10-24T10:05', blockId: 'block-1' });
  });

  it('resizes to arbitrary minutes, never inverts the interval, and supports one-minute keyboard adjustment', () => {
    const state = snapshot(); state.blocks.push(block()); const ui = setup(state);
    const end = screen.getByRole('button', { name: '调整 报告准备 结束时间' });
    ui.drag(end, 605, 607);
    expect(ui.schedule).toHaveBeenLastCalledWith({ date, time: '08:30', end: `${date}T10:07`, blockId: 'block-1' });
    ui.drag(end, 605, 480);
    expect(ui.schedule).toHaveBeenLastCalledWith({ date, time: '08:30', end: `${date}T08:31`, blockId: 'block-1' });
    fireEvent.keyDown(end, { key: 'ArrowDown' });
    expect(ui.schedule).toHaveBeenLastCalledWith({ date, time: '08:30', end: `${date}T10:06`, blockId: 'block-1' });
    fireEvent.keyDown(screen.getByRole('button', { name: /报告准备.*08:30–10:05/ }), { key: 'ArrowDown', altKey: true });
    expect(ui.schedule).toHaveBeenLastCalledWith({ date, time: '08:31', end: `${date}T10:06`, blockId: 'block-1' });
  });

  it('clips overnight blocks visually and preserves both dates when resizing the final segment', () => {
    const state = snapshot(); state.blocks.push(block('night', `${date}T23:30:00+08:00`, '2026-10-24T00:25:00+08:00')); const ui = setup(state);
    const first = ui.column().querySelector<HTMLElement>('[data-timeline-item="night"]')!;
    const second = ui.column('2026-10-24').querySelector<HTMLElement>('[data-timeline-item="night"]')!;
    expect(parseFloat(first.style.top)).toBe(minutePosition(1410)); expect(parseFloat(first.style.height)).toBe(minutePosition(30));
    expect(parseFloat(second.style.top)).toBe(0); expect(parseFloat(second.style.height)).toBe(minutePosition(25));
    expect(within(ui.column()).queryByRole('button', { name: '调整 报告准备 结束时间' })).toBeNull();
    const end = within(ui.column('2026-10-24')).getByRole('button', { name: '调整 报告准备 结束时间' });
    ui.drag(end, 25, 27, '2026-10-24');
    expect(ui.schedule).toHaveBeenCalledWith({ date, time: '23:30', end: '2026-10-24T00:27', blockId: 'night' });
  });

  it('supports keyboard minute selection and external task drops without 30-minute snapping', () => {
    const ui = setup(); fireEvent.focus(ui.column()); fireEvent.keyDown(ui.column(), { key: 'ArrowDown' }); fireEvent.keyDown(ui.column(), { key: 'Enter' });
    expect(ui.schedule).toHaveBeenCalledWith({ date, time: '09:01', end: `${date}T09:31` });
    const drop = new Event('drop', { bubbles: true });
    Object.defineProperties(drop, { clientY: { value: ui.point(625).clientY }, dataTransfer: { value: { getData: () => JSON.stringify({ kind: 'task', id: 'task-1' }) } } });
    fireEvent(ui.column(), drop);
    expect(ui.schedule).toHaveBeenLastCalledWith({ date, time: '10:25', taskId: 'task-1' });
  });

  it('lists every deadline with its time in the deadline row and keeps pending event ranges on the minute axis', () => {
    const state = snapshot();
    state.tasks.push(TaskSchema.parse({ ...metadata, id: 'deadline', title: '上午截止', deadline: { date, time: '10:25' } }), TaskSchema.parse({ ...metadata, id: 'all-day', title: '当天截止', deadline: { date, time: null } }));
    state.candidates.push(CandidateSchema.parse({ ...metadata, id: 'candidate', title: '待确认活动', sourceIds: ['source'], eventStart: `${date}T14:00:00+08:00`, eventEnd: `${date}T15:35:00+08:00` }));
    const ui = setup(state);
    const deadlines = within(ui.container.querySelector('.a2-ddl-row') as HTMLElement);
    expect(deadlines.getByRole('button', { name: /上午截止.*10:25/ })).toBeTruthy();
    expect(deadlines.getByRole('button', { name: /当天截止/ })).toBeTruthy();
    expect(ui.container.querySelector('.time-scroll')!.textContent).not.toContain('上午截止');
    expect(parseFloat(screen.getByRole('button', { name: /待确认活动.*14:00–15:35/ }).parentElement!.style.height)).toBe(minutePosition(95));
    fireEvent.click(screen.getByLabelText('待判断标记')); expect(screen.queryByRole('button', { name: /待确认活动.*14:00/ })).toBeNull();
  });
});
