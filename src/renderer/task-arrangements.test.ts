import { describe, expect, it } from 'vitest';
import { BlockSchema, type Block } from '../shared/contracts';
import { nextTaskArrangement, taskArrangements, taskArrangementSummary, taskEvents } from './task-schedule';

const now = Date.parse('2026-10-24T12:00:00+08:00');
function block(id: string, date: string, kind: 'work' | 'event' = 'work'): Block {
  return BlockSchema.parse({ id, title: id, taskId: 'task', kind, start: `${date}T13:00:00+08:00`, end: `${date}T14:00:00+08:00`,
    version: 1, createdAt: '2026-10-23T09:00:00+08:00', updatedAt: '2026-10-23T09:00:00+08:00' });
}

describe('all task arrangements', () => {
  it('includes saved work sessions and fixed activities in time order, without changing event-only recurrence queries', () => {
    const work = block('work', '2026-10-24'), event = block('event', '2026-10-25', 'event');
    const snapshot = { blocks: [event, { ...work, id: 'other', taskId: 'other-task' }, work] };
    expect(taskArrangements(snapshot, 'task')).toEqual([work, event]);
    expect(taskEvents(snapshot, 'task')).toEqual([event]);
    expect(snapshot.blocks[0]).toBe(event);
    expect(taskArrangementSummary([work], now)).toContain('已安排 · 2026-10-24 13:00');
    expect(taskArrangementSummary([work], now)).toContain('执行时段');
  });

  it('opens the next active slot instead of cancelled/completed or ended slots, and can still open ended history', () => {
    const past = block('past', '2026-10-23'), next = block('next', '2026-10-25');
    const cancelled = { ...block('cancelled', '2026-10-24', 'event'), cancelled: true };
    const completed = { ...block('completed', '2026-10-24'), completed: true };
    expect(nextTaskArrangement([past, cancelled, completed, next], now)).toBe(next);
    expect(nextTaskArrangement([past, cancelled, completed], now)).toBe(past);
    expect(nextTaskArrangement([cancelled], now)).toBeUndefined();
    expect(nextTaskArrangement([completed], now)).toBe(completed);
    expect(taskArrangementSummary([completed], now)).toContain('本次已完成');
  });

  it('retains cancelled history without reopening it as an active arrangement and counts both kinds in upcoming summary', () => {
    const work = block('work', '2026-10-24'), event = block('event', '2026-10-25', 'event');
    expect(taskArrangementSummary([work, event], now)).toContain('剩余2次');
    expect(taskArrangementSummary([{ ...event, cancelled: true }], now)).toContain('活动已全部取消');
  });

  it('summarizes the same unfinished occurrence that 查看安排 opens after a later occurrence was completed', () => {
    const unfinished = block('unfinished', '2026-10-22', 'event');
    const finished = { ...block('finished', '2026-10-23', 'event'), completed: true };
    const blocks = [unfinished, finished];
    expect(nextTaskArrangement(blocks, now)).toBe(unfinished);
    expect(taskArrangementSummary(blocks, now)).toContain('2026-10-22 13:00');
    expect(taskArrangementSummary(blocks, now)).not.toContain('本次已完成');
  });
});
