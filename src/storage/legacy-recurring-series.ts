import { RecurrenceRuleSchema, TaskInputSchema, type Block, type Entity } from '../shared/contracts';
import { expandRecurrence } from '../domain/recurrence';
import { effectiveActivityEnd } from '../domain/activity-duration';
import type { StoredState } from './repository';

/** Recover only membership proven by an applied recurring operation, never by task/title alone.
 * Normalizing old journal images as well as live records preserves their existing undo contract.
 * This runs when reading state, including old backups; dates, versions and timestamps do not change.
 */
export function normalizeLegacyRecurringSeries(state: StoredState): void {
  const membership = new Map<string, { recurrence: NonNullable<Block['recurrence']>; taskId: string; firstVersion: number }>();
  for (const journal of state.journal) {
    if (journal.undoneAt) continue;
    const operation = state.operations.find(value => value.id === journal.operationId);
    if (!operation) continue;
    let mutations: unknown;
    try { mutations = JSON.parse(operation.fingerprint).mutations; } catch { continue; }
    if (!Array.isArray(mutations)) continue;
    mutations.forEach((raw: unknown, index: number) => {
      if (!raw || typeof raw !== 'object') return;
      const mutation = raw as Record<string, unknown>;
      if (mutation.type !== 'scheduleRecurringTask' && mutation.type !== 'createRecurringTask') return;
      const rule = RecurrenceRuleSchema.safeParse(mutation.rule);
      if (!rule.success) return;
      let taskId = typeof mutation.id === 'string' ? mutation.id : null;
      if (mutation.type === 'createRecurringTask') {
        const values = TaskInputSchema.safeParse(mutation.values);
        if (!values.success) return;
        const tasks = journal.details.filter(detail => detail.entity === 'task' && !detail.before && detail.after &&
          Object.entries(values.data).every(([key, value]) => JSON.stringify((detail.after as unknown as Record<string, unknown>)[key]) === JSON.stringify(value)));
        if (tasks.length !== 1) return;
        taskId = tasks[0]!.id;
      }
      if (!taskId) return;
      let occurrences: ReturnType<typeof expandRecurrence>;
      try { occurrences = expandRecurrence(rule.data); } catch { return; }
      const byStart = new Map(occurrences.map(value => [Date.parse(value.start), value]));
      for (const detail of journal.details) {
        if (detail.entity !== 'block' || !detail.after) continue;
        const block = detail.after as Block;
        if (block.kind !== 'event' || block.taskId !== taskId) continue;
        const occurrence = byStart.get(Date.parse(block.recurrence?.occurrenceStart ?? block.start));
        if (!occurrence || Date.parse(effectiveActivityEnd(block.start, block.end)) !== Date.parse(occurrence.end)) continue;
        if (!membership.has(block.id)) membership.set(block.id, {
          // An undo may persist normalized journal images before untouched live siblings.
          // Keep using that proven membership to fill the remaining legacy records.
          recurrence: block.recurrence ?? { seriesId: `legacy-recurring:${journal.id}:${index}`, occurrenceStart: occurrence.start },
          taskId, firstVersion: block.version,
        });
      }
    });
  }
  const normalize = (record: Entity | null): void => {
    if (!record || !('start' in record)) return;
    const member = membership.get(record.id);
    if (!member || record.kind !== 'event' || record.taskId !== member.taskId || record.recurrence || record.version < member.firstVersion) return;
    record.recurrence = { ...member.recurrence };
  };
  for (const block of state.entities.block) normalize(block);
  for (const journal of state.journal) for (const detail of [...journal.details, ...(journal.undoExpected ?? [])]) {
    if (detail.entity === 'block') { normalize(detail.before); normalize(detail.after); }
  }
}
