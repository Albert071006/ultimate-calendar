import type { LedgerEntry, LedgerEntryKind } from './ledger';

export type LedgerLoanPrincipalKind = 'loan_borrow' | 'loan_lend';
export type LedgerLoanSettlementKind = 'loan_repay' | 'loan_collect';
export type LedgerLoanKind = LedgerLoanPrincipalKind | LedgerLoanSettlementKind;
export interface LedgerLoanItem {
  entryId: string;
  kind: LedgerLoanPrincipalKind;
  /** Empty means the counterparty has not been confirmed. */
  counterparty: string;
  principalCents: number;
  settledCents: number;
  outstandingCents: number;
  settlements: LedgerEntry[];
}
export interface LedgerLoans {
  payableCents: number;
  receivableCents: number;
  items: LedgerLoanItem[];
  /** Actual repayments/collections without a known original principal. */
  unlinked: LedgerEntry[];
}
export function isLedgerLoanKind(kind: LedgerEntryKind): kind is LedgerLoanKind {
  return kind === 'loan_borrow' || kind === 'loan_lend' || kind === 'loan_repay' || kind === 'loan_collect';
}

/** Derive principal balances across the complete validated ledger, never a month slice. */
export function ledgerLoans(entries: readonly LedgerEntry[]): LedgerLoans {
  const live = entries.filter(entry => !entry.voided);
  const items: LedgerLoanItem[] = live.flatMap(entry => entry.kind === 'loan_borrow' || entry.kind === 'loan_lend'
    ? [{ entryId: entry.id, kind: entry.kind, counterparty: entry.counterparty?.trim() ?? '', principalCents: entry.amountCents,
      settledCents: 0, outstandingCents: entry.amountCents, settlements: [] }]
    : []);
  const byId = new Map(items.map(item => [item.entryId, item]));
  const unlinked: LedgerEntry[] = [];
  for (const entry of live) {
    if (entry.kind !== 'loan_repay' && entry.kind !== 'loan_collect') continue;
    const original = entry.relatedEntryIds.length === 1 ? byId.get(entry.relatedEntryIds[0]!) : undefined;
    if (!original || original.kind !== (entry.kind === 'loan_repay' ? 'loan_borrow' : 'loan_lend')) {
      unlinked.push(entry); continue;
    }
    original.settledCents += entry.amountCents;
    original.outstandingCents -= entry.amountCents;
    original.settlements.push(entry);
  }
  return {
    payableCents: items.filter(item => item.kind === 'loan_borrow').reduce((sum, item) => sum + item.outstandingCents, 0),
    receivableCents: items.filter(item => item.kind === 'loan_lend').reduce((sum, item) => sum + item.outstandingCents, 0),
    items, unlinked,
  };
}
