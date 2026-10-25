import { useState, type CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import { addCalendarDays, type Course, type Snapshot } from '../../../shared/contracts';
import type { PlannerUI } from '../../hooks/usePlanner';
import type { EditorTarget } from '../../components/editor/EntityEditor';
import { PALETTE, colorName } from '../../../shared/palette';
import { occupiedColors } from '../../../domain/palette';
import { buildCalendar } from '../../../domain/calendar';
import { todayDate } from '../../calendar-layout';
import { clock, weekdayName } from '../item-style';
import { Sheet } from '../Sheet';

const weekdays = '一二三四五六日';
type CourseGroup = { title: string; records: Course[] };

/** Week numbers as ranges: 3,4,5,6,8 → 第 3–6、8 周. */
export function weekRanges(weeks: number[]): string {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b), parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : `${sorted[i]}`);
    i = j;
  }
  return parts.length ? `第 ${parts.join('、')} 周` : '';
}
const courseWeeks = (course: Course) => course.weeks ? weekRanges(course.weeks)
  : `第 ${course.firstWeek}–${course.lastWeek} 周${{ all: '', odd: ' · 单周', even: ' · 双周' }[course.parity]}`;

/**
 * 课程表 on the phone: one row per course with only its next class; times, weeks and color open in a sheet.
 * Each weekly record stays editable on its own, as on the desktop table.
 */
export function CourseList({ snapshot, ui, edit }: { snapshot: Snapshot; ui: PlannerUI; edit: (target: EditorTarget) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const today = todayDate(), now = Date.now();
  const groups: CourseGroup[] = [...snapshot.courses.reduce((map, course) => map.set(course.title, [...(map.get(course.title) ?? []), course]), new Map<string, Course[]>())]
    .map(([title, records]) => ({ title, records: records.sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime)) }));
  // The next class of each course within three weeks, exceptions and replacements included.
  const upcoming = buildCalendar(snapshot, today, addCalendarDays(today, 21), false)
    .filter(item => item.category === 'course' && item.start && Date.parse(item.start) > now)
    .sort((a, b) => a.start!.localeCompare(b.start!));
  const next = (group: CourseGroup) => {
    const ids = new Set(group.records.map(record => record.id));
    const item = upcoming.find(value => ids.has(value.refId));
    if (!item) return group.records.every(record => Math.floor((Date.parse(`${today}T00:00:00+08:00`) - Date.parse(`${record.termStart}T00:00:00+08:00`)) / 604_800_000) + 1 > record.lastWeek) ? '本学期已结课' : '近三周没有课';
    const when = item.date === today ? '今天' : `周${weekdayName(item.date)}`;
    return `下次 ${when} ${clock(item.start)}${item.location ? ` · ${item.location}` : ''}`;
  };
  const shown = groups.find(group => group.title === open);
  if (!groups.length) return <div className="m-empty"><p>课表还是空的，点右上角 + 添加第一门课。</p></div>;
  return <>
    <ul className="m-card">
      {groups.map(group => <li key={group.title}>
        <button className="m-card-row" onClick={() => setOpen(group.title)}>
          <i className="m-dot" style={{ background: group.records[0]!.color ?? 'var(--ink-3)' }} aria-hidden="true" />
          <span className="m-card-main"><b>{group.title}</b><small>{next(group)}</small></span>
          <ChevronRight aria-hidden="true" />
        </button>
      </li>)}
    </ul>
    {shown && <CourseSheet group={shown} snapshot={snapshot} ui={ui} close={() => setOpen(null)} edit={target => { setOpen(null); edit(target); }} />}
  </>;
}

function CourseSheet({ group, snapshot, ui, close, edit }: {
  group: CourseGroup; snapshot: Snapshot; ui: PlannerUI; close: () => void; edit: (target: EditorTarget) => void;
}) {
  const [picking, setPicking] = useState(false);
  const color = group.records[0]!.color;
  const others = occupiedColors(snapshot, todayDate());
  if (color) others.splice(others.indexOf(color), 1);
  const locations = [...new Set(group.records.map(record => record.location).filter(Boolean))].join('、');
  const weeks = [...new Set(group.records.map(courseWeeks))].join('；');
  /** A course's color follows its title, so every weekly record of it changes together. */
  const recolor = (hex: string) => void ui.mutate(group.records.map(record => ({ type: 'update' as const, entity: 'course' as const, id: record.id,
    expectedVersion: record.version, scope: 'all' as const, values: { color: hex as NonNullable<Course['color']> } }))).then(() => setPicking(false));
  return (
    <Sheet title={group.title} onClose={close}>
      <div className="m-detail">
        <h3 className="m-card-label">上课时间</h3>
        <ul className="m-card">
          {group.records.map(record => <li key={record.id}>
            <button className="m-card-row" onClick={() => edit({ entity: 'course', id: record.id })} aria-label={`编辑周${weekdays[record.weekday - 1]} ${record.startTime} 这一节`}>
              <span className="m-card-main"><b>周{weekdays[record.weekday - 1]} {record.startTime}–{record.endTime}</b></span>
              <ChevronRight aria-hidden="true" />
            </button>
          </li>)}
        </ul>
        <ul className="m-card">
          {locations && <li className="m-card-row"><span className="m-card-main"><b>地点</b></span><span className="m-card-value">{locations}</span></li>}
          <li className="m-card-row"><span className="m-card-main"><b>周次</b></span><span className="m-card-value">{weeks}</span></li>
          <li>
            <button className="m-card-row" aria-expanded={picking} onClick={() => setPicking(value => !value)}>
              <span className="m-card-main"><b>颜色</b></span>
              <span className="m-card-value">{color ? colorName(color) : '未设定'}</span>
              <i className="m-dot" style={{ background: color ?? 'transparent' }} aria-hidden="true" />
              <ChevronRight aria-hidden="true" className={picking ? 'turned' : undefined} />
            </button>
            {picking && <div className="m-palette" role="group" aria-label={`${group.title}的颜色`}>
              {PALETTE.map(({ hex, name }) => <button key={hex} style={{ '--c': hex } as CSSProperties} disabled={ui.busy}
                className={`${hex === color ? 'cur' : ''}${others.includes(hex) ? ' used' : ''}`} aria-pressed={hex === color}
                aria-label={`${name}${others.includes(hex) ? '（已被使用）' : ''}`} onClick={() => hex === color ? setPicking(false) : recolor(hex)} />)}
            </div>}
          </li>
        </ul>
        {picking && <p className="m-hint">带圆点的颜色已被其他课程或目标使用。</p>}
      </div>
    </Sheet>
  );
}
