import type { Course, Goal, Task } from '../shared/contracts';

/** A task's belonging color: its course first, then its goal; null means the plain work color. */
export function belongingColor(task: Pick<Task, 'courseId' | 'goalId'>, data: { courses: Course[]; goals: Goal[] }): string | null {
  const course = task.courseId ? data.courses.find(value => value.id === task.courseId) : undefined;
  if (course?.color) return course.color;
  const goal = task.goalId ? data.goals.find(value => value.id === task.goalId) : undefined;
  return goal?.color ?? null;
}
