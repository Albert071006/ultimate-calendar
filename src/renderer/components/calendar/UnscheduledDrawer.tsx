import { ChevronRight } from "lucide-react";
import type { Snapshot, Task } from "../../../shared/contracts";
import type { PlannerUI } from "../../hooks/usePlanner";
import { unscheduledTasks, taskDeadlineEnd } from "../../../domain/unscheduled";
import { dayDistance } from "../../../domain/time";
import { taskAttention } from "../../task-rail";
import { todayDate } from "../../calendar-layout";
import { MoreMenu } from "../shell/MoreMenu";
import type { TaskActions } from "../tasks/TaskRow";
import "./UnscheduledDrawer.css";
import { useMobile } from '../../mobile/layout';

export type Urgency = "over" | "today" | "week" | "later" | "none";
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];

/** Overdue or needing a new time first; then by how soon the deadline falls in this Monday-based week. */
export function urgency(task: Task, snapshot: Snapshot, now: number, today = todayDate()): Urgency {
  const end = taskDeadlineEnd(task);
  if ((end !== null && end <= now) || taskAttention(snapshot, task, now)) return "over";
  if (!task.deadline) return "none";
  if (task.deadline.date === today) return "today";
  const weekday = (new Date(`${today}T12:00:00+08:00`).getUTCDay() + 6) % 7;
  return dayDistance(today, task.deadline.date) <= 6 - weekday ? "week" : "later";
}
export function deadlineText(task: Task, today = todayDate()) {
  if (!task.deadline) return "无截止时间";
  const { date, time } = task.deadline;
  // 2024-01-01 is a Monday; equal quotients mean the same Monday-based week.
  const sameWeek = Math.floor(dayDistance("2024-01-01", date) / 7) === Math.floor(dayDistance("2024-01-01", today) / 7);
  const day = date === today ? "今天" : sameWeek
    ? `周${weekdays[(new Date(`${date}T12:00:00+08:00`).getUTCDay() + 6) % 7]}` : `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
  return `截止 ${day}${time ? ` ${time}` : ""}`;
}

export function UnscheduledDrawer({ snapshot, ui, now, collapse, actions }: {
  snapshot: Snapshot; ui: PlannerUI; now: number; collapse: () => void; actions: TaskActions;
}) {
  const mobile = useMobile();
  const tasks = unscheduledTasks(snapshot, now);
  return (
    <aside className="a2-drawer" aria-label="未安排任务">
      <div className="a2-drawer-h">
        <h2>未安排</h2><span className="count">{tasks.length}</span>
        <button className="ui-btn ghost icon" aria-label="收起未安排" title="收起" onClick={collapse}><ChevronRight aria-hidden="true" /></button>
      </div>
      {tasks.length ? (
        <div className="a2-drawer-list">
          {tasks.map(task => {
            const level = urgency(task, snapshot, now), attention = taskAttention(snapshot, task, now);
            return (
              <article key={task.id} className={`a2-card lvl-${level}`} data-task-id={task.id} title={mobile ? '点击安排，选择分钟时间' : '拖到日历上安排时间'} draggable={!mobile}
                onDragStart={(e) => e.dataTransfer.setData("application/x-planner", JSON.stringify({ kind: "task", id: task.id }))}>
                <span className="grip" aria-hidden="true" />
                <div>
                  <button className="ct" onClick={() => actions.select ? actions.select({ entity: "task", id: task.id }) : actions.editTask(task.id)}>{task.title}</button>
                  <div className="cm">{deadlineText(task)}{attention?.kind === "ended" ? " · 安排已结束" : ""}</div>
                </div>
                {mobile && <button className="ui-btn" onClick={() => actions.schedule(task.id)}>安排</button>}
                <MoreMenu label={`${task.title} 的更多操作`} items={[
                  { label: "安排", onSelect: () => actions.schedule(task.id) },
                  ...(actions.scheduleRecurring ? [{ label: "重复安排", onSelect: () => actions.scheduleRecurring!(task.id) }] : []),
                  { label: "编辑", onSelect: () => actions.editTask(task.id) },
                  { label: "完成", disabled: ui.busy, ariaLabel: `完成任务 ${task.title}`, onSelect: () => void ui.mutate([{ type: "finishTask", id: task.id, expectedVersion: task.version, completed: true }]) },
                  { label: "移除", danger: true, disabled: ui.busy, ariaLabel: `移除 ${task.title}`, onSelect: () => actions.removeTask(task.id) },
                ]} />
              </article>
            );
          })}
        </div>
      ) : (
        <div className="ui-empty a2-drawer-empty"><h4>没有未安排的任务</h4><p>新接受的任务会先出现在这里。</p></div>
      )}
    </aside>
  );
}
