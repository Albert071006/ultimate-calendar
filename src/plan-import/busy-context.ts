import { createHash } from 'node:crypto';
import { buildCalendar } from '../domain/calendar';
import { instantAt, nowInstant } from '../domain/time';
import type { Snapshot } from '../shared/contracts';
import { BusyContextSchema, BusyExportRequestSchema, type BusyContext, type BusyExportRequest } from '../shared/busy-context';
import { PlanSourceSchema, type PlanSource } from '../shared/plan-context';

function intervals(snapshot: Snapshot, request: BusyExportRequest) {
  const lower = Date.parse(`${request.fromDate}T00:00:00+08:00`), upper = Date.parse(`${request.toDate}T00:00:00+08:00`) + 86_400_000;
  return buildCalendar(snapshot, request.fromDate, request.toDate, false)
    .filter(value => value.busy && value.start && value.end && ['course', 'work', 'event'].includes(value.category))
    .flatMap(value => {
      const start = Math.max(lower, Date.parse(value.start!)), end = Math.min(upper, Date.parse(value.end!));
      if (start >= end) return [];
      const owner = value.refKind === 'course' ? snapshot.courses.find(course => course.id === value.refId) : snapshot.blocks.find(block => block.id === value.refId);
      const exception = value.refKind === 'course' ? snapshot.courseExceptions.find(change => `${change.courseId}:${change.originalDate}` === value.id) : undefined;
      return [{ id: value.id, refKind: value.refKind, refId: value.refId, version: owner?.version ?? null,
        exception: exception ? { id: exception.id, version: exception.version } : null,
        start: instantAt(start), end: instantAt(end), category: value.category as 'course' | 'work' | 'event', title: value.title }];
    }).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.id.localeCompare(b.id));
}

/** A save-time freshness check for confirmed occupancy; it is not an import authorization/basis. */
export function busyContextFingerprint(snapshot: Snapshot, input: BusyExportRequest): string {
  const request = BusyExportRequestSchema.parse(input);
  return createHash('sha256').update(JSON.stringify({ fromDate: request.fromDate, toDate: request.toDate, busy: intervals(snapshot, request) })).digest('hex');
}

export function buildBusyContext(snapshot: Snapshot, input: BusyExportRequest, source: PlanSource): BusyContext {
  const request = BusyExportRequestSchema.parse(input), origin = PlanSourceSchema.parse(source), busy = intervals(snapshot, request);
  return BusyContextSchema.parse({ format: 'ultimate-calendar-busy', version: 1, timezone: 'Asia/Shanghai', source: origin,
    fromDate: request.fromDate, toDate: request.toDate, exportedAt: nowInstant(), request: request.instructions,
    instructions: [
      '这是日历忙碌时间参考文件，不能直接导入日历；它不包含已有目标、任务正文、资源或来源原文。',
      '如需创建完整的新目标计划，请返回 format 为 ultimate-calendar-plan、version 为 1、timezone 为 Asia/Shanghai 的 JSON 文件。',
      '在 goals、tasks、blocks 中分别列出新目标、新任务和学习时段，并为每条记录分配文件内唯一 id；任务通过 goalRef 引用本文件目标，时段通过 taskRef 引用本文件任务。',
      '给这份新计划分配独立稳定的 planId。相同文件重试应保持内容及编号不变，不要复制已有事项来覆盖它们；不输出更新或删除操作。',
      '安排学习时段时避开 busyIntervals，并尊重用户给出的时长、日期和休息要求；课程、活动和执行时段都已计入，截止日期和待判断事项不是忙碌占用。',
      '本文件只是导出当时的占用参考，不提供目标上下文的自动基线保护。生成的计划导入时仍须预览并核对当时最新的时间冲突。',
      '需要资料时可在新计划 resources 中给出网页资料并用 resourceRefs 关联；不要制造本机文件路径或凭据。',
    ],
    busyIntervals: busy.map(({ start, end, category, title }) => ({ start, end, category, ...(request.includeBusyTitles ? { title } : {}) })),
    coverage: `仅覆盖 ${request.fromDate} 至 ${request.toDate} 的上海时间日期范围（含首尾日期），共 ${busy.length} 个已确认忙碌区间。跨界时段已裁剪；未填结束时间的事件按应用默认时长计算。取消事项、截止时间和待判断事项不计入，范围外的安排未导出。`,
  });
}
