import type { StoredState } from '../storage/repository';
import { records, findEntity } from '../storage/repository';
import { courseOccurs } from './courses';
/** Existing provenance IDs may outlive explicit source deletion; all new source links must resolve. */
export function validateRelationships(state: StoredState, strictSources: boolean, before?: StoredState): void {
  const has = (kind: Parameters<typeof findEntity>[1], id: string | null) => !id || !!findEntity(state, kind, id);
  for (const t of records(state, 'task')) if (!has('goal', t.goalId) || !has('candidate', t.candidateId)) throw Error('任务关联的目标或候选已不存在');
  for (const b of records(state, 'block')) if (!has('task', b.taskId) || !has('candidate', b.candidateId)) throw Error('执行时段关联任务或候选已不存在；请先解除关联');
  const occurrenceKeys = new Set<string>();
  for (const b of records(state, 'block')) if (b.recurrence) {
    const key = `${b.recurrence.seriesId}:${Date.parse(b.recurrence.occurrenceStart)}`;
    if (occurrenceKeys.has(key)) throw Error('同一系列的每次原始安排只能对应一个活动');
    occurrenceKeys.add(key);
  }
  for (const c of records(state, 'candidate')) {
    if (!has('task', c.taskId) || !has('candidate', c.duplicateOfId) || !has('candidate', c.revisionOfId)) throw Error('候选关联记录已不存在');
    const old = before && findEntity(before, 'candidate', c.id);
    if (strictSources && c.sourceIds.some(id => !has('source', id) && !old?.sourceIds.includes(id))) throw Error('候选来源不存在');
  }
  const exceptionKeys = new Set<string>();
  for (const e of records(state, 'courseException')) {
    const course = findEntity(state, 'course', e.courseId); if (!course || !courseOccurs(course, e.originalDate)) throw Error('调课必须引用实际存在的一次课程');
    const key = `${e.courseId}:${e.originalDate}`; if (exceptionKeys.has(key)) throw Error('同一课程日期只能有一个例外'); exceptionKeys.add(key);
  }
  for (const f of records(state, 'feedback')) if (!has('candidate', f.candidateId)) throw Error('反馈候选不存在');
}
