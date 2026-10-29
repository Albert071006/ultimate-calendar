import type { Snapshot, Task } from '../shared/contracts';
import { taskDeadlineEnd } from '../domain/unscheduled';
import { dayDistance } from '../domain/time';
import { nextTaskArrangement, noticeTimePassed, taskArrangements, taskNoticeTiming } from './task-schedule';

type TodaySnapshot = Pick<Snapshot, 'tasks' | 'blocks' | 'candidates' | 'sources'>;
type OpenGroup = 'over' | 'today' | 'week' | 'later' | 'none';
export type TodayTaskGroup = OpenGroup | 'done';
export const todayTaskGroupNames: Record<TodayTaskGroup, string> = {
  over: '已过时间', today: '今天', week: '本周', later: '以后', none: '时间未定', done: '已完成',
};

interface TaskTime { order: number; date: string; passed: boolean }

/** Display the next thing to act on, without turning an activity time into a deadline. */
function taskTime(snapshot: TodaySnapshot, task: Task, now: number): TaskTime | null {
  const end = taskDeadlineEnd(task);
  const deadline: TaskTime | null = end !== null && task.deadline ? {
    // A date-only deadline belongs to that day, immediately before the next midnight.
    order: end - (task.deadline.time === null ? 1 : 0), date: task.deadline.date,
    passed: task.deadline.time === null ? end <= now : end < now,
  } : null;
  const saved = taskArrangements(snapshot, task.id);
  const unfinished = saved.filter(block => !block.cancelled && !block.completed);
  // Any saved arrangement supersedes the notice, including cancellation/completion.
  const arrangement = saved.length ? nextTaskArrangement(unfinished, now) : taskNoticeTiming(snapshot, task.id);
  if (!arrangement) return deadline;
  const activity: TaskTime = { order: Date.parse(arrangement.start), date: arrangement.start.slice(0, 10), passed: noticeTimePassed(arrangement, now) };
  return deadline && deadline.order <= activity.order ? deadline : activity;
}

/** Group/sort today's to-do list by deadline or actual activity time; preserve stable ties. */
export function groupTodayTasks(snapshot: TodaySnapshot, tasks: Task[], today: string, now: number): (readonly [OpenGroup, Task[]])[] {
  const weekday = (new Date(`${today}T12:00:00+08:00`).getUTCDay() + 6) % 7;
  const rows = tasks.map((task, index) => {
    const time = taskTime(snapshot, task, now);
    const group: OpenGroup = !time ? 'none' : time.passed ? 'over'
      // An ongoing activity which began yesterday still needs attention today.
      : time.date <= today ? 'today'
      : dayDistance(today, time.date) <= 6 - weekday ? 'week' : 'later';
    return { task, index, time, group };
  }).sort((a, b) => (a.time?.order ?? Infinity) - (b.time?.order ?? Infinity) || a.index - b.index);
  return (['over', 'today', 'week', 'later', 'none'] as const)
    .map(key => [key, rows.filter(row => row.group === key).map(row => row.task)] as const)
    .filter(([, list]) => list.length);
}
