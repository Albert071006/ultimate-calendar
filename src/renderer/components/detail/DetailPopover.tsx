import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, FileOutput, Pencil, Trash2, X } from "lucide-react";
import { mondayWeekday, type Block, type Candidate, type Course, type Goal, type ReminderConfig, type Snapshot, type Task } from "../../../shared/contracts";
import type { PlannerUI } from "../../hooks/usePlanner";
import type { Selection } from "../Calendar";
import { useCurrentTime } from "../../hooks/useCurrentTime";
import { candidateExpiry } from "../../../domain/candidate-eligibility";
import { CandidateTiming } from "../CandidateTiming";
import { candidateDisplay } from "../../candidate-display";
import { taskArrangements, eventTimeLabel, taskNoticeTiming, taskNoticeSummary } from "../../task-schedule";
import { taskAttention } from "../../task-rail";
import { effectiveActivityEnd } from "../../../domain/activity-duration";
import { belongingColor } from "../../../domain/belonging";
import { entityNames, findRecord } from "./records";
import { workFill } from "../../work-fill";
import "./DetailPopover.css";
import { useMobile } from '../../mobile/layout';
import { MobileSheet } from '../../mobile/MobileSheet';
import { ResourceSection } from '../resources/ResourcePanel';

export interface DetailActions {
  edit: () => void;
  editTask: (id: string) => void;
  schedule: (id: string, blockId?: string) => void;
  scheduleRecurring?: (id: string) => void;
  removeTask: (id: string) => void;
  exportGoal?: (id: string) => void;
}

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const WIDTH = 316, GAP = 12, MARGIN = 8;

function dateLabel(date: string) {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日 周${weekdays[mondayWeekday(date) - 1]}`;
}
function durationLabel(minutes: number) {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours} 小时` : "", rest ? `${rest} 分` : ""].filter(Boolean).join(" ") || "0 分";
}
/** "10月24日 周六 15:00–16:30 · 1 小时 30 分"; spans across midnight name both dates. */
function spanLabel(start: string, end: string, defaulted = false) {
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60000);
  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  return <><span className="date">{dateLabel(start.slice(0, 10))}{sameDay ? "" : ` 至 ${dateLabel(end.slice(0, 10))}`}</span>
    <b>{start.slice(11, 16)}–{end.slice(11, 16)}</b>{` · ${durationLabel(minutes)}`}{defaulted && "（默认30分钟）"}</>;
}
function reminderLabel(value: ReminderConfig) {
  if (!value.enabled) return "不提醒";
  if (!value.leadMinutes) return "按全局设置";
  if (!value.leadMinutes.length) return "不提前提醒";
  return value.leadMinutes.map(minutes => minutes === 0 ? "准时" : `提前 ${minutes} 分钟`).join("、");
}

/** Where the card sits beside its anchor: the right side when it fits, else the left; kept inside the window. */
function usePlacement(anchor: DOMRect | null | undefined) {
  const ref = useRef<HTMLElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; side: "right" | "left"; arrow: number } | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    // Stay above the assistant bar so the card's actions are never covered.
    const height = ref.current.offsetHeight, width = window.innerWidth;
    const viewport = document.querySelector('[aria-label="生活助手"]')?.getBoundingClientRect().top || window.innerHeight;
    if (!anchor) { setPlace({ left: width - WIDTH - 24, top: 72, side: "left", arrow: -1 }); return; }
    const side = anchor.right + GAP + WIDTH <= width - MARGIN || anchor.left - GAP - WIDTH < MARGIN ? "right" : "left";
    const left = side === "right" ? Math.min(anchor.right + GAP, width - WIDTH - MARGIN) : anchor.left - GAP - WIDTH;
    const top = Math.max(MARGIN, Math.min(anchor.top, viewport - height - MARGIN));
    setPlace({ left: Math.max(MARGIN, left), top, side, arrow: Math.max(14, Math.min(height - 26, anchor.top + Math.min(anchor.height, 40) / 2 - top - 6)) });
  }, [anchor]);
  return { ref, place };
}

/**
 * The small card that opens beside a clicked item. It summarises the record and offers its everyday
 * actions; anything longer goes to the side edit panel.
 */
