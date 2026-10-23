import { useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, Plus } from "lucide-react";
import type { CalendarItem, Snapshot, Task } from "../../../shared/contracts";
import type { PlannerUI } from "../../hooks/usePlanner";
import type { EditorTarget } from "../../components/DetailPanel";
import { buildCalendar } from "../../../domain/calendar";
import { belongingColor } from "../../../domain/belonging";
import { taskDeadlineEnd } from "../../../domain/unscheduled";
import { effectiveActivityEnd } from "../../../domain/activity-duration";
import { dayDistance } from "../../../domain/time";
import { selectRailTasks } from "../../task-rail";
import { todayDate } from "../../calendar-layout";
import { PageToolbar } from "../../components/shell/PageToolbar";
import { useCurrentTime } from "../../hooks/useCurrentTime";
import { TaskRow, type TaskActions } from "../../components/tasks/TaskRow";
import "./Today.css";

type Filter = "open" | "done" | "all";
const hm = (instant: string | null) => instant?.slice(11, 16) ?? "";

export function teachingWeek(termStart: string | null, date: string): number | null {
  if (!termStart) return null;
  const days = dayDistance(termStart, date);
  return days < 0 ? null : Math.floor(days / 7) + 1;
}
export function longDate(date: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" })
    .format(new Date(`${date}T12:00:00+08:00`)).replace(/(日)(星期)/, "$1 $2");
}

/** Groups by deadline relative to today and the Monday-based week. */
function groupOf(task: Task, today: string, now: number): "over" | "today" | "week" | "later" | "none" {
  const end = taskDeadlineEnd(task);
  if (end === null) return "none";
  if (end <= now) return "over";
  if (task.deadline!.date === today) return "today";
  const weekday = (new Date(`${today}T12:00:00+08:00`).getUTCDay() + 6) % 7;
  return dayDistance(today, task.deadline!.date) <= 6 - weekday ? "week" : "later";
}
const groupNames = { over: "已逾期", today: "今天", week: "本周", later: "以后", none: "无截止", done: "已完成" } as const;

