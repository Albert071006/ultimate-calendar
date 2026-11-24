import type { LedgerEntry, LedgerEntryDraft } from './ledger';
import { isLedgerLoanKind } from './ledger-loans';

const normalizeTitle = (value: string) => value.replace(/[\s，。！？、,.!?]/g, '').toLowerCase();

export function duplicateLedgerEntry(entry: LedgerEntry, draft: LedgerEntryDraft): boolean {
  return !entry.voided && entry.date === draft.date && entry.month === draft.month && entry.kind === draft.kind &&
    entry.amountCents === draft.amountCents && normalizeTitle(entry.title) === normalizeTitle(draft.title) &&
    (!isLedgerLoanKind(draft.kind) || ((entry.counterparty?.trim() ?? '') === (draft.counterparty?.trim() ?? '') &&
      JSON.stringify([...new Set(entry.relatedEntryIds)].sort()) === JSON.stringify([...new Set(draft.relatedEntryIds)].sort())));
}
