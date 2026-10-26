import type { CSSProperties } from 'react';
import type { CalendarItem, Snapshot } from '../../shared/contracts';
import { belongingColor } from '../../domain/belonging';
import { workFill } from '../work-fill';

export const kindNames: Record<CalendarItem['category'], string> = { course: '课程', work: '执行时段', event: '固定活动', deadline: '截止', candidate: '待决定' };

/** Belonging color of a course, or of the task behind a block or deadline, as the shared `--c` / `--wf` variables. */
export function itemColor(item: CalendarItem, snapshot: Snapshot): CSSProperties {
  const block = item.refKind === 'block' ? snapshot.blocks.find(value => value.id === item.refId) : undefined;
  const task = block?.taskId ? snapshot.tasks.find(value => value.id === block.taskId)
    : item.refKind === 'task' ? snapshot.tasks.find(value => value.id === item.refId) : undefined;
  const course = item.refKind === 'course' ? snapshot.courses.find(value => value.id === item.refId) : undefined;
  const color = course?.color ?? (task ? belongingColor(task, snapshot) : null);
  return color ? { '--c': color, '--wf': workFill(color) } as CSSProperties : {};
}

export const clock = (instant: string | null | undefined) => instant?.slice(11, 16) ?? '';
export const weekdayName = (date: string) => '一二三四五六日'[(new Date(`${date}T12:00:00+08:00`).getUTCDay() + 6) % 7]!;
export const shortDate = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
