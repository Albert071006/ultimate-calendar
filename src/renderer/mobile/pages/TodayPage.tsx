import { Fragment, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import type { CalendarItem, Snapshot, Task } from '../../../shared/contracts';
import type { PlannerUI } from '../../hooks/usePlanner';
import type { Selection } from '../../components/Calendar';
import type { TaskActions } from '../../components/tasks/TaskRow';
import { buildCalendar } from '../../../domain/calendar';
import { taskDeadlineEnd } from '../../../domain/unscheduled';
import { effectiveActivityEnd } from '../../../domain/activity-duration';
import { dayDistance } from '../../../domain/time';
import { belongingColor } from '../../../domain/belonging';
import { selectRailTasks, taskAttention } from '../../task-rail';
import { taskArrangements, taskArrangementSummary, taskNoticeTiming, taskNoticeSummary } from '../../task-schedule';
import { teachingWeek } from '../../pages/today/Today';
import { todayDate } from '../../calendar-layout';
import { clock, itemColor, kindNames, shortDate, weekdayName } from '../item-style';

type Filter = 'open' | 'done' | 'all';
type Group = 'over' | 'today' | 'week' | 'later' | 'none' | 'done';
const groupNames: Record<Group, string> = { over: '已逾期', today: '今天', week: '本周', later: '以后', none: '无截止', done: '已完成' };

function groupOf(task: Task, today: string, now: number): Exclude<Group, 'done'> {
  const end = taskDeadlineEnd(task);
  if (end === null) return 'none';
  if (end <= now) return 'over';
  if (task.deadline!.date === today) return 'today';
  const weekday = (new Date(`${today}T12:00:00+08:00`).getUTCDay() + 6) % 7;
  return dayDistance(today, task.deadline!.date) <= 6 - weekday ? 'week' : 'later';
}
const endOf = (item: CalendarItem) => Date.parse(item.start ? effectiveActivityEnd(item.start, item.end) : `${item.date}T23:59:59+08:00`);
const minutesLabel = (minutes: number) => minutes < 1 ? '即将开始' : minutes < 60 ? `${minutes} 分钟后` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}后`;

export function TodayPage({ snapshot, ui, now, pendingCount, unscheduledCount, select, openCandidate, openInbox, openUnscheduled, createTask, actions }: {
  snapshot: Snapshot; ui: PlannerUI; now: number; pendingCount: number; unscheduledCount: number;
  select: (selection: Selection) => void; openCandidate: (id: string) => void; openInbox: () => void;
  openUnscheduled: () => void; createTask: () => void; actions: TaskActions;
}) {
  const [filter, setFilter] = useState<Filter>('open');
  const [showPast, setShowPast] = useState(false);
  const today = todayDate();
  const week = teachingWeek(snapshot.settings.termStart, today);
  const items = buildCalendar(snapshot, today, today, snapshot.settings.showPending)
    .sort((a, b) => (a.start ?? '~').localeCompare(b.start ?? '~'));
  const occupying = (item: CalendarItem) => item.category !== 'deadline' && item.category !== 'candidate' && item.start !== null;
  const focus = items.find(item => occupying(item) && endOf(item) > now);
  const past = items.filter(item => item !== focus && endOf(item) <= now);
  const upcoming = items.filter(item => item !== focus && endOf(item) > now);
  const lastEnd = Math.max(0, ...items.filter(occupying).map(endOf));
  const freeFrom = lastEnd > now ? new Date(lastEnd + 8 * 3600_000).toISOString().slice(11, 16) : null;
  const open = (item: CalendarItem) => item.category === 'candidate' ? openCandidate(item.refId) : select({ entity: item.refKind, id: item.refId, occurrenceDate: item.occurrenceDate });

  const openTasks = filter === 'all' ? snapshot.tasks.filter(task => task.status === 'open') : selectRailTasks(snapshot, now);
  const done = snapshot.tasks.filter(task => task.status === 'done');
  const grouped = (['over', 'today', 'week', 'later', 'none'] as const)
    .map(key => [key, openTasks.filter(task => groupOf(task, today, now) === key)] as const).filter(([, list]) => list.length);
  const groups: (readonly [Group, Task[]])[] = filter === 'open' ? grouped : filter === 'done' ? (done.length ? [['done', done]] : [])
    : [...grouped, ...(done.length ? [['done', done] as const] : [])];

  const row = (item: CalendarItem) => (
    <button key={item.id} className={`m-agenda-row kind-${item.category}${endOf(item) <= now ? ' past' : ''}`} style={itemColor(item, snapshot)} onClick={() => open(item)}>
      <time>{item.start ? clock(item.start) : '全天'}</time>
      <span className="m-agenda-text"><strong>{item.title}</strong>
        <small>{[kindNames[item.category], item.location].filter(Boolean).join(' · ')}</small></span>
      <ChevronRight aria-hidden="true" />
    </button>
  );
  const focusStart = focus?.start ? Date.parse(focus.start) : 0;
  const ongoing = focus ? focusStart <= now : false;

  return (
    <div className="m-page m-today">
      <header className="m-hero">
        <div>
          <h1>今天</h1>
          <p>{shortDate(today)} · 周{weekdayName(today)}{week && week <= snapshot.settings.termWeeks ? ` · 第 ${week} 周` : ''}</p>
        </div>
        <div className="m-seal" aria-hidden="true"><span>{Number(today.slice(5, 7))}月</span><b>{Number(today.slice(8))}</b></div>
      </header>

      {pendingCount > 0 && <button className="m-notice-row" onClick={openInbox}>
        <span><b>{pendingCount}</b> 条通知等你判断</span><ChevronRight aria-hidden="true" />
      </button>}

      <section aria-label="今天的安排">
        {focus ? (
          <article className={`m-next kind-${focus.category}`} style={itemColor(focus, snapshot)}>
            <div className="m-next-kicker"><span>{ongoing ? '进行中' : '接下来'} · {kindNames[focus.category]}</span>
              <span>{ongoing ? `${clock(effectiveActivityEnd(focus.start!, focus.end))} 结束` : minutesLabel(Math.round((focusStart - now) / 60_000))}</span></div>
            <h2>{focus.title}</h2>
            <div className="m-next-foot">
              <span>{clock(focus.start)}–{clock(effectiveActivityEnd(focus.start!, focus.end))}{focus.location ? ` · ${focus.location}` : ''}</span>
              <button onClick={() => open(focus)}>详情</button>
            </div>
          </article>
        ) : !items.length ? (
          <div className="m-empty"><p>今天没有课程和安排。</p></div>
        ) : null}
        {/* The free-time line follows the last item that takes time; deadlines after it do not occupy the evening. */}
        {freeFrom && !upcoming.some(occupying) && <p className="m-free">{freeFrom} 之后暂无安排</p>}
        {upcoming.length > 0 && <div className="m-agenda">{upcoming.map((item, index) => <Fragment key={item.id}>
          {row(item)}
          {freeFrom && occupying(item) && !upcoming.slice(index + 1).some(occupying) && <p className="m-free">{freeFrom} 之后暂无安排</p>}
        </Fragment>)}</div>}
        {past.length > 0 && <>
          <button className="m-link" aria-expanded={showPast} onClick={() => setShowPast(value => !value)}>{showPast ? '收起已结束' : `已结束 ${past.length} 项`}</button>
          {showPast && <div className="m-agenda">{past.map(row)}</div>}
        </>}
      </section>

      <section aria-label="待办">
        <div className="m-section-head">
          <h2>待办</h2>
          <div className="m-section-actions">
            {unscheduledCount > 0 && <button className="m-link" onClick={openUnscheduled}>未安排 {unscheduledCount}</button>}
            <button className="m-icon" onClick={createTask} aria-label="新任务"><Plus aria-hidden="true" /></button>
          </div>
        </div>
        <div className="m-tabs" role="group" aria-label="待办筛选">
          {([['open', '待完成'], ['done', '已完成'], ['all', '全部']] as const).map(([id, label]) =>
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
        </div>
        {groups.length ? groups.map(([key, list]) => (
          <div className={`m-group group-${key}`} key={key}>
            <h3><span>{groupNames[key]}</span><span>{list.length} 项</span></h3>
            {list.map(task => <TaskItem key={task.id} task={task} snapshot={snapshot} ui={ui} now={now} today={today} actions={actions} select={select} />)}
          </div>
        )) : <div className="m-empty"><p>{filter === 'done' ? '还没有完成的任务。' : '没有待办任务。'}</p></div>}
      </section>
    </div>
  );
}

function TaskItem({ task, snapshot, ui, now, today, actions, select }: {
  task: Task; snapshot: Snapshot; ui: PlannerUI; now: number; today: string; actions: TaskActions; select: (selection: Selection) => void;
}) {
  const arrangements = taskArrangements(snapshot, task.id);
  const timing = !arrangements.length ? taskNoticeTiming(snapshot, task.id) : null;
  const attention = task.status === 'open' ? taskAttention(snapshot, task, now) : null;
  const color = belongingColor(task, snapshot);
  const primary = attention
    ? { label: attention.actionLabel, run: () => attention.kind === 'overdue' ? actions.editTask(task.id) : actions.schedule(task.id, attention.blockId) }
    : { label: arrangements.length ? '查看安排' : '安排', run: () => actions.schedule(task.id) };
  const deadline = task.deadline ? `${task.deadline.date === today ? '今天' : shortDate(task.deadline.date)}${task.deadline.time ? ` ${task.deadline.time}` : ''} 截止` : '';
  const meta = [deadline, attention?.label, arrangements.length ? taskArrangementSummary(arrangements, now) : '', timing ? taskNoticeSummary(timing, now) : ''].filter(Boolean).join(' · ');
  return (
    <article className={`m-task${attention ? ' warn' : ''}${task.status === 'done' ? ' done' : ''}`} data-task-id={task.id}>
      <label className="m-check"><input type="checkbox" aria-label={`完成 ${task.title}`} checked={task.status === 'done'} disabled={ui.busy}
        onChange={() => void ui.mutate([{ type: 'finishTask', id: task.id, expectedVersion: task.version, completed: task.status !== 'done' }])} /></label>
      <button className="m-task-main" onClick={() => select({ entity: 'task', id: task.id })}>
        <strong>{color && <i className="m-owner" style={{ background: color }} aria-hidden="true" />}{task.title}</strong>
        {meta && <small>{meta}</small>}
      </button>
      {task.status !== 'done' && <button className="m-btn" disabled={ui.busy && !!attention} onClick={primary.run}>{primary.label}</button>}
    </article>
  );
}
