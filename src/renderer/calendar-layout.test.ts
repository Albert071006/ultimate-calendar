import { describe, expect, it } from "vitest";
import { calendarDays, clipInterval, moveDate } from "./calendar-layout";
describe("calendar layout", () => {
  it('starts three-day browsing at the selected date and advances by three across month/year boundaries', () => {
    expect(calendarDays('2026-12-31', 'three-day')).toEqual(['2026-12-31', '2027-01-01', '2027-01-02']);
    expect(moveDate('2026-12-31', 'three-day', 1)).toBe('2027-01-03');
    expect(moveDate('2027-01-02', 'three-day', -1)).toBe('2026-12-30');
    expect(calendarDays('2026-10-24', 'day')).toEqual(['2026-10-24']);
  });
  it("uses Monday weeks, full month rows, and real month navigation", () => {
    expect(calendarDays("2026-10-22", "week")).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
    expect(calendarDays("2026-10-22", "month")).toHaveLength(35);
    expect(moveDate("2026-01-31", "month", 1)).toBe("2026-02-28");
  });
  it("clips a cross-day interval without placing its full length in either day", () => {
    expect(
      clipInterval(
        "2026-10-22T23:00:00+08:00",
        "2026-10-23T01:30:00+08:00",
        "2026-10-22",
      ),
    ).toEqual({ startMinute: 1380, endMinute: 1440 });
    expect(
      clipInterval(
        "2026-10-22T23:00:00+08:00",
        "2026-10-23T01:30:00+08:00",
        "2026-10-23",
      ),
    ).toEqual({ startMinute: 0, endMinute: 90 });
    expect(
      clipInterval(
        "2026-10-22T23:00:00+08:00",
        "2026-10-23T00:00:00+08:00",
        "2026-10-23",
      ),
    ).toBeNull();
  });
});
