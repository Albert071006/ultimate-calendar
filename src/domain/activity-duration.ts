import { instantAt } from './time';

export const DEFAULT_ACTIVITY_MINUTES = 30;

/** Missing source end times use a planning duration without rewriting the source. */
export function effectiveActivityEnd(start: string, end: string | null): string {
  return end ?? instantAt(Date.parse(start) + DEFAULT_ACTIVITY_MINUTES * 60_000);
}
