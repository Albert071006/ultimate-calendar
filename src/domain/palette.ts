import type { Course, Goal, Settings } from '../shared/contracts';
import { PALETTE_COLORS, PRIMARY_COLOR_COUNT, type PaletteColor } from '../shared/palette';
import type { StoredState } from '../storage/repository';
import { dayDistance } from './time';

function oklab(hex: string): [number, number, number] {
  const linear = [1, 3, 5].map(i => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const [r, g, b] = linear as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const distance = (a: string, b: string) => { const x = oklab(a), y = oklab(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };

/** Farthest free primary first, spares only when primaries are exhausted, least-used once every color is taken. */
export function pickColor(occupied: readonly string[]): PaletteColor {
  const counts = new Map<string, number>();
  for (const color of occupied) counts.set(color, (counts.get(color) ?? 0) + 1);
  const free = (list: readonly PaletteColor[]) => list.filter(color => !counts.has(color));
  const primaries = free(PALETTE_COLORS.slice(0, PRIMARY_COLOR_COUNT));
  const candidates = primaries.length ? primaries : free(PALETTE_COLORS.slice(PRIMARY_COLOR_COUNT));
  if (!candidates.length) return PALETTE_COLORS.reduce((best, color) => (counts.get(color) ?? 0) < (counts.get(best) ?? 0) ? color : best);
  const used = [...counts.keys()];
  if (!used.length) return candidates[0]!;
  const score = (color: string) => Math.min(...used.map(other => distance(color, other)));
  return candidates.reduce((best, color) => score(color) > score(best) ? color : best);
}

/** A course holds its color while it belongs to the configured term and its last week has not passed. */
export function courseIsCurrent(course: Course, settings: Settings, today: string): boolean {
  if (settings.termStart && course.termStart !== settings.termStart) return false;
  return Math.floor(dayDistance(course.termStart, today) / 7) + 1 <= course.lastWeek;
}

/** Colors held by current-term courses (once per course title) and active goals, with repeats. */
export function occupiedColors(data: { courses: Course[]; goals: Goal[]; settings: Settings }, today: string): string[] {
  const titles = new Set<string>(), colors: string[] = [];
  for (const course of data.courses) if (course.color && courseIsCurrent(course, data.settings, today) && !titles.has(course.title)) { titles.add(course.title); colors.push(course.color); }
  for (const goal of data.goals) if (goal.color && goal.status === 'active') colors.push(goal.color);
  return colors;
}

/** Fill empty course/goal colors in place without new versions, and give undo images the same color so undo stays valid. */
export function assignMissingColors(state: StoredState, today: string): void {
  const courses = state.entities.course as Course[], goals = state.entities.goal as Goal[];
  const occupied = occupiedColors({ courses, goals, settings: state.settings }, today);
  const byTitle = new Map(courses.filter(course => course.color).map(course => [course.title, course.color!]));
  const assigned = new Map<string, PaletteColor>();
  for (const course of courses) {
    if (course.color) continue;
    let color = byTitle.get(course.title);
    if (!color) {
      color = pickColor(occupied); byTitle.set(course.title, color);
      if (courseIsCurrent(course, state.settings, today)) occupied.push(color);
    }
    course.color = color; assigned.set(`course:${course.id}`, color);
  }
  for (const goal of goals) {
    if (goal.color) continue;
    const color = pickColor(occupied); if (goal.status === 'active') occupied.push(color);
    goal.color = color; assigned.set(`goal:${goal.id}`, color);
  }
  if (!assigned.size) return;
  for (const journal of state.journal) for (const detail of [...journal.details, ...(journal.undoExpected ?? [])]) {
    const color = assigned.get(`${detail.entity}:${detail.id}`); if (!color) continue;
    for (const image of [detail.before, detail.after]) if (image && 'color' in image && image.color === null) image.color = color;
  }
}
