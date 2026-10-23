import { createHash } from 'node:crypto';
import { DEFAULT_LEDGER_RULES, LedgerImportPayloadSchema, type LedgerImportPayload, type LedgerEntryKind } from '../shared/ledger';

/** Source material is data only; even instruction blocks are archived, never executed. */
export interface LegacySourceSnapshot {
  pageId: string;
  sequence: number;
  updatedAt: string;
  title: string;
  blocks: { id: string; kind: string; hash: string; markdown: string }[];
}

export type LegacyReceiptKind = 'income' | 'asset-sale' | 'refund' | 'reimbursement' | 'advance-return' | 'stored-value-return';
export interface LegacyReceiptPlan {
  kind: LegacyReceiptKind;
  incomeCents: number;
  assetSaleCents: number;
  linkedSourceIds: string[];
  recurringKey?: string;
  note?: string;
}
export interface LegacyAdjustment {
  id: string;
  receiptSourceId: string;
  targetSourceIds: string[];
  deltaCents: number;
  month: string;
  date: string | null;
  category: string;
  note: string;
}
export interface LegacyBalanceSnapshot {
  id: string;
  accountId: string;
  amountCents: number;
  date: string;
  kind: 'user-snapshot' | 'reconciled-balance';
  coveredSourceIds: string[];
  evidenceBlockIds: string[];
  note: string;
}
export interface LegacyImportPolicy {
  sourcePageId: string;
  sourceSequence: number;
  sourceFingerprint: string;
  accounts: Record<string, string | null>;
  familyAccountId: string;
  receipts: Record<string, LegacyReceiptPlan>;
  adjustments: LegacyAdjustment[];
  snapshots: LegacyBalanceSnapshot[];
  expected: {
    payments: number;
    receipts: number;
    transfers: number;
    bonuses: number;
    paymentCents: number;
    receiptCents: number;
    rawPersonalCents: number;
    personalCents: number;
    incomeCents: number;
    assetSaleCents: number;
    familyUsageCents: number;
    latestBalances: Record<string, number>;
  };
}
export interface LegacyRecord {
  sourceId: string;
  sourceBlockId: string;
  rawRow: string;
  kind: 'payment' | 'receipt' | 'transfer' | 'bonus';
  receiptKind?: LegacyReceiptKind;
  month: string;
  date: string | null;
  dateLabel: string;
  title: string;
  category: string;
  amountCents: number;
  personalCents: number | null;
  incomeCents: number;
  assetSaleCents: number;
  accountId: string | null;
  accountLabel: string;
  destinationAccountId?: string;
  linkedSourceIds: string[];
  recurringKey?: string;
  note: string;
}
export interface ParsedLegacyLedger {
  source: LegacySourceSnapshot;
  fingerprint: string;
  records: LegacyRecord[];
  adjustments: LegacyAdjustment[];
  snapshots: LegacyBalanceSnapshot[];
  totals: LegacyImportPolicy['expected'];
}

export function legacySourceFingerprint(source: LegacySourceSnapshot): string {
  return createHash('sha256').update(JSON.stringify({ pageId: source.pageId, sequence: source.sequence, blocks: source.blocks })).digest('hex');
}

