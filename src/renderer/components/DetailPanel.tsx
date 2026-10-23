import { useState } from "react";
import {
  BlockInputSchema,
  CandidateInputSchema,
  CourseInputSchema,
  CourseExceptionInputSchema,
  GoalInputSchema,
  TaskInputSchema,
  addCalendarDays,
  mondayWeekday,
  type Entity,
  type EntityKind,
  type MutationInput,
  type Snapshot,
  type Task,
  type Block,
  type Goal,
  type Course,
  type Candidate,
  type ReminderConfig,
} from "../../shared/contracts";
import { displayInstant, todayDate } from "../calendar-layout";
import type { PlannerUI } from "../hooks/usePlanner";
import type { Selection, ScheduleDraft } from "./Calendar";
import { candidateExpiry } from '../../domain/candidate-eligibility';
import { useCurrentTime } from '../hooks/useCurrentTime';
import { CandidateTiming } from './CandidateTiming';
import { candidateDisplay } from '../candidate-display';
import { taskArrangements, taskArrangementSummary, eventTimeLabel, taskNoticeTiming, taskNoticeSummary } from '../task-schedule';
import { selectRailTasks, taskAttention } from '../task-rail';
import { effectiveActivityEnd, DEFAULT_ACTIVITY_MINUTES } from '../../domain/activity-duration';
import { recurringEventTargets } from '../../domain/recurring-events';
export const entityNames: Record<EntityKind, string> = {
  task: "任务",
  block: "时段",
  goal: "目标",
  candidate: "候选事项",
  course: "课程",
  courseException: "课程例外",
  source: "原始来源",
  preference: "偏好",
  feedback: "反馈",
};
export function findRecord(
  snapshot: Snapshot,
  selection: Selection,
): Entity | undefined {
  const keys = {
    task: "tasks",
    block: "blocks",
    goal: "goals",
    candidate: "candidates",
    course: "courses",
    courseException: "courseExceptions",
    source: "sources",
    preference: "preferences",
    feedback: "feedback",
  } as const;
  return snapshot[keys[selection.entity]].find(
    (value) => value.id === selection.id,
  );
}
export function DetailPanel({
  snapshot,
  selection,
  edit,
  editTask,
  close,
  schedule,
  scheduleRecurring,
  removeTask,
  ui,
}: {
  snapshot: Snapshot;
  selection: Selection | null;
  edit: () => void;
  editTask: (id: string) => void;
  close: () => void;
  schedule: (id: string, blockId?: string) => void;
  scheduleRecurring?: (id: string) => void;
  removeTask: (id: string) => void;
  ui: PlannerUI;
}) {
  const now = useCurrentTime();
  const value = selection ? findRecord(snapshot, selection) : undefined;
  const arrangements = selection?.entity === 'task' && value ? taskArrangements(snapshot, value.id) : [];
  const timing = selection?.entity === 'task' && value && !arrangements.length ? taskNoticeTiming(snapshot, value.id) : null;
  const attention = selection?.entity === 'task' && value ? taskAttention(snapshot, value as Task, now) : null;
  const railTasks = selectRailTasks(snapshot, now);
  return (
    <aside className={`detail-panel${!value ? ' task-rail-panel' : ''}`}>
      <div className="detail-title">
        <h3>{value && selection ? entityNames[selection.entity] : "待办任务"}</h3>
        {selection && <button onClick={close}>收起</button>}
      </div>
      {!value ? (
        <section className="rail-tasks" aria-label="待办任务列表">
            {!railTasks.length && <p className="fine-print">暂无待办任务</p>}
            {railTasks.map((t) => {
                const taskActivities = taskArrangements(snapshot, t.id);
                const taskTiming = !taskActivities.length ? taskNoticeTiming(snapshot, t.id) : null;
                const taskStatus = taskAttention(snapshot, t, now);
                return (
                  <div
                    className={`rail-task${taskStatus ? ' task-needs-attention' : ''}`}
                    data-task-id={t.id}
                    data-attention={taskStatus?.kind}
                    key={t.id}
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer.setData(
                        "application/x-planner",
                        JSON.stringify({ kind: "task", id: t.id }),
                      )
                    }
                  >
                    <span>{t.title}
                      {t.deadline && <small className="rail-task-deadline">截止 · {t.deadline.date} {t.deadline.time ?? '当天结束'}</small>}
                      {taskActivities.length > 0 && <small>{taskArrangementSummary(taskActivities, now)}</small>}
                      {taskTiming && <small>{taskNoticeSummary(taskTiming, now)}</small>}
                      {taskStatus && <small className="task-attention-label">{taskStatus.label}</small>}
                    </span>
                    <div className="rail-task-actions">
                      {taskStatus && <button className="task-attention-action" disabled={ui.busy} onClick={() => taskStatus.kind === 'overdue' ? editTask(t.id) : schedule(t.id, taskStatus.blockId)}>{taskStatus.actionLabel}</button>}
                      <button onClick={() => schedule(t.id)}>{taskActivities.length ? '查看安排' : '安排'}</button>
                      {scheduleRecurring && <button onClick={() => scheduleRecurring(t.id)}>重复安排</button>}
                      {taskStatus && <button disabled={ui.busy} aria-label={`完成任务 ${t.title}`} onClick={() => void ui.mutate([{ type: 'finishTask', id: t.id, expectedVersion: t.version, completed: true }])}>完成</button>}
                      <button className="danger-text" disabled={ui.busy} aria-label={`移除 ${t.title}`} onClick={() => removeTask(t.id)}>移除</button>
                    </div>
                  </div>
                );
              })}
        </section>
      ) : (
        <>
          <h2>
            {"title" in value
              ? value.title
              : "text" in value
                ? value.text
                : "详情"}
          </h2>
          {"description" in value && (
            <p className="prewrap">{value.description}</p>
          )}
          {attention && <section className="task-attention-notice" aria-label="任务待处理">
            <strong className="task-attention-label">{attention.label}</strong>
            <p>可修改截止时间、调整安排、标记完成或移除；时间已过不会自动完成任务。</p>
            <button className="task-attention-action" disabled={ui.busy} onClick={() => attention.kind === 'overdue' ? editTask(value.id) : schedule(value.id, attention.blockId)}>{attention.actionLabel}</button>
          </section>}
          {arrangements.length > 0 && <section className="task-event-details" aria-label="已安排活动">
            <h3>{arrangements.some(event => event.cancelled || event.completed) ? '日历安排与历史' : '已加入日历'}</h3>
            {arrangements.map(event => <div className="detail-field" key={event.id}>
              <small>{event.kind === 'work' ? '执行时段' : '固定活动'}{arrangements.length > 1 ? ` · ${event.title}` : ''}</small>
              <strong>{event.cancelled ? '已取消 · ' : event.completed ? '已完成 · ' : ''}{eventTimeLabel(event)}</strong>
              {event.location && <p>地点 · {event.location}</p>}
              {!event.cancelled && <button onClick={() => schedule(value.id, event.id)}>调整时间</button>}
            </div>)}
          </section>}
          {"action" in value && <><CandidateTiming candidate={value} />{value.status === 'pending' && candidateExpiry(value, now).expired && <p className="candidate-expiry">已过期 · {candidateExpiry(value, now).reason}</p>}</>}
          {timing && <div className="detail-field"><small>原通知时间 · 尚未入历</small><strong>{taskNoticeSummary(timing, now)}</strong></div>}
          {"deadline" in value && !("action" in value) && (
            <div className="detail-field">
              <small>独立截止</small>
              <strong>
                {value.deadline
                  ? `${value.deadline.date} ${value.deadline.time ?? "具体时刻未提供"}`
                  : "未设定"}
              </strong>
            </div>
          )}
          {"start" in value && (
            <div className="detail-field">
              <small>开始 / 结束</small>
              <strong>
                {displayInstant(value.start)}
                <br />
                {displayInstant(value.kind === 'event' ? effectiveActivityEnd(value.start, value.end) : value.end)}
                {value.kind === 'event' && !value.end && '（默认30分钟）'}
              </strong>
            </div>
          )}
          {"startTime" in value && (
            <div className="detail-field">
              <small>
                每周
                {
                  ["一", "二", "三", "四", "五", "六", "日"][value.weekday - 1]
                }{" "}
                · {value.firstWeek}–{value.lastWeek} 周
              </small>
              <strong>
                {value.startTime}–{value.endTime}
              </strong>
              <p>
                {value.weeks
                  ? `指定周：${value.weeks.join("、")}`
                  : { all: "每周", odd: "单周", even: "双周" }[value.parity]}
              </p>
              <small>第一周 {value.termStart}</small>
            </div>
          )}
          {"location" in value && value.location && (
            <p>地点 · {value.location}</p>
          )}
          {"action" in value && (
            <>
              <div className="detail-field">
                <small>行动</small>
                <p>{value.action || "需校对"}</p>
              </div>
              <div className="detail-field">
                <small>原文收益</small>
                <p>
                  {value.benefitKind === "stated"
                    ? value.benefit || "未说明"
                    : "未说明"}
                </p>
              </div>
              {value.potentialBenefit && (
                <p>潜在收益（推测）· {value.potentialBenefit}</p>
              )}
              {candidateDisplay(value, snapshot.settings).conditions.length > 0 && <div className="detail-field"><small>参加资格与准备</small><p>{candidateDisplay(value, snapshot.settings).conditions.join('；')}</p></div>}
              {candidateDisplay(value, snapshot.settings).uncertainties.map((u, i) => (
                <p className="warning" key={i}>
                  {u}
                </p>
              ))}
            </>
          )}
          <div className="detail-actions">
            <button className="primary" onClick={edit}>
              编辑{entityNames[selection!.entity]}
            </button>
            {selection!.entity === "task" && !arrangements.length && (
              <button onClick={() => schedule(value.id)}>{timing ? '安排活动' : '安排执行时段'}</button>
            )}
            {selection!.entity === 'task' && <button className="danger-text" disabled={ui.busy} aria-label={`移除 ${(value as Task).title}`} onClick={() => removeTask(value.id)}>移除任务</button>}
            {selection!.entity === 'task' && (value as Task).status !== 'done' && <button disabled={ui.busy} onClick={() => void ui.mutate([{ type: 'finishTask', id: value.id, expectedVersion: value.version, completed: true }])}>完成任务</button>}
            {selection!.entity === 'task' && (value as Task).status !== 'done' && scheduleRecurring && <button onClick={() => scheduleRecurring(value.id)}>重复安排</button>}
            {selection!.entity === "block" && (
              <button
                onClick={() =>
                  void ui.mutate([
                    {
                      type: "finishBlock",
                      id: value.id,
                      expectedVersion: value.version,
                      completed: !("completed" in value && value.completed),
                    },
                  ])
                }
              >
                {"completed" in value && value.completed
                  ? "恢复时段"
                  : "完成此时段"}
              </button>
            )}
          </div>
          <p className="fine-print">
            修改于 {displayInstant(value.updatedAt)} · 版本 {value.version}
          </p>
        </>
      )}
    </aside>
  );
}
function Reminders({ value }: { value?: ReminderConfig }) {
  return (
    <fieldset>
      <legend>此事项提醒</legend>
      <label className="check">
        <input
          type="checkbox"
          name="reminderEnabled"
          defaultChecked={value?.enabled ?? true}
        />
        启用提醒
      </label>
      <div className="form-grid">
        <label>
          提前分钟（逗号分隔；空白继承全局；0 为准时）
          <input
            name="leadMinutes"
            defaultValue={value?.leadMinutes?.join(",") ?? ""}
          />
        </label>
        <label>
          仅日期事项的提醒时刻
          <input
            name="dateOnlyTime"
            type="time"
            defaultValue={value?.dateOnlyTime ?? ""}
          />
        </label>
      </div>
    </fieldset>
  );
}
export interface EditorTarget {
  entity: "task" | "block" | "goal" | "course" | "candidate";
  id?: string;
  occurrenceDate?: string;
  draft?: ScheduleDraft;
  recurring?: boolean;
}
export function EntityEditor({
  target,
  snapshot,
  ui,
  onClose,
}: {
  target: EditorTarget;
  snapshot: Snapshot;
  ui: PlannerUI;
  onClose: () => void;
}) {
  const entity = target.entity;
  const now = useCurrentTime();
  const saved = target.id
    ? findRecord(snapshot, { entity, id: target.id })
    : undefined;
  const task = saved as Task | undefined,
    block = saved as Block | undefined,
    goal = saved as Goal | undefined,
    course = saved as Course | undefined,
    candidate = saved as Candidate | undefined;
  const linkedTask = target.draft?.taskId
    ? snapshot.tasks.find((t) => t.id === target.draft?.taskId)
    : undefined;
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [frequency, setFrequency] = useState<'none' | 'weekly' | 'biweekly' | 'odd-weeks' | 'even-weeks'>(target.recurring ? 'weekly' : 'none');
  const [selectedTaskId, setSelectedTaskId] = useState(block?.taskId ?? target.draft?.taskId ?? '');
  const schedulingTask = snapshot.tasks.find(t => t.id === selectedTaskId);
  const availableTasks = selectRailTasks(snapshot, now);
  const currentTaskId = block?.taskId ?? target.draft?.taskId;
  const currentTask = currentTaskId ? snapshot.tasks.find(t => t.id === currentTaskId) : undefined;
  const taskOptions = currentTask && !availableTasks.some(t => t.id === currentTask.id)
    ? [currentTask, ...availableTasks] : availableTasks;
  const repeating = entity === 'block' && !saved && frequency !== 'none';
  const series = entity === 'block' && block?.recurrence ? block : undefined;
  const [eventScope, setEventScope] = useState<'single' | 'this-and-following'>('single');
  const affectedEvents = series ? recurringEventTargets(snapshot.blocks, series, eventScope) : [];
  const affectedDates = affectedEvents.map(event => event.start.slice(0, 10)).sort();
  const [scope, setScope] = useState<"single" | "this-and-following" | "all">(
    target.occurrenceDate ? "single" : "all",
  );
  const [occurrenceDate, setOccurrenceDate] = useState(target.occurrenceDate ?? "");
  const occurrenceException = scope === "single" ? snapshot.courseExceptions.find(
    ex => ex.courseId === course?.id && ex.originalDate === occurrenceDate,
  ) : undefined;
  const replacement = occurrenceException?.replacement;
  const courseFields = course && replacement ? {
    ...course, title: replacement.title, location: replacement.location,
    startTime: replacement.start.slice(11, 16), endTime: replacement.end.slice(11, 16),
  } : course;
  const courseFieldsKey = `course:${scope}:${occurrenceDate}`;
  const start = target.draft
    ? `${target.draft.date}T${target.draft.time}`
    : (block?.start?.slice(0, 16) ?? `${todayDate()}T09:00`);
  const duration =
    block?.end && block.start
      ? Date.parse(block.end) - Date.parse(block.start)
      : ((target.draft?.kind ?? block?.kind) === 'event' ? DEFAULT_ACTIVITY_MINUTES : 60) * 60000;
  const endValue = target.draft?.end ?? (target.draft
    ? new Date(Date.parse(`${start}:00+08:00`) + duration + 8 * 3600000)
        .toISOString()
        .slice(0, 16)
    : (block?.end?.slice(0, 16) ??
      (block && block.kind !== 'event'
        ? ""
        : new Date(Date.parse(`${start}:00+08:00`) + duration + 8 * 3600000)
            .toISOString()
            .slice(0, 16))));
  const recurrenceFrom = start.slice(0, 10) < todayDate() ? todayDate() : start.slice(0, 10);
  const [seriesStart, setSeriesStart] = useState(start);
  const [seriesEnd, setSeriesEnd] = useState(endValue);
  const [seriesEndEdited, setSeriesEndEdited] = useState(Boolean(series && target.draft?.end && Date.parse(`${target.draft.end}:00+08:00`) - Date.parse(`${start}:00+08:00`) !== duration));
  const semesterEnd = snapshot.settings.termStart
    ? addCalendarDays(snapshot.settings.termStart, snapshot.settings.termWeeks * 7 - 1) : '';
  const recurrenceUntil = semesterEnd >= recurrenceFrom ? semesterEnd : '';
  function reminders(data: FormData): ReminderConfig {
    const raw = String(data.get("leadMinutes") ?? "").trim();
    return {
      enabled: data.has("reminderEnabled"),
      leadMinutes: raw ? raw.split(/[,，]/).map(Number) : null,
      dateOnlyTime: String(data.get("dateOnlyTime") ?? "") || null,
    };
  }
  function instant(value: FormDataEntryValue | null) {
    return value ? `${value}:00+08:00` : null;
  }
  async function save(form: HTMLFormElement) {
    const data = new FormData(form),
      s = (key: string) => String(data.get(key) ?? ""),
      title = s("title");
    try {
      if (series) {
        const values: Record<string, unknown> = {};
        if (title !== series.title) values.title = title;
        const startChanged = s('start') !== series.start.slice(0, 16);
        if (startChanged) values.start = instant(data.get('start'));
        const changedEnd = instant(data.get('end'));
        if (seriesEndEdited && (changedEnd !== series.end || startChanged)) values.end = changedEnd;
        if (s('location') !== series.location) values.location = s('location');
        const reminderValue = reminders(data);
        // An explicitly empty lead list and inheritance both render blank; preserve
        // the original choice when that input was not changed.
        if (s('leadMinutes').trim() === (series.reminders.leadMinutes?.join(',') ?? '')) reminderValue.leadMinutes = series.reminders.leadMinutes;
        if (JSON.stringify(reminderValue) !== JSON.stringify(series.reminders)) values.reminders = reminderValue;
        if (!Object.keys(values).length) { setError('尚未更改活动内容'); return; }
        const result = await ui.mutate([{
          type: 'updateRecurringEvent', id: series.id, expectedVersion: series.version,
          scope: eventScope, values,
        }]);
        if (result && result.status !== 'clarification') onClose();
        return;
      }
      if (repeating) {
        if (!schedulingTask) throw new Error('请先选择要重复安排的任务。');
        const result = await ui.mutate([{
          type: 'scheduleRecurringTask', id: schedulingTask.id, expectedVersion: schedulingTask.version,
          rule: {
            frequency, fromDate: s('fromDate'), untilDate: s('untilDate'),
            weekday: Number(s('recurrenceWeekday')), time: s('recurrenceTime'),
            durationMinutes: Number(s('durationMinutes')), termStart: s('recurrenceTermStart') || null,
          },
          location: s('location'), reminders: reminders(data),
        }]);
        if (result && result.status !== 'clarification') onClose();
        return;
      }
      let values: unknown;
      if (entity === "task")
        values = TaskInputSchema.parse({
          title,
          description: s("description"),
          status: s("status"),
          deadline: s("deadlineDate")
            ? { date: s("deadlineDate"), time: s("deadlineTime") || null }
            : null,
          goalId: s("goalId") || null,
          candidateId: task?.candidateId ?? null,
          reminders: reminders(data),
          courseId: task?.courseId ?? null,
        });
      if (entity === "block")
        values = BlockInputSchema.parse({
          title,
          start: instant(data.get("start")),
          end: instant(data.get("end")),
          kind: s("kind"),
          taskId: s("taskId") || null,
          location: s("location"),
          completed: block?.completed ?? false,
          reminders: reminders(data),
        });
      if (entity === "goal")
        values = GoalInputSchema.parse({
          title,
          description: s("description"),
          priority: s("priority"),
          status: s("status"),
          targetDate: s("targetDate") || null,
          color: goal?.color ?? null,
        });
      if (entity === "course") {
        values = CourseInputSchema.parse({
          title,
          location: s("location"),
          weekday: Number(s("weekday")),
          startTime: s("startTime"),
          endTime: s("endTime"),
          firstWeek: Number(s("firstWeek")),
          lastWeek: Number(s("lastWeek")),
          parity: s("parity"),
          weeks: s("weeks").trim()
            ? s("weeks")
                .split(/[,，、\s]+/)
                .filter(Boolean)
                .map(Number)
            : null,
          termStart: s("termStart"),
          reminders: reminders(data),
          color: course?.color ?? null,
        });
        if (saved) {
          // Recurrence scopes act on a patch: unchanged series fields must not
          // turn an occurrence-time edit into a forbidden series mutation.
          values = Object.fromEntries(
            Object.entries(values as Course).filter(
              ([key, value]) =>
                JSON.stringify(value) !==
                JSON.stringify(course![key as keyof Course]),
            ),
          );
          const originalDate = s("occurrenceDate"), replacementDate = s("replacementDate");
          // Cross-date changes use the existing exception contract. Series fields
          // still go through the course mutation and its strict single whitelist.
          if (scope === "single" && (occurrenceException || (replacementDate && replacementDate !== originalDate)) &&
              Object.keys(values as object).every(key => ["title", "location", "startTime", "endTime"].includes(key))) {
            const exceptionValues = CourseExceptionInputSchema.parse({
              courseId: course!.id, originalDate, cancelled: false,
              replacement: { title, location: s("location"), start: `${replacementDate}T${s("startTime")}:00+08:00`, end: `${replacementDate}T${s("endTime")}:00+08:00` },
            });
            if (occurrenceException && JSON.stringify(exceptionValues.replacement) === JSON.stringify(occurrenceException.replacement)) {
              setError("尚未更改课程内容"); return;
            }
            const result = await ui.mutate([occurrenceException ? {
              type: "update", entity: "courseException", id: occurrenceException.id,
              expectedVersion: occurrenceException.version, values: exceptionValues,
            } : { type: "create", entity: "courseException", values: exceptionValues }]);
            if (result && result.status !== "clarification") onClose();
            return;
          }
          if (!Object.keys(values as object).length) {
            setError("尚未更改课程内容");
            return;
          }
        }
      }
      if (entity === "candidate") {
        const {
          id: _id,
          version: _version,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          ...candidateValues
        } = candidate!;
        const parsed = CandidateInputSchema.parse({
          ...candidateValues,
          title,
          action: s("action"),
          benefit: s("benefit"),
          benefitKind: s("benefitKind"),
          potentialBenefit: s("potentialBenefit"),
          conditions: s("conditions").split("\n").filter(Boolean),
          uncertainties: s("uncertainties").split("\n").filter(Boolean),
          deadline: s("deadlineDate")
            ? { date: s("deadlineDate"), time: s("deadlineTime") || null }
            : null,
          eventStart: instant(data.get("eventStart")),
          eventEnd: instant(data.get("eventEnd")),
          location: s("location"),
        });
        values = parsed;
      }
      let mutation: MutationInput;
      if (entity === "candidate") {
        const v = values as Candidate;
        mutation = {
          type: "update",
          entity,
          id: saved!.id,
          expectedVersion: saved!.version,
          values: {
            title: v.title,
            action: v.action,
            benefit: v.benefit,
            benefitKind: v.benefitKind,
            potentialBenefit: v.potentialBenefit,
            conditions: v.conditions,
            uncertainties: v.uncertainties,
            deadline: v.deadline,
            eventStart: v.eventStart,
            eventEnd: v.eventEnd,
            location: v.location,
          },
        };
      } else if (saved)
        mutation = {
          type: "update",
          entity,
          id: saved.id,
          expectedVersion: saved.version,
          values,
          ...(entity === "course"
            ? { scope, occurrenceDate: s("occurrenceDate") || undefined }
            : {}),
        } as MutationInput;
      else if (entity === 'block' && target.draft?.noticeTaskVersion && linkedTask?.candidateId &&
               s('kind') === 'event' && s('taskId') === linkedTask.id) {
        mutation = { type: 'scheduleTaskEvent', id: linkedTask.id, expectedVersion: target.draft.noticeTaskVersion, values } as MutationInput;
      } else mutation = { type: "create", entity, values } as MutationInput;
      const result = await ui.mutate([mutation]);
      if (result && result.status !== "clarification") onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "请校对输入");
    }
  }
  async function remove(form: HTMLFormElement) {
    if (!saved) return;
    const data = new FormData(form);
    const result = await ui.mutate([
      series ? {
        type: 'cancelRecurringEvent', id: series.id, expectedVersion: series.version, scope: eventScope,
      } : entity === 'task' ? {
        type: 'removeTask', id: saved.id, expectedVersion: saved.version, includeLinkedBlocks: true,
      } : {
        type: "delete",
        entity,
        id: saved.id,
        expectedVersion: saved.version,
        ...(entity === "course"
          ? {
              scope,
              occurrenceDate:
                String(data.get("occurrenceDate") ?? "") || undefined,
            }
          : {}),
      } as MutationInput,
    ]);
    if (result && result.status !== "clarification") onClose();
  }
  const deadline =
    entity === "candidate" ? candidate?.deadline : task?.deadline;
  return (
    <form
      className="editor-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(e.currentTarget);
      }}
    >
      <label>
        名称
        <input
          name="title"
          key={entity === "course" ? courseFieldsKey : repeating ? `recurring-title:${selectedTaskId}` : "title"}
          required={!repeating}
          maxLength={500}
          readOnly={repeating}
          defaultValue={
            repeating ? schedulingTask?.title ?? '' : entity === "course" ? courseFields?.title ?? "" : saved && "title" in saved ? saved.title : (linkedTask?.title ?? "")
          }
        />
      </label>
      {(entity === "task" || entity === "goal") && (
        <label>
          说明
          <textarea
            name="description"
            rows={3}
            defaultValue={
              saved && "description" in saved ? saved.description : ""
            }
          />
        </label>
      )}
      {(entity === "task" || entity === "candidate") && (
        <div className="form-grid">
          <label>
            截止日期
            <input
              name="deadlineDate"
              type="date"
              defaultValue={deadline?.date ?? ""}
            />
          </label>
          <label>
            截止时刻（可留空）
            <input
              name="deadlineTime"
              type="time"
              defaultValue={deadline?.time ?? ""}
            />
          </label>
        </div>
      )}
      {entity === "task" && (
        <div className="form-grid">
          <label>
            状态
            <select name="status" defaultValue={task?.status ?? "open"}>
              <option value="open">待完成</option>
              <option value="done">已完成</option>
            </select>
          </label>
          <label>
            关联目标
            <select name="goalId" defaultValue={task?.goalId ?? ""}>
              <option value="">无</option>
              {snapshot.goals.map((g) => (
                <option value={g.id} key={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {entity === "goal" && (
        <>
          <div className="form-grid">
            <label>
              优先级
              <select name="priority" defaultValue={goal?.priority ?? "medium"}>
                <option value="high">高</option>
                <option value="medium">普通</option>
                <option value="low">低</option>
              </select>
            </label>
            <label>
              状态
              <select name="status" defaultValue={goal?.status ?? "active"}>
                <option value="active">进行中</option>
                <option value="paused">暂停</option>
                <option value="completed">已完成</option>
              </select>
            </label>
          </div>
          <label>
            目标日期
            <input
              name="targetDate"
              type="date"
              defaultValue={goal?.targetDate ?? ""}
            />
          </label>
          {saved && (
            <div className="linked-tasks">
              关联任务：
              {snapshot.tasks
                .filter((t) => t.goalId === saved.id)
                .map((t) => (
                  <p key={t.id}>
                    {t.status === "done" ? "✓" : "○"} {t.title}
                  </p>
                ))}
            </div>
          )}
        </>
      )}
      {entity === "block" && (
        <>
          {series && <fieldset>
            <legend>重复活动</legend>
            <label>修改 / 取消范围
              <select value={eventScope} onChange={e => { setEventScope(e.target.value as typeof eventScope); setDeleting(false); }}>
                <option value="single">仅本次</option>
                <option value="this-and-following">本次及以后</option>
              </select>
            </label>
            <p className="hint" role="status">{eventScope === 'single' ? '仅影响本次活动' : '影响本次及以后尚未完成、尚未取消的活动'} · 共 {affectedEvents.length} 次{affectedEvents.length > 0 && ` · ${affectedDates[0]}${affectedEvents.length > 1 ? ` 至 ${affectedDates.at(-1)}` : ''}`}。保存或取消活动前会列出每次变化供你确认。</p>
          </fieldset>}
          {!saved && <label>
            重复
            <select value={frequency} onChange={e => setFrequency(e.target.value as typeof frequency)}>
              <option value="none">不重复</option>
              <option value="weekly">每周</option>
              <option value="biweekly">每两周</option>
              <option value="odd-weeks">学期单周</option>
              <option value="even-weeks">学期双周</option>
            </select>
          </label>}
          {repeating ? <>
            <p className="hint">将为所选任务创建固定活动，保存后先预览每次日期。每两周从开始日期当天或之后的首个所选星期开始，每隔14天重复；学期单双周按第一教学周计算。</p>
            <div className="form-grid">
              <label>开始日期<input type="date" name="fromDate" required defaultValue={recurrenceFrom} /></label>
              <label>结束日期<input type="date" name="untilDate" required defaultValue={recurrenceUntil} /></label>
              <label>星期<select name="recurrenceWeekday" defaultValue={mondayWeekday(start.slice(0, 10))}>
                {["一", "二", "三", "四", "五", "六", "日"].map((d, i) => <option key={d} value={i + 1}>周{d}</option>)}
              </select></label>
              <label>开始时刻<input type="time" name="recurrenceTime" required defaultValue={start.slice(11, 16)} /></label>
              <label>每次时长（分钟）<input type="number" name="durationMinutes" min={1} max={1440} required defaultValue={30} /></label>
              {(frequency === 'odd-weeks' || frequency === 'even-weeks') && <label>第一教学周周一<input type="date" name="recurrenceTermStart" required defaultValue={snapshot.settings.termStart ?? ''} /></label>}
            </div>
            {!recurrenceUntil && <p className="hint">当前未设定有效的学期结束日期，请填写本次重复安排的结束日期。</p>}
          </> : <>
          {(target.draft?.timingNote || (block?.kind === 'event' && !block.end)) && <p className="warning" role="note">{target.draft?.timingNote ?? '未提供结束时间，默认30分钟，可调整。'}</p>}
          <div className="form-grid">
            <label>
              开始
              <input
                name="start"
                type="datetime-local"
                required
                defaultValue={series ? undefined : start}
                value={series ? seriesStart : undefined}
                onChange={series ? e => {
                  setSeriesStart(e.target.value);
                  if (!seriesEndEdited && e.target.value) setSeriesEnd(new Date(Date.parse(`${e.target.value}:00+08:00`) + duration + 8 * 3600000).toISOString().slice(0, 16));
                } : undefined}
              />
            </label>
            <label>
              结束（活动留空默认30分钟）
              <input name="end" type="datetime-local" defaultValue={series ? undefined : endValue} value={series ? seriesEnd : undefined} onChange={series ? e => { setSeriesEnd(e.target.value); setSeriesEndEdited(true); } : undefined} />
            </label>
          </div>
          </>}
          <div className="form-grid">
            {!repeating && <label>
              类型
              <select name="kind" disabled={Boolean(series)} defaultValue={block?.kind ?? target.draft?.kind ?? "work"}>
                <option value="work">执行时段</option>
                <option value="event">固定活动</option>
              </select>
            </label>}
            <label>
              关联任务
              <select
                name="taskId"
                value={selectedTaskId}
                required={repeating}
                disabled={Boolean(series)}
                onChange={e => setSelectedTaskId(e.target.value)}
              >
                <option value="">无</option>
                {taskOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!repeating && <p className="hint">
            {series ? '仅改开始时间时，每次活动保留原时长；修改结束时间会为所选范围设置相同的新时长。关联任务保持不变。' : '可直接修改结束时间选择时长。完成此时段不会自动完成任务；重叠将先预览。'}
          </p>}
        </>
      )}
      {entity === "candidate" && (
        <>
          <label>
            需要做什么
            <textarea name="action" defaultValue={candidate?.action} />
          </label>
          <div className="form-grid">
            <label>
              收益依据
              <select name="benefitKind" defaultValue={candidate?.benefitKind}>
                <option value="unknown">未说明</option>
                <option value="stated">原文明确</option>
                <option value="inferred">推测</option>
              </select>
            </label>
            <label>
              原文收益
              <input name="benefit" defaultValue={candidate?.benefit} />
            </label>
          </div>
          <label>
            潜在收益（推测）
            <input
              name="potentialBenefit"
              defaultValue={candidate?.potentialBenefit}
            />
          </label>
          <label>
            条件（每行一项）
            <textarea
              name="conditions"
              defaultValue={candidate?.conditions.join("\n")}
            />
          </label>
          <label>
            不确定信息（每行一项）
            <textarea
              name="uncertainties"
              defaultValue={candidate?.uncertainties.join("\n")}
            />
          </label>
          <div className="form-grid">
            <label>
              活动开始
              <input
                name="eventStart"
                type="datetime-local"
                defaultValue={candidate?.eventStart?.slice(0, 16) ?? ""}
              />
            </label>
            <label>
              活动结束
              <input
                name="eventEnd"
                type="datetime-local"
                defaultValue={candidate?.eventEnd?.slice(0, 16) ?? ""}
              />
            </label>
          </div>
        </>
      )}
      {entity === "course" && (
        <>
          <div className="form-grid">
            <label>
              第一教学周周一
              <input
                type="date"
                name="termStart"
                required
                defaultValue={
                  course?.termStart ?? snapshot.settings.termStart ?? ""
                }
              />
            </label>
            <label>
              星期
              <select name="weekday" defaultValue={course?.weekday ?? 1}>
                {["一", "二", "三", "四", "五", "六", "日"].map((d, i) => (
                  <option value={i + 1} key={d}>
                    周{d}
                  </option>
                ))}
              </select>
            </label>
            <label>
              开始
              <input
                name="startTime"
                key={courseFieldsKey}
                type="time"
                required
                defaultValue={courseFields?.startTime ?? ""}
              />
            </label>
            <label>
              结束
              <input
                name="endTime"
                key={courseFieldsKey}
                type="time"
                required
                defaultValue={courseFields?.endTime ?? ""}
              />
            </label>
            <label>
              起始周
              <input
                name="firstWeek"
                type="number"
                min={1}
                max={100}
                defaultValue={course?.firstWeek ?? 1}
              />
            </label>
            <label>
              结束周
              <input
                name="lastWeek"
                type="number"
                min={1}
                max={100}
                defaultValue={course?.lastWeek ?? snapshot.settings.termWeeks}
              />
            </label>
            <label>
              单双周
              <select name="parity" defaultValue={course?.parity ?? "all"}>
                <option value="all">每周</option>
                <option value="odd">单周</option>
                <option value="even">双周</option>
              </select>
            </label>
            <label>
              指定教学周（可留空）
              <input
                name="weeks"
                placeholder="1,3,6,8"
                defaultValue={course?.weeks?.join(",") ?? ""}
              />
            </label>
          </div>
          {saved && (
            <fieldset>
              <legend>重复课程修改范围</legend>
              <label>
                范围
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as typeof scope)}
                >
                  <option value="all">整个系列</option>
                  <option value="single">仅本次</option>
                  <option value="this-and-following">本次及以后</option>
                </select>
              </label>
              <label>
                原上课日期
                <input
                  name="occurrenceDate"
                  type="date"
                  required={scope !== "all"}
                  value={occurrenceDate}
                  onChange={e => setOccurrenceDate(e.target.value)}
                />
              </label>
              {scope === "single" && (
                <label>
                  调课日期
                  <input
                    key={occurrenceDate}
                    name="replacementDate"
                    type="date"
                    required
                    defaultValue={replacement?.start.slice(0, 10) ?? occurrenceDate}
                  />
                </label>
              )}
              {scope === "single" && <p className="hint">调课日期与上方开始、结束时刻共同确定本次安排；原上课日期用于标识同一次课程。</p>}
              <p className="hint">保存、停课及系列变更均先预览。</p>
            </fieldset>
          )}
          {saved &&
            snapshot.courseExceptions
              .filter((ex) => ex.courseId === saved.id)
              .map((ex) => (
                <div className="exception-row" key={ex.id}>
                  <span>
                    {ex.originalDate} ·{" "}
                    {ex.cancelled
                      ? "停课"
                      : `调至 ${displayInstant(ex.replacement?.start)}`}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void ui.mutate([
                        {
                          type: "delete",
                          entity: "courseException",
                          id: ex.id,
                          expectedVersion: ex.version,
                        },
                      ])
                    }
                  >
                    删除例外 / 恢复原课
                  </button>
                </div>
              ))}
        </>
      )}
      {(entity === "block" ||
        entity === "course" ||
        entity === "candidate") && (
        <label>
          地点
          <input
            name="location"
            key={entity === "course" ? courseFieldsKey : "location"}
            defaultValue={entity === "course" ? courseFields?.location ?? "" : saved && "location" in saved ? saved.location : target.draft?.location ?? ""}
          />
        </label>
      )}
      {(entity === "task" || entity === "block" || entity === "course") && (
        <Reminders
          key={repeating ? `recurring:${selectedTaskId}` : 'reminders'}
          value={saved && "reminders" in saved ? saved.reminders : repeating ? schedulingTask?.reminders : undefined}
        />
      )}
      {error && (
        <p role="alert" className="error prewrap">
          {error}
        </p>
      )}
      {saved && deleting && (
        <div className="warning">
          {series ? `将取消所选范围内的 ${affectedEvents.length} 次活动，关联任务和历史记录保留；确认后可撤销。` : entity === 'task' ? '移除任务会同时移除关联的日历安排，下一步可预览；通知来源保留，操作可撤销。' : `确认删除${entity === "course" ? "所选范围的课程" : "此记录"}？相关任务与截止变更将由预览说明。`}
          <button
            type="button"
            className="danger"
            disabled={ui.busy || Boolean(series && !affectedEvents.length)}
            onClick={(e) => void remove(e.currentTarget.form!)}
          >
            {series ? '预览取消活动' : entity === 'task' ? '预览移除' : '确认删除'}
          </button>
        </div>
      )}
      <footer className="form-footer">
        {saved && (
          <button
            type="button"
            className="danger-text"
            onClick={() => setDeleting(!deleting)}
          >
            {series ? '取消活动' : entity === "course" ? "删除 / 停课" : "删除"}
          </button>
        )}
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="primary" disabled={ui.busy || Boolean(series && !affectedEvents.length)}>
          保存{entity === "course" || repeating || series ? "并预览" : ""}
        </button>
      </footer>
    </form>
  );
}
