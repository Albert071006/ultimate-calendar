import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, PanelRight } from "lucide-react";
import type { PlannerUI } from "../hooks/usePlanner";
import { PageToolbar } from "./shell/PageToolbar";
import { belongingColor } from "../../domain/belonging";
import { buildCalendar } from "../../domain/calendar";
import { dayDistance } from "../../domain/time";
import type { CalendarItem, Snapshot } from "../../shared/contracts";
import {
  calendarDays,
  clipInterval,
  moveDate,
  type CalendarView,
} from "../calendar-layout";
import { DAY_HEIGHT, DAY_MINUTES, HOUR_HEIGHT, dayStart, draftRange, gestureRange, localDateTime, minuteAt, minutePosition, positionIntervals, type TimelineOperation } from '../calendar-timeline';
import { useCurrentTime } from '../hooks/useCurrentTime';
import { CurrentTimeIndicator, currentTimePosition } from './CurrentTimeIndicator';
import { MonthView } from './calendar/MonthView';
import { DaySidebar } from './calendar/DaySidebar';
import { calendarAttention } from '../calendar-attention';
import './CalendarTimeline.css';
import './calendar-attention.css';
import './calendar/Calendar.css';
export interface Selection {
  entity: CalendarItem["refKind"];
  id: string;
  occurrenceDate?: string;
}
export interface ScheduleDraft {
  date: string;
  time: string;
  taskId?: string;
  blockId?: string;
  /** Local datetime (YYYY-MM-DDTHH:mm), including the next date for midnight. */
  end?: string | null;
  kind?: 'work' | 'event';
  location?: string;
  timingNote?: string;
  noticeTaskVersion?: number;
}
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
type Gesture = { operation: TimelineOperation; pointerId: number; day: string; target: HTMLElement; item?: CalendarItem;
  initialStart: number; initialEnd: number; initialPointer: number; grabOffset: number; startX: number; startY: number; x: number; y: number; moved: boolean };
