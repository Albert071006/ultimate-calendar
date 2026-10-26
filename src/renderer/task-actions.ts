import type { Snapshot } from "../shared/contracts";
import type { PlannerUI } from "./hooks/usePlanner";
import type { Selection, ScheduleDraft } from "./components/Calendar";
import type { EditorTarget } from "./components/editor/EntityEditor";
import { todayDate } from "./calendar-layout";
import { taskEvents, taskArrangements, taskNoticeTiming, noticeTimePassed, nextTaskArrangement } from "./task-schedule";
import { effectiveActivityEnd } from "../domain/activity-duration";

/**
 * Task actions shared by the desktop and phone shells: open the next arrangement, or start a new one
 * prefilled from the original notice, so neither layout re-implements the scheduling rules.
 */
export function taskActionHandlers({ snapshot, ui, select, editRecord, defaultSlot = () => ({ date: todayDate(), time: '09:00' }) }: {
  snapshot: Snapshot | null;
  ui: PlannerUI;
  select: (selection: Selection) => void;
  editRecord: (target: EditorTarget) => void;
  /** Where a task without any notice time is first placed. */
  defaultSlot?: () => { date: string; time: string };
}) {
  const schedule = (draft: ScheduleDraft) =>
    editRecord({ entity: "block", id: draft.blockId, draft });
  const scheduleTask = (taskId: string, blockId?: string) => {
    if (!snapshot) return;
    const arrangements = taskArrangements(snapshot, taskId);
    const event = blockId ? arrangements.find(block => block.id === blockId && !block.cancelled) : nextTaskArrangement(arrangements, Date.now());
    if (event) {
      editRecord({ entity: 'block', id: event.id });
    } else if (arrangements.length || blockId) {
      select({ entity: 'task', id: taskId });
    } else {
      const timing = taskNoticeTiming(snapshot, taskId);
      schedule(timing ? {
        date: timing.start.slice(0, 10), time: timing.start.slice(11, 16), taskId,
        end: effectiveActivityEnd(timing.start, timing.end).slice(0, 16), kind: 'event', location: timing.location,
        noticeTaskVersion: snapshot.tasks.find(task => task.id === taskId)?.version,
        timingNote: `${timing.source === 'reminder' ? '已带入指定的提醒时间；未提供结束时间，默认30分钟，可调整。' : timing.end ? '已按原消息带入活动时间。' : '已按原消息带入开始时间；未提供结束时间，默认30分钟，可调整。'}${noticeTimePassed(timing, Date.now()) ? `原${timing.source === 'reminder' ? '提醒' : '通知'}时间已过，请核对后保存。` : ''}`,
      } : { ...defaultSlot(), taskId });
    }
  };
  const scheduleRecurringTask = (taskId: string) => {
    if (!snapshot) return;
    const event = taskEvents(snapshot, taskId).find(value => !value.cancelled && Date.parse(effectiveActivityEnd(value.start, value.end)) > Date.now());
    const timing = event ?? taskNoticeTiming(snapshot, taskId);
    editRecord({ entity: 'block', recurring: true, draft: {
      taskId, date: timing?.start.slice(0, 10) ?? todayDate(), time: timing?.start.slice(11, 16) ?? '09:00',
      kind: 'event', location: timing?.location ?? '',
    } });
  };
  const removeTask = (taskId: string) => {
    const task = snapshot?.tasks.find(value => value.id === taskId);
    if (task) void ui.mutate([{ type: 'removeTask', id: task.id, expectedVersion: task.version, includeLinkedBlocks: true }]);
  };
  return { schedule, scheduleTask, scheduleRecurringTask, removeTask };
}
