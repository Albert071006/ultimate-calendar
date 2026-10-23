import { addCalendarDays, toShanghaiInstant, type Course, type CourseException, type CalendarItem } from '../shared/contracts';
import { dayDistance, intersectsDays } from './time';
export function courseOccurs(course: Course, date: string): boolean {
  const offset = dayDistance(course.termStart, date); const week = Math.floor(offset / 7) + 1;
  return offset >= 0 && offset % 7 === course.weekday - 1 && week >= course.firstWeek && week <= course.lastWeek &&
    (!course.weeks || course.weeks.includes(week)) && (course.parity === 'all' || week % 2 === (course.parity === 'odd' ? 1 : 0));
}
export function expandCourse(course: Course, exceptions: CourseException[], from: string, to: string): CalendarItem[] {
  const items: CalendarItem[] = []; const relevant = exceptions.filter(e => e.courseId === course.id);
  for (let week = course.firstWeek; week <= course.lastWeek; week++) {
    const date = addCalendarDays(course.termStart, (week - 1) * 7 + course.weekday - 1);
    if (!courseOccurs(course, date)) continue;
    const exception = relevant.find(e => e.originalDate === date);
    if (exception) {
      if (exception.replacement) { const r = exception.replacement; const replacementDate = r.start.slice(0, 10);
        if (intersectsDays(r.start, r.end, from, to)) items.push({ id: `${course.id}:${date}`, refId: course.id, refKind: 'course', occurrenceDate: date, title: r.title, date: replacementDate, start: r.start, end: r.end, busy: true, pending: false, category: 'course', location: r.location }); }
    } else if (date >= from && date <= to) items.push({ id: `${course.id}:${date}`, refId: course.id, refKind: 'course', occurrenceDate: date, title: course.title, date, start: toShanghaiInstant(date, course.startTime), end: toShanghaiInstant(date, course.endTime), busy: true, pending: false, category: 'course', location: course.location });
  }
  return items;
}
