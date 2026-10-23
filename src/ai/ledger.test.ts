import { afterEach, describe, expect, it } from 'vitest';
import { LedgerIntentSchema } from '../shared/ledger-command';
import { DEFAULT_LEDGER_RULES, LedgerEntrySchema, type LedgerEntry } from '../shared/ledger';
import { LedgerService } from '../ledger/service';
import { ledgerChanges, ledgerQueryReply, ledgerSavedReply } from './ledger';

const now = '2026-01-21T19:00:00+08:00';
const before = '2026-01-21T18:00:00+08:00';
const services: LedgerService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function entry(extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return LedgerEntrySchema.parse({ id: 'original', kind: 'expense', date: '2026-01-21', month: '2026-01', title: '合成消费', category: '交通', amountCents: 10000, personalCents: 10000,
    cashflows: [{ accountId: 'alipay', deltaCents: -10000 }], version: 1, createdAt: before, updatedAt: before, ...extra });
}
function fixture(entries: LedgerEntry[]) {
  const service = new LedgerService(':memory:', { now: () => new Date(now) }); services.push(service);
  service.import({ format: 'ultimate-calendar-ledger', formatVersion: 1, entries, balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [] }, 'synthetic-import');
  return { service, snapshot: service.snapshot('2026-01') };
}
function mutation(value: unknown) {
  const intent = LedgerIntentSchema.parse(value);
  if (intent.kind !== 'mutate') throw Error('Expected mutation');
  return intent;
}

