import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LEDGER_RULES, LedgerEntryDraftSchema, LedgerEntrySchema, LedgerImportPayloadSchema, type LedgerEntryDraft } from '../shared/ledger';
import { LedgerService } from './service';
import { ledgerChanges, ledgerSavedReply } from '../ai/ledger';
import { LedgerIntentSchema } from '../shared/ledger-command';

const at = '2026-10-23T14:00:00Z';
const services: LedgerService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function fixture() {
  const service = new LedgerService(':memory:', { now: () => new Date(at) }); services.push(service);
  service.import(LedgerImportPayloadSchema.parse({ format: 'ultimate-calendar-ledger', formatVersion: 1, entries: [], rules: DEFAULT_LEDGER_RULES,
    balanceSnapshots: ['alipay','wechat'].map(accountId => ({ id: `baseline-${accountId}`, accountId, balanceCents: 10000, date: '2026-10-23', asOf: '2026-10-23T10:00:00Z', recordedAt: '2026-10-23T10:00:00Z', coveredEntryIds: [], note: '', sourceId: null })),
  }), 'seed');
  return service;
}
function draft(overrides: Partial<LedgerEntryDraft> = {}) {
  return LedgerEntryDraftSchema.parse({ id: 'vpn', kind: 'expense', title: 'VPN', category: '软件服务', amountCents: 1400, personalCents: 1400,
    date: '2026-10-23', month: '2026-10', cashflows: [{ accountId: 'alipay', deltaCents: -1400 }], ...overrides });
}
function put(service: LedgerService, entry = draft(), expectedVersion: number | null = null, operationId = 'create') {
  return service.mutate({ operationId, expectedRevision: service.snapshot().revision, changes: [{ type: 'putEntry', entry, expectedVersion, confirmDuplicate: false, note: '' }] });
}
function alipay(service: LedgerService) { return service.snapshot().summary.accounts.find(a => a.id === 'alipay')!; }