export function Today({ snapshot, ui, pendingCount, create, openInbox, openCandidate, openRecord, goCalendar, detail, ...actions }: TaskActions & {
  snapshot: Snapshot; ui: PlannerUI; pendingCount: number;
  create: () => void; openInbox: () => void; openCandidate: (id: string) => void;
  openRecord: (target: EditorTarget) => void; goCalendar: () => void;
  /** Details of the selected task, shown beside the lists. */
  detail?: ReactNode;
}) {
  const now = useCurrentTime();
  const [filter, setFilter] = useState<Filter>("open");
  const today = todayDate();
  const week = teachingWeek(snapshot.settings.termStart, today);

  const items = buildCalendar(snapshot, today, today, snapshot.settings.showPending)
    .sort((a, b) => (a.start ?? "~").localeCompare(b.start ?? "~"));
  const endOf = (item: CalendarItem) => Date.parse(item.start ? (item.end ?? effectiveActivityEnd(item.start, null)) : `${item.date}T23:59:59+08:00`);
  const nowIndex = items.findIndex(item => item.start !== null && Date.parse(item.start) >= now);
  const next = items.find(item => item.category !== "deadline" && item.start && Date.parse(item.start) > now);
  const arranged = items.filter(item => item.category === "work" || item.category === "event").length;
  const deadlines = items.filter(item => item.category === "deadline").length;

  // "待完成" hides fixed activities already attended or cancelled; "全部" keeps every task.
  const open = filter === "all" ? snapshot.tasks.filter(task => task.status === "open") : selectRailTasks(snapshot, now);
  const done = snapshot.tasks.filter(task => task.status === "done");
  const grouped = (["over", "today", "week", "later", "none"] as const)
    .map(key => [key, open.filter(task => groupOf(task, today, now) === key)] as const)
    .filter(([, list]) => list.length);
  const groups = filter === "open" ? grouped : filter === "done" ? (done.length ? [["done", done] as const] : []) : [...grouped, ...(done.length ? [["done", done] as const] : [])];

  const decide = (candidateId: string, type: "acceptCandidate" | "ignoreCandidate") => {
    const candidate = snapshot.candidates.find(value => value.id === candidateId);
    if (candidate) void ui.mutate([{ type, id: candidate.id, expectedVersion: candidate.version, reason: "" }]);
  };
  const timeline = items.map((item, index) => {
    const block = item.refKind === "block" ? snapshot.blocks.find(value => value.id === item.refId) : undefined;
    const task = block?.taskId ? snapshot.tasks.find(value => value.id === block.taskId) : undefined;
    const course = item.refKind === "course" ? snapshot.courses.find(value => value.id === item.refId) : undefined;
    const color = course?.color ?? (task ? belongingColor(task, snapshot) : null);
    const past = endOf(item) <= now;
    const kind = item.category === "candidate" ? "pend" : item.category === "deadline" ? "ddl" : item.category;
    const minutes = item === next && item.start ? Math.round((Date.parse(item.start) - now) / 60_000) : null;
    const style = { ...(color ? { "--c": color } : {}), ...(color && kind === "work" ? { "--wf": `color-mix(in srgb, ${color} 82%, #111)` } : {}) } as CSSProperties;
    const meta = item.category === "deadline" ? "截止" : item.category === "candidate" ? `待决定${item.location ? ` · ${item.location}` : ""}`
      : item.category === "work" ? `执行时段${task ? ` · ${task.title}` : ""}` : item.location;
    return (
      <div key={item.id}>
        {index === nowIndex && <div className="a2-tl-now"><span>{new Date(now + 8 * 3600_000).toISOString().slice(11, 16)}</span></div>}
        <div className={`a2-tl-item ${kind}${past ? " past" : ""}${item === next ? " next" : ""}${block?.completed ? " done" : ""}`} style={style}>
          <div className="time">{item.start ? hm(item.start) : "当天"}{item.end && <small>{hm(item.end)}</small>}</div>
          <div className="box">
            <button className="bt" onClick={() => item.category === "candidate" ? openCandidate(item.refId)
              : openRecord({ entity: item.refKind as EditorTarget["entity"], id: item.refId })}>
              {item.title}
              {minutes !== null && minutes <= 180 && <span className="soon">{minutes} 分钟后</span>}
            </button>
            {meta && <div className="bm">{meta}</div>}
            {item.category === "candidate" && !past && (
              <div className="acts">
                <button className="ui-btn sm primary" disabled={ui.busy} onClick={() => decide(item.refId, "acceptCandidate")}>参加</button>
                <button className="ui-btn sm" disabled={ui.busy} onClick={() => decide(item.refId, "ignoreCandidate")}>忽略</button>
                <button className="ui-btn sm ghost" onClick={() => openCandidate(item.refId)}>稍后</button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  });

  return (
    <div className="a2-page">
      <PageToolbar title={longDate(today)} sub={week ? `第 ${week} 周` : undefined} ui={ui}>
        <button className="ui-btn" onClick={create}><Plus aria-hidden="true" />新任务</button>
      </PageToolbar>
      <div className={`a2-today-frame${detail ? " with-detail" : ""}`}>
      <div className="a2-today">
        {pendingCount > 0 && (
          <button className="a2-banner" onClick={openInbox}>
            <b>{pendingCount}</b> 条通知等你判断<span className="go">去看看 <ArrowRight aria-hidden="true" /></span>
          </button>
        )}
        <div className="a2-today-cols">
          <section aria-label="今天的安排">
            <div className="a2-sec-h"><h2>今天</h2>{items.length > 0 && <span className="ui-hint">{arranged} 项安排 · {deadlines} 个截止</span>}</div>
            {items.length ? <div className="a2-tl">{timeline}{nowIndex === -1 && <div className="a2-tl-now end"><span>{new Date(now + 8 * 3600_000).toISOString().slice(11, 16)}</span></div>}</div> : (
              <div className="ui-empty">
                <h4>今天没有课程和安排</h4>
                <p>可以在日历上拖出一段时间，或者对助手说"下午三点留一小时背单词"。</p>
                <div className="actions"><button className="ui-btn" onClick={goCalendar}>去日历安排</button></div>
              </div>
            )}
          </section>
          <section aria-label="待办">
            <div className="a2-sec-h">
              <h2>待办</h2>
              <div className="ui-seg" role="group" aria-label="待办筛选">
                {([["open", "待完成"], ["done", "已完成"], ["all", "全部"]] as const).map(([id, label]) => (
                  <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
                ))}
              </div>
            </div>
            {groups.length ? groups.map(([key, list]) => (
              <div className={`a2-group ${key}`} key={key}>
                <h3>{groupNames[key]} <b>{list.length}</b></h3>
                {list.map(task => <TaskRow key={task.id} task={task} snapshot={snapshot} ui={ui} now={now} today={today} actions={actions} />)}
              </div>
            )) : (
              <div className="ui-empty">
                <h4>{filter === "done" ? "还没有完成的任务" : "没有待办任务"}</h4>
                <p>接受待判断里的通知，或者新建一个任务。</p>
                <div className="actions"><button className="ui-btn" onClick={create}><Plus aria-hidden="true" />新任务</button></div>
              </div>
            )}
          </section>
        </div>
      </div>
      {detail}
      </div>
    </div>
  );
}
