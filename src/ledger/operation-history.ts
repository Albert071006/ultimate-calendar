import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  LedgerAccountSchema, LedgerBalanceSnapshotSchema, LedgerDataSchema, LedgerEntrySchema,
  LedgerRulesSchema, LedgerSourceSchema, type LedgerData,
} from '../shared/ledger';

// A pair reuses a contiguous range of rows in the later revision. Only rows
// removed or changed by the operation need their original values on disk.
type Slice = [start: number, count: number];
const index = z.number().int().nonnegative();
const range = z.tuple([index, z.number().int().positive()]);
const segments = <T extends z.ZodType>(row: T) => z.array(z.union([range, row]));
const InverseSchema = z.strictObject({
  format: z.literal('ledger-inverse-v1'), auditLength: index,
  entries: segments(LedgerEntrySchema).optional(),
  balanceSnapshots: segments(LedgerBalanceSnapshotSchema).optional(),
  sources: segments(LedgerSourceSchema).optional(),
  accounts: segments(LedgerAccountSchema).nullable().optional(),
  rules: LedgerRulesSchema.optional(),
});

// Mutations replace individual row objects and append to the audit. Keeping
// references and array positions avoids serializing or cloning the old ledger.
export function captureLedgerBefore(data: LedgerData) {
  return {
    entries: data.entries.slice(), balanceSnapshots: data.balanceSnapshots.slice(),
    sources: data.sources.slice(), accounts: data.accounts?.slice(),
    rules: data.rules, auditLength: data.audit.length,
  };
}

function inverseRows<T extends { id: string }>(before: T[], after: T[]): (T | Slice)[] | undefined {
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  if (prefix === before.length && prefix === after.length) return undefined;
  const parts: (T | Slice)[] = prefix ? [[0, prefix]] : [];
  let moved: Map<string, number> | undefined;
  for (let i = prefix; i < before.length; i++) {
    const old = before[i]!;
    let position: number | undefined = i;
    if (after[i]?.id !== old.id) {
      moved ??= new Map(after.map((row, at) => [row.id, at]));
      position = moved.get(old.id);
    }
    if (position === undefined || (old !== after[position] && !isDeepStrictEqual(old, after[position]))) {
      parts.push(old);
    } else {
      const last = parts.at(-1);
      if (Array.isArray(last) && last[0] + last[1] === position) last[1]++;
      else parts.push([position, 1]);
    }
  }
  return parts;
}

export function encodeLedgerBefore(before: ReturnType<typeof captureLedgerBefore>, after: LedgerData): string {
  const delta: z.infer<typeof InverseSchema> = {
    format: 'ledger-inverse-v1', auditLength: before.auditLength,
    entries: inverseRows(before.entries, after.entries),
    balanceSnapshots: inverseRows(before.balanceSnapshots, after.balanceSnapshots),
    sources: inverseRows(before.sources, after.sources),
    rules: isDeepStrictEqual(before.rules, after.rules) ? undefined : before.rules,
  };
  if (before.accounts) delta.accounts = inverseRows(before.accounts, after.accounts ?? []);
  else if (after.accounts) delta.accounts = null;
  return JSON.stringify(delta);
}

function restoreRows<T extends { id: string }>(current: T[], parts?: (T | Slice)[]): T[] {
  if (parts === undefined) return current;
  const first = parts[0];
  if (parts.length === 1 && Array.isArray(first) && first[0] === 0 && first[1] <= current.length) {
    // The common append-only history can rewind in place on the private working
    // arrays, even when materializing a receipt many revisions in the past.
    current.length = first[1];
    return current;
  }
  const rows: T[] = [];
  for (const part of parts) {
    if (Array.isArray(part)) {
      const [start, count] = part;
      // No reversible collection in LedgerDataSchema can exceed 100,000 rows.
      if (start + count > current.length || rows.length + count > 100_000) throw Error('账本历史引用的记录范围无效');
      for (let i = start; i < start + count; i++) rows.push(current[i]!);
    } else {
      if (rows.length >= 100_000) throw Error('账本历史记录数量超限');
      rows.push(part);
    }
  }
  return rows;
}

export function readLedgerBefore(current: LedgerData, payload: string, revision: number, mode: 'history' | 'undo'): LedgerData {
  const raw: unknown = JSON.parse(payload);
  let result: LedgerData;
  if (raw && typeof raw === 'object' && 'format' in raw) {
    const delta = InverseSchema.parse(raw);
    if (delta.auditLength > current.audit.length) throw Error('账本历史缺少审计记录');
    if (mode === 'history') current.audit.length = delta.auditLength;
    result = {
      revision: revision - 1, rules: delta.rules ?? current.rules,
      entries: restoreRows(current.entries, delta.entries),
      balanceSnapshots: restoreRows(current.balanceSnapshots, delta.balanceSnapshots),
      sources: restoreRows(current.sources, delta.sources),
      audit: current.audit,
    };
    if (delta.accounts !== null && (current.accounts || delta.accounts))
      result.accounts = restoreRows(current.accounts ?? [], delta.accounts);
  } else {
    // Existing databases carry a complete pre-operation ledger in this column.
    result = LedgerDataSchema.parse(raw);
    if (result.revision !== revision - 1) throw Error('账本历史版本不连续');
  }
  if (mode === 'undo') {
    result.audit = current.audit;
    result.revision = current.revision;
  }
  return result;
}
