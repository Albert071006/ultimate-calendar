import type { Snapshot, Task } from '../shared/contracts';
import { taskArrangements, taskNoticeTiming, noticeTimePassed } from './task-schedule';
import { fixedActivitySettled, taskDeadlineEnd } from '../domain/unscheduled';

type RailSnapshot = Pick<Snapshot, 'tasks' | 'blocks' | 'candidates' | 'sources'>;

export { taskDeadlineEnd };

export interface TaskAttention {
  kind: 'overdue' | 'ended';
  label: string;
  blockId?: string;
  actionLabel: '修改 DDL' | '重新安排' | '调整时间';
}

/** Passing a date never completes or removes a task. This is derived presentation only. */
export function taskAttention(snapshot: RailSnapshot, task: Task, now: number): TaskAttention | null {
  if (task.status !== 'open' || !Number.isFinite(now)) return null;
  const end = taskDeadlineEnd(task);
  if (end !== null && (task.deadline?.time === null ? now >= end : now > end)) {
    return { kind: 'overdue', label: '已逾期 · 待处理', actionLabel: '修改 DDL' };
  }
  const blocks = taskArrangements(snapshot, task.id);
  const ended = blocks.find(block => !block.cancelled && !block.completed && noticeTimePassed(block, now));
  if (ended) return { kind: 'ended', label: '已结束 · 待处理', blockId: ended.id, actionLabel: ended.kind === 'work' ? '重新安排' : '调整时间' };
  // Saved arrangements supersede original notices, including rescheduling and cancellation.
  const notice = !blocks.length ? taskNoticeTiming(snapshot, task.id) : null;
  return notice && noticeTimePassed(notice, now)
    ? { kind: 'ended', label: '已结束 · 待处理', actionLabel: '调整时间' }
    : null;
}

/** Only explicit completion/cancellation removes a fixed-activity task from the rail. */
function confirmedActivityResolved(snapshot: RailSnapshot, task: Task): boolean {
  return fixedActivitySettled(taskArrangements(snapshot, task.id));
}

/** Keep unfinished work visible, ordered by deadline; selection never mutates stored records. */
export function selectRailTasks(snapshot: RailSnapshot, _now: number): Task[] {
  return snapshot.tasks
    .map((task, index) => ({ task, index, end: taskDeadlineEnd(task) }))
    .filter(({ task }) => task.status === 'open' && !confirmedActivityResolved(snapshot, task))
    .sort((a, b) => (a.end ?? Infinity) - (b.end ?? Infinity) || a.index - b.index)
    .map(({ task }) => task);
}
