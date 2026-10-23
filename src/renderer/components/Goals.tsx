import type { Snapshot } from "../../shared/contracts";
import type { Selection } from "./Calendar";
export function Goals({
  snapshot,
  select,
  create,
}: {
  snapshot: Snapshot;
  select: (s: Selection) => void;
  create: () => void;
}) {
  return (
    <div className="page-scroll">
      <div className="section-heading">
        <div>
          <h2>给每天一个方向</h2>
          <p>把长期目标连接到具体任务。</p>
        </div>
        <button className="primary" onClick={create}>
          ＋ 新建目标
        </button>
      </div>
      {!snapshot.goals.length && (
        <div className="empty-state">
          <h3>想完成什么？</h3>
          <p>先写下一个目标，再逐步关联任务。</p>
          <button onClick={create}>添加目标</button>
        </div>
      )}
      <div className="goal-grid">
        {snapshot.goals.map((goal) => {
          const linked = snapshot.tasks.filter((t) => t.goalId === goal.id),
            done = linked.filter((t) => t.status === "done").length;
          return (
            <button
              className="goal-card"
              key={goal.id}
              onClick={() => select({ entity: "goal", id: goal.id })}
            >
              <span className="eyebrow">
                {
                  { high: "高优先级", medium: "普通优先级", low: "低优先级" }[
                    goal.priority
                  ]
                }{" "}
                ·{" "}
                {
                  { active: "进行中", paused: "暂停", completed: "已完成" }[
                    goal.status
                  ]
                }
              </span>
              <h3>{goal.title}</h3>
              <p>{goal.description || "尚未填写目标说明"}</p>
              <div className="progress">
                <span
                  style={{
                    width: `${linked.length ? (done / linked.length) * 100 : 0}%`,
                  }}
                />
              </div>
              <small>
                {done} / {linked.length} 项任务完成
                {goal.targetDate && ` · 目标 ${goal.targetDate}`}
              </small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
