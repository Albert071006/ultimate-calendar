import type { CSSProperties } from "react";
import { Plus } from "lucide-react";
import type { CalendarItem } from "../../../shared/contracts";
import "./MonthView.css";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const LIMIT = 3;

/**
 * Month overview: courses are only dots beside the date (they repeat every week and would crowd out
 * everything else); each cell lists at most three deadlines, activities and sessions.
 */
export function MonthView({ days, month, today, items, inDay, tone, label, colorStyle, open, edit, openDay, schedule }: {
  days: string[];
  /** YYYY-MM of the month being shown; other dates are drawn as spill-over. */
  month: string;
  today: string;
  items: CalendarItem[];
  inDay: (item: CalendarItem, day: string) => boolean;
  tone: (item: CalendarItem) => string;
  label: (item: CalendarItem) => string;
  colorStyle: (item: CalendarItem) => CSSProperties;
  open: (item: CalendarItem, day: string) => void;
  edit: (item: CalendarItem, day: string) => void;
  openDay: (day: string) => void;
  schedule: (day: string) => void;
}) {
  const kind = (item: CalendarItem) => {
    const status = tone(item);
    if (status === "completed") return "done";
    if (item.category === "candidate") return "pending";
    if (item.category === "deadline") return status === "attention" ? "overdue" : "ddl";
    if (status === "attention") return "unfinished";
    return item.category;
  };
  return (
    <div className="a2-month">
      <div className="a2-m-head">{weekdays.map(w => <div key={w}>周{w}</div>)}</div>
      <div className="a2-m-grid" style={{ gridTemplateRows: `repeat(${days.length / 7}, minmax(96px, 1fr))` }}>
        {days.map(day => {
          const list = items.filter(item => inDay(item, day));
          const courses = list.filter(item => item.category === "course");
          const seen = new Set<string>();
          const dots = courses.filter(item => !seen.has(item.title) && seen.add(item.title));
          const entries = list.filter(item => item.category !== "course")
            .sort((a, b) => (a.start ?? `${a.date}T24`).localeCompare(b.start ?? `${b.date}T24`));
          const hidden = entries.length - LIMIT;
          return (
            <div key={day} className={`a2-m-cell${day.slice(0, 7) !== month ? " out" : ""}${day === today ? " today" : ""}`} data-day={day}>
              <div className="a2-m-top">
                <button className="a2-m-d" onClick={() => openDay(day)} aria-label={`打开 ${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`}>{Number(day.slice(8))}</button>
                {dots.length > 0 && <span className="a2-m-dots" title={dots.map(item => item.title).join("、")} aria-label={`${dots.length} 门课`}>
                  {dots.map(item => <i key={item.id} style={colorStyle(item)} />)}
                </span>}
                <button className="a2-m-add" onClick={() => schedule(day)} aria-label={`在 ${day} 安排`} title="在这天安排"><Plus aria-hidden="true" /></button>
              </div>
              {entries.slice(0, LIMIT).map(item => (
                <button key={item.id} className={`month-item a2-m-it ${kind(item)} calendar-${tone(item)}`} style={colorStyle(item)}
                  onClick={() => open(item, day)} onDoubleClick={() => edit(item, day)}
                  title={`${item.category === "candidate" ? "待定 · " : ""}${item.title}${item.start ? ` ${item.start.slice(11, 16)}` : ""}${label(item) ? ` · ${label(item)}` : ""}`}>
                  {item.start && item.start.slice(0, 10) === day && <b>{item.start.slice(11, 16)}</b>}{item.title}
                  {label(item) && <span className="a2-visually-hidden"> {label(item)}</span>}
                </button>
              ))}
              {hidden > 0 && <button className="a2-m-more" onClick={() => openDay(day)}>还有 {hidden} 项</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
