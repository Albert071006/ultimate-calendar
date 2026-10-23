export { addCalendarDays, mondayWeekday, shanghaiDate, toShanghaiInstant } from '../shared/contracts';
import { InstantSchema, type Instant } from '../shared/contracts';
export function nowInstant(): Instant { return instantAt(Date.now()); }
export function instantAt(ms: number): Instant { return InstantSchema.parse(new Date(ms + 8 * 3600_000).toISOString().replace('.000Z', '+08:00').replace('Z', '+08:00')); }
export function dayDistance(from: string, to: string): number { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000); }
export function intersectsDays(start: string, end: string | null, from: string, to: string): boolean {
  const lower = Date.parse(`${from}T00:00:00+08:00`); const upper = Date.parse(`${to}T00:00:00+08:00`) + 86400_000;
  return Date.parse(start) < upper && (end ? Date.parse(end) > lower : Date.parse(start) >= lower);
}
