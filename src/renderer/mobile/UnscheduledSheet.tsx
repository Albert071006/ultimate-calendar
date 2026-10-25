import type { Snapshot } from '../../shared/contracts';
import type { Selection } from '../components/Calendar';
import { unscheduledTasks } from '../../domain/unscheduled';
import { taskAttention } from '../task-rail';
import { deadlineText, urgency } from '../components/calendar/UnscheduledDrawer';
import { Sheet } from './Sheet';

/** Every unscheduled task by urgency; "安排" opens the minute form, the title opens the task. */
export function UnscheduledSheet({ snapshot, now, close, select, schedule }: {
  snapshot: Snapshot; now: number; close: () => void; select: (selection: Selection) => void; schedule: (taskId: string) => void;
}) {
  const tasks = unscheduledTasks(snapshot, now);
  return (
    <Sheet title={`未安排 · ${tasks.length}`} onClose={close}>
      {tasks.length ? <ul className="m-list">
        {tasks.map(task => {
          const level = urgency(task, snapshot, now), ended = taskAttention(snapshot, task, now)?.kind === 'ended';
          return <li key={task.id} className={`m-unscheduled lvl-${level}`}>
            <button className="m-task-main" onClick={() => select({ entity: 'task', id: task.id })}>
              <strong>{task.title}</strong><small>{deadlineText(task)}{ended ? ' · 安排已结束' : ''}</small>
            </button>
            <button className="m-btn" onClick={() => schedule(task.id)}>安排</button>
          </li>;
        })}
      </ul> : <div className="m-empty"><p>没有未安排的任务。</p></div>}
    </Sheet>
  );
}
