import type { Snapshot, Task } from "../../../shared/contracts";
import type { PlannerUI } from "../../hooks/usePlanner";
import { taskArrangements, taskArrangementSummary, taskNoticeTiming, taskNoticeSummary } from "../../task-schedule";
import { taskAttention } from "../../task-rail";
import { belongingColor } from "../../../domain/belonging";
import { MoreMenu, type MenuItem } from "../shell/MoreMenu";
import "./TaskRow.css";

export interface TaskActions {
  /** Shows the task details; falls back to editing where no details are available. */
  select?: (selection: { entity: "task"; id: string }) => void;
  editTask: (id: string) => void;
  schedule: (id: string, blockId?: string) => void;
  scheduleRecurring?: (id: string) => void;
  removeTask: (id: string) => void;
}

function deadlineLabel(task: Task, today: string) {
  if (!task.deadline) return "";
  const day = task.deadline.date === today ? "今天" : `${Number(task.deadline.date.slice(5, 7))}月${Number(task.deadline.date.slice(8))}日`;
  return `${day}${task.deadline.time ? ` ${task.deadline.time}` : ""}`;
}

/** A task with one visible primary action; everything else lives in its "⋯" menu. */
export function TaskRow({ task, snapshot, ui, now, today, actions }: {
  task: Task; snapshot: Snapshot; ui: PlannerUI; now: number; today: string; actions: TaskActions;
}) {
  const arrangements = taskArrangements(snapshot, task.id);
  const timing = !arrangements.length ? taskNoticeTiming(snapshot, task.id) : null;
  const attention = task.status === "open" ? taskAttention(snapshot, task, now) : null;
  const course = task.courseId ? snapshot.courses.find(value => value.id === task.courseId) : undefined;
  const goal = task.goalId ? snapshot.goals.find(value => value.id === task.goalId) : undefined;
  const color = belongingColor(task, snapshot);
  const primary = attention
    ? { label: attention.actionLabel, run: () => attention.kind === "overdue" ? actions.editTask(task.id) : actions.schedule(task.id, attention.blockId) }
    : { label: arrangements.length ? "查看安排" : "安排", run: () => actions.schedule(task.id) };
  const menu: MenuItem[] = [
    ...(attention ? [{ label: arrangements.length ? "查看安排" : "安排", onSelect: () => actions.schedule(task.id) }] : []),
    { label: "编辑", onSelect: () => actions.editTask(task.id) },
    ...(task.status !== "done" && actions.scheduleRecurring ? [{ label: "重复安排", onSelect: () => actions.scheduleRecurring!(task.id) }] : []),
    { label: "移除", danger: true, disabled: ui.busy, ariaLabel: `移除 ${task.title}`, onSelect: () => actions.removeTask(task.id) },
  ];
  const meta = [
    task.deadline ? `截止 ${deadlineLabel(task, today)}` : "",
    attention?.label ?? "",
  ].filter(Boolean).join(" · ");
  return (
    <article className={`a2-task-row${attention ? " warn" : ""}${task.status === "done" ? " done" : ""}`} data-task-id={task.id} data-attention={attention?.kind}
      draggable onDragStart={(e) => e.dataTransfer.setData("application/x-planner", JSON.stringify({ kind: "task", id: task.id }))}>
      <input type="checkbox" aria-label={`完成 ${task.title}`} checked={task.status === "done"} disabled={ui.busy}
        onChange={() => void ui.mutate([{ type: "finishTask", id: task.id, expectedVersion: task.version, completed: task.status !== "done" }])} />
      <div className="a2-task-main">
        <button className="a2-task-title" onClick={() => actions.select ? actions.select({ entity: "task", id: task.id }) : actions.editTask(task.id)}>{task.title}</button>
        <div className="a2-task-meta">
          {meta && <span className={attention ? "warn" : ""}>{meta}</span>}
          {(course || goal) && <span className="a2-task-belonging">
            {color && <i className="ui-dot" style={{ "--c": color } as React.CSSProperties} aria-hidden="true" />}
            {[course?.title, goal && `目标：${goal.title}`].filter(Boolean).join(" · ")}
          </span>}
          {arrangements.length > 0 && <span>{taskArrangementSummary(arrangements, now)}</span>}
          {timing && <span>{taskNoticeSummary(timing, now)}</span>}
        </div>
      </div>
      {task.status !== "done" ? <button className="ui-btn sm" disabled={ui.busy && !!attention} onClick={primary.run}>{primary.label}</button> : <span />}
      <MoreMenu label={`${task.title} 的更多操作`} items={menu} />
    </article>
  );
}
