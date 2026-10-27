import { randomUUID } from 'node:crypto';
import { type Mutation, type Conflict, type Course, type Task, type ReminderConfig, type RecurrenceRule, type Block } from '../shared/contracts';
import { newEntity, updateEntity, findEntity, deleteEntity, records, type StoredState } from '../storage/repository';
import { courseOccurs } from './courses';
import { dayDistance } from './time';
import { expandRecurrence } from './recurrence';
import { effectiveActivityEnd } from './activity-duration';
import { recurringEventTargets, recurringEventPatch } from './recurring-events';
import type { ResourceReference } from '../shared/resources';
import { taskScheduleMode, taskScheduleLimitExceeded } from './task-scheduling';
export class DomainConflict extends Error { constructor(public conflict: Conflict) { super(conflict.message); } }
export function conflict(kind: Conflict['kind'], entity: Conflict['entity'], id: string, message: string): never { throw new DomainConflict({ kind, entity, id, message, conflictingIds: [] }); }
function removeTask(state: StoredState, taskId: string, includeLinkedBlocks: boolean): boolean {
  const blocks = records(state, 'block').filter(block => block.taskId === taskId);
  for (const block of blocks) {
    if (includeLinkedBlocks) deleteEntity(state, 'block', block.id);
    else updateEntity(state, 'block', block.id, { taskId: null });
  }
  for (const candidate of records(state, 'candidate').filter(candidate => candidate.taskId === taskId)) updateEntity(state, 'candidate', candidate.id, { taskId: null });
  deleteEntity(state, 'task', taskId);
  return blocks.length > 0;
}
function scheduleRecurringTask(state: StoredState, task: Task, rule: RecurrenceRule, location: string, reminders: ReminderConfig | undefined, resources?: ResourceReference[]): void {
  if (task.status === 'done') conflict('recurrence', 'task', task.id, '已完成的任务不能新增重复活动，请先恢复任务');
  const occurrences = expandRecurrence(rule);
  if (!occurrences.length) conflict('recurrence', 'task', task.id, '所选日期范围内没有符合规则的活动，请调整日期或重复规则');
  const config = reminders ?? task.reminders;
  const reminderKey = (value: ReminderConfig) => JSON.stringify({ ...value, leadMinutes: value.leadMinutes?.slice().sort((a, b) => a - b) ?? null });
  const existing = records(state, 'block').filter(block => block.taskId === task.id);
  const originalStarts = new Set(occurrences.map(occurrence => Date.parse(occurrence.start)));
  const seriesIds = new Set(existing.filter(block => block.recurrence && originalStarts.has(Date.parse(block.recurrence.occurrenceStart))).map(block => block.recurrence!.seriesId));
  if (seriesIds.size > 1) conflict('recurrence', 'task', task.id, '日期范围涉及多个重复活动系列，请分别安排，不能合并系列');
  const seriesId = [...seriesIds][0] ?? randomUUID();
  const adopted: Block[] = [];
  const missing = occurrences.filter(occurrence => {
    const originals = existing.filter(block => block.recurrence?.seriesId === seriesId && Date.parse(block.recurrence.occurrenceStart) === Date.parse(occurrence.start));
    // Moved, completed and cancelled occurrences remain members and cannot be recreated.
    if (originals.length) return false;
    const matches = existing.filter(block => Date.parse(block.start) === Date.parse(occurrence.start));
    if (!matches.length) return true;
    if (matches.length > 1 || matches.some(block => block.recurrence || block.cancelled || block.kind !== 'event' || block.title !== task.title || Date.parse(effectiveActivityEnd(block.start, block.end)) !== Date.parse(occurrence.end) || block.location !== location || reminderKey(block.reminders) !== reminderKey(config))) {
      conflict('recurrence', 'task', task.id, `${occurrence.start.slice(0, 16).replace('T', ' ')} 已有不同的关联安排，请先核对，不能覆盖`);
    }
    adopted.push(...matches); return false;
  });
  if (!missing.length && !adopted.length) conflict('recurrence', 'task', task.id, '这些重复活动已经全部安排，无需重复添加');
  // Choosing a recurrence is an explicit request for multiple slots, even for a one-date range.
  if (task.scheduleMode !== 'multiple') updateEntity(state, 'task', task.id, { scheduleMode: 'multiple' });
  for (const block of adopted) updateEntity(state, 'block', block.id, {
    recurrence: { seriesId, occurrenceStart: block.start },
    ...(resources ? { resources: [...new Map([...(block.resources ?? []), ...resources].map(resource => [resource.id, resource])).values()] } : {}),
  });
  for (const occurrence of missing) newEntity(state, 'block', { title: task.title, ...occurrence, kind: 'event', taskId: task.id, location, reminders: config, resources, recurrence: { seriesId, occurrenceStart: occurrence.start } });
}
export function expandMutations(state: StoredState, mutations: Mutation[]): { deliberate: boolean } {
  const previousTasks = structuredClone(records(state, 'task'));
  const previousBlocks = structuredClone(records(state, 'block'));
  const completionMode = (task: Task) => task.scheduleMode ?? taskScheduleMode(previousTasks.find(value => value.id === task.id) ?? task, previousBlocks);
  const syncTaskCompletion = (task: Task, completed: boolean) => {
    if (completionMode(task) !== 'single') return;
    const linked = records(state, 'block').filter(block => block.taskId === task.id && !block.cancelled);
    if (linked.length === 1 && !linked[0]!.recurrence && linked[0]!.completed !== completed) updateEntity(state, 'block', linked[0]!.id, { completed });
  };
  const syncBlockCompletion = (block: Block, completed: boolean) => {
    const task = block.taskId ? findEntity(state, 'task', block.taskId) : undefined;
    if (!task || block.cancelled || block.recurrence || completionMode(task) !== 'single') return;
    const linked = records(state, 'block').filter(value => value.taskId === task.id && !value.cancelled);
    if (linked.length === 1 && task.status !== (completed ? 'done' : 'open')) updateEntity(state, 'task', task.id, { status: completed ? 'done' : 'open' });
  };
  let deliberate = mutations.length > 1;
  for (const m of mutations) {
    if ('entity' in m && m.entity === 'courseException') deliberate = true;
    if (m.type === 'createScheduledTask') {
      const task = newEntity(state, 'task', m.values) as Task;
      newEntity(state, 'block', { title: task.title, start: m.start, end: effectiveActivityEnd(m.start, m.end), kind: 'event', taskId: task.id, location: m.location, reminders: m.reminders ?? task.reminders });
      continue;
    }
    if (m.type === 'createRecurringTask') {
      deliberate = true;
      const task = newEntity(state, 'task', m.values) as Task;
      scheduleRecurringTask(state, task, m.rule, m.location, m.reminders, m.resources);
      continue;
    }
    if (m.type === 'create') { newEntity(state, m.entity, m.values); continue; }
    const kind = m.type === 'finishTask' || m.type === 'removeTask' || m.type === 'scheduleTaskEvent' || m.type === 'scheduleRecurringTask' ? 'task' : m.type === 'finishBlock' || m.type === 'updateRecurringEvent' || m.type === 'cancelRecurringEvent' ? 'block' : 'entity' in m ? m.entity : 'candidate';
    const old = findEntity(state, kind, m.id);
    if (!old) conflict('missing', kind, m.id, '记录已不存在，请刷新后重试');
    if (old.version !== m.expectedVersion) conflict('version', kind, m.id, '记录已修改，请查看最新版本');
    if (m.type === 'updateRecurringEvent' || m.type === 'cancelRecurringEvent') {
      deliberate = true;
      const anchor = old as Block;
      if (!anchor.recurrence || anchor.kind !== 'event') conflict('recurrence', 'block', m.id, '这不是重复活动，请编辑单个时段');
      const targets = recurringEventTargets(records(state, 'block'), anchor, m.scope);
      if (!targets.length) conflict('recurrence', 'block', m.id, '所选范围没有可更改的活动；已取消或已完成的活动会保留原状');
      let changed = false;
      for (const block of targets) {
        const patch = m.type === 'cancelRecurringEvent' ? { cancelled: true } : recurringEventPatch(block, anchor, m);
        if (Object.entries(patch).every(([key, value]) => JSON.stringify(block[key as keyof Block]) === JSON.stringify(value))) continue;
        updateEntity(state, 'block', block.id, patch); changed = true;
      }
      if (!changed) conflict('recurrence', 'block', m.id, '所选活动与当前安排相同，无需修改');
      continue;
    }
    if ('entity' in m && m.entity === 'block' && (m.type === 'update' || m.type === 'delete') && (old as Block).recurrence) conflict('recurrence', 'block', m.id, '重复活动请明确选择“仅本次”或“本次及以后”修改、取消');
    if (m.type === 'scheduleRecurringTask') { deliberate = true; scheduleRecurringTask(state, old as Task, m.rule, m.location, m.reminders, m.resources); continue; }
    if (m.type === 'removeTask') { deliberate = true; removeTask(state, m.id, m.includeLinkedBlocks); continue; }
    if (m.type === 'scheduleTaskEvent') {
      const task = findEntity(state, 'task', m.id)!;
      const candidate = task.candidateId ? findEntity(state, 'candidate', task.candidateId) : undefined;
      if (m.values.kind !== 'event' || m.values.taskId !== task.id || candidate?.status !== 'accepted' || candidate.taskId !== task.id) conflict('revision', 'task', m.id, '任务与原通知的关联已改变，请刷新后重新安排');
      if (records(state, 'block').some(block => block.kind === 'event' && block.taskId === task.id)) conflict('revision', 'task', m.id, '任务已有固定活动，请查看现有安排，不能重复添加');
      newEntity(state, 'block', { ...m.values, candidateId: candidate.id });
      continue;
    }
    if (m.type === 'finishTask' || m.type === 'finishBlock') {
      if (m.type === 'finishBlock' && (old as Block).cancelled) conflict('revision', 'block', m.id, '已取消的时段不能更改完成状态');
      const next = updateEntity(state, kind, m.id, m.type === 'finishTask' ? { status: m.completed ? 'done' : 'open' } : { completed: m.completed });
      if (m.type === 'finishTask') syncTaskCompletion(next as Task, m.completed); else syncBlockCompletion(next as Block, m.completed);
      continue;
    }
    if (m.type === 'acceptCandidate' || m.type === 'ignoreCandidate' || m.type === 'snoozeCandidate' || m.type === 'restoreCandidate') {
      const candidate = findEntity(state, 'candidate', m.id)!;
      if (m.type === 'acceptCandidate') {
        if (candidate.status === 'accepted' || candidate.taskId) conflict('revision', 'candidate', m.id, '候选已接受，请直接编辑已关联任务');
        if (candidate.duplicateOfId) {
          if (candidate.revisionOfId) conflict('revision', 'candidate', m.id, '候选同时标记重复和变更，请先明确关系');
          const duplicate = findEntity(state, 'candidate', candidate.duplicateOfId);
          const task = duplicate?.taskId ? findEntity(state, 'task', duplicate.taskId) : undefined;
          if (!task) conflict('revision', 'candidate', m.id, '请先处理重复关联的原候选，再接受此通知');
          updateEntity(state, 'candidate', m.id, { status: 'accepted', taskId: task.id, snoozedUntil: null });
          newEntity(state, 'feedback', { candidateId: m.id, decision: 'accepted', reason: m.reason ?? '' }); continue;
        }
        const previous = candidate.revisionOfId ? findEntity(state, 'candidate', candidate.revisionOfId) : undefined;
        const existingTask = previous?.status === 'accepted' && previous.taskId ? findEntity(state, 'task', previous.taskId) : undefined;
        if (previous?.status === 'accepted' && !existingTask) conflict('revision', 'candidate', m.id, '原事项任务已删除，请确认如何处理后重新关联');
        if (existingTask) deliberate = true;
        const values = { title: candidate.title, description: candidate.action, deadline: candidate.deadline, candidateId: candidate.id };
        const task = existingTask ? updateEntity(state, 'task', existingTask.id, values) : newEntity(state, 'task', values);
        const originalEvents = existingTask ? records(state, 'block').filter(b => b.kind === 'event' && b.taskId === task.id && b.candidateId === existingTask.candidateId) : [];
        if (originalEvents.length > 1) conflict('revision', 'candidate', m.id, '原活动包含多个关联时段，请先明确活动变更');
        const event = originalEvents[0];
        if (event?.recurrence) conflict('recurrence', 'candidate', m.id, '原活动属于重复系列，请先明确按“仅本次”或“本次及以后”处理变更');
        const eventValues = { title: candidate.title, start: candidate.eventStart, end: candidate.eventEnd, kind: 'event', taskId: task.id, candidateId: candidate.id, location: candidate.location };
        if (candidate.eventStart) { if (event) updateEntity(state, 'block', event.id, eventValues); else newEntity(state, 'block', eventValues); }
        else if (event) deleteEntity(state, 'block', event.id);
        updateEntity(state, 'candidate', m.id, { status: 'accepted', taskId: task.id, snoozedUntil: null });
      } else {
        if (candidate.status === 'accepted') conflict('revision', 'candidate', m.id, '已接受事项请先处理关联任务，不能静默忽略');
        updateEntity(state, 'candidate', m.id, m.type === 'ignoreCandidate' ? { status: 'ignored', snoozedUntil: null } : { status: 'pending', snoozedUntil: m.type === 'snoozeCandidate' ? m.until : null });
      }
      newEntity(state, 'feedback', { candidateId: m.id, decision: m.type === 'acceptCandidate' ? 'accepted' : m.type === 'ignoreCandidate' ? 'ignored' : m.type === 'restoreCandidate' ? 'restored' : 'snoozed', reason: m.reason ?? '' }); continue;
    }
    if (!('entity' in m)) continue;
    if (m.entity === 'course' && (m.type === 'update' || m.type === 'delete')) {
      deliberate = true; const course = findEntity(state, 'course', m.id)!;
      if (m.scope !== 'all') {
        const date = m.occurrenceDate!; if (!courseOccurs(course, date)) conflict('recurrence', 'course', m.id, '所选日期没有该课程');
        if (m.scope === 'single') {
          const existing = records(state, 'courseException').find(e => e.courseId === course.id && e.originalDate === date);
          const next = m.type === 'update' ? { ...course, ...m.values } as Course : course;
          const values = { courseId: course.id, originalDate: date, cancelled: m.type === 'delete', replacement: m.type === 'delete' ? null : { title: next.title, location: next.location, start: `${date}T${next.startTime}:00+08:00`, end: `${date}T${next.endTime}:00+08:00` } };
          if (m.type === 'update' && Object.keys(m.values).some(k => !['title', 'location', 'startTime', 'endTime'].includes(k))) conflict('recurrence', 'course', m.id, '单次修改仅支持标题、地点和时刻；更改日期请使用调课');
          if (existing) updateEntity(state, 'courseException', existing.id, values); else newEntity(state, 'courseException', values); continue;
        }
        const cutWeek = Math.floor(dayDistance(course.termStart, date) / 7) + 1;
        if (m.type === 'update') {
          if (m.values.firstWeek !== undefined && m.values.firstWeek !== cutWeek) conflict('recurrence', 'course', m.id, '此后修改从所选教学周开始；请更正首周或选择整个系列');
          const next = newEntity(state, 'course', { ...stripMetadata(course), ...m.values, firstWeek: cutWeek, weeks: m.values.weeks !== undefined ? m.values.weeks : course.weeks?.filter(w => w >= cutWeek) ?? null });
          for (const e of [...records(state, 'courseException')]) if (e.courseId === course.id && e.originalDate >= date) {
            if (courseOccurs(next as Course, e.originalDate)) updateEntity(state, 'courseException', e.id, { courseId: next.id }); else deleteEntity(state, 'courseException', e.id);
          }
          if (cutWeek <= course.firstWeek) for (const t of [...records(state, 'task')]) if (t.courseId === course.id) updateEntity(state, 'task', t.id, { courseId: next.id });
        } else for (const e of [...records(state, 'courseException')]) if (e.courseId === course.id && e.originalDate >= date) deleteEntity(state, 'courseException', e.id);
        const remaining = course.weeks?.filter(w => w < cutWeek) ?? null;
        if (cutWeek <= course.firstWeek || remaining?.length === 0) {
          for (const t of [...records(state, 'task')]) if (t.courseId === course.id) updateEntity(state, 'task', t.id, { courseId: null });
          deleteEntity(state, 'course', course.id);
        }
        else updateEntity(state, 'course', course.id, { lastWeek: cutWeek - 1, weeks: remaining }); continue;
      }
      if (m.type === 'update') {
        const next = updateEntity(state, 'course', m.id, m.values) as Course;
        for (const e of [...records(state, 'courseException')]) if (e.courseId === m.id && !courseOccurs(next, e.originalDate)) deleteEntity(state, 'courseException', e.id);
        continue;
      }
    }
    if (m.type === 'update') {
      if (m.entity === 'candidate' && findEntity(state, 'candidate', m.id)!.status === 'accepted') deliberate = true;
      const next = updateEntity(state, m.entity, m.id, m.values);
      // Editors submit full values; unchanged legacy completion fields are not a request to rewrite the linked record.
      if (m.entity === 'task' && m.values.status !== undefined && m.values.status !== (old as Task).status) syncTaskCompletion(next as Task, m.values.status === 'done');
      if (m.entity === 'block' && m.values.completed !== undefined && m.values.completed !== (old as Block).completed) syncBlockCompletion(next as Block, m.values.completed);
      continue;
    }
    if (m.type === 'delete') {
      if (m.entity === 'task') {
        if (removeTask(state, m.id, false)) deliberate = true;
        continue;
      }
      if (m.entity === 'goal') for (const t of [...records(state, 'task')]) if (t.goalId === m.id) { deliberate = true; updateEntity(state, 'task', t.id, { goalId: null }); }
      if (m.entity === 'course') {
        for (const e of [...records(state, 'courseException')]) if (e.courseId === m.id) deleteEntity(state, 'courseException', e.id);
        for (const t of [...records(state, 'task')]) if (t.courseId === m.id) { deliberate = true; updateEntity(state, 'task', t.id, { courseId: null }); }
      }
      if (m.entity === 'candidate') {
        for (const b of [...records(state, 'block')]) if (b.candidateId === m.id) updateEntity(state, 'block', b.id, { candidateId: null });
        for (const t of [...records(state, 'task')]) if (t.candidateId === m.id) updateEntity(state, 'task', t.id, { candidateId: null });
        for (const c of [...records(state, 'candidate')]) if (c.duplicateOfId === m.id || c.revisionOfId === m.id) updateEntity(state, 'candidate', c.id, { duplicateOfId: c.duplicateOfId === m.id ? null : c.duplicateOfId, revisionOfId: c.revisionOfId === m.id ? null : c.revisionOfId });
        for (const f of [...records(state, 'feedback')]) if (f.candidateId === m.id) deleteEntity(state, 'feedback', f.id);
      }
      deleteEntity(state, m.entity, m.id);
    }
  }
  for (const task of records(state, 'task')) if (taskScheduleLimitExceeded(task, records(state, 'block'), previousTasks.find(value => value.id === task.id), previousBlocks)) {
    conflict('revision', 'task', task.id, '这个任务默认只安排一个时段；请调整已有时段，或先选择“多个时段”再添加');
  }
  // Removing an old slot must not silently turn an intentionally split task into a single-slot task.
  // Persist only when an edit would erase the legacy evidence; reads/backups remain unchanged.
  for (const task of records(state, 'task')) {
    const previous = previousTasks.find(value => value.id === task.id);
    if (previous && !previous.scheduleMode && !task.scheduleMode && taskScheduleMode(previous, previousBlocks) === 'multiple'
      && taskScheduleMode(task, records(state, 'block')) === 'single') updateEntity(state, 'task', task.id, { scheduleMode: 'multiple' });
  }
  // Recoloring a course (all records of its title) or a goal only changes presentation; it applies directly and stays undoable.
  const recolor = mutations.every(m => m.type === 'update' && (m.entity === 'course' || m.entity === 'goal')
    && Object.keys(m.values).every(key => key === 'color') && (m.entity !== 'course' || m.scope === 'all'));
  return { deliberate: deliberate && !recolor };
}
function stripMetadata(value: Course) { const { id: _id, version: _v, createdAt: _c, updatedAt: _u, ...rest } = value; return rest; }
