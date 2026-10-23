import { DAY_MINUTES, dayStart, localDateTime, minutePosition } from '../calendar-timeline';
import './CurrentTimeIndicator.css';

/** Use the same Asia/Shanghai day boundary and minute axis as calendar events. */
export function currentTimePosition(day: string, now: number): { minute: number; time: string } | null {
  const minute = (now - dayStart(day)) / 60_000;
  if (!Number.isFinite(minute) || minute < 0 || minute >= DAY_MINUTES) return null;
  return { minute, time: localDateTime(now).slice(11, 16) };
}

export function CurrentTimeIndicator({ day, now }: { day: string; now: number }) {
  const current = currentTimePosition(day, now);
  if (!current) return null;
  const top = minutePosition(current.minute);
  return (
    <div className="calendar-current-time" style={{ top }} data-at-start={top < 24 || undefined}
      role="note" aria-label={`当前时间 ${current.time}（北京时间）`}>
      <span className="calendar-current-time-dot" aria-hidden="true" />
      <time className="calendar-current-time-label" dateTime={new Date(now).toISOString()}>{current.time}</time>
    </div>
  );
}
