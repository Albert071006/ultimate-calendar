import { createHash } from 'node:crypto';
import { buildCalendar } from '../domain/calendar';
import { resolveResources } from '../domain/resources';
import { instantAt, nowInstant } from '../domain/time';
import type { Snapshot } from '../shared/contracts';
import { PlanContextSchema, PlanExportRequestSchema, PlanSourceSchema, type PlanContext, type PlanExportRequest, type PlanSource } from '../shared/plan-context';
import type { ResourceOwner } from '../shared/resources';

/** Arrays in the basis are sets of records/references; their presentation order is not a data change. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
function collect(snapshot: Snapshot, goalId: string, fromDate: string, toDate: string) {
  PlanExportRequestSchema.parse({ goalId, fromDate, toDate });
  const goal = snapshot.goals.find(value => value.id === goalId);
  if (!goal) throw Error('所选目标已不存在，请刷新后重新选择');
  const tasks = snapshot.tasks.filter(value => value.goalId === goalId).map(({ candidateId: _source, ...task }) => task).sort((a, b) => a.id.localeCompare(b.id));
  const taskIds = new Set(tasks.map(value => value.id));
  const blocks = snapshot.blocks.filter(value => value.taskId && taskIds.has(value.taskId)).map(({ candidateId: _source, ...block }) => block).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const blockIds = new Set(blocks.map(value => value.id));
  const targets: ResourceOwner[] = [{ entity: 'goal', id: goalId }, ...tasks.map(value => ({ entity: 'task' as const, id: value.id })), ...blocks.map(value => ({ entity: 'block' as const, id: value.id }))];
  const resourceLinks = targets.flatMap(target => resolveResources(snapshot, target).map(({ group: _group, ...link }) => ({ target, ...link })))
    .sort((a, b) => `${a.target.entity}:${a.target.id}:${a.owner.entity}:${a.owner.id}:${a.resource.id}`.localeCompare(`${b.target.entity}:${b.target.id}:${b.owner.entity}:${b.owner.id}:${b.resource.id}`));
  const courseIds = new Set(tasks.flatMap(value => value.courseId ? [value.courseId] : []));
  const relatedCourses = snapshot.courses.filter(course => courseIds.has(course.id) || snapshot.courses.some(original => courseIds.has(original.id) && original.title === course.title && original.termStart === course.termStart));
  const lower = Date.parse(`${fromDate}T00:00:00+08:00`), upper = Date.parse(`${toDate}T00:00:00+08:00`) + 86_400_000;
  const busy = buildCalendar(snapshot, fromDate, toDate, false).filter(value => value.busy && value.start && value.end).flatMap(value => {
    const start = Math.max(lower, Date.parse(value.start!)), end = Math.min(upper, Date.parse(value.end!));
    if (end <= start || !['course', 'work', 'event'].includes(value.category)) return [];
    const owner = value.refKind === 'course' ? snapshot.courses.find(course => course.id === value.refId) : snapshot.blocks.find(block => block.id === value.refId);
    return [{ id: value.id, refKind: value.refKind, refId: value.refId, version: owner?.version ?? null,
      start: instantAt(start), end: instantAt(end), category: value.category as 'course' | 'work' | 'event', title: value.title,
      selectedPlan: value.refKind === 'block' && blockIds.has(value.refId) }];
  }).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.id.localeCompare(b.id));
  const busyCourseIds = new Set(busy.filter(value => value.refKind === 'course').map(value => value.refId));
  return { goal: structuredClone(goal), tasks, blocks, resourceLinks, relatedCourses,
    busy, busyCourseExceptions: snapshot.courseExceptions.filter(value => busyCourseIds.has(value.courseId)) };
}

/** Hash only the selected goal's planning context and this range's confirmed calendar occupancy. */
export function planContextFingerprint(snapshot: Snapshot, goalId: string, fromDate: string, toDate: string): string {
  const data = collect(snapshot, goalId, fromDate, toDate);
  return createHash('sha256').update(JSON.stringify(canonical({ goalId, fromDate, toDate, goal: data.goal, tasks: data.tasks, blocks: data.blocks,
    resourceLinks: data.resourceLinks, relatedCourses: data.relatedCourses, busy: data.busy, busyCourseExceptions: data.busyCourseExceptions }))).digest('hex');
}

