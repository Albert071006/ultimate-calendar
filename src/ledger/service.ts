import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../storage/database';
import {
  DEFAULT_LEDGER_RULES, LEDGER_ACCOUNTS, LedgerDataSchema, LedgerImportPayloadSchema, LedgerMutationRequestSchema,
  LedgerMonthSchema, LedgerQuerySchema, LedgerUndoRequestSchema, ledgerAllowanceKey, ledgerToday,
  type LedgerData, type LedgerEntry, type LedgerImportPayload, type LedgerMutationRequest, type LedgerMutationResult,
  type LedgerQuery, type LedgerSnapshot, type LedgerUndoRequest,
} from '../shared/ledger';
import { ledgerEntryMatches, summarizeLedger } from './summary';
import { ledgerReceivable } from './receivable';

export class LedgerError extends Error {
  constructor(readonly code: 'VALIDATION' | 'CONFLICT' | 'DUPLICATE' | 'STORAGE', message: string, readonly details?: unknown) { super(message); this.name = 'LedgerError'; }
}
/** A new mutation failed validation and its entire transaction was rolled back. */
export class LedgerValidationRejection extends LedgerError {
  constructor(readonly operationId: string, message: string) { super('VALIDATION', message); this.name = 'LedgerValidationRejection'; }
}
function emptyLedger(): LedgerData { return { revision: 0, entries: [], balanceSnapshots: [], rules: structuredClone(DEFAULT_LEDGER_RULES), audit: [], sources: [] }; }
export function initializeLedgerDatabase(db: DatabaseSync): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ledger_state','ledger_operations')").all();
  if (tables.length === 1) throw new LedgerError('STORAGE', '账本数据表不完整，请恢复完整备份，未新建空账本');
  if (tables.length === 2) { readLedgerDatabase(db); return; }
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, before_payload TEXT NOT NULL, entry_ids TEXT NOT NULL, revision INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0)`);
  db.prepare('INSERT OR IGNORE INTO ledger_state(id,payload) VALUES(1,?)').run(JSON.stringify(emptyLedger()));
}
/** Read-only backup inspection; old app backups legitimately have no ledger tables. */
export function readLedgerDatabase(db: DatabaseSync): LedgerData {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ledger_state','ledger_operations')").all();
  if (tables.length === 0) return emptyLedger();
  if (tables.length !== 2) throw new LedgerError('STORAGE', '备份的账本数据表不完整，未将其视为空账本');
  const rows = db.prepare('SELECT id,payload FROM ledger_state').all();
  if (rows.length !== 1 || rows[0]!['id'] !== 1) throw new LedgerError('STORAGE', '账本主记录缺失或重复，请保留文件并恢复完整备份');
  const data = LedgerDataSchema.parse(JSON.parse(String(rows[0]!['payload']))); validateLedgerData(data); return data;
}
/** Call inside the planner restore transaction. No cached state survives replacement. */
export function replaceLedgerDatabase(db: DatabaseSync, input: LedgerData): void {
  const data = LedgerDataSchema.parse(input); validateLedgerData(data);
  initializeLedgerDatabase(db);
  db.prepare('UPDATE ledger_state SET payload=? WHERE id=1').run(JSON.stringify(data));
  db.exec('DELETE FROM ledger_operations');
}
const fail = (message: string): never => { throw new LedgerError('VALIDATION', message); };
const noValue = (value: number | null) => value === 0 || value === null;

/** Enforce money semantics at the persistence boundary, regardless of UI/model origin. */
export function validateLedgerData(data: LedgerData): void {
  const seenIds = new Set<string>(); const sourceKeys = new Set<string>(); const ruleKeys = new Set<string>();
  for (const entry of data.entries) {
    if (seenIds.has(entry.id)) fail('账目编号重复，尚未保存'); seenIds.add(entry.id);
    if (entry.sourceKey) { if (sourceKeys.has(entry.sourceKey)) fail('来源编号重复，尚未保存'); sourceKeys.add(entry.sourceKey); }
    if (entry.ruleKey) { if (ruleKeys.has(entry.ruleKey)) fail('该月份的固定收入已存在，不能重复生成'); ruleKeys.add(entry.ruleKey); }
    if (entry.date && entry.date.slice(0, 7) !== entry.month) fail('交易日期与月份不一致');
    if (!entry.date && !entry.dateNote.trim()) fail('日期不确定时请保留日期说明');
    if (entry.occurredAt && ledgerToday(new Date(entry.occurredAt)) !== entry.date) fail('交易时刻与北京时间日期不一致');
    if (entry.personalCents !== null && entry.personalCents > entry.amountCents) fail('个人开销不能超过实际付款；请拆分或核对金额');
    const outgoing = entry.cashflows.reduce((sum, flow) => sum + Math.max(0, -flow.deltaCents), 0);
    const incoming = entry.cashflows.reduce((sum, flow) => sum + Math.max(0, flow.deltaCents), 0);
    if (entry.kind === 'expense' || entry.kind === 'repayment') {
      if (incoming !== 0 || outgoing !== entry.amountCents) fail('付款账户的支出必须与实际付款金额一致');
      if (entry.incomeCents || entry.assetSaleCents) fail('支出不能同时记为收入或资产变现');
      if (entry.kind === 'repayment' && !noValue(entry.personalCents)) fail('还款不能重复计入消费，原消费不明时只记资金支出');
    } else if (entry.kind === 'transfer') {
      if (outgoing !== entry.amountCents || incoming !== entry.amountCents || entry.cashflows.length < 2) fail('转账必须同时记录等额转出与转入账户');
      if (!noValue(entry.personalCents) || entry.incomeCents || entry.assetSaleCents) fail('账户转账不计个人开销或收入');
      if (new Set(entry.cashflows.map(flow => flow.accountId)).size < 2) fail('转出和转入不能是同一账户');
    } else if (entry.kind === 'bonus') {
      if (outgoing || incoming !== entry.amountCents || entry.cashflows.some(flow => !['meal', 'bakery'].includes(flow.accountId ?? ''))) fail('赠送额度只能增加储值卡余额');
      if (!noValue(entry.personalCents) || entry.incomeCents || entry.assetSaleCents) fail('会员赠送额度不计现金收入或消费');
    } else if (entry.kind !== 'adjustment') {
      if (outgoing || incoming !== entry.amountCents) fail('收款账户的增加必须与收款金额一致');
      if (!noValue(entry.personalCents)) fail('收款的个人开销应为零，退款请关联原消费');
      if (entry.incomeCents + entry.assetSaleCents > entry.amountCents) fail('收入或资产变现金额不能超过实际收款');
      if (entry.kind === 'income' && (entry.incomeCents !== entry.amountCents || entry.assetSaleCents)) fail('普通收入必须与该笔实际收入一致');
      if (entry.kind === 'asset_sale' && (entry.assetSaleCents !== entry.amountCents || entry.incomeCents)) fail('资产变现须与实际收款一致，不能混作普通收入');
      if (['refund', 'aa_return'].includes(entry.kind) && (entry.incomeCents || entry.assetSaleCents)) fail('退款、AA 返款不属于普通收入或资产变现');
    } else if (entry.cashflows.length || entry.amountCents || !noValue(entry.personalCents) || entry.incomeCents || entry.assetSaleCents) fail('纯开销调整不产生新的资金收付');
    if (entry.adjustments.length && !['refund', 'reimbursement', 'adjustment'].includes(entry.kind)) fail('只有退款、报销或明确更正才能冲减原消费');
    if (new Set(entry.relatedEntryIds).size !== entry.relatedEntryIds.length || entry.relatedEntryIds.includes(entry.id)) fail('账目关联编号有重复或指向自身');
  }
  const byId = new Map(data.entries.map(entry => [entry.id, entry]));
  const groups = new Map<string, { ids: Set<string>; amount: number; capacity: number }>();
  for (const entry of data.entries.filter(item => !item.voided)) {
    for (const relatedId of entry.relatedEntryIds) if (!byId.has(relatedId)) fail('关联原记录不存在，请先补充原记录或保留为未关联说明');
    for (const adjustment of entry.adjustments) {
      const ids = new Set(adjustment.targetEntryIds);
      if (ids.size !== adjustment.targetEntryIds.length || ids.has(entry.id)) fail('退款关联记录不能重复或指向自己');
      const targets = [...ids].map(targetId => byId.get(targetId));
      if (targets.some(target => !target || target.voided || target.kind !== 'expense' || target.personalCents === null)) fail('冲减必须关联已有且未移除、个人开销已明确的消费；原消费未入账时只记资金回流');
      const originals = targets as LedgerEntry[];
      if (new Set(originals.map(target => target.month)).size > 1 || new Set(originals.map(target => target.category)).size > 1) fail('跨月份或跨分类的退款请分别确认冲减金额，不能擅自分摊');
      const key = [...ids].sort().join('|');
      for (const [oldKey, group] of groups) if (oldKey !== key && [...ids].some(targetId => group.ids.has(targetId))) fail('该退款与已有组级冲减重叠，请先明确每笔消费的冲减分配，避免重复冲减');
      const group = groups.get(key) ?? { ids, amount: 0, capacity: originals.reduce((sum, target) => sum + target.personalCents!, 0) };
      group.amount += adjustment.amountCents; if (group.amount > group.capacity) fail('累计退款或报销超过原个人开销，请确认超出部分的性质，不能再次冲减'); groups.set(key, group);
    }
    if (entry.kind !== 'adjustment' && entry.adjustments.reduce((sum, adjustment) => sum + adjustment.amountCents, 0) + entry.incomeCents > entry.amountCents) fail('冲减与额外收入合计超过实际收款');
  }
  const snapshotIds = new Set<string>();
  for (const snapshot of data.balanceSnapshots) {
    if (snapshotIds.has(snapshot.id)) fail('余额快照编号重复'); snapshotIds.add(snapshot.id);
    if (snapshot.asOf && ledgerToday(new Date(snapshot.asOf)) !== snapshot.date) fail('余额快照的日期和时刻不一致');
    if (new Set(snapshot.coveredEntryIds).size !== snapshot.coveredEntryIds.length) fail('余额快照覆盖编号重复');
    if (snapshot.coveredEntryIds.some(entryId => !byId.has(entryId))) fail('余额快照引用了不存在的交易');
  }
  const snapshotsById = new Map(data.balanceSnapshots.map(snapshot => [snapshot.id, snapshot]));
  for (const entry of data.entries) {
    if (new Set(entry.snapshotPositions.map(item => item.snapshotId)).size !== entry.snapshotPositions.length) fail('同一余额快照的先后关系不能重复设置');
    for (const relation of entry.snapshotPositions) {
      const snapshot = snapshotsById.get(relation.snapshotId) ?? fail('余额先后关系引用了不存在的快照，请先重新读取账户余额');
      if (!entry.cashflows.some(flow => flow.accountId === null || flow.accountId === snapshot.accountId)) fail('这笔交易不涉及所指定余额快照的账户');
      if (entry.date && ((relation.position === 'after' && entry.date < snapshot.date) || (relation.position === 'before' && entry.date > snapshot.date))) fail('交易日期与已确认的余额快照先后关系矛盾，请核对日期');
    }
  }
}

type OperationRow = { id: string; fingerprint: string; kind: string; before_payload: string; entry_ids: string; revision: number; undone: number };
const fingerprint = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const normalizeTitle = (value: string) => value.replace(/[\s，。！？、,.!?]/g, '').toLowerCase();

export class LedgerService {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  constructor(readonly path: string, options: { now?: () => Date } = {}) {
    this.db = openDatabase(path); this.now = options.now ?? (() => new Date());
    try { initializeLedgerDatabase(this.db); } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  snapshot(month?: string): LedgerSnapshot { return this.toSnapshot(readLedgerDatabase(this.db), month); }
  query(input: LedgerQuery = {}) {
    const query = LedgerQuerySchema.parse(input); const data = readLedgerDatabase(this.db);
    const month = query.month ?? ((!query.from && !query.to) ? ledgerToday(this.now()).slice(0, 7) : undefined);
    return { entries: data.entries.filter(entry => ledgerEntryMatches(entry, { ...query, month })), summary: summarizeLedger(data, query, this.now()), receivables: ledgerReceivable(data.entries, { ...query, month }) };
  }
  private toSnapshot(data: LedgerData, month?: string): LedgerSnapshot {
    return { ...data, sources: data.sources.map(({ content: _content, ...source }) => source), summary: summarizeLedger(data, { month: month ? LedgerMonthSchema.parse(month) : undefined }, this.now()) };
  }
  private transact(operationId: string, kind: string, digest: string, expectedRevision: number | undefined, month: string | undefined, apply: (data: LedgerData, at: string) => string[]): LedgerMutationResult {
    this.db.exec('BEGIN IMMEDIATE');
    let phase: 'read' | 'apply' | 'write' | 'committed' = 'read';
    try {
      const previous = this.db.prepare('SELECT * FROM ledger_operations WHERE id=?').get(operationId) as OperationRow | undefined;
      const data = readLedgerDatabase(this.db);
      if (previous) {
        if (previous.fingerprint !== digest) throw new LedgerError('CONFLICT', '同一操作编号的内容已改变，请重新发起该操作');
        this.db.exec('COMMIT');
        phase = 'committed';
        return { status: 'already_saved', operationId, snapshot: this.toSnapshot(data, month), entryIds: JSON.parse(previous.entry_ids) as string[], message: previous.undone ? '该操作已保存后撤销，本次重试未重复记账' : '此前已保存，本次重试未重复记账', undoAvailable: this.hasUndo() };
      }
      if (expectedRevision !== undefined && data.revision !== expectedRevision) throw new LedgerError('CONFLICT', '账本已更新，请刷新最新记录后再操作');
      const before = JSON.stringify(data); const at = this.now().toISOString();
      phase = 'apply';
      const entryIds = apply(data, at);
      data.revision += 1; validateLedgerData(data); LedgerDataSchema.parse(data);
      const payload = JSON.stringify(data);
      phase = 'write';
      this.db.prepare('UPDATE ledger_state SET payload=? WHERE id=1').run(payload);
      this.db.prepare('INSERT INTO ledger_operations(id,fingerprint,kind,before_payload,entry_ids,revision) VALUES(?,?,?,?,?,?)').run(operationId, digest, kind, before, JSON.stringify(entryIds), data.revision);
      if (String(this.db.prepare('SELECT payload FROM ledger_state WHERE id=1').get()!['payload']) !== payload) throw new LedgerError('STORAGE', '保存后核对失败，账本尚未完成保存');
      this.db.exec('COMMIT');
      phase = 'committed';
      return { status: 'saved', operationId, snapshot: this.toSnapshot(data, month), entryIds, message: kind === 'undo' ? '已撤销上一次账本操作' : '已保存并核对本地账本', undoAvailable: this.hasUndo() };
    } catch (error) {
      if (phase === 'committed') throw new LedgerError('STORAGE', '账本已提交，但结果读取未完成；请核对原操作，不要重新记账');
      try { this.db.exec('ROLLBACK'); } catch {
        throw new LedgerError('STORAGE', '账本保存状态尚未确认，请核对原操作，不要重新记账');
      }
      // Only this proven, rolled-back boundary permits fresh AI analysis. Read
      // failures, conflicts and uncertain/committed writes must retain their ID.
      if (kind === 'mutation' && phase === 'apply') {
        if (error instanceof LedgerError && error.code === 'VALIDATION') throw new LedgerValidationRejection(operationId, error.message);
        if (error instanceof Error && error.name === 'ZodError') throw new LedgerValidationRejection(operationId, '账目格式不符合保存要求');
      }
      if (error instanceof LedgerError) throw error;
      if (error instanceof Error && error.name === 'ZodError') throw new LedgerError('VALIDATION', '账目格式不正确，尚未保存', error.message);
      throw new LedgerError('STORAGE', '本地账本保存未完成，请检查文件后重试同一操作', error instanceof Error ? error.message : undefined);
    }
  }
  private hasUndo(): boolean { return !!this.db.prepare("SELECT 1 FROM ledger_operations WHERE kind!='undo' AND undone=0 ORDER BY revision DESC LIMIT 1").get(); }
  mutate(input: LedgerMutationRequest): LedgerMutationResult {
    const request = LedgerMutationRequestSchema.parse(input);
    return this.transact(request.operationId, 'mutation', fingerprint({ kind: 'mutation', changes: request.changes }), request.expectedRevision, request.month, (data, at) => {
      const entryIds: string[] = [];
      for (const change of request.changes) {
        if (change.type === 'putEntry') {
          const today = ledgerToday(this.now());
          if ((change.entry.date && change.entry.date > today) || change.entry.month > today.slice(0, 7) || (change.entry.occurredAt && Date.parse(change.entry.occurredAt) > this.now().getTime())) fail('该笔交易的日期或时刻尚未发生。未来付款计划请先安排到日历，实际发生后再记账');
          const index = data.entries.findIndex(entry => entry.id === change.entry.id); const old = data.entries[index];
          if ((old?.version ?? null) !== change.expectedVersion) throw new LedgerError('CONFLICT', '这笔账已被修改，请打开最新记录后再更正');
          if (old?.voided) throw new LedgerError('CONFLICT', '这笔账已移除，可先撤销移除再修改');
          if (!old && !change.confirmDuplicate) {
            const duplicate = data.entries.find(entry => !entry.voided && entry.date === change.entry.date && entry.month === change.entry.month && entry.kind === change.entry.kind && entry.amountCents === change.entry.amountCents && normalizeTitle(entry.title) === normalizeTitle(change.entry.title));
            if (duplicate) throw new LedgerError('DUPLICATE', `已有相同日期、项目和金额的“${duplicate.title}”，请先确认是否确实是另一笔`, { entryIds: [duplicate.id] });
          }
          const entry: LedgerEntry = { ...change.entry, version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? at, updatedAt: at, voided: false,
            sameDayBalanceOrder: old?.sameDayBalanceOrder ?? data.rules.sameDayNewEntryOrder };
          if (old) data.entries[index] = entry; else data.entries.push(entry);
          entryIds.push(entry.id);
          data.audit.push({ id: randomUUID(), operationId: request.operationId, at, action: old ? '更正账目' : '新增账目', entryIds: [entry.id], note: change.note || entry.title, beforeEntries: old ? [old] : [] });
        } else if (change.type === 'voidEntry') {
          const index = data.entries.findIndex(entry => entry.id === change.id); const old = data.entries[index];
          if (!old || old.version !== change.expectedVersion || old.voided) throw new LedgerError('CONFLICT', '这笔账已发生变化，请刷新后再移除');
          data.entries[index] = { ...old, voided: true, version: old.version + 1, updatedAt: at }; entryIds.push(old.id);
          data.audit.push({ id: randomUUID(), operationId: request.operationId, at, action: '移除账目', entryIds: [old.id], note: change.note || old.title, beforeEntries: [old] });
        } else if (change.type === 'setBalance') {
          if (data.balanceSnapshots.some(snapshot => snapshot.id === change.snapshot.id)) throw new LedgerError('CONFLICT', '此快照编号已存在，请创建新的余额核对记录');
          if (change.snapshot.date > ledgerToday(this.now())) fail('不能记录未来余额快照');
          if (change.snapshot.asOf && Date.parse(change.snapshot.asOf) > this.now().getTime()) fail('余额快照的核对时刻尚未发生，请提供已经观察到的余额');
          data.balanceSnapshots.push({ ...change.snapshot, recordedAt: at });
          data.audit.push({ id: randomUUID(), operationId: request.operationId, at, action: '核对余额', entryIds: [], note: `${LEDGER_ACCOUNTS.find(account => account.id === change.snapshot.accountId)!.name}：${(change.snapshot.balanceCents / 100).toFixed(2)}；${change.snapshot.note}`, beforeEntries: [] });
        } else {
          const resumed = !data.rules.monthlyAllowance.enabled && change.rules.monthlyAllowance.enabled;
          const currentMonth = ledgerToday(this.now()).slice(0, 7);
          const startMonth = resumed && change.rules.monthlyAllowance.startMonth < currentMonth ? currentMonth : change.rules.monthlyAllowance.startMonth;
          data.rules = { ...change.rules, monthlyAllowance: { ...change.rules.monthlyAllowance, startMonth } };
          const note = change.note || '规则用于后续记录，已有账目保持不变';
          data.audit.push({ id: randomUUID(), operationId: request.operationId, at, action: '修改记账规则', entryIds: [], note: resumed ? `${note}；从 ${startMonth} 恢复，不补暂停月份` : note, beforeEntries: [] });
        }
      }
      return [...new Set(entryIds)];
    });
  }
  undo(input: LedgerUndoRequest): LedgerMutationResult {
    const request = LedgerUndoRequestSchema.parse(input);
    return this.transact(request.operationId, 'undo', fingerprint({ kind: 'undo' }), request.expectedRevision, request.month, (data, at) => {
      const operation = this.db.prepare("SELECT * FROM ledger_operations WHERE kind!='undo' AND undone=0 ORDER BY revision DESC LIMIT 1").get() as OperationRow | undefined;
      if (!operation) throw new LedgerError('VALIDATION', '没有可撤销的账本操作');
      const before = LedgerDataSchema.parse(JSON.parse(operation.before_payload));
      const audit = data.audit; const revision = data.revision;
      Object.assign(data, before, { revision, audit });
      const entryIds = JSON.parse(operation.entry_ids) as string[];
      data.audit.push({ id: randomUUID(), operationId: request.operationId, at, action: '撤销账本操作', entryIds, note: `撤销操作 ${operation.id}`, beforeEntries: [] });
      this.db.prepare('UPDATE ledger_operations SET undone=1 WHERE id=?').run(operation.id);
      return entryIds;
    });
  }
  import(input: LedgerImportPayload, operationId: string, expectedRevision?: number): LedgerMutationResult {
    const payload = LedgerImportPayloadSchema.parse(input);
    return this.transact(operationId, 'import', fingerprint({ kind: 'import', payload }), expectedRevision, undefined, (data, at) => {
      const importedIds: string[] = [];
      for (const entry of payload.entries) {
        const byId = data.entries.find(existing => existing.id === entry.id);
        const bySource = entry.sourceKey ? data.entries.find(existing => existing.sourceKey === entry.sourceKey) : undefined;
        const byRule = entry.ruleKey ? data.entries.find(existing => existing.ruleKey === entry.ruleKey) : undefined;
        if (byId || bySource) {
          const existing = byId ?? bySource!;
          if (fingerprint(existing) !== fingerprint(entry)) throw new LedgerError('CONFLICT', `导入的“${entry.title}”与本地记录不同，请先核对更正，未覆盖本地记录`);
          continue;
        }
        if (byRule) {
          if (byRule.sourceId || byRule.version !== 1 || byRule.voided) throw new LedgerError('CONFLICT', '固定生活费已存在并有本地更正，请先核对，未重复导入');
          data.entries = data.entries.filter(existing => existing.id !== byRule.id);
          for (const snapshot of data.balanceSnapshots) snapshot.coveredEntryIds = snapshot.coveredEntryIds.map(existingId => existingId === byRule.id ? entry.id : existingId);
        }
        data.entries.push(entry); importedIds.push(entry.id);
      }
      for (const snapshot of payload.balanceSnapshots) {
        const existing = data.balanceSnapshots.find(item => item.id === snapshot.id);
        if (existing && fingerprint(existing) !== fingerprint(snapshot)) throw new LedgerError('CONFLICT', '导入的余额快照与本地同编号记录不同，未覆盖');
        if (!existing) data.balanceSnapshots.push(snapshot);
      }
      for (const source of payload.sources) {
        const existing = data.sources.find(item => item.id === source.id);
        if (existing && existing.checksum !== source.checksum) throw new LedgerError('CONFLICT', '来源内容已改变，请先核对新旧版本，未重复导入');
        if (!existing) data.sources.push(source);
      }
      if (data.entries.length === importedIds.length) data.rules = payload.rules;
      for (const audit of payload.audit) if (!data.audit.some(item => item.id === audit.id)) data.audit.push(audit);
      data.audit.push({ id: randomUUID(), operationId, at, action: '导入历史账本', entryIds: importedIds, note: `原子导入 ${importedIds.length} 笔记录，保留原编号、快照和说明`, beforeEntries: [] });
      return importedIds;
    });
  }
  ensureMonthlyAllowance(): LedgerMutationResult | null {
    const initial = readLedgerDatabase(this.db); const currentMonth = ledgerToday(this.now()).slice(0, 7); const rule = initial.rules.monthlyAllowance;
    if (!rule.enabled || currentMonth < rule.startMonth) return null;
    let month = rule.startMonth; let result: LedgerMutationResult | null = null;
    while (month <= currentMonth) {
      const data = readLedgerDatabase(this.db); const key = ledgerAllowanceKey(month);
      // An explicit undo or void is a user correction, not a reason to regenerate.
      if (!data.entries.some(entry => entry.ruleKey === key) && !data.audit.some(audit => audit.action === '撤销账本操作' && audit.entryIds.includes(key)) && !this.db.prepare('SELECT 1 FROM ledger_operations WHERE id=?').get(key)) {
        result = this.mutate({ operationId: key, expectedRevision: data.revision, changes: [{ type: 'putEntry', expectedVersion: null, confirmDuplicate: false, note: '按用户已约定的每月生活费规则生成，未向支付平台核验到账', entry: {
          id: key, kind: 'income', date: `${month}-01`, month, dateNote: '', occurredAt: null, title: '约定生活费', category: '生活费', amountCents: rule.amountCents, personalCents: 0, incomeCents: rule.amountCents, assetSaleCents: 0,
          cashflows: [{ accountId: rule.accountId, deltaCents: rule.amountCents }], adjustments: [], relatedEntryIds: [], snapshotPositions: [], note: '按每月 1 日约定计入；账户不明时不增加任何已知账户余额。未到账、金额变更或暂停时请更正本记录。', originalText: '', sourceId: null, sourceKey: null, ruleKey: key,
        } }] });
      }
      const next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); month = next.toISOString().slice(0, 7);
    }
    return result;
  }
  exportJson(): LedgerImportPayload {
    const { entries, balanceSnapshots, rules, audit, sources } = readLedgerDatabase(this.db);
    return { format: 'ultimate-calendar-ledger', formatVersion: 1, entries, balanceSnapshots, rules, audit, sources };
  }
  exportCsv(month?: string): string {
    const data = readLedgerDatabase(this.db); if (month) LedgerMonthSchema.parse(month);
    const cell = (value: string | number | null) => {
      const raw = value === null ? '' : String(value);
      const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows: Array<Array<string | number | null>> = [['编号', '日期', '月份', '日期说明', '性质', '项目', '分类', '实际金额', '原记录个人开销', '普通收入', '资产变现', '账户资金变化', '关联冲减金额', '关联原记录', '备注', '状态', '版本', '登记时间', '更正时间']];
    for (const entry of data.entries.filter(item => !month || item.month === month)) rows.push([
      entry.id, entry.date, entry.month, entry.dateNote, entry.kind, entry.title, entry.category, (entry.amountCents / 100).toFixed(2), entry.personalCents === null ? null : (entry.personalCents / 100).toFixed(2), (entry.incomeCents / 100).toFixed(2), (entry.assetSaleCents / 100).toFixed(2),
      entry.cashflows.map(flow => `${LEDGER_ACCOUNTS.find(account => account.id === flow.accountId)?.name ?? '账户待确认'} ${(flow.deltaCents / 100).toFixed(2)}`).join('；'),
      (entry.adjustments.reduce((sum, adjustment) => sum + adjustment.amountCents, 0) / 100).toFixed(2), [...new Set([...entry.relatedEntryIds, ...entry.adjustments.flatMap(adjustment => adjustment.targetEntryIds)])].join('；'), entry.note, entry.voided ? '已移除' : '有效', entry.version, entry.createdAt, entry.updatedAt,
    ]);
    return `\uFEFF${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`;
  }
}
export function createLedgerService(path: string, options: { now?: () => Date } = {}): LedgerService { return new LedgerService(path, options); }