function focusCurrentTime(viewport: HTMLDivElement | null, date: string, view: CalendarView): boolean {
  if (!viewport || view === 'month') return false;
  const now = Date.now(), today = localDateTime(now).slice(0, 10);
  if (!calendarDays(date, view).includes(today)) return false;
  const current = currentTimePosition(today, now);
  if (!current) return false;
  // Leave more room for upcoming plans while keeping a little recent context visible.
  viewport.scrollTop = Math.max(0, Math.min(DAY_HEIGHT - viewport.clientHeight,
    minutePosition(current.minute) - viewport.clientHeight / 3));
  return true;
}
export function Calendar({
  snapshot,
  date,
  setDate,
  select,
  edit,
  schedule,
  courses,
  ui,
  panel,
  drawer,
  openCandidate,
  drawerOpen = false,
  toggleDrawer,
  unscheduledCount = 0,
}: {
  snapshot: Snapshot;
  date: string;
  setDate: (value: string) => void;
  select: (item: Selection) => void;
  /** Double-click: open the edit panel directly. */
  edit?: (item: Selection) => void;
  schedule: (draft: ScheduleDraft) => void;
  courses: () => void;
  /** Supplies the save notice and undo in the toolbar. */
  ui?: PlannerUI;
  /** The edit panel; while open it takes the drawer's place. */
  panel?: ReactNode;
  /** The unscheduled drawer, or nothing while it is collapsed. The day view wraps it in its sidebar. */
  drawer?: ReactNode;
  /** "稍后" on a notice in the day sidebar: open it in the inbox. */
  openCandidate?: (id: string) => void;
  drawerOpen?: boolean;
  toggleDrawer?: () => void;
  unscheduledCount?: number;
}) {
  const [view, setView] = useState<CalendarView>("week");
  const [pending, setPending] = useState(snapshot.settings.showPending);
  const now = useCurrentTime();
  const scroll = useRef<HTMLDivElement>(null);
  const columns = useRef(new Map<string, HTMLDivElement>());
  const gesture = useRef<Gesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<{ start: number; end: number; itemId?: string } | null>(null);
  const [cursor, setCursor] = useState<{ day: string; minute: number } | null>(null);
  const suppressClick = useRef<string | null>(null);
  const days = calendarDays(date, view),
    today = localDateTime(now).slice(0, 10);
  const items = buildCalendar(snapshot, days[0]!, days.at(-1)!, pending);
  const itemAttention = new Map(items.map(item => [item.id, calendarAttention(item, snapshot, now)]));
  const attentionClass = (item: CalendarItem) => `calendar-${itemAttention.get(item.id)!.tone}`;
  const attentionLabel = (item: CalendarItem) => itemAttention.get(item.id)!.label;
  const statusLabel = (item: CalendarItem) => attentionLabel(item)
    ? <span className="calendar-item-status">{attentionLabel(item)}</span> : null;
  const weekOf = (day: string) => snapshot.settings.termStart ? Math.floor(dayDistance(snapshot.settings.termStart, day) / 7) + 1 : null;
  const inTerm = (week: number | null): week is number => week !== null && week >= 1 && week <= snapshot.settings.termWeeks;
  // The month view names the span of teaching weeks it covers; the other views name the current one.
  const termWeeks = (view === "month" ? [days.find(day => day.slice(0, 7) === date.slice(0, 7))!, days.findLast(day => day.slice(0, 7) === date.slice(0, 7))!] : [date])
    .map(weekOf).filter(inTerm);
  const termLabel = !termWeeks.length ? null : termWeeks.length > 1 && termWeeks[0] !== termWeeks[1] ? `第 ${termWeeks[0]} – ${termWeeks[1]} 周` : `第 ${termWeeks[0]} 周`;
  useLayoutEffect(() => {
    if (scroll.current && !focusCurrentTime(scroll.current, date, view)) scroll.current.scrollTop = 7 * HOUR_HEIGHT;
    // Only entering a date/view focuses the clock; ticks and refreshed records must not take over scrolling.
  }, [date, view]);
  const target = (item: CalendarItem, occurrenceDate = item.date): Selection =>
    ({ entity: item.refKind, id: item.refId, occurrenceDate: item.occurrenceDate ?? occurrenceDate });
  const open = (item: CalendarItem, occurrenceDate = item.date) => select(target(item, occurrenceDate));
  const editItem = (item: CalendarItem, occurrenceDate = item.date) => edit?.(target(item, occurrenceDate));
  const inDay = (item: CalendarItem, day: string) =>
    item.start && item.end
      ? !!clipInterval(item.start, item.end, day)
      : item.date === day;
  function clock(minute: number) { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; }
  function pointerDate(x: number, fallback: string): string {
    const visible = days.flatMap(day => { const node = columns.current.get(day); return node ? [{ day, rect: node.getBoundingClientRect() }] : []; });
    return visible.find(entry => x >= entry.rect.left && x <= entry.rect.right)?.day
      ?? (visible.length ? x < visible[0]!.rect.left ? visible[0]!.day : visible.at(-1)!.day : fallback);
  }
  function pointerInstant(day: string, y: number, max = DAY_MINUTES): number {
    const rect = columns.current.get(day)?.getBoundingClientRect();
    return dayStart(day) + minuteAt(y, rect ?? { top: 0, height: DAY_HEIGHT }, max) * 60_000;
  }
  function cancelGesture() {
    const current = gesture.current; gesture.current = null; setDragging(false); setPreview(null);
    if (current?.target.hasPointerCapture?.(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  }
  useEffect(() => { cancelGesture(); setCursor(null); }, [view, date]);
  function begin(e: ReactPointerEvent<HTMLElement>, day: string, operation: TimelineOperation, item?: CalendarItem) {
    if (e.button !== 0 || e.isPrimary === false || gesture.current) return;
    e.preventDefault(); e.stopPropagation(); e.currentTarget.focus(); suppressClick.current = null;
    const pointer = pointerInstant(day, e.clientY, operation === 'create' ? 1439 : 1440);
    const initialStart = item?.start ? Date.parse(item.start) : pointer;
    const initialEnd = item?.end ? Date.parse(item.end) : Math.min(pointer + 60 * 60_000, dayStart(day) + 86400_000);
    gesture.current = { operation, pointerId: e.pointerId, day, target: e.currentTarget, item, initialStart, initialEnd,
      initialPointer: pointer, grabOffset: pointer - initialStart, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(true); setCursor(null); setPreview({ start: initialStart, end: initialEnd, itemId: item?.id });
  }
  function updateGesture(x: number, y: number) {
    const current = gesture.current; if (!current) return;
    current.x = x; current.y = y;
    const day = current.operation === 'create' ? current.day : pointerDate(x, current.day);
    const pointer = pointerInstant(day, y);
    current.moved ||= pointer !== current.initialPointer || Math.abs(x - current.startX) > 3 || Math.abs(y - current.startY) > 3;
    if (!current.moved) return;
    const range = gestureRange(current.operation, pointer, current.initialStart, current.initialEnd, current.grabOffset);
    setPreview({ ...range, itemId: current.item?.id });
  }
  const updateRef = useRef(updateGesture); updateRef.current = updateGesture;
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const advance = () => {
      const current = gesture.current, viewport = scroll.current;
      if (current && viewport) {
        const rect = viewport.getBoundingClientRect(), before = viewport.scrollTop;
        const distance = current.y < rect.top + 32 ? -Math.min(16, Math.max(0, (rect.top + 32 - current.y) / 3))
          : current.y > rect.bottom - 32 ? Math.min(16, Math.max(0, (current.y - rect.bottom + 32) / 3)) : 0;
        if (rect.height > 0 && distance) viewport.scrollTop += distance;
        if (viewport.scrollTop !== before) updateRef.current(current.x, current.y);
      }
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancelGesture(); } };
    window.addEventListener('keydown', escape);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', escape); };
  }, [dragging]);
  function finish(e: ReactPointerEvent) {
    const current = gesture.current; if (!current || current.pointerId !== e.pointerId) return;
    updateGesture(e.clientX, e.clientY);
    const day = current.operation === 'create' ? current.day : pointerDate(e.clientX, current.day);
    const range = current.moved ? gestureRange(current.operation, pointerInstant(day, e.clientY), current.initialStart, current.initialEnd, current.grabOffset)
      : { start: current.initialStart, end: current.initialEnd };
    const changed = range.start !== current.initialStart || range.end !== current.initialEnd;
    if (current.item && current.moved) suppressClick.current = current.item.id;
    cancelGesture();
    if (current.operation === 'create' || changed) schedule(draftRange(range.start, range.end, current.item?.refId));
  }
  function keyboardTime(e: React.KeyboardEvent, day: string) {
    if (e.target !== e.currentTarget) return;
    const minute = cursor?.day === day ? cursor.minute : 540;
    const direction = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : e.key === 'PageUp' ? -60 : e.key === 'PageDown' ? 60 : 0;
    if (direction || e.key === 'Home' || e.key === 'End') {
      e.preventDefault(); const next = Math.max(0, Math.min(1439, e.key === 'Home' ? 0 : e.key === 'End' ? 1439 : minute + direction));
      setCursor({ day, minute: next });
      const viewport = scroll.current;
      if (viewport) { const top = minutePosition(next); if (top < viewport.scrollTop + 20) viewport.scrollTop = Math.max(0, top - 20); else if (top > viewport.scrollTop + viewport.clientHeight - 30) viewport.scrollTop = top - viewport.clientHeight + 30; }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); schedule(draftRange(dayStart(day) + minute * 60000, dayStart(day) + Math.min(1440, minute + 60) * 60000));
    }
  }
  function keyboardBlock(e: React.KeyboardEvent, item: CalendarItem, operation: 'move' | 'resize-start' | 'resize-end') {
    if (item.refKind !== 'block' || !item.start || !item.end || (operation === 'move' && !e.altKey) || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation(); const delta = e.key === 'ArrowUp' ? -60000 : 60000;
    const start = Date.parse(item.start), end = Date.parse(item.end);
    const range = operation === 'move' ? { start: start + delta, end: end + delta }
      : gestureRange(operation, (operation === 'resize-start' ? start : end) + delta, start, end);
    schedule(draftRange(range.start, range.end, item.refId));
  }
  function drop(e: React.DragEvent, day: string) {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-planner");
    try {
      const value: unknown = JSON.parse(raw);
      if (
        !value ||
        typeof value !== "object" ||
        !("id" in value) ||
        typeof value.id !== "string" ||
        !("kind" in value) || !['task', 'block'].includes(String(value.kind))
      )
        return;
      const minute = minuteAt(e.clientY, e.currentTarget.getBoundingClientRect(), 1439);
      schedule({
        date: day,
        time: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
        ...(value.kind === "task"
          ? { taskId: value.id }
          : value.kind === "block"
            ? { blockId: value.id }
            : {}),
      });
    } catch {
      /* Ignore unrelated drag payloads. */
    }
  }
  const shortDate = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`;
  const title = view === "month" ? `${Number(date.slice(0, 4))} 年 ${Number(date.slice(5, 7))} 月`
    : view === "day" ? `${shortDate(date)} 星期${weekdays[(new Date(`${date}T00:00Z`).getUTCDay() + 6) % 7]}`
    : days[0]!.slice(5, 7) === days.at(-1)!.slice(5, 7) ? `${shortDate(days[0]!)} – ${Number(days.at(-1)!.slice(8))}日` : `${shortDate(days[0]!)} – ${shortDate(days.at(-1)!)}`;
  /** Belonging color of a course, or of the task behind a block or deadline. */
  const colorStyle = (item: CalendarItem): CSSProperties => {
    const block = item.refKind === "block" ? snapshot.blocks.find(value => value.id === item.refId) : undefined;
    const task = block?.taskId ? snapshot.tasks.find(value => value.id === block.taskId)
      : item.refKind === "task" ? snapshot.tasks.find(value => value.id === item.refId) : undefined;
    const course = item.refKind === "course" ? snapshot.courses.find(value => value.id === item.refId) : undefined;
    const color = course?.color ?? (task ? belongingColor(task, snapshot) : null);
    return color ? { "--c": color, "--wf": `color-mix(in srgb, ${color} 82%, #111)` } as CSSProperties : {};
  };
  const kindClass = (item: CalendarItem) => item.category === "candidate" ? "pending" : item.category;
  const markerClass = (item: CalendarItem, day: string) => item.category === "candidate" ? "pending"
    : itemAttention.get(item.id)!.tone === "attention" ? "overdue" : itemAttention.get(item.id)!.tone === "completed" ? "done" : day === today ? "today" : "ddl";
  const columnsStyle = { gridTemplateColumns: `56px repeat(${days.length}, minmax(0,1fr))` };
  const side = panel ?? (view === "day" && drawer && ui
    ? <DaySidebar snapshot={snapshot} day={date} today={today} items={buildCalendar(snapshot, date, date, true)} now={now} ui={ui}
        open={item => open(item, date)} openCandidate={openCandidate} drawer={drawer} />
    : drawer);
  const dayCounts = (day: string) => {
    const dayItems = items.filter(item => inDay(item, day));
    return [["course", "节课"], ["work", "段执行时段"], ["event", "项活动"]]
      .map(([category, unit]) => { const n = dayItems.filter(item => item.category === category).length; return n ? `${n} ${unit}` : ""; })
      .filter(Boolean).join(" · ");
  };
  return (
    <div className="a2-page a2-calendar-page">
      <PageToolbar ui={ui} title={title} sub={termLabel ? <span className="calendar-term-week">{termLabel}</span> : undefined}
        lead={<div className="a2-cal-nav">
          <button className="ui-btn icon" onClick={() => setDate(moveDate(date, view, -1))} aria-label="上一页"><ChevronLeft aria-hidden="true" /></button>
          <button className="ui-btn" onClick={() => { setDate(today); focusCurrentTime(scroll.current, today, view); }}>今天</button>
          <button className="ui-btn icon" onClick={() => setDate(moveDate(date, view, 1))} aria-label="下一页"><ChevronRight aria-hidden="true" /></button>
        </div>}>
        <span className="ui-legend" aria-hidden="true"><i className="course" />课程<i className="work" />执行时段<i className="event" />活动<i className="pending" />待定</span>
        <label className="a2-check"><input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} />待判断标记</label>
        <div className="ui-seg" role="group" aria-label="视图">
          {(["day", "week", "month"] as const).map((v, i) => (
            <button aria-pressed={v === view} onClick={() => setView(v)} key={v}>{["日", "周", "月"][i]}</button>
          ))}
        </div>
        <button className="ui-btn ghost" onClick={courses}>课表</button>
        {toggleDrawer && <button className={`ui-btn${drawerOpen ? " on" : ""}`} aria-pressed={drawerOpen} onClick={toggleDrawer}><PanelRight aria-hidden="true" />未安排 {unscheduledCount}</button>}
      </PageToolbar>
      <div className={`a2-cal-body${side ? " with-side" : ""}`}>
      <section className={`calendar-panel a2-cal view-${view}`} title="点击或拖选空白时间新建；拖动时段或上下边缘调整到分钟；方向键选分钟，Enter 新建；Alt + 上下键移动时段">
      {view === "month" ? (
        <MonthView days={days} month={date.slice(0, 7)} today={today} items={items} inDay={inDay}
          tone={item => itemAttention.get(item.id)!.tone} label={attentionLabel} colorStyle={colorStyle}
          open={open} edit={editItem} openDay={day => { setDate(day); setView("day"); }} schedule={day => schedule({ date: day, time: "09:00" })} />
      ) : (
        <>
          <div className="a2-days" style={columnsStyle}>
            <span className="timezone" title="北京时间">GMT+8</span>
            {days.map((day, i) => (
              <div key={day} className={day === today ? "today" : ""}>
                <button className="day-number dn" title="打开这一天" onClick={() => { setDate(day); setView("day"); }}>{Number(day.slice(8))}</button>
                <span className="wd">周{view === "day" ? weekdays[(new Date(`${day}T00:00Z`).getUTCDay() + 6) % 7] : weekdays[i]}{view === "day" && dayCounts(day) ? ` · ${dayCounts(day)}` : ""}</span>
              </div>
            ))}
          </div>
          <div className="a2-ddl-row" style={columnsStyle}>
            <span>截止</span>
            {days.map((day) => (
              <div key={day}>
                {items.filter((i) => (i.category === "deadline" || i.category === "candidate" || !i.start) && !i.end && i.date === day).map((i) => (
                  <button className={`marker ui-chip ${markerClass(i, day)} ${attentionClass(i)}`} key={i.id} style={colorStyle(i)} onClick={() => open(i)} onDoubleClick={() => editItem(i)}
                    title={`${i.category === "candidate" ? "待定 · " : ""}${i.title}${i.start ? ` ${i.start.slice(11, 16)}` : ""}${attentionLabel(i) ? ` · ${attentionLabel(i)}` : ''}`}>
                    {i.category === "candidate" ? "待定 · " : !i.start && i.category !== "deadline" ? "时间点 · " : ""}{i.title}
                    {i.start && <b>{i.start.slice(11, 16)}</b>}
                    {statusLabel(i)}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="time-scroll" ref={scroll}>
            <div className={`time-grid continuous-time-grid ${dragging ? "is-selecting" : ""}`} style={{ ...columnsStyle, height: DAY_HEIGHT, minHeight: DAY_HEIGHT, "--hour": `${HOUR_HEIGHT}px` } as CSSProperties}
              onPointerMove={e => { if (gesture.current?.pointerId === e.pointerId) updateGesture(e.clientX, e.clientY); }}
              onPointerUp={finish}
              onPointerCancel={cancelGesture}
              onLostPointerCapture={e => { if (gesture.current?.pointerId === e.pointerId) cancelGesture(); }}>
              <div className="hours">
                {Array.from({ length: 24 }, (_, h) => (
                  <span style={{ top: h * HOUR_HEIGHT }} key={h}>{h ? `${String(h).padStart(2, "0")}:00` : ""}</span>
                ))}
              </div>
              {days.map((day) => {
                const positioned = positionIntervals(items, day);
                const projected = preview ? clipInterval(`${localDateTime(preview.start)}:00+08:00`, `${localDateTime(preview.end)}:00+08:00`, day) : null;
                return (
                <div
                  className={`day-column continuous-day ${day === today ? "today-column" : ""}`}
                  key={day}
                  ref={node => { if (node) columns.current.set(day, node); else columns.current.delete(day); }}
                  data-day={day}
                  role="group"
                  aria-label={`${day} 分钟时间轴`}
                  aria-describedby="calendar-minute-help"
                  tabIndex={0}
                  onFocus={e => { if (e.target === e.currentTarget) setCursor(value => value?.day === day ? value : { day, minute: 540 }); }}
                  onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setCursor(null); }}
                  onKeyDown={e => keyboardTime(e, day)}
                  onPointerDown={e => { if (e.target === e.currentTarget) begin(e, day, 'create'); }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => drop(e, day)}
                >
                  <div className="a2-ev-layer">
                  {positioned.map(({ item, startMinute, endMinute, column, columns: count }) => {
                    const movable = item.refKind === 'block';
                    const startsHere = Date.parse(item.start!) >= dayStart(day), endsHere = Date.parse(item.end!) <= dayStart(day) + 86400_000;
                    const label = `${item.title} ${item.start!.slice(11, 16)}–${item.end!.slice(11, 16)}${item.end!.slice(0, 10) !== item.start!.slice(0, 10) ? '（跨日）' : ''}${attentionLabel(item) ? ` · ${attentionLabel(item)}` : ''}`;
                    const short = endMinute - startMinute < 34;
                    return <div key={item.id} data-timeline-item={item.id}
                      className={`timeline-event ${kindClass(item)} ${attentionClass(item)} ${item.pending ? 'pending' : ''} ${short ? 'compact' : ''} ${preview?.itemId === item.id ? 'is-moving' : ''}`}
                      style={{ ...colorStyle(item), top: minutePosition(startMinute), height: minutePosition(endMinute - startMinute), left: `calc(${column / count * 100}% + 4px)`, width: `calc(${100 / count}% - 8px)` }}>
                      <button className={`timeline-event-button ${movable ? 'can-move' : ''}`} title={`${label}\n${item.start!.slice(0, 10)} 至 ${item.end!.slice(0, 10)}${movable ? '\n拖动移动；Alt + 上下方向键微调 1 分钟' : ''}`}
                        onPointerDown={e => { if (movable) begin(e, day, 'move', item); else e.stopPropagation(); }}
                        onKeyDown={e => keyboardBlock(e, item, 'move')}
                        onClick={e => { if (suppressClick.current === item.id && e.detail !== 0) { suppressClick.current = null; return; } open(item, day); }}
                        onDoubleClick={() => { if (!suppressClick.current) editItem(item, day); }}>
                        <strong>{item.title}</strong><small>{short ? item.start!.slice(11, 16) : `${item.start!.slice(11, 16)}–${item.end!.slice(11, 16)}`}{item.end!.slice(0, 10) !== item.start!.slice(0, 10) ? ' · 跨日' : ''}</small>
                        {/* Short blocks rely on their color; the status stays in the title tooltip. */}
                        {endMinute - startMinute >= 55 && statusLabel(item)}
                        {item.location && <small>{item.location}</small>}
                      </button>
                      {movable && startsHere && <button className="timeline-resize start" aria-label={`调整 ${item.title} 开始时间`} title="拖动调整开始；上下方向键微调 1 分钟"
                        onPointerDown={e => begin(e, day, 'resize-start', item)} onKeyDown={e => keyboardBlock(e, item, 'resize-start')} onClick={e => e.stopPropagation()} />}
                      {movable && endsHere && <button className="timeline-resize end" aria-label={`调整 ${item.title} 结束时间`} title="拖动调整结束；上下方向键微调 1 分钟"
                        onPointerDown={e => begin(e, day, 'resize-end', item)} onKeyDown={e => keyboardBlock(e, item, 'resize-end')} onClick={e => e.stopPropagation()} />}
                    </div>;
                  })}
                  </div>
                  {items.filter(item => item.start && !item.end && item.date === day && item.category !== "deadline" && item.category !== "candidate").map(item => <button key={item.id} className={`timeline-point ${kindClass(item)} ${attentionClass(item)}`}
                    title={`${item.title} · ${item.start!.slice(11, 16)}（不占用时间）${attentionLabel(item) ? ` · ${attentionLabel(item)}` : ''}`}
                    style={{ ...colorStyle(item), top: minutePosition(Math.max(0, Math.min(1439, (Date.parse(item.start!) - dayStart(day)) / 60000))) }}
                    onPointerDown={e => e.stopPropagation()} onClick={() => open(item, day)} onDoubleClick={() => editItem(item, day)}>
                    ◆ {item.start!.slice(11, 16)} {item.title}
                    {statusLabel(item)}
                  </button>)}
                  {projected && <div className="timeline-preview" style={{ top: minutePosition(projected.startMinute), height: minutePosition(projected.endMinute - projected.startMinute) }}>
                    <span className="timeline-preview-label">{clock(projected.startMinute)}–{clock(projected.endMinute)}</span>
                  </div>}
                  {!dragging && cursor?.day === day && <div className="timeline-cursor" style={{ top: minutePosition(cursor.minute) }}><span>{clock(cursor.minute)}</span></div>}
                  <CurrentTimeIndicator day={day} now={now} />
                </div>
              ); })}
            </div>
          </div>
        </>
      )}
      <span className="a2-visually-hidden" id="calendar-minute-help">点击或拖选空白时间新建；拖动时段或上下边缘可精确到分钟，松开后核对并保存；方向键选分钟，Enter 新建；Alt + 上下键移动时段</span>
      <span className="timeline-live-status" aria-live="polite">{cursor ? `${cursor.day} ${clock(cursor.minute)}` : preview ? `${localDateTime(preview.start)} 至 ${localDateTime(preview.end)}` : ''}</span>
      </section>
      {side}
      </div>
    </div>
  );
}
