import { createHash, randomUUID } from 'node:crypto';
import { MutationRequestSchema, MutationResultSchema, type MutationRequest, type MutationResult, type PlannerService, type Conflict, type PreviewDetail } from '../shared/contracts';
import { type Repository, type StoredState, stateSnapshot, diffStates, summarize, findEntity, putEntity, deleteEntity, records } from '../storage/repository';
import { automaticBackup } from '../storage/backups';
import { nowInstant, instantAt } from './time';
import { buildCalendar } from './calendar';
import { validateRelationships } from './validation';
import { expandMutations, DomainConflict } from './mutations';

const signature = (state: StoredState) => JSON.stringify({ entities: state.entities, settings: state.settings });
const fingerprint = (request: MutationRequest) => JSON.stringify({ operationId: request.operationId, mutations: request.mutations });
function clarification(message: string, conflicts: Conflict[] = []): MutationResult { return { status: 'clarification', message, conflicts, changes: [], questions: [message] }; }
function adoptedOccurrences(details: PreviewDetail[]): number {
  return details.filter(detail => detail.entity === 'block' && detail.before && detail.after && 'recurrence' in detail.before && 'recurrence' in detail.after && !detail.before.recurrence && detail.after.recurrence).length;
}
function previewMessage(request: MutationRequest, details: PreviewDetail[]): string {
  const mutation = request.mutations.length === 1 ? request.mutations[0] : undefined;
  if (mutation?.type === 'updateRecurringEvent' || mutation?.type === 'cancelRecurringEvent') return `${mutation.scope === 'single' ? '仅本次' : '本次及以后'}：将${mutation.type === 'cancelRecurringEvent' ? '取消' : '修改'}${details.filter(detail => detail.entity === 'block').length}次活动，请核对后确认`;
  const adopted = adoptedOccurrences(details);
  if ((mutation?.type === 'scheduleRecurringTask' || mutation?.type === 'createRecurringTask') && adopted) return `将新增${details.filter(detail => detail.entity === 'block' && !detail.before && detail.after).length}次重复活动，并将${adopted}次已有安排纳入同一系列，请核对后确认`;
  return '请核对以下更改后确认';
}
function appliedMessage(state: StoredState, request: MutationRequest, details: PreviewDetail[]): string {
  const mutation = request.mutations.length === 1 ? request.mutations[0] : undefined;
  if (mutation?.type === 'updateRecurringEvent' || mutation?.type === 'cancelRecurringEvent') return `已${mutation.type === 'cancelRecurringEvent' ? '取消' : '修改'}${details.filter(detail => detail.entity === 'block').length}次重复活动，可撤销`;
  if (mutation?.type === 'scheduleRecurringTask' || mutation?.type === 'createRecurringTask') {
    const count = details.filter(detail => detail.entity === 'block' && !detail.before && detail.after).length;
    const adopted = adoptedOccurrences(details);
    return `${count ? `已安排${count}次重复活动` : ''}${adopted ? `${count ? '，' : ''}已将${adopted}次已有安排纳入同一系列` : ''}，可撤销`;
  }
  if (mutation?.type === 'removeTask') return details.some(detail => detail.entity === 'block' && !detail.after) ? '任务及关联安排已移除，可撤销' : '任务已移除，可撤销';
  if (mutation?.type !== 'acceptCandidate') return '已保存，可撤销';
  const candidate = findEntity(state, 'candidate', mutation.id)!;
  if (candidate.duplicateOfId) return '已接受，已关联原任务，可撤销';
  const event = records(state, 'block').find(b => b.kind === 'event' && b.taskId === candidate.taskId && b.candidateId === candidate.id);
  if (event) {
    const updated = details.some(d => d.entity === 'block' && d.id === event.id && d.before);
    return `已接受，活动${updated ? '时间已更新到' : '已加入'}日历：${event.start.slice(0, 16).replace('T', ' ')}${event.end ? '' : '（默认安排30分钟，可调整）'}，可撤销`;
  }
  const task = candidate.taskId ? findEntity(state, 'task', candidate.taskId) : undefined;
  return task?.deadline ? '已接受，截止时间已保留，执行时间待安排，可撤销' : '已接受，任务待安排，可撤销';
}
type CancellationUndoBaseline = NonNullable<StoredState['journal'][number]['cancellationUndoBaseline']>;
type TimeConflictFact = { conflict: Conflict; baseline: CancellationUndoBaseline[number] };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function participantFingerprint(state: StoredState, entity: 'block' | 'course', id: string): string {
  return hash({ record: findEntity(state, entity, id) ?? null, exceptions: entity === 'course' ? records(state, 'courseException').filter(e => e.courseId === id).sort((a, b) => a.id.localeCompare(b.id)) : [] });
}
function timeConflictFacts(state: StoredState, details: PreviewDetail[]): TimeConflictFact[] {
  const changed = new Set(details.filter(d => d.after).map(d => d.id));
  for (const d of details) if (d.entity === 'courseException') for (const value of [d.before, d.after]) if (value && 'originalDate' in value) changed.add(value.courseId);
  if (!details.some(d => ['block', 'course', 'courseException'].includes(d.entity))) return [];
  const dates: string[] = [];
  for (const b of state.entities.block) if ('start' in b) { dates.push(b.start.slice(0, 10)); if (b.end) dates.push(b.end.slice(0, 10)); }
  for (const c of state.entities.course) if ('termStart' in c) { dates.push(c.termStart); dates.push(instantAt(Date.parse(`${c.termStart}T00:00:00+08:00`) + c.lastWeek * 7 * 86400_000).slice(0, 10)); }
  for (const e of state.entities.courseException) if ('replacement' in e && e.replacement) { dates.push(e.replacement.start.slice(0, 10)); dates.push(e.replacement.end.slice(0, 10)); }
  if (!dates.length) return []; dates.sort(); const items = buildCalendar(stateSnapshot(state), dates[0]!, dates.at(-1)!, false).filter(x => x.busy).sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!));
  const conflicts: TimeConflictFact[] = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i]!; const b = items[j]!;
    if (Date.parse(b.start!) >= Date.parse(a.end!)) break;
    const affected = changed.has(a.refId) || changed.has(b.refId);
    if (affected && Date.parse(a.start!) < Date.parse(b.end!) && Date.parse(b.start!) < Date.parse(a.end!)) {
      const witnesses = [a, b].map(item => ({ entity: item.refKind as 'block' | 'course', id: item.refId, fingerprint: participantFingerprint(state, item.refKind as 'block' | 'course', item.refId) }));
      const key = hash([a, b].map(item => JSON.stringify({ entity: item.refKind, id: item.refId, occurrence: item.id, start: item.start, end: item.end })).sort());
      conflicts.push({ conflict: { kind: 'time', entity: a.refKind, id: a.refId, message: `${a.title} 与 ${b.title} 时间重叠`, conflictingIds: [b.refId] }, baseline: { key, witnesses } });
    }
  }
  return conflicts;
}
const overlaps = (state: StoredState, details: PreviewDetail[]): Conflict[] => timeConflictFacts(state, details).map(fact => fact.conflict);
function cancellationUndoBaseline(state: StoredState, request: MutationRequest, details: PreviewDetail[]): CancellationUndoBaseline | undefined {
  if (!request.mutations.every(m => m.type === 'cancelRecurringEvent')) return undefined;
  if (!details.length || details.some(d => d.entity !== 'block' || !d.before || !d.after || !('cancelled' in d.before) || !('cancelled' in d.after) || d.before.cancelled || !d.after.cancelled)) return undefined;
  const original = structuredClone(state);
  for (const detail of details) putEntity(original, detail.entity, detail.before!);
  return timeConflictFacts(original, details).map(fact => fact.baseline);
}
function permitsCancellationUndo(fact: TimeConflictFact, baseline: CancellationUndoBaseline | undefined, beforeUndo: StoredState, details: PreviewDetail[]): boolean {
  const original = baseline?.find(value => value.key === fact.baseline.key);
  if (!original) return false;
  // Own after-images were already version-checked. Compare their original before-images,
  // while every external participant (including course exceptions) must remain identical.
  const witnessState = structuredClone(beforeUndo);
  for (const detail of details) if (detail.before) putEntity(witnessState, detail.entity, detail.before);
  return original.witnesses.every(witness => participantFingerprint(witnessState, witness.entity, witness.id) === witness.fingerprint);
}
export function createPlanner(repository: Repository, options: { automaticBackup?(repository: Repository): void } = {}): PlannerService {
  const backup = options.automaticBackup ?? automaticBackup;
  const previews = new Map<string, { signature: string; fingerprint: string; expires: number; details: PreviewDetail[] }>();
  function apply(state: StoredState, request: MutationRequest, details: PreviewDetail[], conflicts: Conflict[]): MutationResult {
    const id = randomUUID(); const at = nowInstant(); const changes = summarize(details);
    const result = MutationResultSchema.parse({ status: 'applied', message: appliedMessage(state, request, details), changes, conflicts, transactionId: id });
    const baseline = cancellationUndoBaseline(state, request, details);
    state.journal.push({ id, operationId: request.operationId, origin: request.origin, createdAt: at, message: result.message, changes, details, undoneAt: null, undoable: true, ...(baseline?.length ? { cancellationUndoBaseline: baseline } : {}) });
    state.operations.push({ id: request.operationId, fingerprint: fingerprint(request), result }); return result;
  }
  return {
    snapshot: () => repository.snapshot(),
    mutate(input) {
      const parsed = MutationRequestSchema.safeParse(input); if (!parsed.success) return clarification(`操作数据无效：${parsed.error.issues[0]?.message ?? ''}`);
      const request = parsed.data;
      for (const [token, preview] of previews) if (preview.expires <= Date.now()) previews.delete(token);
      if (previews.size >= 100) previews.delete(previews.keys().next().value!);
      try {
        const result = repository.transact(state => {
          const prior = state.operations.find(o => o.id === request.operationId); if (prior) return prior.fingerprint === fingerprint(request) ? MutationResultSchema.parse(prior.result) : clarification('operationId 已用于不同操作，请重新发起');
          const before = structuredClone(state);
          if (request.confirmed) {
            const preview = previews.get(request.confirmationToken!);
            if (!preview || preview.expires <= Date.now() || preview.fingerprint !== fingerprint(request)) return clarification('预览凭据无效或已过期，请重新预览');
            if (preview.signature !== signature(state)) return clarification('预览之后数据已改变，请查看最新内容后重新预览');
            for (const detail of preview.details) { if (detail.after) putEntity(state, detail.entity, detail.after); else deleteEntity(state, detail.entity, detail.id); }
            validateRelationships(state, true, before); const conflicts = overlaps(state, preview.details); const result = apply(state, request, preview.details, conflicts); previews.delete(request.confirmationToken!); return result;
          }
          const { deliberate } = expandMutations(state, request.mutations); validateRelationships(state, true, before);
          const details = diffStates(before, state); const conflicts = overlaps(state, details);
          if (deliberate || conflicts.length) {
            const token = randomUUID(); const expires = Date.now() + 10 * 60000;
            previews.set(token, { signature: signature(before), fingerprint: fingerprint(request), expires, details: structuredClone(details) });
            Object.assign(state, before);
            return MutationResultSchema.parse({ status: 'preview', message: `${conflicts.length ? '存在时间冲突，' : ''}${previewMessage(request, details)}`, changes: summarize(details), conflicts, confirmationToken: token, expiresAt: instantAt(expires), proposedRequest: request, details });
          }
          return apply(state, request, details, conflicts);
        }); if (result.status === 'applied') backup(repository); return result;
      } catch (error) { return clarification(error instanceof Error ? error.message : '操作失败', error instanceof DomainConflict ? [error.conflict] : []); }
    },
    undo(transactionId) {
      try {
        const result = repository.transact(state => {
          const journal = transactionId ? state.journal.find(j => j.id === transactionId && !j.undoneAt && j.undoable) : state.journal.findLast(j => !j.undoneAt && j.undoable);
          if (!journal) return clarification('没有可撤销的操作'); const before = structuredClone(state);
          for (const d of journal.undoExpected ?? journal.details) {
            const live = findEntity(state, d.entity, d.id) ?? null;
            if (JSON.stringify(live) !== JSON.stringify(d.after)) return clarification('记录后来已改变，不能覆盖更新；请手动处理', [{ kind: 'version', entity: d.entity, id: d.id, message: '后续修改阻止撤销', conflictingIds: [] }]);
          }
          for (const d of journal.details) { if (d.before) putEntity(state, d.entity, { ...d.before, version: Math.max(d.before.version, d.after?.version ?? 0, findEntity(state, d.entity, d.id)?.version ?? 0) + 1, updatedAt: nowInstant() }); else deleteEntity(state, d.entity, d.id); }
          validateRelationships(state, true, before);
          const details = diffStates(before, state);
          const conflicts = timeConflictFacts(state, details).filter(fact => !permitsCancellationUndo(fact, journal.cancellationUndoBaseline, before, journal.details)).map(fact => fact.conflict);
          if (conflicts.length) throw new DomainConflict(conflicts[0]!);
          // A legitimate undo changes versions. Carry that identity only to the nearest prior
          // transaction whose exact after-image was restored, preserving successive undo.
          for (const original of journal.details) {
            const restored = findEntity(state, original.entity, original.id) ?? null;
            for (const previous of state.journal.slice(0, state.journal.indexOf(journal)).reverse()) {
              if (previous.undoneAt || !previous.undoable) continue;
              const expected = previous.undoExpected ?? previous.details; const index = expected.findIndex(d => d.entity === original.entity && d.id === original.id);
              if (index < 0) continue;
              if (JSON.stringify(expected[index]!.after) === JSON.stringify(original.before)) { previous.undoExpected = structuredClone(expected); previous.undoExpected[index]!.after = restored; }
              break;
            }
          }
          journal.undoneAt = nowInstant(); journal.undoable = false;
          const id = randomUUID(); const changes = summarize(details); const result: MutationResult = { status: 'applied', transactionId: id, message: '已撤销', changes, conflicts: [] };
          state.journal.push({ id, operationId: `undo:${journal.id}`, createdAt: nowInstant(), origin: 'manual', message: result.message, changes, details, undoneAt: null, undoable: false }); return result;
        }); if (result.status === 'applied') backup(repository); return result;
      } catch (error) { return clarification(error instanceof Error ? error.message : '撤销失败', error instanceof DomainConflict ? [error.conflict] : []); }
    },
  };
}
