import { ledgerAccounts, LedgerQuerySchema, ledgerToday, type LedgerData, type LedgerEntry, type LedgerQuery, type LedgerSummary } from '../shared/ledger';

export function ledgerEntryMatches(entry: LedgerEntry, query: LedgerQuery): boolean {
  if (entry.voided) return false;
  if (query.month && entry.month !== query.month) return false;
  if (query.from && (!entry.date || entry.date < query.from)) return false;
  if (query.to && (!entry.date || entry.date > query.to)) return false;
  if (query.accountId && !entry.cashflows.some(flow => flow.accountId === query.accountId)) return false;
  if (query.category && entry.category !== query.category) return false;
  if (query.search && !`${entry.title}\n${entry.note}\n${entry.originalText}\n${entry.counterparty ?? ''}`.toLowerCase().includes(query.search.toLowerCase())) return false;
  return true;
}

/** Integer-only derived views; model-generated balances are never accepted as calculations. */
export function summarizeLedger(data: Pick<LedgerData, 'entries' | 'balanceSnapshots' | 'accounts'>, input: LedgerQuery = {}, now = new Date()): LedgerSummary {
  const query = LedgerQuerySchema.parse(input);
  const month = query.month ?? query.from?.slice(0, 7) ?? ledgerToday(now).slice(0, 7);
  const effectiveQuery = (query.from || query.to) ? query : { ...query, month };
  const live = data.entries.filter(entry => !entry.voided);
  const selected = live.filter(entry => ledgerEntryMatches(entry, effectiveQuery));
  const categories = new Map<string, number>(); const days = new Map<string, number>();
  const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);
  let personalCents = 0; let uncertainDateCents = 0; let unallocatedAdjustmentCents = 0;
  for (const entry of selected) {
    if (entry.personalCents === null) continue;
    personalCents += entry.personalCents; add(categories, entry.category, entry.personalCents);
    if (entry.date) add(days, entry.date, entry.personalCents); else uncertainDateCents += entry.personalCents;
  }
  const byId = new Map(live.map(entry => [entry.id, entry]));
  for (const receipt of live) for (const adjustment of receipt.adjustments) {
    const targets = adjustment.targetEntryIds.map(id => byId.get(id)).filter((entry): entry is LedgerEntry => !!entry);
    if (!targets.length) continue;
    // Group adjustments share a category/month. A filter must include the entire group;
    // otherwise allocation is unknown and must not silently invent a per-payment split.
    if (!targets.every(entry => ledgerEntryMatches(entry, effectiveQuery))) {
      if (targets.some(entry => ledgerEntryMatches(entry, effectiveQuery))) unallocatedAdjustmentCents += adjustment.amountCents;
      continue;
    }
    personalCents -= adjustment.amountCents;
    add(categories, targets[0]!.category, -adjustment.amountCents);
    const dates = new Set(targets.map(entry => entry.date));
    if (dates.size === 1 && targets[0]!.date) add(days, targets[0]!.date, -adjustment.amountCents);
    else uncertainDateCents -= adjustment.amountCents;
  }
  const uncertainOutsideRange = (query.from || query.to) ? live.filter(entry => !entry.date &&
    ledgerEntryMatches(entry, { ...effectiveQuery, from: undefined, to: undefined }) &&
    (!query.from || entry.month >= query.from.slice(0, 7)) && (!query.to || entry.month <= query.to.slice(0, 7))) : [];
  let excludedUncertainDateCents = uncertainOutsideRange.reduce((sum, entry) => sum + (entry.personalCents ?? 0), 0);
  const excludedIds = new Set(uncertainOutsideRange.map(entry => entry.id));
  for (const receipt of live) for (const adjustment of receipt.adjustments) if (adjustment.targetEntryIds.every(id => excludedIds.has(id))) excludedUncertainDateCents -= adjustment.amountCents;
  const accounts = ledgerAccounts(data).map(account => {
    const snapshots = data.balanceSnapshots.filter(snapshot => snapshot.accountId === account.id).sort((a, b) => b.date.localeCompare(a.date) || (b.asOf ?? b.recordedAt).localeCompare(a.asOf ?? a.recordedAt) || b.recordedAt.localeCompare(a.recordedAt));
    const snapshot = snapshots[0];
    let balanceCents: number | null = account.kind === 'family' || !snapshot ? null : snapshot.balanceCents;
    const pendingEntryIds: string[] = [];
    const covered = new Set(snapshot?.coveredEntryIds ?? []);
    if (snapshot && balanceCents !== null) for (const entry of live) {
      const delta = entry.cashflows.filter(flow => flow.accountId === account.id).reduce((sum, flow) => sum + flow.deltaCents, 0);
      if (!delta) continue;
      const position = entry.snapshotPositions?.find(item => item.snapshotId === snapshot.id)?.position;
      if (position === 'before') continue;
      if (position === 'after') { balanceCents += delta; continue; }
      if (covered.has(entry.id)) continue;
      if (entry.date && entry.date > snapshot.date) { balanceCents += delta; continue; }
      if (entry.date === snapshot.date && entry.occurredAt) {
        if (snapshot.asOf && Date.parse(entry.occurredAt) <= Date.parse(snapshot.asOf)) continue;
        // The recorded time is an upper bound on a user-reported snapshot's time.
        if (Date.parse(entry.occurredAt) > Date.parse(snapshot.asOf ?? snapshot.recordedAt)) { balanceCents += delta; continue; }
      }
      // The user's default applies to local same-day entries registered after the
      // balance was recorded. Never use updatedAt: later account corrections of
      // imported/older transactions must not debit a reconciled balance again.
      if (entry.sameDayBalanceOrder === 'after' && !entry.occurredAt && !entry.sourceId && !entry.sourceKey && !entry.ruleKey &&
          entry.date === snapshot.date && entry.date === ledgerToday(new Date(entry.createdAt)) &&
          Date.parse(entry.createdAt) > Date.parse(snapshot.recordedAt)) {
        balanceCents += delta; continue;
      }
      // Uncovered historical entries and same-day unknown ordering need reconciliation.
      pendingEntryIds.push(entry.id);
    }
    const periodFlows = selected.flatMap(entry => entry.cashflows).filter(flow => flow.accountId === account.id);
    return { id: account.id, name: account.name, kind: account.kind, balanceCents,
      snapshotDate: snapshot?.date ?? null, snapshotAt: snapshot?.asOf ?? null, pendingEntryIds,
      periodChangeCents: periodFlows.reduce((sum, flow) => sum + flow.deltaCents, 0),
      recordedUsageCents: account.kind === 'family' ? periodFlows.reduce((sum, flow) => sum + Math.max(0, -flow.deltaCents), 0) : 0 };
  });
  const balanceTotal = (kind: 'cash' | 'stored') => {
    const group = accounts.filter(account => account.kind === kind);
    return group.some(account => account.balanceCents === null) ? null : group.reduce((sum, account) => sum + account.balanceCents!, 0);
  };
  return { month, from: query.from ?? null, to: query.to ?? null,
    actualPaidCents: selected.filter(entry => entry.kind === 'expense' || entry.kind === 'repayment' || entry.kind === 'loan_lend' || entry.kind === 'loan_repay').reduce((sum, entry) => sum + entry.amountCents, 0),
    personalCents, incomeCents: selected.reduce((sum, entry) => sum + entry.incomeCents, 0), assetSaleCents: selected.reduce((sum, entry) => sum + entry.assetSaleCents, 0),
    familyUsageCents: accounts.filter(account => account.kind === 'family').reduce((sum, account) => sum + account.recordedUsageCents, 0),
    pendingPersonalCount: selected.filter(entry => entry.kind === 'expense' && entry.personalCents === null).length,
    pendingAccountCount: selected.filter(entry => entry.cashflows.some(flow => flow.accountId === null && flow.deltaCents !== 0)).length,
    uncertainDateCents, excludedUncertainDateCents, unallocatedAdjustmentCents, cashBalanceCents: balanceTotal('cash'), storedBalanceCents: balanceTotal('stored'), accounts,
    categories: [...categories].filter(([, cents]) => cents !== 0).map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category)),
    days: [...days].map(([date, cents]) => ({ date, cents })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
