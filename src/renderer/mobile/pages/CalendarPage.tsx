import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { CalendarItem, Snapshot } from '../../../shared/contracts';
import type { Selection, ScheduleDraft } from '../../components/Calendar';
import { buildCalendar } from '../../../domain/calendar';
import { dayDistance } from '../../../domain/time';
import { DEFAULT_ACTIVITY_MINUTES } from '../../../domain/activity-duration';
import { calendarDays, clipInterval, moveDate, todayDate, type CalendarView } from '../../calendar-layout';
import { DAY_HEIGHT, HOUR_HEIGHT, dayStart, localDateTime, minuteAt, minutePosition, positionIntervals, draftRange } from '../../calendar-timeline';
import { calendarAttention } from '../../calendar-attention';
import { CurrentTimeIndicator, currentTimePosition } from '../../components/CurrentTimeIndicator';
import { MoreMenu } from '../../components/shell/MoreMenu';
import { clock, itemColor, shortDate, weekdayName } from '../item-style';
import '../../components/CalendarTimeline.css';
import '../../components/calendar-attention.css';
import '../../components/calendar/Calendar.css';

export type PhoneView = Extract<CalendarView, 'day' | 'three-day' | 'month'>;
const viewNames: [PhoneView, string][] = [['day', '日'], ['three-day', '3天'], ['month', '月']];

/** Scrolls to the clock when the visible days include today, else to the morning; never on refresh. */
function focusTime(viewport: HTMLDivElement | null, days: string[], now: number) {
  if (!viewport) return;
  const today = localDateTime(now).slice(0, 10), current = days.includes(today) ? currentTimePosition(today, now) : null;
  viewport.scrollTop = current ? Math.max(0, minutePosition(current.minute) - viewport.clientHeight / 3) : 7 * HOUR_HEIGHT;
}

