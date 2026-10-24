import { Plus } from "lucide-react";
import type { Snapshot } from "../../../shared/contracts";
import type { PlannerUI } from "../../hooks/usePlanner";
import type { Selection } from "../../components/Calendar";
import { occupiedColors } from "../../../domain/palette";
import { todayDate } from "../../calendar-layout";
import { ColorPicker } from "./ColorPicker";

const priority = { high: "高优先", medium: "普通", low: "低优先" } as const;
const status = { active: "进行中", paused: "暂停", completed: "已完成" } as const;

/** Goals with their color, progress across linked tasks and target date. */
export function Goals({ snapshot, ui, select, create }: {
  snapshot: Snapshot;
  ui: PlannerUI;
  select: (s: Selection) => void;
  create: () => void;
}) {
  const used = occupiedColors(snapshot, todayDate());
  const active = snapshot.goals.filter(goal => goal.status === "active").length;
  return (
    <div className="a2-goals">
      <div className="a2-me-h">
        <h2>目标</h2>
        {snapshot.goals.length > 0 && <span className="ui-hint">{active} 个进行中</span>}
        <button className="ui-btn" onClick={create}><Plus aria-hidden="true" />新建目标</button>
      </div>
      {snapshot.goals.length ? (
        <ul className="a2-goal-list">
          {snapshot.goals.map(goal => {
            const linked = snapshot.tasks.filter(task => task.goalId === goal.id), done = linked.filter(task => task.status === "done").length;
            const others = [...used];
            if (goal.color && goal.status === "active") others.splice(others.indexOf(goal.color), 1);
            return (
              <li key={goal.id} className={goal.status !== "active" ? "quiet" : ""}>
                <ColorPicker name={goal.title} color={goal.color} used={others} busy={ui.busy}
                  pick={hex => void ui.mutate([{ type: "update", entity: "goal", id: goal.id, expectedVersion: goal.version, values: { color: hex as NonNullable<typeof goal.color> } }])} />
                <div className="main">
                  <button className="t" onClick={() => select({ entity: "goal", id: goal.id })}>{goal.title}</button>
                  <span className="meta">{[status[goal.status], priority[goal.priority], goal.targetDate && `目标日期 ${goal.targetDate}`].filter(Boolean).join(" · ")}</span>
                  {goal.description && <p>{goal.description}</p>}
                </div>
                <div className="a2-goal-progress" title={`${done} / ${linked.length} 项任务完成`}>
                  <span className="bar"><i style={{ width: `${linked.length ? done / linked.length * 100 : 0}%`, background: goal.color ?? undefined }} /></span>
                  <span className="n">{linked.length ? `${done} / ${linked.length}` : "暂无任务"}</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="ui-empty">
          <h4>还没有目标</h4>
          <p>写下一个想完成的事，之后新建任务时可以把它关联上来。</p>
          <div className="actions"><button className="ui-btn" onClick={create}><Plus aria-hidden="true" />新建目标</button></div>
        </div>
      )}
    </div>
  );
}
