import type { CalendarItem } from '../../../shared/contracts';
import { formatFriendlyDate, formatFriendlyRange } from '../../../shared/display-time';

/** Calendar rows supplement the answer; they are never silently appended to it. */
export function AssistantCalendarItems({ items, reply }: { items?: CalendarItem[]; reply: string }) {
  if (!items?.length) return null;
  return <details className="assistant-calendar-items" open={!reply.trim() || undefined}>
    <summary>相关日程 · {items.length} 项</summary>
    <p className="ui-hint">所查日期范围的日程，不代表未完成事项。</p>
    <ul>{items.map(item => <li key={item.id}>
      <span>{item.start ? formatFriendlyRange(item.start, item.end) : formatFriendlyDate(item.date)}</span>
      <strong>{item.title}</strong>
      {item.location && <span>{item.location}</span>}
    </li>)}</ul>
  </details>;
}
