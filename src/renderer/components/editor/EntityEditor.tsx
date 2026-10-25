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
  type MutationInput,
  type Snapshot,
  type Task,
  type Block,
  type Goal,
  type Course,
  type Candidate,
  type ReminderConfig,
} from "../../../shared/contracts";
import { displayInstant, todayDate } from "../../calendar-layout";
import type { PlannerUI } from "../../hooks/usePlanner";
import type { ScheduleDraft } from "../Calendar";
import { useCurrentTime } from '../../hooks/useCurrentTime';
import { selectRailTasks } from '../../task-rail';
import { useMobile } from '../../mobile/layout';
import { DEFAULT_ACTIVITY_MINUTES, effectiveActivityEnd } from '../../../domain/activity-duration';
import { recurringEventTargets } from '../../../domain/recurring-events';
import { courseIsCurrent } from '../../../domain/palette';
import { findRecord } from '../detail/records';
import { ResourceFields, ResourceSection } from '../resources/ResourcePanel';
import type { ResourceReference } from '../../../shared/resources';
function Reminders({ value }: { value?: ReminderConfig }) {
  const mobile = useMobile();
  return (
    <fieldset data-more="">
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
          {mobile ? '提前分钟' : '提前分钟（逗号分隔；空白继承全局；0 为准时）'}
          <input
            name="leadMinutes"
            placeholder={mobile ? '如 10,30' : undefined}
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
/**
 * One choice per course title: a timetable keeps a record per weekday, but a task belongs to the course.
 * The task's own record represents its title so an unchanged form keeps the saved id.
 */
function courseChoices(snapshot: Snapshot, currentId: string | null): Course[] {
  const today = todayDate();
  const ranked = [...snapshot.courses].sort((a, b) =>
    Number(b.id === currentId) - Number(a.id === currentId) || Number(courseIsCurrent(b, snapshot.settings, today)) - Number(courseIsCurrent(a, snapshot.settings, today)));
  const seen = new Set<string>();
  return ranked.filter(course => !seen.has(course.title) && seen.add(course.title))
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
}
/** The phone hides the field labels of the title, so its placeholder says what to type. */
const titlePlaceholders: Record<EditorTarget['entity'], string> = { task: '要做什么', block: '要做什么', goal: '目标名称', course: '课程名称', candidate: '事项名称' };

/** What 更多 holds on the phone, so the collapsed row says what is behind it. */
const moreNames: Record<EditorTarget['entity'], string> = {
  task: '说明、状态、目标、课程、提醒',
  block: '类型、关联任务、地点、提醒',
  goal: '说明、优先级、状态',
  course: '周次、地点、提醒',
  candidate: '收益、条件、活动时间、地点',
};

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
  const mobile = useMobile();
  // The phone shows the fields needed to decide first; the rest (marked data-more) open under 更多.
  const [moreOpen, setMoreOpen] = useState(false);
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
  const [resources, setResources] = useState<ResourceReference[]>(saved && 'resources' in saved ? saved.resources ?? [] : []);
  const [resourceBaseline] = useState({ version: saved?.version, value: JSON.stringify(resources) });
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
      : DEFAULT_ACTIVITY_MINUTES * 60000;
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
      const resourcesChanged = JSON.stringify(resources) !== resourceBaseline.value;
      const resourcesToSave = !resourcesChanged && saved && 'resources' in saved ? saved.resources ?? [] : resources;
      if (entity !== 'course' && saved && saved.version !== resourceBaseline.version && resourcesChanged)
        throw new Error('这条记录在编辑期间已改变，请重新打开后关联资料。');
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
        if (JSON.stringify(resourcesToSave) !== JSON.stringify(series.resources ?? [])) values.resources = resourcesToSave;
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
          location: s('location'), reminders: reminders(data), ...(resources.length ? { resources } : {}),
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
          courseId: s("courseId") || null,
          ...(resourcesToSave.length || task?.resources ? { resources: resourcesToSave } : {}),
        });
      if (entity === "block") {
        const blockStart = instant(data.get("start"));
        const blockEnd = instant(data.get("end"));
        values = BlockInputSchema.parse({
          title,
          start: blockStart,
          end: blockEnd ?? (s('kind') === 'work' && blockStart ? effectiveActivityEnd(blockStart, null) : null),
          kind: s("kind"),
          taskId: s("taskId") || null,
          location: s("location"),
          completed: block?.completed ?? false,
          reminders: reminders(data),
          ...(resourcesToSave.length || block?.resources ? { resources: resourcesToSave } : {}),
        });
      }
      if (entity === "goal")
        values = GoalInputSchema.parse({
          title,
          description: s("description"),
          priority: s("priority"),
          status: s("status"),
          targetDate: s("targetDate") || null,
          color: goal?.color ?? null,
          ...(resourcesToSave.length || goal?.resources ? { resources: resourcesToSave } : {}),
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
          ...(saved ? (course?.resources ? { resources: course.resources } : {}) : resources.length ? { resources } : {}),
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
      className={`editor-form${mobile && moreOpen ? ' more-open' : ''}`}
      onInvalidCapture={() => setMoreOpen(true)}
      onSubmit={(e) => {
        e.preventDefault();
        void save(e.currentTarget);
      }}
    >
      <label>
        名称
        <input
          name="title"
          placeholder={mobile ? titlePlaceholders[entity] : undefined}
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
        <label data-more="">
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
            {mobile ? '截止时刻' : '截止时刻（可留空）'}
            <input
              name="deadlineTime"
              type="time"
              defaultValue={deadline?.time ?? ""}
            />
          </label>
        </div>
      )}
      {entity === "task" && (
        <div className="form-grid" data-more="">
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
          <label>
            所属课程
            <select name="courseId" defaultValue={task?.courseId ?? ""}>
              <option value="">无</option>
              {courseChoices(snapshot, task?.courseId ?? null).map((c) => (
                <option value={c.id} key={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {entity === "goal" && (
        <>
          <div className="form-grid" data-more="">
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
            <div className="linked-tasks" data-more="">
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
          {!saved && <label data-more={repeating ? undefined : ''}>
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
                value={seriesStart}
                onChange={e => {
                  setSeriesStart(e.target.value);
                  if ((series || (!saved && !target.draft?.end)) && !seriesEndEdited && e.target.value) setSeriesEnd(new Date(Date.parse(`${e.target.value}:00+08:00`) + duration + 8 * 3600000).toISOString().slice(0, 16));
                }}
              />
            </label>
            <label>
              {mobile ? '结束' : '结束（留空默认30分钟）'}
              <input name="end" type="datetime-local" value={seriesEnd} onChange={e => { setSeriesEnd(e.target.value); setSeriesEndEdited(true); }} />
            </label>
          </div>
          </>}
          <div className="form-grid" data-more={repeating ? undefined : ''}>
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
          <div className="form-grid" data-more="">
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
          <label data-more="">
            潜在收益（推测）
            <input
              name="potentialBenefit"
              defaultValue={candidate?.potentialBenefit}
            />
          </label>
          <label data-more="">
            条件（每行一项）
            <textarea
              name="conditions"
              defaultValue={candidate?.conditions.join("\n")}
            />
          </label>
          <label data-more="">
            不确定信息（每行一项）
            <textarea
              name="uncertainties"
              defaultValue={candidate?.uncertainties.join("\n")}
            />
          </label>
          <div className="form-grid" data-more="">
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
            <label data-more="">
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
            <label data-more="">
              起始周
              <input
                name="firstWeek"
                type="number"
                min={1}
                max={100}
                defaultValue={course?.firstWeek ?? 1}
              />
            </label>
            <label data-more="">
              结束周
              <input
                name="lastWeek"
                type="number"
                min={1}
                max={100}
                defaultValue={course?.lastWeek ?? snapshot.settings.termWeeks}
              />
            </label>
            <label data-more="">
              单双周
              <select name="parity" defaultValue={course?.parity ?? "all"}>
                <option value="all">每周</option>
                <option value="odd">单周</option>
                <option value="even">双周</option>
              </select>
            </label>
            <label data-more="">
              {mobile ? '指定教学周' : '指定教学周（可留空）'}
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
                <div className="exception-row" key={ex.id} data-more="">
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
        <label data-more="">
          地点
          <input
            name="location"
            placeholder={mobile ? '未填' : undefined}
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
      {entity !== 'candidate' && <div className="editor-resources" data-more="">{entity === 'course' && saved
        ? <ResourceSection snapshot={snapshot} target={{ entity, id: saved.id }} ui={ui} />
        : <>
          <ResourceFields value={resources} onChange={setResources} host={ui.host} disabled={ui.busy}
            title={entity === 'block' ? (repeating ? '每次活动的资料' : '本次资料') : entity === 'task' ? '任务资料' : '公共资料'} />
          {series && eventScope === 'this-and-following' && <p className="resource-scope">资料更改同步到本次及以后，每次独有的其他资料保留。</p>}
          {saved && <ResourceSection snapshot={snapshot} target={{ entity, id: saved.id }} ui={ui} inheritedOnly />}
          {!saved && entity === 'block' && schedulingTask && <ResourceSection snapshot={snapshot} target={{ entity: 'task', id: schedulingTask.id }} ui={ui} />}
        </>}</div>}
      {mobile && <button type="button" className="m-more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>
        <span>{moreOpen ? '收起' : '更多'}</span>{!moreOpen && <small>{moreNames[entity]}</small>}
      </button>}
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
        {!mobile && <button type="button" onClick={onClose}>
          取消
        </button>}
        <button type="submit" className="primary" disabled={ui.busy || Boolean(series && !affectedEvents.length)}>
          保存{entity === "course" || repeating || series ? "并预览" : ""}
        </button>
      </footer>
    </form>
  );
}
