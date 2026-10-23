import type { Block, Task } from '../shared/contracts';
import { effectiveActivityEnd } from './activity-duration';

/** Date-only deadlines last until the end of that Shanghai day. */
export function taskDeadlineEnd(task: Task): number | null {
  if (!task.deadline) return null;
  const end = Date.parse(`${task.deadline.date}T${task.deadline.time ?? '00:00'}:00+08:00`)
    + (task.deadline.time === null ? 86_400_000 : 0);
  return Number.isFinite(end) ? end : null;
}

/** Fixed activities that were all attended or cancelled settle their task; only explicit records do this. */
export function fixedActivitySettled(blocks: Block[]): boolean {
  return blocks.length > 0 && blocks.every(block => block.kind === 'event' && (block.completed || block.cancelled));
}

/** Open tasks with no unfinished arrangement still ahead, including ones whose sessions all ended. Ordered by deadline. */
export function unscheduledTasks(data: { tasks: Task[]; blocks: Block[] }, now: number): Task[] {
  return data.tasks
    .map((task, index) => ({ task, index, end: taskDeadlineEnd(task) }))
    .filter(({ task }) => {
      if (task.status !== 'open') return false;
      const own = data.blocks.filter(block => block.taskId === task.id);
      if (fixedActivitySettled(own)) return false;
      return !own.some(block => !block.cancelled && !block.completed && Date.parse(effectiveActivityEnd(block.start, block.end)) > now);
    })
    .sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity) || a.index - b.index)
    .map(({ task }) => task);
}