export function buildPlanContext(snapshot: Snapshot, input: PlanExportRequest, source: PlanSource): PlanContext {
  const request = PlanExportRequestSchema.parse(input), origin = PlanSourceSchema.parse(source);
  const data = collect(snapshot, request.goalId, request.fromDate, request.toDate);
  return PlanContextSchema.parse({ format: 'ultimate-calendar-context', version: 1, timezone: 'Asia/Shanghai',
    basis: { source: origin, goalId: request.goalId, fromDate: request.fromDate, toDate: request.toDate, exportedAt: nowInstant(), fingerprint: planContextFingerprint(snapshot, request.goalId, request.fromDate, request.toDate) },
    request: request.instructions,
    instructions: [
      '这是规划上下文文件，不能直接导入日历。请返回 format 为 ultimate-calendar-plan、timezone 为 Asia/Shanghai 的 JSON 计划文件：只追加用 version 为 2，修改或删除已有记录用 version 为 3。',
      '完整复制 basis，不能修改其中的来源、目标、日期范围或指纹。给本次补录或修订分配独立且稳定的 planId；同一计划失败重试时保持文件内容不变，下一轮调整须重新导出上下文并使用新 planId。',
      'goals 必须为空，沿用所选目标。不要复制已有目标、任务或时段。v1/v2 只追加，不接受 updates/deletions；v3 可在同一文件内明确列出新增、修改和删除。',
      'v3 updates 每条为 {id,kind,targetId,expectedVersion,values}，kind 为 goal/task/block；targetId 和 expectedVersion 必须取本文件对应记录的真实 id 与 version，values 只写要改的字段，省略字段保留原值。同一记录只能修改或删除一次。',
      'v3 可改目标的 title/description/priority/targetDate/status/color/resourceRefs，任务的 title/description/deadline/scheduleMode/reminders/resourceRefs，时段的 title/start/end/location/reminders/resourceRefs。不能改任务完成状态、归属，或时段完成/取消/循环状态与归属。resourceRefs 省略保留，明确 [] 才清空直接资料；reminders 是整组替换，必须给 enabled/leadMinutes/dateOnlyTime。',
      '任务默认只安排一个时段，完成该时段会同时完成任务。只有用户明确需要分多次完成时，才设置 scheduleMode="multiple"；新任务写在 tasks 条目中，现有任务用 v3 updates 明确修改。已有多个时段或重复系列的旧任务保持多时段。不要因为规划方便而自行拆成多个时段；单时段改期应修改原 block。',
      'v3 deletions 每条为 {id,kind,targetId,expectedVersion}，kind 仅 task/block；不支持删除目标，已完成任务不能通过文件删除。删除任务时必须把其全部关联时段明确列入 deletions，有通知候选关联的任务由应用阻止删除。已完成、已取消或重复系列时段不能修改或删除。',
      '新增任务的 goalId 必须等于 basis.goalId；为已有任务补时段用 blocks[].taskId，为本文件新任务排时段用 taskRef。不能引用其它目标下的事项，不能创建未关联任务的时段。',
      '新增时段、待修改或删除时段的原时间、修改后的时间，都必须完整位于 basis.fromDate 至 basis.toDate 的上海日期范围内；末日次日 00:00 可作为结束时间。范围不足请重新导出，不要修改 basis。',
      '不能为已完成任务新增时段；为未安排的未完成任务补充学习时段。保留用户已经完成、移动或取消的安排，不重建它们。',
      'busyIntervals 是指定日期内已确认的占用，已裁剪到日期范围。selectedPlan=true 的时段也已列入 blocks，只计算一次；v3 按明确修改或删除后的最终安排避让，不把已移动时段的旧位置再次算作占用。其它占用不应覆盖。截止时间和待判断事项不是忙碌时段。',
      'resourceLinks 包含直接及继承资料。需要关联时将所需 resource 原样放入 resources，用 resourceRefs 引用其 id；不要制造本机文件路径或上传原文件。',
      '导入会展示修改前后及删除清单，删除需另行勾选确认。已有内容的修订先作为一个事务保存，再依次新增任务与时段；中断保留已保存部分，不会自动回滚整份计划。',
    ],
    goal: data.goal, tasks: data.tasks, blocks: data.blocks, resourceLinks: data.resourceLinks,
    busyIntervals: data.busy.map(({ start, end, category, title, selectedPlan }) => ({ start, end, category, selectedPlan, ...(selectedPlan || request.includeBusyTitles ? { title } : {}) })),
    coverage: `目标、关联任务及其全部已有时段均已包含；忙碌信息仅覆盖 ${request.fromDate} 至 ${request.toDate}（上海时间，含首尾日期）。跨界时段已裁剪；事件未填结束时间按应用默认时长计算。未包含 QQ 原文、来源记录、账本或其它目标的任务详情。`,
  });
}
