// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildCalendar } from '../domain/calendar';
import { BlockSchema, CandidateSchema, CourseSchema, SnapshotSchema, TaskSchema, type CalendarItem, type Snapshot } from '../shared/contracts';
import { calendarAttention } from './calendar-attention';
import { Calendar } from './components/Calendar';

const metadata = { version: 1, createdAt: '2026-10-22T08:00:00+08:00', updatedAt: '2026-10-22T08:00:00+08:00' };
function snapshot(): Snapshot {
  return SnapshotSchema.parse({ schemaVersion: 1, sources: [], candidates: [], tasks: [], blocks: [], goals: [], courses: [], courseExceptions: [], preferences: [], feedback: [], settings: { showPending: true }, journal: [], tokenUsage: [], keyStatus: { configured: false, sessionOnly: false } });
}
function task(id: string, values = {}) {
  return TaskSchema.parse({ ...metadata, id, title: id, ...values });
}
function block(id: string, values = {}) {
  return BlockSchema.parse({ ...metadata, id, title: id, kind: 'work', start: '2026-10-23T09:00:00+08:00', end: '2026-10-23T10:00:00+08:00', ...values });
}
function calendar(state: Snapshot, date = '2026-10-23') {
  const props = { snapshot: state, date, setDate: vi.fn(), select: vi.fn(), schedule: vi.fn(), courses: vi.fn() };
  return { ...render(<Calendar {...props} />), props };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('personal calendar attention states', () => {
  it('does not infer overdue or ended status from an invalid current time', () => {
    const state = snapshot(); state.blocks.push(block('练习'));
    state.tasks.push(task('截止', { deadline: { date: '2026-10-23', time: '10:00' } }));
    const items = buildCalendar(state, '2026-10-23', '2026-10-23', false);
    for (const now of [NaN, Infinity, -Infinity]) {
      for (const item of items) expect(calendarAttention(item, state, now)).toEqual({ tone: 'normal', label: '' });
    }
  });

  it('marks an unfinished work slot at its exact end, refreshes while open, and keeps selection available', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T09:59:30+08:00'));
    const state = snapshot(); state.blocks.push(block('学习时段'));
    const ui = calendar(state);
    const item = ui.container.querySelector('[data-timeline-item="学习时段"]')!;
    expect(item.classList.contains('calendar-attention')).toBe(false);
    act(() => vi.advanceTimersByTime(30_000));
    expect(item.classList.contains('calendar-attention')).toBe(true);
    expect(screen.getByText('已结束 · 待处理')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /学习时段.*已结束 · 待处理/ }));
    expect(ui.props.select).toHaveBeenCalledWith({ entity: 'block', id: '学习时段', occurrenceDate: '2026-10-23' });
    expect(state.blocks[0]!.completed).toBe(false);
  });

  it('uses the full default thirty-minute activity end across midnight for both rendered day segments', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T00:19:30+08:00'));
    const state = snapshot(); state.blocks.push(block('夜间活动', { kind: 'event', start: '2026-10-23T23:50:00+08:00', end: null }));
    const ui = calendar(state, '2026-10-24');
    const items = () => [...ui.container.querySelectorAll('[data-timeline-item="夜间活动"]')];
    expect(items()).toHaveLength(2);
    expect(items().every(item => !item.classList.contains('calendar-attention'))).toBe(true);
    act(() => vi.advanceTimersByTime(30_000));
    expect(items().every(item => item.classList.contains('calendar-attention'))).toBe(true);
    expect(state.blocks[0]!.end).toBeNull();
  });

  it('renders completed blocks and blocks belonging to completed tasks as quiet history', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T10:30:00+08:00'));
    const state = snapshot(); state.tasks.push(task('done-task', { status: 'done' }));
    state.blocks.push(block('已完成时段', { completed: true }), block('已完成任务的活动', { kind: 'event', taskId: 'done-task' }), block('未处理活动', { kind: 'event' }));
    const ui = calendar(state);
    for (const id of ['已完成时段', '已完成任务的活动']) {
      const item = ui.container.querySelector(`[data-timeline-item="${id}"]`)!;
      expect(item.classList.contains('calendar-completed')).toBe(true);
      expect(item.classList.contains('calendar-attention')).toBe(false);
      expect(item.textContent).not.toContain('待处理');
    }
    state.blocks[2]!.completed = true;
    ui.rerender(<Calendar {...ui.props} snapshot={{ ...state }} />);
    expect(ui.container.querySelectorAll('.timeline-event.calendar-attention')).toHaveLength(0);
    expect(ui.container.querySelectorAll('.timeline-event.calendar-completed')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '月' }));
    expect(ui.container.querySelectorAll('.month-item.calendar-completed')).toHaveLength(3);
    expect(screen.queryByText('已结束 · 待处理')).toBeNull();
  });

  it('keeps courses and candidate notices outside the personal pending-action lifecycle', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T11:00:00+08:00'));
    const state = snapshot();
    state.courses.push(CourseSchema.parse({ ...metadata, id: 'course', title: '数学课程', termStart: '2026-10-19', weekday: 5, startTime: '08:30', endTime: '10:05', firstWeek: 1, lastWeek: 1 }));
    state.candidates.push(CandidateSchema.parse({ ...metadata, id: 'candidate', title: '待判断通知', sourceIds: ['synthetic-source'], eventStart: '2026-10-23T12:00:00+08:00', eventEnd: '2026-10-23T13:00:00+08:00' }));
    const ui = calendar(state);
    expect(screen.getByRole('button', { name: /数学课程.*08:30–10:05/ }).parentElement!.classList.contains('calendar-normal')).toBe(true);
    expect(ui.container.querySelectorAll('.calendar-attention, .calendar-completed')).toHaveLength(0);
    const notice = buildCalendar(state, '2026-10-23', '2026-10-23', true).find(item => item.refKind === 'candidate')!;
    expect(calendarAttention(notice, state, Date.parse('2026-10-23T14:00:00+08:00'))).toEqual({ tone: 'normal', label: '' });
  });

  it('marks timed and all-day overdue deadlines in timeline, marker row and month view without warning for completed tasks', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T10:00:30+08:00'));
    const state = snapshot();
    state.tasks.push(task('昨天截止', { deadline: { date: '2026-10-22', time: null } }), task('准点截止', { deadline: { date: '2026-10-23', time: '10:00' } }), task('完成的截止', { status: 'done', deadline: { date: '2026-10-22', time: null } }));
    const ui = calendar(state);
    expect(ui.container.querySelector('.marker.calendar-attention')!.textContent).toContain('昨天截止');
    expect(ui.container.querySelector('.timeline-point.calendar-attention')!.textContent).toContain('准点截止');
    expect(screen.getAllByText('已逾期')).toHaveLength(2);
    expect(screen.queryByText(/完成的截止/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '月' }));
    expect(ui.container.querySelectorAll('.month-item.calendar-attention')).toHaveLength(2);
    expect(screen.getAllByText('已逾期')).toHaveLength(2);
    const completedMarker = { id: 'deadline:完成的截止', refKind: 'task', refId: '完成的截止', category: 'deadline' } as CalendarItem;
    expect(calendarAttention(completedMarker, state, Date.now())).toEqual({ tone: 'completed', label: '已完成' });
  });

  it('waits until the end of a date-only deadline in Beijing time and recovers attention on window focus', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T23:59:30+08:00'));
    const state = snapshot(); state.tasks.push(task('当天截止', { deadline: { date: '2026-10-23', time: null } }));
    const ui = calendar(state);
    expect(ui.container.querySelector('.marker.calendar-attention')).toBeNull();
    vi.setSystemTime(new Date('2026-10-24T00:00:00+08:00'));
    fireEvent.focus(window);
    expect(ui.container.querySelector('.marker.calendar-attention')!.textContent).toContain('已逾期');
  });
});
