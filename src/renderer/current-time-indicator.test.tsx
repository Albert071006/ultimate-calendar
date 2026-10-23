// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SnapshotSchema } from '../shared/contracts';
import { Calendar } from './components/Calendar';
import { currentTimePosition } from './components/CurrentTimeIndicator';
import { DAY_HEIGHT, HOUR_HEIGHT, minutePosition } from './calendar-timeline';

const date = '2026-10-23';
const snapshot = () => SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: {}, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
const at = (time: string) => Date.parse(`${date}T${time}+08:00`);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(at('10:25:00'));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function setup() {
  const props = { snapshot: snapshot(), date, setDate: vi.fn(), select: vi.fn(), schedule: vi.fn(), courses: vi.fn() };
  return { ...render(<Calendar {...props} />), props };
}

describe('current time on the continuous calendar', () => {
  it('opens the current week and day around now with more room for upcoming plans', () => {
    const ui = setup();
    const viewport = ui.container.querySelector('.time-scroll') as HTMLDivElement;
    expect(viewport.scrollTop).toBe(minutePosition(625) - 200);
    viewport.scrollTop = 150;
    fireEvent.click(screen.getByRole('button', { name: /^日$/ }));
    expect(viewport.scrollTop).toBe(minutePosition(625) - 200);
    expect(ui.props.setDate).not.toHaveBeenCalled();
    expect(ui.props.schedule).not.toHaveBeenCalled();
    expect(ui.props.select).not.toHaveBeenCalled();
  });

  it('keeps historical and future dates selected rather than taking them back to today', () => {
    const ui = setup();
    for (const selectedDate of ['2026-10-12', '2026-11-02']) {
      ui.rerender(<Calendar {...ui.props} date={selectedDate} />);
      const viewport = ui.container.querySelector('.time-scroll') as HTMLDivElement;
      expect(viewport.scrollTop).toBe(7 * HOUR_HEIGHT);
      expect(ui.container.querySelector('.calendar-current-time')).toBeNull();
    }
    expect(ui.props.setDate).not.toHaveBeenCalled();
    ui.rerender(<Calendar {...ui.props} date="2026-10-19" />);
    expect((ui.container.querySelector('.time-scroll') as HTMLDivElement).scrollTop).toBe(minutePosition(625) - 200);
    fireEvent.click(screen.getByRole('button', { name: /^月$/ }));
    expect(ui.container.querySelector('.time-scroll')).toBeNull();
    expect(ui.props.setDate).not.toHaveBeenCalled();
  });

  it('recentres on Today even if the selected date is already today, but not on data refresh', () => {
    const ui = setup();
    const viewport = ui.container.querySelector('.time-scroll') as HTMLDivElement;
    viewport.scrollTop = 150;
    ui.rerender(<Calendar {...ui.props} snapshot={snapshot()} />);
    expect(viewport.scrollTop).toBe(150);
    vi.setSystemTime(at('15:20:00'));
    fireEvent.click(screen.getByRole('button', { name: '今天' }));
    expect(viewport.scrollTop).toBe(minutePosition(920) - 200);
    expect(ui.props.setDate).toHaveBeenCalledWith(date);
  });

  it('keeps the current line visible at the start and end of a day', () => {
    vi.setSystemTime(at('00:03:00'));
    const ui = setup();
    expect((ui.container.querySelector('.time-scroll') as HTMLDivElement).scrollTop).toBe(0);
    vi.setSystemTime(at('23:58:00'));
    fireEvent.click(screen.getByRole('button', { name: '今天' }));
    expect((ui.container.querySelector('.time-scroll') as HTMLDivElement).scrollTop).toBe(DAY_HEIGHT - 600);
  });

  it('uses the Shanghai date and exact minute axis without snapping or clamping other dates', () => {
    expect(currentTimePosition(date, Date.parse('2026-10-23T02:25:30Z'))).toEqual({ minute: 625.5, time: '10:25' });
    expect(currentTimePosition(date, Date.parse('2026-10-22T16:00:00Z'))).toEqual({ minute: 0, time: '00:00' });
    expect(currentTimePosition(date, Date.parse('2026-10-22T15:59:59Z'))).toBeNull();
    expect(currentTimePosition(date, Date.parse('2026-10-23T16:00:00Z'))).toBeNull();
    expect(currentTimePosition(date, Number.NaN)).toBeNull();
  });

  it('shows one labelled line in today’s column in week and day views, with no line in month or another date', () => {
    const ui = setup();
    const line = screen.getByRole('note', { name: '当前时间 10:25（北京时间）' });
    expect(ui.container.querySelectorAll('.calendar-current-time')).toHaveLength(1);
    expect(line.closest('[data-day]')?.getAttribute('data-day')).toBe(date);
    expect(parseFloat(line.style.top)).toBe(minutePosition(625));
    expect(line.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-23T02:25:00.000Z');
    fireEvent.click(screen.getByRole('button', { name: /^日$/ }));
    expect(ui.container.querySelectorAll('.calendar-current-time')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^月$/ }));
    expect(ui.container.querySelector('.calendar-current-time')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^周$/ }));
    ui.rerender(<Calendar {...ui.props} date="2026-11-02" />);
    expect(ui.container.querySelector('.calendar-current-time')).toBeNull();
  });

  it('updates the line and label while open without changing the scroll position or opening an editor', () => {
    vi.setSystemTime(at('10:25:45'));
    const ui = setup();
    const viewport = ui.container.querySelector('.time-scroll') as HTMLDivElement;
    viewport.scrollTop = 930;
    act(() => { vi.advanceTimersByTime(30_000); });
    const line = screen.getByRole('note', { name: '当前时间 10:26（北京时间）' });
    expect(parseFloat(line.style.top)).toBe(minutePosition(626.25));
    expect(viewport.scrollTop).toBe(930);
    expect(ui.props.schedule).not.toHaveBeenCalled();
    expect(ui.props.setDate).not.toHaveBeenCalled();
    expect(ui.props.select).not.toHaveBeenCalled();
  });

  it('moves to the new Shanghai day at midnight and refreshes immediately after focus or visibility changes', () => {
    vi.setSystemTime(at('23:59:45'));
    const ui = setup();
    expect(screen.getByRole('note').closest('[data-day]')?.getAttribute('data-day')).toBe(date);
    act(() => { vi.advanceTimersByTime(30_000); });
    const afterMidnight = screen.getByRole('note', { name: '当前时间 00:00（北京时间）' });
    expect(afterMidnight.closest('[data-day]')?.getAttribute('data-day')).toBe('2026-10-24');
    expect(parseFloat(afterMidnight.style.top)).toBe(minutePosition(0.25));
    expect(afterMidnight.hasAttribute('data-at-start')).toBe(true);
    expect(ui.container.querySelector('[data-day="2026-10-23"] .calendar-current-time')).toBeNull();
    vi.setSystemTime('2026-10-24T09:12:00+08:00');
    fireEvent.focus(window);
    expect(screen.getByRole('note', { name: '当前时间 09:12（北京时间）' })).toBeTruthy();
    vi.setSystemTime('2026-10-24T09:13:00+08:00');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByRole('note', { name: '当前时间 09:13（北京时间）' })).toBeTruthy();
  });
});
