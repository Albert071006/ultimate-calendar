import { addCalendarDays, mondayWeekday, RecurrenceRuleSchema, toShanghaiInstant, type Instant, type RecurrenceRuleInput } from '../shared/contracts';
import { dayDistance, instantAt } from './time';

export interface RecurrenceOccurrence { start: Instant; end: Instant }

/** Dates are inclusive. Every other week starts with the first matching weekday on or after fromDate. */
export function expandRecurrence(input: RecurrenceRuleInput): RecurrenceOccurrence[] {
  const rule = RecurrenceRuleSchema.parse(input);
  const firstOccurrence = addCalendarDays(rule.fromDate, (rule.weekday - mondayWeekday(rule.fromDate) + 7) % 7);
  const result: RecurrenceOccurrence[] = [];
  for (let date = rule.fromDate; date <= rule.untilDate; date = addCalendarDays(date, 1)) {
    if (mondayWeekday(date) !== rule.weekday) continue;
    if (rule.frequency === 'biweekly' && dayDistance(firstOccurrence, date) % 14 !== 0) continue;
    if (rule.frequency === 'odd-weeks' || rule.frequency === 'even-weeks') {
      const week = Math.floor(dayDistance(rule.termStart!, date) / 7) + 1;
      if (week < 1 || week % 2 !== (rule.frequency === 'odd-weeks' ? 1 : 0)) continue;
    }
    const start = toShanghaiInstant(date, rule.time);
    result.push({ start, end: instantAt(Date.parse(start) + rule.durationMinutes * 60_000) });
    if (result.length > 100) throw new Error('一次最多安排100次重复活动，请缩小日期范围');
  }
  return result;
}
