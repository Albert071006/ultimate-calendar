import { z } from 'zod';
import { readLedgerSnapshotAtRevision } from '../ledger/service';
import { PlannerPatchSchema } from '../shared/contracts';
import { LedgerMonthSchema, LedgerMutationResultSchema } from '../shared/ledger';
import type { RemoteMethod } from '../shared/remote';
import { openDatabase } from '../storage/database';
import { redactEvidence } from './backup';
import { remoteOutputs } from './protocol';

const format = 'ledger-receipt-v1';
const storedReceipt = z.strictObject({
  format: z.literal(format),
  revision: z.number().int().nonnegative(),
  month: LedgerMonthSchema,
  data: LedgerMutationResultSchema.omit({ snapshot: true }),
  sync: PlannerPatchSchema.optional(),
});

type RpcResult = z.output<(typeof remoteOutputs)[RemoteMethod]>;

export function compactLedgerReceipt(method: RemoteMethod, result: RpcResult) {
  if (!result.ok || (method !== 'ledgerMutate' && method !== 'ledgerUndo')) return result;
  // The caller validated the public RPC schema. Keep the original acknowledgement
  // (including already_saved and the undo flag), even after subsequent writes.
  if (!('snapshot' in result.data && 'entryIds' in result.data)) throw Error('账本写入回执缺少快照');
  const { snapshot, ...data } = result.data;
  return { format, revision: snapshot.revision, month: snapshot.summary.month, data, sync: result.sync };
}

export function readReceipt(method: RemoteMethod, value: unknown, ledgerPath: string) {
  if ((method === 'ledgerMutate' || method === 'ledgerUndo') &&
      value && typeof value === 'object' && 'format' in value && value.format === format) {
    const receipt = storedReceipt.parse(value);
    const db = openDatabase(ledgerPath, true);
    try {
      const snapshot = redactEvidence(readLedgerSnapshotAtRevision(db, receipt.revision, receipt.month));
      return remoteOutputs[method].parse({ ok: true, data: { ...receipt.data, snapshot }, sync: receipt.sync });
    } finally { db.close(); }
  }
  // Includes pre-upgrade receipts containing the entire result, and saved failures.
  return remoteOutputs[method].parse(value);
}