export function CalendarPage({ snapshot, now, date, setDate, view, setView, select, schedule, openCandidate, unscheduledCount, openUnscheduled, openCourses }: {
  snapshot: Snapshot; now: number; date: string; setDate: (date: string) => void; view: PhoneView; setView: (view: PhoneView) => void;
  select: (selection: Selection) => void; schedule: (draft: ScheduleDraft) => void; openCandidate: (id: string) => void;
  unscheduledCount: number; openUnscheduled: () => void; openCourses: () => void;
}) {
  const [pending, setPending] = useState(snapshot.settings.showPending);
  const scroll = useRef<HTMLDivElement>(null);
  const today = todayDate();
  const days = calendarDays(date, view);
  const items = buildCalendar(snapshot, days[0]!, days.at(-1)!, pending);
  useLayoutEffect(() => focusTime(scroll.current, days, Date.now()), [date, view]);

  const open = (item: CalendarItem, day = item.date) => item.category === 'candidate' ? openCandidate(item.refId)
    : select({ entity: item.refKind, id: item.refId, occurrenceDate: item.occurrenceDate ?? day });
  const attention = (item: CalendarItem) => calendarAttention(item, snapshot, now);
  const inDay = (item: CalendarItem, day: string) => item.start && item.end ? !!clipInterval(item.start, item.end, day) : item.date === day;
  const markers = (day: string) => items.filter(item => (item.category === 'deadline' || item.category === 'candidate' || !item.start) && !item.end && item.date === day);
  const week = snapshot.settings.termStart ? Math.floor(dayDistance(snapshot.settings.termStart, date) / 7) + 1 : null;
  const title = view === 'month' ? `${Number(date.slice(5, 7))}月` : view === 'day' ? `${shortDate(date)} 周${weekdayName(date)}`
    : `${shortDate(days[0]!)} – ${days[0]!.slice(5, 7) === days[2]!.slice(5, 7) ? `${Number(days[2]!.slice(8))}日` : shortDate(days[2]!)}`;
  const tapSlot = (event: React.MouseEvent<HTMLDivElement>, day: string) => {
    if (event.target !== event.currentTarget) return;
    const minute = Math.floor(minuteAt(event.clientY, event.currentTarget.getBoundingClientRect(), 1439) / 15) * 15;
    schedule(draftRange(dayStart(day) + minute * 60_000, dayStart(day) + Math.min(1440, minute + DEFAULT_ACTIVITY_MINUTES) * 60_000));
  };
  const weekStrip = calendarDays(date, 'week');

  return (
    <div className={`m-page m-calendar view-${view}`}>
      <header className="m-cal-head">
        <div className="m-cal-title">
          <button className="m-icon" aria-label="上一页" onClick={() => setDate(moveDate(date, view, -1))}><ChevronLeft aria-hidden="true" /></button>
          <h1>{title}</h1>
          <button className="m-icon" aria-label="下一页" onClick={() => setDate(moveDate(date, view, 1))}><ChevronRight aria-hidden="true" /></button>
          <span className="m-spacer" />
          {!days.includes(today) || view === 'month' && date !== today ? <button className="m-link" onClick={() => setDate(today)}>今天</button> : null}
          <MoreMenu label="日历选项" items={[
            { label: pending ? '隐藏待判断标记' : '显示待判断标记', onSelect: () => setPending(value => !value) },
            { label: '课表', onSelect: openCourses },
          ]} />
        </div>
        <div className="m-cal-tools">
          <div className="m-seg" role="group" aria-label="视图">
            {viewNames.map(([value, label]) => <button key={value} aria-pressed={view === value} onClick={() => setView(value)}>{label}</button>)}
          </div>
          {week && week >= 1 && week <= snapshot.settings.termWeeks && view !== 'month' && <span className="m-cal-week">第 {week} 周</span>}
          <span className="m-spacer" />
          {unscheduledCount > 0 && <button className="m-link attn" onClick={openUnscheduled}>未安排 {unscheduledCount}</button>}
        </div>
        {view === 'day' && <div className="m-week-strip" role="group" aria-label="本周日期">
          {weekStrip.map(day => {
            const count = buildCalendar(snapshot, day, day, false).filter(item => item.category !== 'deadline').length;
            return <button key={day} aria-pressed={day === date} className={day === today ? 'today' : ''} onClick={() => setDate(day)}
              aria-label={`${shortDate(day)} 周${weekdayName(day)}${count ? `，${count} 项安排` : ''}`}>
              <small>{weekdayName(day)}</small><b>{Number(day.slice(8))}</b>{count > 0 && <i aria-hidden="true" />}
            </button>;
          })}
        </div>}
      </header>

      {view === 'month' ? <MonthGrid days={days} month={date.slice(0, 7)} date={date} today={today} items={items} inDay={inDay} snapshot={snapshot}
        openDay={day => { setDate(day); setView('day'); }} /> : <>
        {view === 'three-day' && <div className="m-day-heads">
          {days.map(day => <button key={day} className={day === today ? 'today' : ''} onClick={() => { setDate(day); setView('day'); }}>
            <small>周{weekdayName(day)}</small><b>{Number(day.slice(8))}</b></button>)}
        </div>}
        {days.some(day => markers(day).length) && <div className="m-markers" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0,1fr))` }}>
          {days.map(day => <div key={day}>{markers(day).map(item => {
            const state = attention(item);
            return <button key={item.id} className={`m-marker ${item.category}${state.tone !== 'normal' ? ` ${state.tone}` : ''}`} style={itemColor(item, snapshot)} onClick={() => open(item, day)}>
              <span>{item.category === 'candidate' ? '待定 · ' : item.category === 'deadline' ? '截止 · ' : ''}{item.title}</span>
              {item.start && <b>{clock(item.start)}</b>}{state.label && <em>{state.label}</em>}
            </button>;
          })}</div>)}
        </div>}
        <section className={`calendar-panel a2-cal m-grid view-${view}`} aria-label="时间轴">
          <div className="time-scroll" ref={scroll}>
            <div className="time-grid continuous-time-grid" style={{ gridTemplateColumns: `44px repeat(${days.length}, minmax(0,1fr))`, height: DAY_HEIGHT, minHeight: DAY_HEIGHT, '--hour': `${HOUR_HEIGHT}px` } as CSSProperties}>
              <div className="hours">{Array.from({ length: 24 }, (_, h) => <span style={{ top: h * HOUR_HEIGHT }} key={h}>{h ? `${String(h).padStart(2, '0')}:00` : ''}</span>)}</div>
              {days.map(day => (
                <div key={day} className={`day-column continuous-day${day === today ? ' today-column' : ''}`} data-day={day} onClick={event => tapSlot(event, day)}>
                  <div className="a2-ev-layer">
                    {positionIntervals(items, day).map(({ item, startMinute, endMinute, column, columns }) => {
                      const state = attention(item), short = endMinute - startMinute < 34;
                      return <div key={item.id} data-timeline-item={item.id}
                        className={`timeline-event ${item.category === 'candidate' ? 'pending' : item.category} calendar-${state.tone}${item.pending ? ' pending' : ''}${short ? ' compact' : ''}`}
                        style={{ ...itemColor(item, snapshot), top: minutePosition(startMinute), height: minutePosition(endMinute - startMinute), left: `calc(${column / columns * 100}% + 3px)`, width: `calc(${100 / columns}% - 6px)` }}>
                        <button className="timeline-event-button" onClick={() => open(item, day)}
                          aria-label={`${item.title} ${clock(item.start)}–${clock(item.end)}${state.label ? ` · ${state.label}` : ''}`}>
                          <strong>{item.title}</strong>
                          <small>{short ? clock(item.start) : `${clock(item.start)}–${clock(item.end)}`}</small>
                          {!short && item.location && view === 'day' && <small>{item.location}</small>}
                          {state.label && endMinute - startMinute >= 70 && <span className="calendar-item-status">{state.label}</span>}
                        </button>
                      </div>;
                    })}
                  </div>
                  {items.filter(item => item.start && !item.end && item.date === day && item.category !== 'deadline' && item.category !== 'candidate').map(item =>
                    <button key={item.id} className={`timeline-point ${item.category} calendar-${attention(item).tone}`} style={{ ...itemColor(item, snapshot), top: minutePosition(Math.max(0, Math.min(1439, (Date.parse(item.start!) - dayStart(day)) / 60_000))) }}
                      onClick={() => open(item, day)}>◆ {clock(item.start)} {item.title}</button>)}
                  <CurrentTimeIndicator day={day} now={now} />
                </div>
              ))}
            </div>
          </div>
        </section>
      </>}
      <button className="m-fab" aria-label="新安排" onClick={() => schedule({ date: view === 'month' ? date : days.includes(today) ? today : date, time: nextSlot(now, days.includes(today) || view === 'month' && date === today) })}><Plus aria-hidden="true" /></button>
    </div>
  );
}

/** The next quarter hour from now on today; 09:00 on other days. */
export function nextSlot(now: number, isToday: boolean) {
  if (!isToday) return '09:00';
  const minute = Math.min(23 * 60 + 45, Math.ceil((now - dayStart(localDateTime(now).slice(0, 10))) / 60_000 / 15) * 15);
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function MonthGrid({ days, month, date, today, items, inDay, snapshot, openDay }: {
  days: string[]; month: string; date: string; today: string; items: CalendarItem[]; inDay: (item: CalendarItem, day: string) => boolean;
  snapshot: Snapshot; openDay: (day: string) => void;
}) {
  return (
    <div className="m-month" role="grid" aria-label={`${Number(month.slice(5))}月`}>
      <div className="m-month-row m-month-weekdays" role="row">{'一二三四五六日'.split('').map(day => <span key={day} role="columnheader">{day}</span>)}</div>
      {Array.from({ length: days.length / 7 }, (_, row) => (
        <div className="m-month-row" role="row" key={row}>
          {days.slice(row * 7, row * 7 + 7).map(day => {
            const list = items.filter(item => inDay(item, day));
            return <button key={day} role="gridcell" className={`${day.slice(0, 7) !== month ? 'outside' : ''}${day === today ? ' today' : ''}${day === date ? ' chosen' : ''}`}
              aria-label={`${shortDate(day)}${list.length ? `，${list.length} 项` : ''}`} onClick={() => openDay(day)}>
              <b>{Number(day.slice(8))}</b>
              <span className="m-dots" aria-hidden="true">{list.slice(0, 3).map(item => <i key={item.id} className={item.category} style={itemColor(item, snapshot)} />)}</span>
            </button>;
          })}
        </div>
      ))}
    </div>
  );
}
