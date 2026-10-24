import { expect, it } from 'vitest';
import { LedgerEntrySchema } from '../shared/ledger';
import { ledgerReceivable } from './receivable';

const stamp = '2026-10-20T12:00:00+08:00';
const entry = (id: string, values: Record<string, unknown>) => LedgerEntrySchema.parse({
  id, kind: 'expense', date: '2026-10-20', month: '2026-10', title: id, category: '餐饮', amountCents: 0, personalCents: 0,
  cashflows: [], version: 1, createdAt: stamp, updatedAt: stamp, ...values,
});

it('counts the unreturned part of each advance and ignores expenses with an unknown share', () => {
  const entries = [
    entry('tea', { amountCents: 3600, personalCents: 1800 }),
    entry('dinner', { date: '2026-10-21', amountCents: 10000, personalCents: 2500 }),
    entry('solo', { amountCents: 1500, personalCents: 1500 }),
    entry('unknown', { amountCents: 8000, personalCents: null }),
    entry('back', { kind: 'aa_return', amountCents: 1800, personalCents: 0, relatedEntryIds: ['tea'] }),
    entry('partial', { kind: 'aa_return', amountCents: 2500, personalCents: 0, relatedEntryIds: ['dinner'] }),
  ];
  expect(ledgerReceivable(entries, '2026-10')).toEqual({ cents: 5000, entryIds: ['dinner'] });
});

it('settles a return linked to several advances in date order and skips voided records and other months', () => {
  const entries = [
    entry('later', { date: '2026-10-22', amountCents: 3000, personalCents: 1000 }),
    entry('earlier', { date: '2026-10-02', amountCents: 2000, personalCents: 1000 }),
    entry('september', { date: '2026-09-28', month: '2026-09', amountCents: 5000, personalCents: 0 }),
    entry('voided', { amountCents: 9000, personalCents: 0, voided: true }),
    entry('back', { kind: 'aa_return', amountCents: 1500, personalCents: 0, relatedEntryIds: ['later', 'earlier'] }),
  ];
  expect(ledgerReceivable(entries, '2026-10')).toEqual({ cents: 1500, entryIds: ['later'] });
});