describe('new transaction balance order preference', () => {
  it('defaults same-day local entries to after and applies the cashflow only once across reads and retries', () => {
    const service = fixture(); const saved = put(service);
    expect(alipay(service)).toMatchObject({ balanceCents: 8600, pendingEntryIds: [] });
    expect(ledgerSavedReply(saved.snapshot, saved.entryIds, saved.message)).not.toContain('之前还是之后');
    expect(saved.snapshot.entries[0]!.occurredAt).toBeNull();
    expect(put(service).status).toBe('already_saved');
    expect(alipay(service).balanceCents).toBe(8600);
  });
  it('uses original creation time when adding an account, then respects a newer covering balance', () => {
    const service = fixture(); put(service, draft({ cashflows: [{ accountId: null, deltaCents: -1400 }] }));
    expect(alipay(service).balanceCents).toBe(10000);
    put(service, draft(), 1, 'add-account');
    expect(alipay(service)).toMatchObject({ balanceCents: 8600, pendingEntryIds: [] });
    service.mutate({ operationId: 'new-balance', expectedRevision: service.snapshot().revision, changes: [{ type: 'setBalance', snapshot: {
      id: 'latest', accountId: 'alipay', balanceCents: 8000, date: '2026-10-23', asOf: at, coveredEntryIds: ['vpn'], note: '', sourceId: null,
    } }] });
    put(service, draft({ title: 'VPN续费' }), 2, 'title-correction');
    expect(alipay(service)).toMatchObject({ balanceCents: 8000, pendingEntryIds: [] });
  });
  it.each([
    { snapshotPositions: [{ snapshotId: 'baseline-alipay', position: 'before' as const }] },
    { occurredAt: '2026-10-23T09:00:00Z' },
  ])('respects explicit prior position or actual earlier time: %j', overrides => {
    const service = fixture(); put(service, draft(overrides));
    expect(alipay(service)).toMatchObject({ balanceCents: 10000, pendingEntryIds: [] });
  });
  it.each([
    { date: '2026-10-22' }, { date: null, dateNote: '十月，具体日期未知' }, { sourceId: 'legacy-import' }, { sourceKey: 'old-payment' }, { ruleKey: 'recurring-allowance' },
  ])('does not turn historical, imported, uncertain or rule entries into new post-snapshot payments: %j', overrides => {
    const service = fixture(); put(service, draft(overrides));
    expect(alipay(service)).toMatchObject({ balanceCents: 10000, pendingEntryIds: ['vpn'] });
  });
  it('does not use updatedAt when an older same-day entry is corrected', () => {
    const service = fixture(); const payload = service.exportJson();
    payload.entries.push(LedgerEntrySchema.parse({ ...draft({ cashflows: [{ accountId: null, deltaCents: -1400 }] }), version: 1,
      createdAt: '2026-10-23T09:00:00Z', updatedAt: at, voided: false }));
    const other = new LedgerService(':memory:', { now: () => new Date(at) }); services.push(other); other.import(payload, 'older-entry');
    put(other, draft(), 1, 'account-correction');
    expect(alipay(other)).toMatchObject({ balanceCents: 10000, pendingEntryIds: ['vpn'] });
  });
  it('applies transfers independently to each account without creating expense', () => {
    const service = fixture(); put(service, draft({ kind: 'transfer', personalCents: 0, cashflows: [{ accountId: 'alipay', deltaCents: -1400 }, { accountId: 'wechat', deltaCents: 1400 }] }));
    expect(alipay(service).balanceCents).toBe(8600);
    expect(service.snapshot().summary.accounts.find(a => a.id === 'wechat')!.balanceCents).toBe(11400);
    expect(service.snapshot().summary.personalCents).toBe(0);
  });
  it('captures the default when an entry is created, so later preference changes do not alter previous balances', () => {
    const service = fixture();
    const setOrder = (order: 'after'|'ask') => service.mutate({ operationId: `order-${order}`, expectedRevision: service.snapshot().revision,
      changes: [{ type: 'updateRules', rules: { ...service.snapshot().rules, sameDayNewEntryOrder: order }, note: '用户修改默认先后' }] });
    setOrder('ask'); put(service);
    expect(alipay(service).pendingEntryIds).toEqual(['vpn']);
    const intent = LedgerIntentSchema.parse({ kind: 'mutate', changes: [{ type: 'updateRules', patch: { familyMonthlyLimitCents: 210000 }, note: '只改亲情卡额度' }] });
    if (intent.kind !== 'mutate') throw Error('Expected mutation');
    const change = ledgerChanges(intent, service.snapshot(), { operationId: 'other-rule', text: '亲情卡月额度改2100' }, new Set(), at)[0]!;
    expect(change.type === 'updateRules' && change.rules.sameDayNewEntryOrder).toBe('ask');
    setOrder('after');
    expect(alipay(service)).toMatchObject({ balanceCents: 10000, pendingEntryIds: ['vpn'] });
    put(service, draft({ id: 'new-vpn', title: '新VPN' }), null, 'after-rule');
    expect(alipay(service)).toMatchObject({ balanceCents: 8600, pendingEntryIds: ['vpn'] });
    service.mutate({ operationId: 'ask-again', expectedRevision: service.snapshot().revision,
      changes: [{ type: 'updateRules', rules: { ...service.snapshot().rules, sameDayNewEntryOrder: 'ask' }, note: '以后先核对' }] });
    expect(alipay(service)).toMatchObject({ balanceCents: 8600, pendingEntryIds: ['vpn'] });
    put(service, draft({ id: 'new-vpn', title: 'VPN更正标题' }), 1, 'correct-title');
    expect(alipay(service).balanceCents).toBe(8600);
  });
  it('adopts the requested after default for pre-update local pending records without changing transaction facts', () => {
    const service = fixture(); const payload = service.exportJson();
    const legacy = { ...draft(), version: 1, createdAt: at, updatedAt: at, voided: false };
    payload.entries.push(LedgerEntrySchema.parse(legacy));
    const restored = new LedgerService(':memory:', { now: () => new Date(at) }); services.push(restored); restored.import(payload, 'old-version');
    expect(alipay(restored)).toMatchObject({ balanceCents: 8600, pendingEntryIds: [] });
    expect(restored.snapshot().entries[0]).toMatchObject(legacy);
  });
});