describe('ledger AI adaptation', () => {
  it('keeps omitted patch fields absent and preserves imported refund links, notes, amounts and provenance', () => {
    const refund = entry({ id: 'refund', kind: 'reimbursement', title: '合成报销', amountCents: 4000, personalCents: 0, incomeCents: 1000,
      cashflows: [{ accountId: 'wechat', deltaCents: 4000 }], adjustments: [{ targetEntryIds: ['original'], amountCents: 3000, note: '已确认部分报销' }], relatedEntryIds: ['original'],
      sourceId: 'legacy-source', sourceKey: 'legacy-record', originalText: '原始报销说明', note: '需要保留的更正说明', dateNote: '消费当天收到', occurredAt: before });
    const { service, snapshot } = fixture([entry(), refund]);
    const intent = mutation({ kind: 'mutate', changes: [{ type: 'updateEntry', id: 'refund', expectedVersion: 1, patch: { cashflows: [{ accountId: 'alipay', deltaCents: 4000 }] }, note: '实际到账支付宝' }] });
    const change = intent.changes[0]!;
    expect(change.type === 'updateEntry' && Object.keys(change.patch)).toEqual(['cashflows']);
    const changes = ledgerChanges(intent, snapshot, { operationId: 'patch-account', text: '这笔报销到账支付宝' }, new Set(['refund']), now);
    const saved = service.mutate({ operationId: 'save-patch', expectedRevision: snapshot.revision, changes, month: '2026-01' });
    expect(saved.snapshot.entries.find(value => value.id === 'refund')).toMatchObject({
      incomeCents: 1000, adjustments: refund.adjustments, relatedEntryIds: ['original'], sourceId: 'legacy-source', sourceKey: 'legacy-record', originalText: '原始报销说明', note: '需要保留的更正说明', dateNote: '消费当天收到', occurredAt: before,
      cashflows: [{ accountId: 'alipay', deltaCents: 4000 }], version: 2,
    });
    expect(saved.snapshot.summary.personalCents).toBe(7000);
    expect(saved.snapshot.summary.incomeCents).toBe(1000);
    expect(() => mutation({ kind: 'mutate', changes: [{ type: 'updateEntry', id: 'refund', expectedVersion: 2, patch: { sourceId: 'forged' }, note: '伪造' }] })).toThrow();
    const unknownSnapshot = mutation({ kind: 'mutate', changes: [{ type: 'updateEntry', id: 'refund', expectedVersion: 2, patch: { snapshotPositions: [{ snapshotId: 'forged', position: 'after' }] }, note: '不能编造快照编号' }] });
    expect(() => ledgerChanges(unknownSnapshot, saved.snapshot, { operationId: 'bad-snapshot', text: '这笔在余额核对之后' }, new Set(['refund']), now)).toThrow('未找到提案关联的余额快照');
  });

  it('covers already-recorded same-day flows for an explicit current balance and uses server time', () => {
    const { snapshot } = fixture([entry(), entry({ id: 'yesterday', date: '2026-01-20', occurredAt: '2026-01-20T10:00:00+08:00' })]);
    snapshot.entries.push(entry({ id: 'later', occurredAt: '2026-01-21T20:00:00+08:00' }));
    const intent = mutation({ kind: 'mutate', changes: [{ type: 'setBalance', timing: 'current', accountId: 'alipay', balanceCents: 50000, date: '2026-01-21', asOf: null, note: '用户给出当前余额' }] });
    const result = ledgerChanges(intent, snapshot, { operationId: 'balance-current', text: '支付宝当前余额500元' }, new Set(), now)[0]!;
    expect(result.type).toBe('setBalance');
    if (result.type !== 'setBalance') throw Error('Expected balance');
    expect(result.snapshot.asOf).toBe(now);
    expect(result.snapshot.coveredEntryIds).toEqual(['original', 'yesterday']);
    const invalid = mutation({ kind: 'mutate', changes: [{ type: 'setBalance', timing: 'current', accountId: 'alipay', balanceCents: 50000, date: '2026-01-20', asOf: null, note: '不能把历史写成当前' }] });
    expect(() => ledgerChanges(invalid, snapshot, { operationId: 'wrong-current', text: '余额' }, new Set(), now)).toThrow('当前余额必须按今天核对');
  });

  it('keeps unknown same-day ordering unresolved for historical snapshots', () => {
    const { snapshot } = fixture([entry(), entry({ id: 'yesterday', date: '2026-01-20' })]);
    const intent = mutation({ kind: 'mutate', changes: [{ type: 'setBalance', accountId: 'alipay', balanceCents: 40000, date: '2026-01-21', asOf: null, note: '当天某时余额，具体时间未知' }] });
    const result = ledgerChanges(intent, snapshot, { operationId: 'balance-old', text: '补录余额快照' }, new Set(), now)[0]!;
    if (result.type !== 'setBalance') throw Error('Expected balance');
    expect(result.snapshot.asOf).toBeNull();
    expect(result.snapshot.coveredEntryIds).toEqual(['yesterday']);
  });

  it('includes the same command’s newly recorded facts in an explicit current balance without double deduction', () => {
    const { service, snapshot } = fixture([]);
    const intent = mutation({ kind: 'mutate', changes: [
      { type: 'setBalance', timing: 'current', accountId: 'alipay', balanceCents: 10000, date: '2026-01-21', asOf: null, note: '当前余额已包含本次午饭' },
      { type: 'createEntry', key: 'new:0', values: { kind: 'expense', date: '2026-01-21', month: '2026-01', title: '午饭', category: '餐饮', amountCents: 2000, personalCents: 2000, cashflows: [{ accountId: 'alipay', deltaCents: -2000 }] } },
    ] });
    const changes = ledgerChanges(intent, snapshot, { operationId: 'lunch-and-balance', text: '支付宝现在余额100元，刚才午饭20元支付宝支付' }, new Set(), now);
    const saved = service.mutate({ operationId: 'save-batch', expectedRevision: snapshot.revision, changes, month: '2026-01' });
    const account = saved.snapshot.summary.accounts.find(value => value.id === 'alipay')!;
    expect(account.balanceCents).toBe(10000);
    expect(account.pendingEntryIds).toEqual([]);
    expect(saved.snapshot.summary.personalCents).toBe(2000);
    expect(saved.snapshot.balanceSnapshots[0]?.coveredEntryIds).toEqual([saved.snapshot.entries[0]?.id]);
  });

  it('reports snapshot-only affected accounts and distinguishes unknown balances from known family limits', () => {
    const { snapshot } = fixture([]);
    snapshot.rules.familyActualRemainingCents = 78900;
    const reply = ledgerSavedReply(snapshot, [], '已核对余额', ['alipay', 'family']);
    expect(reply).toContain('支付宝余额：账面余额 未知');
    expect(reply).toContain('当前真实剩余额度 ¥789.00');
    expect(reply).not.toContain('¥未知');
    const query = ledgerQueryReply({ month: '2026-01' }, { entries: [], summary: snapshot.summary, rules: snapshot.rules }, 'balances');
    expect(query).toContain('当前真实剩余额度 ¥789.00');
    expect(query).not.toContain('¥未知');
  });
});
