import type { Snapshot, Task } from '../shared/contracts';
import { effectiveActivityEnd } from '../domain/activity-duration';
import { taskNoticeTiming } from './task-schedule';

type RailSnapshot = Pick<Snapshot, 'tasks' | 'blocks' | 'candidates' | 'sources'>;

function deadlineEnd(task: Task): number | null {
  if (!task.deadline) return null;
  const end = Date.parse(`${task.deadline.date}T${task.deadline.time ?? '00:00'}:00+08:00`)
    + (task.deadline.time === null ? 86_400_000 : 0);
  return Number.isFinite(end) ? end : null;
}

function activityEnded(timing: { start: string; end: string | null; completed?: boolean; cancelled?: boolean }, now: number): boolean {
  if (timing.completed || timing.cancelled) return true;
  if (!Number.isFinite(now)) return false;
  const end = Date.parse(effectiveActivityEnd(timing.start, timing.end));
  return Number.isFinite(end) && end <= now;
}

function taskActivityEnded(snapshot: RailSnapshot, task: Task, now: number): boolean {
  const events = snapshot.blocks.filter(block => block.taskId === task.id && block.kind === 'event');
  // Calendar edits supersede the original notice, including moving an activity to a later date.
  if (events.length) return events.every(event => activityEnded(event, now));
  const notice = taskNoticeTiming(snapshot, task.id);
  return notice !== null && activityEnded(notice, now);
}

/** The rail hides finished items without deleting tasks, sources, or calendar history. */
export function selectRailTasks(snapshot: RailSnapshot, now: number): Task[] {
  return snapshot.tasks
    .map((task, index) => ({ task, index, end: deadlineEnd(task) }))
    .filter(({ task, end }) => task.status === 'open' && (
      end === null || !Number.isFinite(now)
      || (task.deadline?.time === null ? now < end : now <= end)
    ) && !taskActivityEnded(snapshot, task, now))
    .sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity) || a.index - b.index)
    .map(({ task }) => task);
}
