import type { LedgerEntry } from '../shared/ledger';

export interface Receivable { cents: number; entryIds: string[] }

/**
 * Money paid for others this month that has not come back yet: for each expense whose actual payment exceeds
 * the known personal share, the advance minus AA / 代垫 returns linked to it. Returns linked to several expenses
 * settle them in date order. Expenses with an unknown personal share are left out rather than guessed. This only
 * reads the ledger for display; it does not change any total.
 */
export function ledgerReceivable(entries: LedgerEntry[], month: string): Receivable {
  const live = entries.filter(entry => !entry.voided);
  const advances = new Map(live
    .filter(entry => entry.kind === 'expense' && entry.month === month && entry.personalCents !== null && entry.amountCents > entry.personalCents)
    .sort((a, b) => (a.date ?? a.month).localeCompare(b.date ?? b.month) || a.createdAt.localeCompare(b.createdAt))
    .map(entry => [entry.id, entry.amountCents - entry.personalCents!]));
  for (const back of live.filter(entry => entry.kind === 'aa_return')) {
    let left = back.amountCents;
    for (const id of advances.keys()) {
      if (!left) break;
      if (!back.relatedEntryIds.includes(id)) continue;
      const settled = Math.min(left, advances.get(id)!);
      advances.set(id, advances.get(id)! - settled);
      left -= settled;
    }
  }
  const open = [...advances].filter(([, cents]) => cents > 0);
  return { cents: open.reduce((sum, [, cents]) => sum + cents, 0), entryIds: open.map(([id]) => id) };
}
