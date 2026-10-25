import { addCalendarDays, type Block, type Mutation } from '../shared/contracts';
import { dayDistance, instantAt } from './time';

export type RecurringEventUpdate = Extract<Mutation, { type: 'updateRecurringEvent' }>;
export type RecurringEventScope = RecurringEventUpdate['scope'];

/** Original occurrence order survives one-off moves across the series boundary. */
export function recurringEventTargets(blocks: Block[], anchor: Block, scope: RecurringEventScope): Block[] {
  if (!anchor.recurrence) return [];
  return blocks.filter(block => block.kind === 'event' && !block.completed && !block.cancelled &&
    block.recurrence?.seriesId === anchor.recurrence!.seriesId &&
    (scope === 'single' ? block.id === anchor.id : Date.parse(block.recurrence.occurrenceStart) >= Date.parse(anchor.recurrence!.occurrenceStart)))
    .sort((a, b) => Date.parse(a.recurrence!.occurrenceStart) - Date.parse(b.recurrence!.occurrenceStart) || a.id.localeCompare(b.id));
}

/** A date move is a calendar-day offset; changing only a reminder leaves every time intact. */
export function recurringEventPatch(block: Block, anchor: Block, mutation: RecurringEventUpdate): RecurringEventUpdate['values'] {
  const values = mutation.values;
  const patch = { ...values };
  if (mutation.resourceMode === 'append' && values.resources !== undefined) {
    const resources = [...(block.resources ?? [])];
    const existing = new Set(resources.map(resource => resource.id));
    for (const resource of values.resources) if (!existing.has(resource.id)) { resources.push(resource); existing.add(resource.id); }
    patch.resources = resources;
  } else if (mutation.scope === 'this-and-following' && values.resources !== undefined && block.id !== anchor.id) {
    const original = new Map((anchor.resources ?? []).map(resource => [resource.id, resource]));
    const edited = new Map(values.resources.map(resource => [resource.id, resource]));
    const removed = new Set([...original.keys()].filter(id => !edited.has(id)));
    const changed = new Map(values.resources.filter(resource => original.has(resource.id) && JSON.stringify(original.get(resource.id)) !== JSON.stringify(resource)).map(resource => [resource.id, resource]));
    const resources = (block.resources ?? []).filter(resource => !removed.has(resource.id)).map(resource => changed.get(resource.id) ?? resource);
    const existing = new Set(resources.map(resource => resource.id));
    for (const resource of values.resources) if (!original.has(resource.id) && !existing.has(resource.id)) {
      resources.push(resource); existing.add(resource.id);
    }
    patch.resources = resources;
  }
  let start = block.start;
  if (values.start !== undefined) {
    const offset = dayDistance(anchor.start.slice(0, 10), values.start.slice(0, 10));
    start = mutation.scope === 'single' ? values.start : `${addCalendarDays(block.start.slice(0, 10), offset)}${values.start.slice(10)}`;
    patch.start = start;
  }
  if (values.end !== undefined) {
    if (values.end === null) patch.end = null;
    else {
      const duration = Date.parse(values.end) - Date.parse(values.start ?? anchor.start);
      if (duration <= 0) throw new Error('活动结束必须晚于开始');
      patch.end = instantAt(Date.parse(start) + duration);
    }
  } else if (values.start !== undefined) {
    patch.end = block.end === null ? null : instantAt(Date.parse(start) + Date.parse(block.end) - Date.parse(block.start));
  }
  return patch;
}
