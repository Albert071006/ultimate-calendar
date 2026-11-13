import { effectiveActivityEnd } from '../domain/activity-duration';
import type { CalendarItem, Snapshot } from '../shared/contracts';

export interface CalendarAttention {
  tone: 'normal' | 'attention' | 'completed' | 'elapsed';
  label: string;
}

const normal: CalendarAttention = { tone: 'normal', label: '' };
const completed: CalendarAttention = { tone: 'completed', label: '已完成' };

/** Calendar status describes the saved item, never just a clipped day segment. */
export function calendarAttention(item: CalendarItem, snapshot: Pick<Snapshot, 'tasks' | 'blocks'>, now: number): CalendarAttention {
  if (item.refKind === 'block') {
    const block = snapshot.blocks.find(value => value.id === item.refId);
    if (!block || block.cancelled) return normal;
    const task = block.taskId ? snapshot.tasks.find(value => value.id === block.taskId) : undefined;
    if (block.completed || task?.status === 'done') return completed;
    const end = block.kind === 'event' ? effectiveActivityEnd(block.start, block.end) : block.end;
    if (!Number.isFinite(now) || !end || !Number.isFinite(Date.parse(end)) || Date.parse(end) > now) return normal;
    // A fixed event has simply elapsed. It is not unfinished work and the clock
    // alone cannot prove attendance or mark its linked task completed.
    return block.kind === 'event' ? { tone: 'elapsed', label: '已结束' } : { tone: 'attention', label: '已结束 · 待处理' };
  }
  if (item.refKind === 'task' && item.category === 'deadline') {
    const task = snapshot.tasks.find(value => value.id === item.refId);
    if (task?.status === 'done') return completed;
    if (!task?.deadline) return normal;
    const end = Date.parse(`${task.deadline.date}T${task.deadline.time ?? '00:00'}:00+08:00`)
      + (task.deadline.time === null ? 86_400_000 : 0);
    const overdue = Number.isFinite(now) && (task.deadline.time === null ? now >= end : now > end);
    return overdue ? { tone: 'attention', label: '已逾期' } : normal;
  }
  // Courses and undecided candidates retain their own lifecycle and appearance.
  return normal;
}
