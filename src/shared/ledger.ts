import { z } from 'zod';

const id = z.string().trim().min(1).max(200);
const text = z.string().max(100_000);
export const LedgerCentsSchema = z.number().int().min(0).max(9_000_000_000_000);
const signedCents = z.number().int().min(-9_000_000_000_000).max(9_000_000_000_000);
export const LedgerMonthSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
export const LedgerDateSchema = z.string().refine(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, '日期必须真实存在');
const instant = z.string().refine(value => /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), '时间须包含时区');
export const LedgerAccountIdSchema = z.enum(['alipay', 'wechat', 'cmb', 'meal', 'bakery', 'family']);
export type LedgerAccountId = z.infer<typeof LedgerAccountIdSchema>;
export const LEDGER_ACCOUNTS: ReadonlyArray<{ id: LedgerAccountId; name: string; kind: 'cash' | 'stored' | 'family'; aliases: string[] }> = [
  { id: 'alipay', name: '支付宝余额', kind: 'cash', aliases: ['支付宝'] },
  { id: 'wechat', name: '微信余额', kind: 'cash', aliases: ['微信'] },
  { id: 'cmb', name: '银行卡', kind: 'cash', aliases: ['银行卡', '储蓄卡'] },
  { id: 'meal', name: '学校饭卡', kind: 'stored', aliases: ['饭卡', '校园卡'] },
  { id: 'bakery', name: '储值会员卡', kind: 'stored', aliases: ['储值卡', '会员卡'] },
  { id: 'family', name: '亲情卡', kind: 'family', aliases: ['亲情卡'] },
];
export const LedgerEntryKindSchema = z.enum(['expense', 'income', 'asset_sale', 'transfer', 'bonus', 'refund', 'reimbursement', 'aa_return', 'repayment', 'adjustment', 'loan_borrow', 'loan_lend', 'loan_repay', 'loan_collect']);
export type LedgerEntryKind = z.infer<typeof LedgerEntryKindSchema>;
export const LedgerCashflowSchema = z.strictObject({ accountId: LedgerAccountIdSchema.nullable(), deltaCents: signedCents });
export const LedgerAdjustmentSchema = z.strictObject({ targetEntryIds: z.array(id).min(1).max(100), amountCents: LedgerCentsSchema.positive(), note: text.default('') });
export const LedgerEntryDraftSchema = z.strictObject({
  id, kind: LedgerEntryKindSchema, date: LedgerDateSchema.nullable(), month: LedgerMonthSchema,
  dateNote: z.string().max(2000).default(''), occurredAt: instant.nullable().default(null),
  title: z.string().trim().min(1).max(500), category: z.string().trim().min(1).max(100),
  counterparty: z.string().trim().max(200).optional(),
  amountCents: LedgerCentsSchema, personalCents: LedgerCentsSchema.nullable(),
  incomeCents: LedgerCentsSchema.default(0), assetSaleCents: LedgerCentsSchema.default(0),
  cashflows: z.array(LedgerCashflowSchema).max(20), adjustments: z.array(LedgerAdjustmentSchema).max(100).default([]),
  relatedEntryIds: z.array(id).max(100).default([]), note: text.default(''), originalText: text.default(''),
  snapshotPositions: z.array(z.strictObject({ snapshotId: id, position: z.enum(['before', 'after']) })).max(100).default([]),
  sourceId: id.nullable().default(null), sourceKey: id.nullable().default(null), ruleKey: id.nullable().default(null),
});
export type LedgerEntryDraft = z.infer<typeof LedgerEntryDraftSchema>;
export const LedgerEntrySchema = LedgerEntryDraftSchema.extend({ version: z.number().int().positive(), createdAt: instant, updatedAt: instant, voided: z.boolean().default(false), sameDayBalanceOrder: z.enum(['after', 'ask']).default('after') });
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export const LedgerBalanceSnapshotDraftSchema = z.strictObject({
  id, accountId: LedgerAccountIdSchema.exclude(['family']), balanceCents: signedCents,
  date: LedgerDateSchema, asOf: instant.nullable().default(null), coveredEntryIds: z.array(id).max(100_000),
  note: text.default(''), sourceId: id.nullable().default(null),
});
export const LedgerBalanceSnapshotSchema = LedgerBalanceSnapshotDraftSchema.extend({ recordedAt: instant });
export type LedgerBalanceSnapshot = z.infer<typeof LedgerBalanceSnapshotSchema>;
export const LedgerRulesSchema = z.strictObject({
  sameDayNewEntryOrder: z.enum(['after', 'ask']).default('after'),
  monthlyAllowance: z.strictObject({ enabled: z.boolean(), amountCents: LedgerCentsSchema, accountId: LedgerAccountIdSchema.exclude(['family']).nullable(), startMonth: LedgerMonthSchema }),
  familyMonthlyLimitCents: LedgerCentsSchema, familyActualRemainingCents: LedgerCentsSchema.nullable(),
  familyRefreshDay: z.number().int().min(1).max(31).nullable(), notes: text,
});
export type LedgerRules = z.infer<typeof LedgerRulesSchema>;
export const DEFAULT_LEDGER_RULES: LedgerRules = { sameDayNewEntryOrder: 'after', monthlyAllowance: { enabled: false, amountCents: 0, accountId: null, startMonth: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7) }, familyMonthlyLimitCents: 0, familyActualRemainingCents: null, familyRefreshDay: null, notes: '' };
export const LedgerAuditSchema = z.strictObject({ id, operationId: id, at: instant, action: z.string().max(100), entryIds: z.array(id), note: text, beforeEntries: z.array(LedgerEntrySchema).default([]) });
export type LedgerAudit = z.infer<typeof LedgerAuditSchema>;
export const LedgerSourceSchema = z.strictObject({ id, label: z.string().max(500), importedAt: instant, content: text, checksum: z.string().max(200) });
export const LedgerDataSchema = z.strictObject({
  revision: z.number().int().nonnegative(), entries: z.array(LedgerEntrySchema).max(100_000),
  balanceSnapshots: z.array(LedgerBalanceSnapshotSchema).max(100_000), rules: LedgerRulesSchema,
  audit: z.array(LedgerAuditSchema).max(200_000), sources: z.array(LedgerSourceSchema).max(1000),
});
export type LedgerData = z.infer<typeof LedgerDataSchema>;
export const LedgerAccountSummarySchema = z.strictObject({
  id: LedgerAccountIdSchema, name: z.string(), kind: z.enum(['cash', 'stored', 'family']),
  balanceCents: signedCents.nullable(), snapshotDate: LedgerDateSchema.nullable(), snapshotAt: instant.nullable(),
  pendingEntryIds: z.array(id), periodChangeCents: signedCents, recordedUsageCents: LedgerCentsSchema,
});
export const LedgerSummarySchema = z.strictObject({
  month: LedgerMonthSchema, from: LedgerDateSchema.nullable(), to: LedgerDateSchema.nullable(),
  actualPaidCents: LedgerCentsSchema, personalCents: signedCents, incomeCents: LedgerCentsSchema, assetSaleCents: LedgerCentsSchema,
  familyUsageCents: LedgerCentsSchema, pendingPersonalCount: z.number().int().nonnegative(), pendingAccountCount: z.number().int().nonnegative(),
  uncertainDateCents: signedCents, excludedUncertainDateCents: signedCents.default(0), unallocatedAdjustmentCents: LedgerCentsSchema.default(0),
  cashBalanceCents: signedCents.nullable(), storedBalanceCents: signedCents.nullable(),
  accounts: z.array(LedgerAccountSummarySchema), categories: z.array(z.strictObject({ category: z.string(), cents: signedCents })),
  days: z.array(z.strictObject({ date: LedgerDateSchema, cents: signedCents })),
});
export type LedgerSummary = z.infer<typeof LedgerSummarySchema>;
export const LedgerSnapshotSchema = LedgerDataSchema.omit({ sources: true }).extend({ sources: z.array(LedgerSourceSchema.omit({ content: true })), summary: LedgerSummarySchema });
export type LedgerSnapshot = z.infer<typeof LedgerSnapshotSchema>;
export const LedgerChangeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('putEntry'), entry: LedgerEntryDraftSchema, expectedVersion: z.number().int().positive().nullable(), confirmDuplicate: z.boolean().default(false), note: text.default('') }),
  z.strictObject({ type: z.literal('voidEntry'), id, expectedVersion: z.number().int().positive(), note: text.default('') }),
  z.strictObject({ type: z.literal('setBalance'), snapshot: LedgerBalanceSnapshotDraftSchema }),
  z.strictObject({ type: z.literal('updateRules'), rules: LedgerRulesSchema, note: text.default('') }),
]);
export const LedgerMutationRequestSchema = z.strictObject({ operationId: id, expectedRevision: z.number().int().nonnegative(), changes: z.array(LedgerChangeSchema).min(1).max(200), month: LedgerMonthSchema.optional() });
export type LedgerMutationRequest = z.infer<typeof LedgerMutationRequestSchema>;
export const LedgerUndoRequestSchema = z.strictObject({ operationId: id, expectedRevision: z.number().int().nonnegative(), month: LedgerMonthSchema.optional() });
export type LedgerUndoRequest = z.infer<typeof LedgerUndoRequestSchema>;
export const LedgerMutationResultSchema = z.strictObject({ status: z.enum(['saved', 'already_saved']), operationId: id, snapshot: LedgerSnapshotSchema, entryIds: z.array(id), message: z.string(), undoAvailable: z.boolean() });
export type LedgerMutationResult = z.infer<typeof LedgerMutationResultSchema>;
export const LedgerImportPayloadSchema = z.strictObject({ format: z.literal('ultimate-calendar-ledger'), formatVersion: z.literal(1), entries: z.array(LedgerEntrySchema).max(100_000), balanceSnapshots: z.array(LedgerBalanceSnapshotSchema).max(100_000), rules: LedgerRulesSchema, audit: z.array(LedgerAuditSchema).default([]), sources: z.array(LedgerSourceSchema).default([]) });
export type LedgerImportPayload = z.infer<typeof LedgerImportPayloadSchema>;
export const LedgerQuerySchema = z.strictObject({ month: LedgerMonthSchema.optional(), from: LedgerDateSchema.optional(), to: LedgerDateSchema.optional(), accountId: LedgerAccountIdSchema.optional(), category: z.string().max(100).optional(), search: z.string().max(500).optional() });
export type LedgerQuery = z.infer<typeof LedgerQuerySchema>;
export function formatLedgerMoney(cents: number | null): string { return cents === null ? '未知' : (cents / 100).toFixed(2); }
export function ledgerToday(now = new Date()): string { return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10); }
export function ledgerAllowanceKey(month: string): string { return `rule:monthly-allowance:${LedgerMonthSchema.parse(month)}`; }