export function DetailPopover({ snapshot, selection, anchor, ui, close, actions }: {
  snapshot: Snapshot;
  selection: Selection;
  anchor?: DOMRect | null;
  ui: PlannerUI;
  close: () => void;
  actions: DetailActions;
}) {
  const mobile = useMobile();
  const now = useCurrentTime();
  const value = findRecord(snapshot, selection);
  const { ref, place } = usePlacement(anchor);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // A modal or the edit panel above the card handles its own Escape.
      if (event.key === "Escape" && !document.querySelector('[role="dialog"]')) { event.preventDefault(); closeRef.current(); }
    };
    const outside = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target && !ref.current?.contains(target) && !target.closest('[role="dialog"], .modal-backdrop')) closeRef.current();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", outside);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("mousedown", outside); };
  }, [ref]);
  if (!value) return null;
  const name = entityNames[selection.entity];
  let body: ReactNode = null, kind = name, swatch: CSSProperties | undefined, title = "title" in value ? value.title : "text" in value ? value.text : "详情";
  let footer: ReactNode = null;
  const editButton = <button className="ui-btn sm" onClick={actions.edit}><Pencil aria-hidden="true" />编辑{name}</button>;
  const belonging = (task: Task | undefined) => {
    const course = task?.courseId ? snapshot.courses.find(c => c.id === task.courseId) : undefined;
    const goal = task?.goalId ? snapshot.goals.find(g => g.id === task.goalId) : undefined;
    const color = task ? belongingColor(task, snapshot) : null;
    if (!course && !goal) return null;
    return <><dt>归属</dt><dd>{color && <i className="ui-dot" style={{ "--c": color } as CSSProperties} aria-hidden="true" />} {[course?.title, goal && `目标：${goal.title}`].filter(Boolean).join(" · ")}</dd></>;
  };

  if (selection.entity === "block") {
    const block = value as Block, task = block.taskId ? snapshot.tasks.find(t => t.id === block.taskId) : undefined;
    const color = task ? belongingColor(task, snapshot) : null;
    kind = block.kind === "work" ? "执行时段" : "固定活动";
    swatch = color ? { "--wf": workFill(color), "--c": color } as CSSProperties : undefined;
    const end = block.kind === "event" ? effectiveActivityEnd(block.start, block.end) : block.end;
    body = <dl>
      <dt>时间</dt><dd>{end ? spanLabel(block.start, end, block.kind === "event" && !block.end) : <b>{block.start.slice(11, 16)}</b>}</dd>
      {block.location && <><dt>地点</dt><dd>{block.location}</dd></>}
      {task && <><dt>任务</dt><dd><button className="a2-pop-link" onClick={() => actions.editTask(task.id)}>{task.title}</button></dd></>}
      {belonging(task)}
      <dt>提醒</dt><dd>{reminderLabel(block.reminders)}</dd>
      {(block.completed || block.cancelled) && <><dt>状态</dt><dd>{block.cancelled ? "已取消" : "已完成"}</dd></>}
    </dl>;
    const remove = () => void ui.mutate([block.recurrence
      ? { type: "cancelRecurringEvent", id: block.id, expectedVersion: block.version, scope: "single" }
      : { type: "delete", entity: "block", id: block.id, expectedVersion: block.version }]);
    footer = <>
      {!block.cancelled && <button className="ui-btn sm dark" disabled={ui.busy}
        onClick={() => void ui.mutate([{ type: "finishBlock", id: block.id, expectedVersion: block.version, completed: !block.completed }])}>
        <Check aria-hidden="true" />{block.completed ? "恢复未完成" : "完成"}</button>}
      {editButton}
      <span className="spacer" />
      {!block.cancelled && <button className="ui-btn sm ghost icon" disabled={ui.busy} aria-label={block.recurrence ? `取消本次 ${block.title}` : `删除 ${block.title}`}
        title={block.recurrence ? "取消本次活动" : "删除"} onClick={remove}><Trash2 aria-hidden="true" /></button>}
    </>;
  } else if (selection.entity === "course") {
    const course = value as Course;
    const exception = selection.occurrenceDate ? snapshot.courseExceptions.find(ex => ex.courseId === course.id && ex.originalDate === selection.occurrenceDate) : undefined;
    const replacement = exception?.replacement;
    if (replacement) title = replacement.title;
    swatch = course.color ? { "--c": course.color } as CSSProperties : undefined;
    const date = selection.occurrenceDate;
    body = <dl>
      <dt>时间</dt><dd>{replacement ? spanLabel(replacement.start, replacement.end)
        : date ? spanLabel(`${date}T${course.startTime}:00+08:00`, `${date}T${course.endTime}:00+08:00`) : <b>{course.startTime}–{course.endTime}</b>}</dd>
      {(replacement?.location ?? course.location) && <><dt>地点</dt><dd>{replacement?.location ?? course.location}</dd></>}
      <dt>周次</dt><dd>每周{weekdays[course.weekday - 1]} · {course.weeks ? `第 ${course.weeks.join("、")} 周` : `${course.firstWeek}–${course.lastWeek} 周${{ all: "", odd: " · 单周", even: " · 双周" }[course.parity]}`}</dd>
      {exception && <><dt>调整</dt><dd>{exception.cancelled ? "本次停课" : `原定 ${dateLabel(exception.originalDate)}`}</dd></>}
      <dt>提醒</dt><dd>{reminderLabel(course.reminders)}</dd>
    </dl>;
    footer = editButton;
  } else if (selection.entity === "task") {
    const task = value as Task;
    const arrangements = taskArrangements(snapshot, task.id);
    const timing = !arrangements.length ? taskNoticeTiming(snapshot, task.id) : null;
    const attention = task.status === "open" ? taskAttention(snapshot, task, now) : null;
    const color = belongingColor(task, snapshot);
    swatch = color ? { "--c": color } as CSSProperties : undefined;
    body = <>
      {task.description && <p className="a2-pop-desc">{task.description}</p>}
      {attention && <section className="a2-pop-attention" aria-label="任务待处理">
        <strong className="task-attention-label">{attention.label}</strong>
        <button className="ui-btn sm" disabled={ui.busy} onClick={() => attention.kind === "overdue" ? actions.editTask(task.id) : actions.schedule(task.id, attention.blockId)}>{attention.actionLabel}</button>
      </section>}
      <dl>
        <dt>截止</dt><dd>{task.deadline ? <>{dateLabel(task.deadline.date)} <b>{task.deadline.time ?? ""}</b></> : "未设定"}</dd>
        {belonging(task)}
        {timing && <><dt>{timing.source === 'reminder' ? '提醒时间' : '原通知'}</dt><dd>{taskNoticeSummary(timing, now)} · 尚未入历</dd></>}
        <dt>提醒</dt><dd>{reminderLabel(task.reminders)}</dd>
        {task.status === "done" && <><dt>状态</dt><dd>已完成</dd></>}
      </dl>
      {arrangements.length > 0 && <section className="a2-pop-arrangements" aria-label="已安排活动">
        <h4>{arrangements.some(event => event.cancelled || event.completed) ? "日历安排与历史" : "已加入日历"}</h4>
        {arrangements.map(event => <div className="row" key={event.id}>
          <div><small>{event.kind === "work" ? "执行时段" : "固定活动"}{arrangements.length > 1 ? ` · ${event.title}` : ""}</small>
            <span>{event.cancelled ? "已取消 · " : event.completed ? "已完成 · " : ""}{eventTimeLabel(event)}</span>
            {event.location && <small>地点 · {event.location}</small>}</div>
          {!event.cancelled && <button className="ui-btn sm ghost" onClick={() => actions.schedule(task.id, event.id)}>调整时间</button>}
        </div>)}
      </section>}
    </>;
    footer = <>
      {task.status !== "done" && <button className="ui-btn sm dark" disabled={ui.busy}
        onClick={() => void ui.mutate([{ type: "finishTask", id: task.id, expectedVersion: task.version, completed: true }])}><Check aria-hidden="true" />完成任务</button>}
      {editButton}
      {!arrangements.length && <button className="ui-btn sm" onClick={() => actions.schedule(task.id)}>{timing ? "安排活动" : "安排执行时段"}</button>}
      {task.status !== "done" && actions.scheduleRecurring && <button className="ui-btn sm ghost" onClick={() => actions.scheduleRecurring!(task.id)}>重复安排</button>}
      <span className="spacer" />
      <button className="ui-btn sm ghost icon" disabled={ui.busy} aria-label={`移除 ${task.title}`} title="移除任务" onClick={() => actions.removeTask(task.id)}><Trash2 aria-hidden="true" /></button>
    </>;
  } else if (selection.entity === "candidate") {
    const candidate = value as Candidate, display = candidateDisplay(candidate, snapshot.settings), expiry = candidateExpiry(candidate, now);
    kind = "待定活动";
    body = <div className="a2-pop-candidate">
      <CandidateTiming candidate={candidate} />
      {candidate.status === "pending" && expiry.expired && <p className="candidate-expiry">已过期 · {expiry.reason}</p>}
      {candidate.location && <p>地点 · {candidate.location}</p>}
      <dl>
        <dt>行动</dt><dd>{candidate.action || "需校对"}</dd>
        <dt>收益</dt><dd>{candidate.benefitKind === "stated" ? candidate.benefit || "未说明" : "未说明"}</dd>
        {candidate.potentialBenefit && <><dt>推测</dt><dd>{candidate.potentialBenefit}</dd></>}
        {display.conditions.length > 0 && <><dt>准备</dt><dd>{display.conditions.join("；")}</dd></>}
      </dl>
      {display.uncertainties.map((u, i) => <p className="warning" key={i}>{u}</p>)}
    </div>;
    const decide = (type: "acceptCandidate" | "ignoreCandidate") => void ui.mutate([{ type, id: candidate.id, expectedVersion: candidate.version, reason: "" }]);
    footer = <>
      {candidate.status === "pending" && !expiry.expired && <>
        <button className="ui-btn sm primary" disabled={ui.busy} onClick={() => decide("acceptCandidate")}>参加</button>
        <button className="ui-btn sm" disabled={ui.busy} onClick={() => decide("ignoreCandidate")}>忽略</button>
      </>}
      {editButton}
    </>;
  } else if (selection.entity === "goal") {
    const goal = value as Goal;
    swatch = goal.color ? { "--c": goal.color } as CSSProperties : undefined;
    const linked = snapshot.tasks.filter(task => task.goalId === goal.id);
    body = <>
      {goal.description && <p className="a2-pop-desc">{goal.description}</p>}
      <dl>
        <dt>状态</dt><dd>{{ active: "进行中", paused: "暂停", completed: "已完成" }[goal.status]}</dd>
        {goal.targetDate && <><dt>日期</dt><dd>{dateLabel(goal.targetDate)}</dd></>}
        <dt>任务</dt><dd>{linked.length ? `${linked.filter(task => task.status === "done").length} / ${linked.length} 已完成` : "暂无关联任务"}</dd>
      </dl>
    </>;
    footer = <>{editButton}{!mobile && actions.exportGoal && <button className="ui-btn sm" onClick={() => actions.exportGoal!(goal.id)}><FileOutput aria-hidden="true" />导出给外部智能体</button>}</>;
  } else {
    body = "description" in value && value.description ? <p className="a2-pop-desc">{value.description}</p> : null;
  }

  const content = (
    <aside ref={ref} aria-label={`${name}详情`}
      className={`a2-pop${place ? ` ${place.side}` : ""}${place?.arrow === -1 ? " no-arrow" : ""}`}
      style={mobile ? undefined : { left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? undefined : "hidden", "--arrow": `${place?.arrow ?? 20}px` } as CSSProperties}>
      <header className="a2-pop-h">
        <div className="kind"><i className={`swatch ${selection.entity === "block" ? (value as Block).kind : selection.entity}`} style={swatch} aria-hidden="true" />{kind}</div>
        <h3>{title}</h3>
        <button className="ui-btn sm ghost icon close" onClick={close} aria-label="关闭详情" title="关闭（Esc）"><X aria-hidden="true" /></button>
      </header>
      <div className="a2-pop-b">{body}
        {(selection.entity === 'task' || selection.entity === 'block' || selection.entity === 'course' || selection.entity === 'goal') &&
          <ResourceSection snapshot={snapshot} target={{ entity: selection.entity, id: selection.id }} ui={ui} />}
      </div>
      {footer && <footer className="a2-pop-a">{footer}</footer>}
    </aside>
  );
  return mobile ? <MobileSheet title={`${name}详情`} close={close} bare>{content}</MobileSheet> : content;
}
