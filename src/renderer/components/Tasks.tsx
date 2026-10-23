import type { Snapshot } from "../../shared/contracts";
import type { PlannerUI } from "../hooks/usePlanner";
import type { Selection } from "./Calendar";
import { useState } from "react";
import { taskArrangements, taskArrangementSummary, taskNoticeTiming, taskNoticeSummary } from '../task-schedule';
import { useCurrentTime } from '../hooks/useCurrentTime';
import { selectRailTasks, taskAttention } from '../task-rail';
export function Tasks({
  snapshot,
  ui,
  select,
  create,
  editTask,
  schedule,
  scheduleRecurring,
  removeTask,
}: {
  snapshot: Snapshot;
  ui: PlannerUI;
  select: (s: Selection) => void;
  create: () => void;
  editTask: (id: string) => void;
  schedule: (id: string, blockId?: string) => void;
  scheduleRecurring?: (id: string) => void;
  removeTask: (id: string) => void;
}) {
  const now = useCurrentTime();
  const [filter, setFilter] = useState("open");
  const tasks = filter === 'open'
    ? selectRailTasks(snapshot, now)
    : snapshot.tasks.filter((t) => filter === 'all' || t.status === filter);
  return (
    <div className="page-scroll">
      <div className="section-heading">
        <div>
          <h2>留出时间，完成重要的事</h2>
          <p>查看已有安排，继续处理未完成的事。截止已过或安排已结束时会标记提醒，由你决定如何处理。</p>
        </div>
        <button className="primary" onClick={create}>
          ＋ 新建任务
        </button>
      </div>
      <div className="tabs">
        {[
          ["open", "待完成"],
          ["done", "已完成"],
          ["all", "全部"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={filter === id ? "selected" : ""}
            onClick={() => setFilter(id!)}
          >
            {label}
          </button>
        ))}
      </div>
      {!tasks.length && (
        <div className="empty-state">
          <h3>这里还没有任务</h3>
          <p>手动新建，或从待判断事项中接受一个。</p>
          <button onClick={create}>新建第一项任务</button>
        </div>
      )}
      <div className="task-list">
        {tasks.map((task) => {
          const arrangements = taskArrangements(snapshot, task.id);
          const timing = !arrangements.length ? taskNoticeTiming(snapshot, task.id) : null;
          const attention = taskAttention(snapshot, task, now);
          return (
            <article
              className={`task-row${attention ? ' task-needs-attention' : ''}`}
              data-task-id={task.id}
              data-attention={attention?.kind}
              key={task.id}
              draggable
              onDragStart={(e) =>
                e.dataTransfer.setData(
                  "application/x-planner",
                  JSON.stringify({ kind: "task", id: task.id }),
                )
              }
            >
              <input
                aria-label={`完成 ${task.title}`}
                type="checkbox"
                checked={task.status === "done"}
                disabled={ui.busy}
                onChange={() =>
                  void ui.mutate([
                    {
                      type: "finishTask",
                      id: task.id,
                      expectedVersion: task.version,
                      completed: task.status !== "done",
                    },
                  ])
                }
              />
              <button
                className="task-main"
                onClick={() => select({ entity: "task", id: task.id })}
              >
                <strong className={task.status === "done" ? "completed" : ""}>
                  {task.title}
                </strong>
                {arrangements.length > 0 && <small className="task-event-time">{taskArrangementSummary(arrangements, now)}</small>}
                {timing && <small className="task-event-time">{taskNoticeSummary(timing, now)}</small>}
                <small>
                  {task.deadline
                    ? `截止 ${task.deadline.date} ${task.deadline.time ?? "（仅日期）"}`
                    : "未设截止"}
                  {task.goalId &&
                    ` · ${snapshot.goals.find((g) => g.id === task.goalId)?.title ?? "目标"}`}
                </small>
                {attention && <small className="task-attention-label">{attention.label}</small>}
              </button>
              <div className="task-row-actions">
                {attention && <button className="task-attention-action" disabled={ui.busy} onClick={() => attention.kind === 'overdue' ? editTask(task.id) : schedule(task.id, attention.blockId)}>{attention.actionLabel}</button>}
                <button onClick={() => schedule(task.id)}>{arrangements.length ? '查看安排' : '安排时间'}</button>
                {task.status !== 'done' && scheduleRecurring && <button onClick={() => scheduleRecurring(task.id)}>重复安排</button>}
                <button onClick={() => editTask(task.id)}>编辑</button>
                <button className="danger-text" disabled={ui.busy} aria-label={`移除 ${task.title}`} onClick={() => removeTask(task.id)}>移除</button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
