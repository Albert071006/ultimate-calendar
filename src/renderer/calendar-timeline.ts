import type { CalendarItem } from '../shared/contracts';
import { clipInterval } from './calendar-layout';

export const HOUR_HEIGHT = 96;
export const DAY_MINUTES = 1440;
export const DAY_HEIGHT = HOUR_HEIGHT * 24;
export const minutePosition = (minute: number) => minute * HOUR_HEIGHT / 60;
export const dayStart = (date: string) => Date.parse(`${date}T00:00:00+08:00`);
export function localDateTime(ms: number): string { return new Date(ms + 8 * 3600_000).toISOString().slice(0, 16); }
export function minuteAt(clientY: number, bounds: { top: number; height: number }, max = DAY_MINUTES): number {
  return Math.max(0, Math.min(max, Math.round((clientY - bounds.top) / (bounds.height || DAY_HEIGHT) * DAY_MINUTES)));
}
export function draftRange(start: number, end: number, blockId?: string) {
  const local = localDateTime(start);
  return { date: local.slice(0, 10), time: local.slice(11), end: localDateTime(end), ...(blockId ? { blockId } : {}) };
}

export interface PositionedInterval { item: CalendarItem; startMinute: number; endMinute: number; column: number; columns: number }
/** Half-open intervals sharing time use separate columns. Adjacent events do not collide. */
export function positionIntervals(items: CalendarItem[], day: string): PositionedInterval[] {
  const values = items.flatMap(item => {
    if (!item.start || !item.end) return [];
    const clipped = clipInterval(item.start, item.end, day);
    return clipped ? [{ item, ...clipped, column: 0, columns: 1 }] : [];
  }).sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute || a.item.id.localeCompare(b.item.id));
  let group: PositionedInterval[] = [], groupEnd = -1, ends: number[] = [];
  const finish = () => { for (const value of group) value.columns = ends.length; group = []; ends = []; };
  for (const value of values) {
    if (value.startMinute >= groupEnd) finish();
    let column = ends.findIndex(end => end <= value.startMinute);
    if (column < 0) column = ends.length;
    ends[column] = value.endMinute; value.column = column; group.push(value);
    groupEnd = group.length === 1 ? value.endMinute : Math.max(groupEnd, value.endMinute);
  }
  finish(); return values;
}

export type TimelineOperation = 'create' | 'move' | 'resize-start' | 'resize-end';
export function gestureRange(operation: TimelineOperation, pointer: number, initialStart: number, initialEnd: number, grabOffset = 0): { start: number; end: number } {
  if (operation === 'move') { const start = pointer - grabOffset; return { start, end: start + initialEnd - initialStart }; }
  if (operation === 'resize-start') return { start: Math.min(pointer, initialEnd - 60_000), end: initialEnd };
  if (operation === 'resize-end') return { start: initialStart, end: Math.max(pointer, initialStart + 60_000) };
  return { start: Math.min(pointer, initialStart), end: Math.max(pointer, initialStart + (pointer === initialStart ? 60_000 : 0)) };
}
