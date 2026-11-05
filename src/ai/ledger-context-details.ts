import { z } from 'zod';
import { LedgerIntentSchema, type LedgerIntent } from '../shared/ledger-command';
import type { ledgerContext } from './ledger';

/** A read request never enters a durable mutation proposal or authorizes a write. */
export const LedgerContextIntentSchema = z.union([
  LedgerIntentSchema,
  z.strictObject({ kind: z.literal('read_entries'), ids: z.array(z.string().min(1).max(200)).min(1).max(100) }),
]);

type Context = ReturnType<typeof ledgerContext>;

/** A record's refunds, returns and repayments may link to it only in reverse. */
export function expandLedgerDetailIds(context: Context, detailIds: Iterable<string>): string[] {
  const links = new Map(context.entries.map(entry => [entry.id, new Set<string>()]));
  for (const entry of context.entries) {
    for (const id of [...entry.relatedEntryIds, ...entry.adjustments.flatMap(adjustment => adjustment.targetEntryIds)]) {
      if (!links.has(id)) continue;
      links.get(entry.id)!.add(id);
      links.get(id)!.add(entry.id);
    }
  }
  const wanted = new Set<string>();
  const pending = [...detailIds].filter(id => links.has(id));
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]!;
    if (wanted.has(id)) continue;
    wanted.add(id);
    for (const related of links.get(id)!) if (!wanted.has(related)) pending.push(related);
  }
  // Only expand within this same retrieved snapshot, in its stable wire order.
  return context.entries.filter(entry => wanted.has(entry.id)).map(entry => entry.id);
}

export function initialLedgerDetailIds(context: Context): string[] {
  return expandLedgerDetailIds(context, context.relevantRecordIds.entries.slice(0, 8));
}

/** Keep the index lossless for locating records, and fetch full facts before edits. */
export function ledgerPromptContext(context: Context, detailIds = initialLedgerDetailIds(context)) {
  const wanted = new Set(expandLedgerDetailIds(context, detailIds));
  const columns = ['id', 'version', 'title', 'kind', 'date', 'month', 'amountCents', 'counterparty', 'voided'] as const;
  return {
    ...context,
    entryIndex: { columns, rows: context.entries.map(entry => columns.map(column => entry[column])) },
    entries: context.entries.filter(entry => wanted.has(entry.id)),
    providedDetailCount: context.entries.filter(entry => wanted.has(entry.id)).length,
  };
}

/** Every existing record whose facts a mutation uses must have been read in full. */
export function referencedLedgerEntries(intent: LedgerIntent): string[] {
  if (intent.kind !== 'mutate') return [];
  const newKeys = new Set(intent.changes.flatMap(change => change.type === 'createEntry' ? [change.key] : []));
  const ids = new Set<string>();
  for (const change of intent.changes) {
    if (change.type === 'voidEntry' || change.type === 'updateEntry') ids.add(change.id);
    const values = change.type === 'createEntry' ? change.values : change.type === 'updateEntry' ? change.patch : null;
    for (const id of values?.relatedEntryIds ?? []) if (!newKeys.has(id)) ids.add(id);
    for (const adjustment of values?.adjustments ?? []) for (const id of adjustment.targetEntryIds) if (!newKeys.has(id)) ids.add(id);
  }
  return [...ids];
}