/** Parse decimal strings without binary floating point or permissive numeric coercion. */
export function legacyMoney(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw Error(`旧账金额无效：${value}`);
  const result = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw Error('旧账金额超出范围');
  return result;
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}
function rows(source: LegacySourceSnapshot): { headers: string[]; values: string[]; raw: string; blockId: string }[] {
  return source.blocks.flatMap(block => {
    const lines = block.markdown.split(/\r?\n/).filter(line => line.trim().startsWith('|'));
    if (!lines.length) return [];
    const headers = cells(lines[0]!);
    if (headers[0] !== '编号') return [];
    if (!lines[1] || !cells(lines[1]).every(cell => /^:?-+:?$/.test(cell))) throw Error('旧账表格缺少表头分隔');
    return lines.slice(2).map(raw => {
      const values = cells(raw);
      if (values.length !== headers.length) throw Error(`旧账表格列数错误：${values[0] ?? block.id}`);
      return { headers, values, raw, blockId: block.id };
    });
  });
}
function dateParts(sourceId: string, label: string): { month: string; date: string | null } {
  const id = /^(\d{4})(\d{2})-\d+$/.exec(sourceId);
  if (!id) throw Error(`旧账编号无效：${sourceId}`);
  const month = `${id[1]}-${id[2]}`;
  const day = /^(\d{1,2})月(\d{1,2})日$/.exec(label);
  if (day) {
    const date = `${id[1]}-${day[1]!.padStart(2, '0')}-${day[2]!.padStart(2, '0')}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date.slice(0, 7) !== month) throw Error(`旧账日期无效：${label}`);
    return { month, date };
  }
  if (!new RegExp(`^0?${Number(id[2])}月\\s*日期待确认$`).test(label)) throw Error(`旧账日期需要人工核对：${label}`);
  return { month, date: null };
}
function cents(value: number, field: string, signed = false) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) throw Error(`迁移核对金额无效：${field}`);
}
function account(label: string, policy: LegacyImportPolicy): string | null {
  if (!Object.hasOwn(policy.accounts, label)) throw Error(`旧账账户未核对：${label}`);
  return policy.accounts[label]!;
}
function assertEqual(actual: number, expected: number, label: string) {
  if (actual !== expected) throw Error(`迁移核对失败：${label}，实际 ${actual}，预期 ${expected}`);
}

/**
 * The policy is an explicitly audited private manifest, not an AI inference.
 * Binding it to the whole source hash makes stale notes/corrections fail closed.
 */
export function parseLegacyLedger(source: LegacySourceSnapshot, policy: LegacyImportPolicy): ParsedLegacyLedger {
  const fingerprint = legacySourceFingerprint(source);
  if (source.pageId !== policy.sourcePageId || source.sequence !== policy.sourceSequence || fingerprint !== policy.sourceFingerprint) throw Error('旧账来源已变化，请重新核对迁移方案');
  if (new Set(source.blocks.map(block => block.id)).size !== source.blocks.length) throw Error('旧账源块编号重复');
  const records: LegacyRecord[] = rows(source).map(row => {
    const get = (key: string): string => {
      const index = row.headers.indexOf(key);
      if (index < 0) throw Error(`旧账缺少列：${key}`);
      return row.values[index]!;
    };
    const sourceId = get('编号');
    const dateLabel = get('日期');
    const base = { sourceId, sourceBlockId: row.blockId, rawRow: row.raw, ...dateParts(sourceId, dateLabel), dateLabel, title: get('项目') };
    if (row.headers.includes('支付金额')) {
      const rawPersonal = get('个人开销');
      const personalCents = /^[—–-]$/.test(rawPersonal) ? null : legacyMoney(rawPersonal);
      const amountCents = legacyMoney(get('支付金额'));
      if (personalCents !== null && personalCents > amountCents) throw Error(`个人开销超出付款：${sourceId}`);
      const accountLabel = get('支付账户');
      return { ...base, kind: 'payment', category: get('分类'), amountCents, personalCents, incomeCents: 0, assetSaleCents: 0,
        accountId: account(accountLabel, policy), accountLabel, linkedSourceIds: [], note: get('备注') };
    }
    if (row.headers.includes('到账账户')) {
      const plan = policy.receipts[sourceId];
      if (!plan) throw Error(`收款性质尚未核对：${sourceId}`);
      const amountCents = legacyMoney(get('金额'));
      cents(plan.incomeCents, sourceId); cents(plan.assetSaleCents, sourceId);
      if (plan.incomeCents + plan.assetSaleCents > amountCents) throw Error(`收入分类超过实际到账：${sourceId}`);
      const accountLabel = get('到账账户');
      return { ...base, kind: 'receipt', receiptKind: plan.kind, category: get('性质'), amountCents, personalCents: 0,
        incomeCents: plan.incomeCents, assetSaleCents: plan.assetSaleCents, accountId: account(accountLabel, policy), accountLabel,
        linkedSourceIds: [...plan.linkedSourceIds], ...(plan.recurringKey ? { recurringKey: plan.recurringKey } : {}),
        note: [get('关联付款'), plan.note].filter(Boolean).join('；') };
    }
    if (row.headers.includes('转入账户')) {
      const nature = get('性质');
      if (nature !== '账户转账' && nature !== '商家赠送额度') throw Error(`转账性质尚未核对：${sourceId}`);
      const destinationAccountId = account(get('转入账户'), policy);
      if (!destinationAccountId) throw Error(`转入账户尚未确认：${sourceId}`);
      const accountLabel = get('来源');
      return { ...base, kind: nature === '账户转账' ? 'transfer' : 'bonus', category: nature,
        amountCents: legacyMoney(get('金额')), personalCents: 0, incomeCents: 0, assetSaleCents: 0,
        accountId: nature === '账户转账' ? account(accountLabel, policy) : null, accountLabel, destinationAccountId,
        linkedSourceIds: [], note: get('备注') };
    }
    throw Error(`无法识别旧账表格：${row.blockId}`);
  });
  const byId = new Map(records.map(record => [record.sourceId, record]));
  if (byId.size !== records.length) throw Error('旧账交易编号重复');
  if (new Set(records.flatMap(record => record.recurringKey ? [record.recurringKey] : [])).size !== records.filter(record => record.recurringKey).length) throw Error('固定收入规则月份重复');
  for (const [id, plan] of Object.entries(policy.receipts)) {
    if (byId.get(id)?.kind !== 'receipt') throw Error(`迁移方案包含不存在的收款：${id}`);
    for (const linked of plan.linkedSourceIds) if (byId.get(linked)?.kind !== 'payment') throw Error(`收款关联的原付款不存在：${linked}`);
  }
  const seenAdjustments = new Set<string>();
  for (const adjustment of policy.adjustments) {
    cents(adjustment.deltaCents, adjustment.id, true);
    if (adjustment.deltaCents >= 0 || !adjustment.targetSourceIds.length || seenAdjustments.has(adjustment.receiptSourceId)) throw Error('个人开销冲减必须为单次负数调整');
    seenAdjustments.add(adjustment.receiptSourceId);
    const receipt = byId.get(adjustment.receiptSourceId);
    if (!receipt || receipt.kind !== 'receipt' || -adjustment.deltaCents > receipt.amountCents - receipt.incomeCents - receipt.assetSaleCents) throw Error('冲减金额超出关联返款');
    const targets = adjustment.targetSourceIds.map(id => byId.get(id));
    if (targets.some(target => !target || target.kind !== 'payment' || target.month !== adjustment.month || target.date !== adjustment.date || target.category !== adjustment.category)) throw Error('组级调整的消费日期或分类不一致，请单独核对');
    if (new Set(adjustment.targetSourceIds).size !== adjustment.targetSourceIds.length || adjustment.targetSourceIds.some(id => !receipt.linkedSourceIds.includes(id))) throw Error('组级冲减缺少对应收款关联');
    const personal = targets.reduce((sum, target) => sum + (target?.personalCents ?? 0), 0);
    if (personal + adjustment.deltaCents < 0) throw Error('组级冲减超过个人开销');
  }
  const sourceBlocks = new Set(source.blocks.map(block => block.id));
  const latestBalances: Record<string, number> = {};
  for (const snapshot of policy.snapshots) {
    cents(snapshot.amountCents, snapshot.id);
    if (!snapshot.evidenceBlockIds.length || snapshot.evidenceBlockIds.some(id => !sourceBlocks.has(id))) throw Error('余额快照缺少原始依据');
    if (snapshot.coveredSourceIds.some(id => !byId.has(id)) || new Set(snapshot.coveredSourceIds).size !== snapshot.coveredSourceIds.length) throw Error('余额快照覆盖的交易编号无效');
    if (snapshot.kind === 'reconciled-balance') {
      if (Object.hasOwn(latestBalances, snapshot.accountId)) throw Error('账户有重复的迁移基准余额');
      latestBalances[snapshot.accountId] = snapshot.amountCents;
    }
  }
  const sum = (select: (record: LegacyRecord) => number) => records.reduce((total, record) => total + select(record), 0);
  const rawPersonalCents = sum(record => record.personalCents ?? 0);
  const totals: LegacyImportPolicy['expected'] = {
    payments: records.filter(record => record.kind === 'payment').length,
    receipts: records.filter(record => record.kind === 'receipt').length,
    transfers: records.filter(record => record.kind === 'transfer').length,
    bonuses: records.filter(record => record.kind === 'bonus').length,
    paymentCents: sum(record => record.kind === 'payment' ? record.amountCents : 0),
    receiptCents: sum(record => record.kind === 'receipt' ? record.amountCents : 0), rawPersonalCents,
    personalCents: rawPersonalCents + policy.adjustments.reduce((total, adjustment) => total + adjustment.deltaCents, 0),
    incomeCents: sum(record => record.incomeCents), assetSaleCents: sum(record => record.assetSaleCents),
    familyUsageCents: sum(record => (record.kind === 'payment' || record.kind === 'transfer') && record.accountId === policy.familyAccountId ? record.amountCents : 0),
    latestBalances,
  };
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
    if (key === 'latestBalances') continue;
    assertEqual(totals[key], policy.expected[key], key);
  }
  if (Object.keys(latestBalances).sort().join('|') !== Object.keys(policy.expected.latestBalances).sort().join('|')) throw Error('迁移核对账户不完整');
  for (const [key, value] of Object.entries(latestBalances)) assertEqual(value, policy.expected.latestBalances[key]!, `余额 ${key}`);
  return { source: structuredClone(source), fingerprint, records, adjustments: structuredClone(policy.adjustments), snapshots: structuredClone(policy.snapshots), totals };
}

/** Build an import-only payload; this function does not open or mutate a database. */
export function buildLegacyImportPayload(source: LegacySourceSnapshot, policy: LegacyImportPolicy, importedAt: string): LedgerImportPayload {
  const parsed = parseLegacyLedger(source, policy);
  const id = (sourceId: string) => `legacy:${source.pageId}:${sourceId}`;
  const sourceId = `legacy:${source.pageId}:v${source.sequence}`;
  const receiptKinds: Record<LegacyReceiptKind, LedgerEntryKind> = {
    income: 'income', 'asset-sale': 'asset_sale', refund: 'refund', reimbursement: 'reimbursement',
    'advance-return': 'aa_return', 'stored-value-return': 'aa_return',
  };
  return LedgerImportPayloadSchema.parse({
    format: 'ultimate-calendar-ledger', formatVersion: 1,
    entries: parsed.records.map(record => {
      const kind: LedgerEntryKind = record.kind === 'payment' ? (record.category === '还款' ? 'repayment' : 'expense')
        : record.kind === 'receipt' ? receiptKinds[record.receiptKind!] : record.kind;
      const cashflows = record.kind === 'transfer'
        ? [{ accountId: record.accountId, deltaCents: -record.amountCents }, { accountId: record.destinationAccountId, deltaCents: record.amountCents }]
        : [{ accountId: record.kind === 'bonus' ? record.destinationAccountId : record.accountId, deltaCents: record.kind === 'payment' ? -record.amountCents : record.amountCents }];
      const related = new Set([...record.linkedSourceIds, ...parsed.records.filter(other => other.linkedSourceIds.includes(record.sourceId)).map(other => other.sourceId)]);
      return {
        id: id(record.sourceId), kind, month: record.month, date: record.date, occurredAt: null,
        dateNote: record.date === null ? `${record.dateLabel}；${record.note}` : '',
        title: record.title, category: record.category, amountCents: record.amountCents, personalCents: record.personalCents,
        incomeCents: record.incomeCents, assetSaleCents: record.assetSaleCents, cashflows,
        adjustments: parsed.adjustments.filter(adjustment => adjustment.receiptSourceId === record.sourceId).map(adjustment => ({
          targetEntryIds: adjustment.targetSourceIds.map(id), amountCents: -adjustment.deltaCents, note: adjustment.note,
        })),
        relatedEntryIds: [...related].map(id), note: record.note, originalText: record.rawRow,
        sourceId, sourceKey: `${source.pageId}:${record.sourceId}`, ruleKey: record.recurringKey ?? null,
        version: 1, createdAt: importedAt, updatedAt: importedAt, voided: false,
      };
    }),
    balanceSnapshots: parsed.snapshots.map(snapshot => ({
      id: id(`snapshot:${snapshot.id}`), accountId: snapshot.accountId, balanceCents: snapshot.amountCents,
      date: snapshot.date, asOf: null, coveredEntryIds: snapshot.coveredSourceIds.map(id),
      note: snapshot.note, sourceId, recordedAt: importedAt,
    })),
    rules: DEFAULT_LEDGER_RULES, audit: [],
    sources: [{ id: sourceId, label: `${source.title}（旧账迁入，版本 ${source.sequence}）`, importedAt,
      content: JSON.stringify({ source: parsed.source, reconciliation: policy }), checksum: parsed.fingerprint }],
  });
}
