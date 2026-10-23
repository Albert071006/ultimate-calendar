import { addCalendarDays, mondayWeekday } from "../shared/contracts";
export type CalendarView = "day" | "week" | "month";
export function calendarDays(date: string, view: CalendarView): string[] {
  if (view === "day") return [date];
  const first = view === "week" ? date : `${date.slice(0, 7)}-01`;
  const start = addCalendarDays(first, 1 - mondayWeekday(first));
  if (view === "week")
    return Array.from({ length: 7 }, (_, i) => addCalendarDays(start, i));
  const next = new Date(`${first}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = addCalendarDays(next.toISOString().slice(0, 10), -1);
  const end = addCalendarDays(last, 7 - mondayWeekday(last));
  const length =
    Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  return Array.from({ length }, (_, i) => addCalendarDays(start, i));
}
export function moveDate(
  date: string,
  view: CalendarView,
  direction: number,
): string {
  if (view !== "month")
    return addCalendarDays(date, direction * (view === "week" ? 7 : 1));
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + direction);
  const end = new Date(d);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return `${d.toISOString().slice(0, 7)}-${String(Math.min(Number(date.slice(8)), end.getUTCDate())).padStart(2, "0")}`;
}
export function clipInterval(
  start: string,
  end: string | null,
  date: string,
): { startMinute: number; endMinute: number } | null {
  const day = Date.parse(`${date}T00:00:00+08:00`),
    from = Date.parse(start),
    to = end ? Date.parse(end) : from + 60000;
  if (from >= day + 86400000 || to <= day) return null;
  return {
    startMinute: Math.max(0, (from - day) / 60000),
    endMinute: Math.min(1440, (to - day) / 60000),
  };
}
export const todayDate = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export const displayInstant = (value: string | null | undefined) =>
  value ? value.slice(0, 16).replace("T", " ") : "未提供";
export const operationId = () => crypto.randomUUID();
