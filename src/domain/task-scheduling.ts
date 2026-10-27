import type { Block, Task } from '../shared/contracts';

type SchedulingTask = Pick<Task, 'id' | 'scheduleMode'>;
type SchedulingBlock = Pick<Block, 'taskId' | 'cancelled' | 'recurrence'>;

/** Existing multiple arrangements remain usable without rewriting old records on read. */
export function taskScheduleMode(task: SchedulingTask, blocks: readonly SchedulingBlock[]): 'single' | 'multiple' {
  if (task.scheduleMode) return task.scheduleMode;
  const linked = blocks.filter(block => block.taskId === task.id);
  return linked.some(block => block.recurrence) || linked.filter(block => !block.cancelled).length > 1 ? 'multiple' : 'single';
}

/** Resolve the mode before adding slots, so a new second slot cannot make itself look like legacy data. */
export function taskScheduleLimitExceeded(task: SchedulingTask, blocks: readonly SchedulingBlock[], previousTask?: SchedulingTask, previousBlocks: readonly SchedulingBlock[] = []): boolean {
  const mode = task.scheduleMode ?? (previousTask ? taskScheduleMode(previousTask, previousBlocks) : 'single');
  const linked = blocks.filter(block => block.taskId === task.id && !block.cancelled);
  return mode === 'single' && (linked.length > 1 || linked.some(block => block.recurrence));
}
