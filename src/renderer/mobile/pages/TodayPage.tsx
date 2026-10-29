import { Fragment, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import type { CalendarItem, Snapshot, Task } from '../../../shared/contracts';
import type { PlannerUI } from '../../hooks/usePlanner';
import type { Selection } from '../../components/Calendar';
import type { TaskActions } from '../../components/tasks/TaskRow';
import { buildCalendar } from '../../../domain/calendar';
import { effectiveActivityEnd } from '../../../domain/activity-duration';
import { selectRailTasks, taskAttention } from '../../task-rail';
import { groupTodayTasks, todayTaskGroupNames as groupNames, type TodayTaskGroup as Group } from '../../today-tasks';
import { taskArrangements, taskArrangementSummary, taskNoticeTiming, taskNoticeSummary } from '../../task-schedule';
import { teachingWeek } from '../../pages/today/Today';
import { todayDate } from '../../calendar-layout';
import { clock, itemColor, shortDate, weekdayName } from '../item-style';

const endOf = (item: CalendarItem) => Date.parse(item.start ? effectiveActivityEnd(item.start, item.end) : `${item.date}T23:59:59+08:00`);
const minutesLabel = (minutes: number) => minutes < 1 ? '即将开始' : minutes < 60 ? `${minutes} 分钟后` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}后`;

export function TodayPage({ snapshot, ui, now, pendingCount, unscheduledCount, select, openCandidate, openInbox, openUnscheduled, createTask, actions }: {
  snapshot: Snapshot; ui: PlannerUI; now: number; pendingCount: number; unscheduledCount: number;
  select: (selection: Selection) => void; openCandidate: (id: string) => void; openInbox: () => void;
  openUnscheduled: () => void; createTask: () => void; actions: TaskActions;
}) {
  const [showDone, setShowDone] = useState(false);
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

  const openTasks = selectRailTasks(snapshot, now);
  const done = snapshot.tasks.filter(task => task.status === 'done');
  const grouped = groupTodayTasks(snapshot, openTasks, today, now);
  const groups: (readonly [Group, Task[]])[] = [...grouped, ...(showDone && done.length ? [['done', done] as const] : [])];
  // A group label is only worth showing when it separates one group from another.
  const labelled = grouped.length > 1 || grouped.some(([key]) => key === 'over');

  // The bar's style shows the kind; only a deadline or an undecided marker says so in words.
  const row = (item: CalendarItem) => (
    <button key={item.id} className={`m-agenda-row kind-${item.category}${endOf(item) <= now ? ' past' : ''}`} style={itemColor(item, snapshot)} onClick={() => open(item)}>
      <time>{item.start ? clock(item.start) : '全天'}</time>
      <i aria-hidden="true" />
      <strong>{item.title}</strong>
      {item.category === 'deadline' ? <em>截止</em> : item.category === 'candidate' ? <em className="quiet">待决定</em> : <span />}
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
      </header>

      {pendingCount > 0 && <button className="m-notice-row" onClick={openInbox}>
        <span><b>{pendingCount}</b> 条通知等你判断</span><ChevronRight aria-hidden="true" />
      </button>}

      <section aria-label="今天的安排">
        {focus ? (
          <button className={`m-next kind-${focus.category}`} style={itemColor(focus, snapshot)} onClick={() => open(focus)}>
            <small>{ongoing ? `进行中 · ${clock(effectiveActivityEnd(focus.start!, focus.end))} 结束` : minutesLabel(Math.round((focusStart - now) / 60_000))}</small>
            <strong>{focus.title}</strong>
            <span>{clock(focus.start)}–{clock(effectiveActivityEnd(focus.start!, focus.end))}{focus.location ? ` · ${focus.location}` : ''}</span>
          </button>
        ) : !items.length ? (
          <div className="m-empty"><p>今天没有课程和安排。</p></div>
        ) : null}
        {/* The free-time line follows the last item that takes time; deadlines after it do not occupy the evening. */}
        {freeFrom && !upcoming.some(occupying) && <p className="m-free">{freeFrom} 之后空闲</p>}
        {upcoming.length > 0 && <div className="m-agenda">{upcoming.map((item, index) => <Fragment key={item.id}>
          {row(item)}
          {freeFrom && occupying(item) && !upcoming.slice(index + 1).some(occupying) && <p className="m-free">{freeFrom} 之后空闲</p>}
        </Fragment>)}</div>}
        {past.length > 0 && <>
          <button className="m-link quiet" aria-expanded={showPast} onClick={() => setShowPast(value => !value)}>{showPast ? '收起已结束' : `已结束 ${past.length} 项`}</button>
          {showPast && <div className="m-agenda">{past.map(row)}</div>}
        </>}
      </section>

      <section aria-label="待办">
        <div className="m-section-head">
          <h2>待办</h2>
          <div className="m-section-actions">
            {unscheduledCount > 0 && <button className="m-link attn" onClick={openUnscheduled}>未安排 {unscheduledCount}</button>}
            <button className="m-icon" onClick={createTask} aria-label="新任务"><Plus aria-hidden="true" /></button>
          </div>
        </div>
        {groups.length ? groups.map(([key, list]) => (
          <div className={`m-group group-${key}`} key={key}>
            {(labelled || key === 'done') && <h3>{groupNames[key]}</h3>}
            {list.map(task => <TaskItem key={task.id} task={task} snapshot={snapshot} ui={ui} now={now} today={today} actions={actions} select={select} />)}
          </div>
        )) : <div className="m-empty"><p>没有待办任务。</p></div>}
        {done.length > 0 && <button className="m-link quiet m-more-link" aria-expanded={showDone} onClick={() => setShowDone(value => !value)}>{showDone ? '收起已完成' : '查看已完成'}</button>}
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
  const primary = attention
    ? { label: attention.actionLabel, run: () => attention.kind === 'overdue' ? actions.editTask(task.id) : actions.schedule(task.id, attention.blockId) }
    : { label: arrangements.length ? '查看安排' : '安排', run: () => actions.schedule(task.id) };
  const deadline = task.deadline ? `${task.deadline.date === today ? '今天' : shortDate(task.deadline.date)}${task.deadline.time ? ` ${task.deadline.time}` : ''} 截止` : '';
  // One line: what needs attention first, otherwise the deadline, otherwise where it is arranged.
  const meta = task.status === 'done' ? '' : attention?.label ?? (deadline || (arrangements.length ? taskArrangementSummary(arrangements, now) : timing ? taskNoticeSummary(timing, now) : ''));
  const urgent = !!attention || (task.status === 'open' && !!task.deadline && task.deadline.date <= today);
  return (
    <article className={`m-task${attention ? ' warn' : ''}${task.status === 'done' ? ' done' : ''}`} data-task-id={task.id}>
      <label className="m-check"><input type="checkbox" aria-label={`完成 ${task.title}`} checked={task.status === 'done'} disabled={ui.busy}
        onChange={() => void ui.mutate([{ type: 'finishTask', id: task.id, expectedVersion: task.version, completed: task.status !== 'done' }])} /></label>
      <button className="m-task-main" onClick={() => select({ entity: 'task', id: task.id })}>
        <strong>{task.title}</strong>
        {meta && <small className={urgent ? 'due' : undefined}>{meta}</small>}
      </button>
      {task.status !== 'done' && <button className="m-text-btn" disabled={ui.busy && !!attention} onClick={primary.run}>{primary.label}</button>}
    </article>
  );
}
