import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import './CalendarTimeline.css';
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
  schedule,
  courses,
}: {
  snapshot: Snapshot;
  date: string;
  setDate: (value: string) => void;
  select: (item: Selection) => void;
  schedule: (draft: ScheduleDraft) => void;
  courses: () => void;
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
  const termWeek = snapshot.settings.termStart ? Math.floor(dayDistance(snapshot.settings.termStart, date) / 7) + 1 : null;
  useLayoutEffect(() => {
    if (scroll.current && !focusCurrentTime(scroll.current, date, view)) scroll.current.scrollTop = 7 * HOUR_HEIGHT;
    // Only entering a date/view focuses the clock; ticks and refreshed records must not take over scrolling.
  }, [date, view]);
  const open = (item: CalendarItem, occurrenceDate = item.date) =>
    select({ entity: item.refKind, id: item.refId, occurrenceDate: item.occurrenceDate ?? occurrenceDate });
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
  return (
    <section className="calendar-panel">
      <div className="calendar-toolbar">
        <div className="date-controls">
          <button
            onClick={() => setDate(moveDate(date, view, -1))}
            aria-label="上一页"
          >
            ‹
          </button>
          <button onClick={() => { setDate(today); focusCurrentTime(scroll.current, today, view); }}>今天</button>
          <button
            onClick={() => setDate(moveDate(date, view, 1))}
            aria-label="下一页"
          >
            ›
          </button>
          <h2>
            {Number(date.slice(0, 4))} 年 {Number(date.slice(5, 7))} 月
          </h2>
          {termWeek !== null && termWeek >= 1 && termWeek <= snapshot.settings.termWeeks && <span className="calendar-term-week">第 {termWeek} 周</span>}
        </div>
        <div className="toolbar">
          <label className="check">
            <input
              type="checkbox"
              checked={pending}
              onChange={(e) => setPending(e.target.checked)}
            />
            待判断层
          </label>
          <div className="segmented">
            {(["day", "week", "month"] as const).map((v, i) => (
              <button
                className={v === view ? "selected" : ""}
                onClick={() => setView(v)}
                key={v}
              >
                {["日", "周", "月"][i]}
              </button>
            ))}
          </div>
          <button onClick={courses}>课表</button>
        </div>
      </div>
      <div className="calendar-legend">
        <span className="dot course" />
        课程 <span className="dot work" />
        执行时段 <span className="dot event" />
        固定活动 <span className="dot deadline" />
        截止 <span className="dot candidate" />
        待判断 <span className="legend-hint">截止与待判断不占用已确认时间</span>
      </div>
      {view === "month" ? (
        <div className="month-view">
          <div className="month-head">
            {weekdays.map((w) => (
              <span key={w}>周{w}</span>
            ))}
          </div>
          <div
            className="month-grid"
            style={{
              gridTemplateRows: `repeat(${days.length / 7}, minmax(100px,1fr))`,
            }}
          >
            {days.map((day) => (
              <div
                key={day}
                className={`month-cell ${day.slice(5, 7) !== date.slice(5, 7) ? "muted-day" : ""}`}
              >
                <button
                  className={`day-number ${day === today ? "today-number" : ""}`}
                  onClick={() => {
                    setDate(day);
                    setView("day");
                  }}
                >
                  {Number(day.slice(8))}
                </button>
                {items
                  .filter((i) => inDay(i, day))
                  .map((i) => (
                    <button
                      key={i.id}
                      className={`month-item ${i.category}`}
                      onClick={() => open(i, day)}
                    >
                      {i.start ? i.start.slice(11, 16) : "截止"} {i.title}
                    </button>
                  ))}
                <button
                  className="month-add"
                  onClick={() => schedule({ date: day, time: "09:00" })}
                >
                  ＋ 安排
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div
            className="week-heading"
            style={{
              gridTemplateColumns: `52px repeat(${days.length}, minmax(0,1fr))`,
            }}
          >
            <span className="timezone">GMT+8</span>
            {days.map((day, i) => (
              <div key={day}>
                <span>
                  周
                  {view === "day"
                    ? weekdays[(new Date(`${day}T00:00Z`).getUTCDay() + 6) % 7]
                    : weekdays[i]}
                </span>
                <button
                  className={`day-number ${day === today ? "today-number" : ""}`}
                  onClick={() => {
                    setDate(day);
                    setView("day");
                  }}
                >
                  {Number(day.slice(8))}
                </button>
              </div>
            ))}
          </div>
          <div
            className="marker-row"
            style={{
              gridTemplateColumns: `52px repeat(${days.length}, minmax(0,1fr))`,
            }}
          >
            <span>标记</span>
            {days.map((day) => (
              <div key={day}>
                {items
                  .filter((i) => !i.start && i.date === day)
                  .map((i) => (
                    <button
                      className={`marker ${i.category}`}
                      key={i.id}
                      onClick={() => open(i)}
                      title={i.title}
                    >
                      {i.category === "candidate"
                        ? "待判"
                        : i.category === "deadline"
                          ? "截止"
                          : "时间点"}{" "}
                      {i.start?.slice(11, 16)} {i.title}
                    </button>
                  ))}
              </div>
            ))}
          </div>
          <div className="time-scroll" ref={scroll}>
            <div
              className={`time-grid continuous-time-grid ${dragging ? 'is-selecting' : ''}`}
              style={{
                gridTemplateColumns: `52px repeat(${days.length}, minmax(0,1fr))`,
              }}
              onPointerMove={e => { if (gesture.current?.pointerId === e.pointerId) updateGesture(e.clientX, e.clientY); }}
              onPointerUp={finish}
              onPointerCancel={cancelGesture}
              onLostPointerCapture={e => { if (gesture.current?.pointerId === e.pointerId) cancelGesture(); }}
            >
              <div className="hours">
                {Array.from({ length: 24 }, (_, h) => (
                  <span style={{ top: h * HOUR_HEIGHT }} key={h}>
                    {String(h).padStart(2, "0")}:00
                  </span>
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
                  {positioned.map(({ item, startMinute, endMinute, column, columns: count }) => {
                    const movable = item.refKind === 'block';
                    const startsHere = Date.parse(item.start!) >= dayStart(day), endsHere = Date.parse(item.end!) <= dayStart(day) + 86400_000;
                    const label = `${item.title} ${item.start!.slice(11, 16)}–${item.end!.slice(11, 16)}${item.end!.slice(0, 10) !== item.start!.slice(0, 10) ? '（跨日）' : ''}`;
                    return <div key={item.id} data-timeline-item={item.id}
                      className={`timeline-event ${item.category} ${item.pending ? 'pending' : ''} ${endMinute - startMinute < 18 ? 'compact' : ''} ${preview?.itemId === item.id ? 'is-moving' : ''}`}
                      style={{ top: minutePosition(startMinute), height: minutePosition(endMinute - startMinute), left: `calc(${column / count * 100}% + 3px)`, width: `calc(${100 / count}% - 6px)` }}>
                      <button className={`timeline-event-button ${movable ? 'can-move' : ''}`} title={`${label}\n${item.start!.slice(0, 10)} 至 ${item.end!.slice(0, 10)}${movable ? '\n拖动移动；Alt + 上下方向键微调 1 分钟' : ''}`}
                        onPointerDown={e => { if (movable) begin(e, day, 'move', item); else e.stopPropagation(); }}
                        onKeyDown={e => keyboardBlock(e, item, 'move')}
                        onClick={e => { if (suppressClick.current === item.id && e.detail !== 0) { suppressClick.current = null; return; } open(item, day); }}>
                        <strong>{item.title}</strong><small>{item.start!.slice(11, 16)}–{item.end!.slice(11, 16)}{item.end!.slice(0, 10) !== item.start!.slice(0, 10) ? ' · 跨日' : ''}</small>
                        {item.location && <small>{item.location}</small>}
                      </button>
                      {movable && startsHere && <button className="timeline-resize start" aria-label={`调整 ${item.title} 开始时间`} title="拖动调整开始；上下方向键微调 1 分钟"
                        onPointerDown={e => begin(e, day, 'resize-start', item)} onKeyDown={e => keyboardBlock(e, item, 'resize-start')} onClick={e => e.stopPropagation()} />}
                      {movable && endsHere && <button className="timeline-resize end" aria-label={`调整 ${item.title} 结束时间`} title="拖动调整结束；上下方向键微调 1 分钟"
                        onPointerDown={e => begin(e, day, 'resize-end', item)} onKeyDown={e => keyboardBlock(e, item, 'resize-end')} onClick={e => e.stopPropagation()} />}
                    </div>;
                  })}
                  {items.filter(item => item.start && !item.end && item.date === day).map(item => <button key={item.id} className={`timeline-point ${item.category}`}
                    title={`${item.title} · ${item.start!.slice(11, 16)}（不占用时间）`}
                    style={{ top: minutePosition(Math.max(0, Math.min(1439, (Date.parse(item.start!) - dayStart(day)) / 60000))) }}
                    onPointerDown={e => e.stopPropagation()} onClick={() => open(item, day)}>
                    ◆ {item.start!.slice(11, 16)} {item.title}
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
      <footer className="calendar-footnote timeline-help" id="calendar-minute-help">
        点击或拖选空白时间 · 拖动时段或上下边缘可精确到分钟，松开后核对并保存 · 方向键选分钟，Enter 新建；Alt + 上下键移动时段
      </footer>
      <span className="timeline-live-status" aria-live="polite">{cursor ? `${cursor.day} ${clock(cursor.minute)}` : preview ? `${localDateTime(preview.start)} 至 ${localDateTime(preview.end)}` : ''}</span>
    </section>
  );
}
