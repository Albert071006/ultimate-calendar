import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { buildCalendar } from '../domain/calendar';
import { readPrivate, writePrivate } from '../remote/private-file';
import { BlockInputSchema, GoalInputSchema, MutationRequestSchema, SnapshotSchema, TaskInputSchema, type Entity, type MutationRequestInput, type MutationResult, type Snapshot } from '../shared/contracts';
import { PlanFileSchema, PlanImportConfirmSchema, type PlanFile, type PlanImportPreview, type PlanImportResult, type PlanImportRow } from '../shared/plan-import';
import { PlanSourceSchema, type PlanSource } from '../shared/plan-context';
import { planContextFingerprint } from './context';
import { RevisionReceiptSchema, REVISION_KEY, hasRevisions, prepareRevision, revisionItems, revisionRequest, revisionOperationId, revisionChangesMatch,
  revisionReceiptValid, recordRevisionAfter, restoreRevisionBefore, safeRevisionPreview, type RevisionReceipt } from './revision';

type Kind = PlanImportRow['kind'];
type Item = { kind: Kind; id: string; title: string };
const EntrySchema = z.strictObject({ key: z.string(), entityId: z.string(), fingerprint: z.string().nullable() });
const ReceiptSchema = z.strictObject({ planId: z.string(), scope: z.string(), fingerprint: z.string(), entries: z.array(EntrySchema), revision: RevisionReceiptSchema.optional() });
const PendingSchema = z.strictObject({ planId: z.string(), scope: z.string(), key: z.string(), request: MutationRequestSchema });
const StoreSchema = z.strictObject({ version: z.literal(1), plans: z.array(ReceiptSchema), pending: PendingSchema.nullable() });
type Entry = z.infer<typeof EntrySchema>;
type Store = z.infer<typeof StoreSchema>;
type Receipt = z.infer<typeof ReceiptSchema>;
type Options = { directory: string; snapshot(): Promise<Snapshot>; mutate(request: MutationRequestInput): Promise<MutationResult>; scope(): Promise<string>; source?(): Promise<PlanSource> };
type Fact = { key: string; message: string; participants: string[] };
type Preview = { plan: PlanFile; scope: string; signature: string; expires: number; facts: Fact[]; view: PlanImportPreview; recovered: Entry[] };
const keyOf = (item: Item) => `${item.kind}:${item.id}`;
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalized(v)]));
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(normalized(value)) ?? 'undefined').digest('hex');
function canonical(input: unknown): PlanFile {
  const parsed = PlanFileSchema.safeParse(input);
  if (!parsed.success) throw Error(`计划文件无效：${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).slice(0, 4).join('；')}`);
  const plan = parsed.data;
  for (const name of ['goals', 'tasks', 'blocks', 'resources'] as const) plan[name].sort((a, b) => a.id.localeCompare(b.id));
  for (const row of [...plan.goals, ...plan.tasks, ...plan.blocks]) row.resourceRefs.sort();
  plan.updates?.sort((a, b) => a.id.localeCompare(b.id)); plan.deletions?.sort((a, b) => a.id.localeCompare(b.id));
  for (const update of plan.updates ?? []) update.values.resourceRefs?.sort();
  return plan;
}
function items(plan: PlanFile): Item[] { return [...plan.goals.map(value => ({ ...value, kind: 'goal' as const })), ...plan.tasks.map(value => ({ ...value, kind: 'task' as const })), ...plan.blocks.map(value => ({ ...value, kind: 'block' as const }))]; }
function entity(snapshot: Snapshot, kind: Kind, id: string): Entity | undefined { return (kind === 'goal' ? snapshot.goals : kind === 'task' ? snapshot.tasks : snapshot.blocks).find(value => value.id === id); }
function signature(snapshot: Snapshot) {
  const ordered = <T extends { id: string }>(records: T[]) => [...records].sort((a, b) => a.id.localeCompare(b.id));
  return hash({ sources: ordered(snapshot.sources), candidates: ordered(snapshot.candidates), goals: ordered(snapshot.goals), tasks: ordered(snapshot.tasks), blocks: ordered(snapshot.blocks), courses: ordered(snapshot.courses), courseExceptions: ordered(snapshot.courseExceptions), preferences: ordered(snapshot.preferences), feedback: ordered(snapshot.feedback), settings: snapshot.settings });
}
function operationId(plan: PlanFile, item: Item) { return `plan-import:${hash([plan.planId, keyOf(item)])}`; }
function values(plan: PlanFile, item: Item, entries: Entry[]): Record<string, unknown> {
  const list = item.kind === 'goal' ? plan.goals : item.kind === 'task' ? plan.tasks : plan.blocks;
  const source = list.find(value => value.id === item.id)!;
  const { id: _id, resourceRefs, ...rest } = source;
  const result: Record<string, unknown> = { ...rest };
  if ('goalRef' in source) { delete result.goalRef; result.goalId = entries.find(value => value.key === `goal:${source.goalRef}`)?.entityId; }
  if ('taskRef' in source) { delete result.taskRef; result.taskId = entries.find(value => value.key === `task:${source.taskRef}`)?.entityId; }
  if (resourceRefs.length) result.resources = resourceRefs.map(id => plan.resources.find(value => value.id === id)!);
  return (item.kind === 'goal' ? GoalInputSchema : item.kind === 'task' ? TaskInputSchema : BlockInputSchema).parse(result);
}
function matches(record: Entity, desired: Record<string, unknown>): boolean {
  return hash('resources' in record ? record.resources ?? [] : []) === hash(desired.resources ?? [])
    && Object.entries(desired).every(([key, value]) => key === 'color' && value === null || hash((record as unknown as Record<string, unknown>)[key]) === hash(value));
}
function detail(plan: PlanFile, item: Item, snapshot: Snapshot): string {
  const resources = (ids: string[]) => ids.length ? `资料：${ids.map(id => plan.resources.find(value => value.id === id)!.name).join('、')}` : '';
  if (item.kind === 'goal') {
    const goal = plan.goals.find(value => value.id === item.id)!;
    return [goal.targetDate && `目标日期：${goal.targetDate}`, goal.description, resources(goal.resourceRefs)].filter(Boolean).join('；');
  }
  if (item.kind === 'task') {
    const task = plan.tasks.find(value => value.id === item.id)!;
    return [task.goalRef ? `目标：${plan.goals.find(value => value.id === task.goalRef)!.title}` : task.goalId && `已有目标：${snapshot.goals.find(value => value.id === task.goalId)?.title ?? '未找到'}`, task.courseId && `课程：${snapshot.courses.find(value => value.id === task.courseId)?.title ?? '未找到'}`, task.deadline && `截止：${task.deadline.date}${task.deadline.time ? ' ' + task.deadline.time : ''}`, task.description, resources(task.resourceRefs)].filter(Boolean).join('；');
  }
  const block = plan.blocks.find(value => value.id === item.id)!;
  return [`${block.start} 至 ${block.end}`, block.taskRef ? `任务：${plan.tasks.find(value => value.id === block.taskRef)!.title}` : block.taskId && `已有任务：${snapshot.tasks.find(value => value.id === block.taskId)?.title ?? '未找到'}`, block.location, resources(block.resourceRefs)].filter(Boolean).join('；');
}
function conflicts(snapshot: Snapshot, plan: PlanFile, rows: PlanImportRow[], entries: Entry[]): Fact[] {
  const additions = plan.blocks.filter(block => rows.some(row => row.kind === 'block' && row.localId === block.id && row.state === 'new' && !row.existingId));
  const updates = snapshot.blocks.filter(block => rows.some(row => row.kind === 'block' && row.existingId === block.id && row.state === 'update'));
  if (!additions.length && !updates.length) return [];
  const dates = [...additions, ...updates].flatMap(block => [block.start.slice(0, 10), (block.end ?? block.start).slice(0, 10)]).sort();
  const existing = buildCalendar(snapshot, dates[0]!, dates.at(-1)!, false).filter(value => value.busy && value.start && value.end).map(value => ({
    key: entries.find(entry => entry.key.startsWith('block:') && entry.entityId === value.refId)?.key ?? `${value.refKind}:${value.refId}:${value.id}`,
    participant: `${value.refKind}:${value.refId}`, title: value.title, start: value.start!, end: value.end!, fresh: updates.some(block => block.id === value.refId),
  })).filter(value => !additions.some(block => value.key === `block:${block.id}`));
  const proposed = additions.map(value => ({ key: `block:${value.id}`, participant: `new:${value.id}`, title: value.title, start: value.start, end: value.end, fresh: true }));
  const all = [...existing, ...proposed], facts: Fact[] = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i]!, b = all[j]!;
    if ((!a.fresh && !b.fresh) || Date.parse(a.start) >= Date.parse(b.end) || Date.parse(b.start) >= Date.parse(a.end)) continue;
    facts.push({ key: hash([a, b].map(value => ({ key: value.key, start: value.start, end: value.end })).sort((x, y) => x.key.localeCompare(y.key))), message: `${a.title}（${a.start}）与 ${b.title}（${b.start}）时间重叠`, participants: [a.participant, b.participant].sort() });
  }
  return facts;
}

/** Remove only records identified by this plan's durable/recovered receipts before checking its original context. */
function basisIssues(plan: PlanFile, snapshot: Snapshot, entries: Entry[], source: PlanSource | null): { reason: string | null; rows: Map<string, string> } {
  const issues = { reason: null as string | null, rows: new Map<string, string>() };
  if (plan.version === 1) return issues;
  const basis = plan.basis!;
  const baseline = structuredClone(snapshot);
  const owned = (kind: Kind, id: string) => entries.some(entry => entry.key.startsWith(`${kind}:`) && entry.entityId === id);
  baseline.goals = baseline.goals.filter(value => !owned('goal', value.id));
  baseline.tasks = baseline.tasks.filter(value => !owned('task', value.id));
  baseline.blocks = baseline.blocks.filter(value => !owned('block', value.id));
  if (!source) issues.reason = '无法核对上下文的资料来源，请重新连接后预览；未新增任何事项';
  else if (hash(source) !== hash(basis.source)) issues.reason = '计划来自另一份资料或恢复前的资料版本，请重新导出当前目标上下文后规划';
  else {
    try { if (planContextFingerprint(baseline, basis.goalId, basis.fromDate, basis.toDate) !== basis.fingerprint) issues.reason = '导出后目标、任务、时段或忙碌安排已改变，请重新导出上下文后规划'; }
    catch { issues.reason = '上下文中的目标已不存在，请重新选择目标导出'; }
  }
  const tasks = baseline.tasks.filter(task => task.goalId === basis.goalId), taskIds = new Set(tasks.map(task => task.id)), courseIds = new Set(tasks.flatMap(task => task.courseId ? [task.courseId] : []));
  const deletedTasks = new Set((plan.deletions ?? []).filter(value => value.kind === 'task').map(value => value.targetId));
  for (const goal of plan.goals) issues.rows.set(`goal:${goal.id}`, '增量计划应沿用导出的目标，不能复制或新建目标');
  for (const task of plan.tasks) {
    if (task.goalRef || task.goalId !== basis.goalId) issues.rows.set(`task:${task.id}`, '新增任务必须关联上下文中的原目标');
    else if (task.courseId && !courseIds.has(task.courseId)) issues.rows.set(`task:${task.id}`, '不能关联上下文目标范围外的课程');
  }
  const lower = Date.parse(`${basis.fromDate}T00:00:00+08:00`), upper = Date.parse(`${basis.toDate}T00:00:00+08:00`) + 86_400_000;
  for (const block of plan.blocks) {
    let issue = '';
    if (!block.taskId && !block.taskRef) issue = '增量学习时段必须关联一个任务';
    else if (block.taskId && deletedTasks.has(block.taskId)) issue = '新增时段不能关联本文件将要删除的任务';
    else if (block.taskId && !taskIds.has(block.taskId)) issue = '不能安排上下文目标范围外的任务';
    else if (block.taskId && tasks.find(task => task.id === block.taskId)?.status === 'done' || block.taskRef && plan.tasks.find(task => task.id === block.taskRef)?.status === 'done') issue = '已完成任务不能新增学习安排，请先核对任务状态';
    else if (block.taskRef && issues.rows.has(`task:${block.taskRef}`)) issue = '关联的新任务不属于本次目标范围，未安排';
    else if (Date.parse(block.start) < lower || Date.parse(block.end) > upper) issue = '新增时段必须完整位于导出上下文的规划日期内';
    if (issue) issues.rows.set(`block:${block.id}`, issue);
  }
  return issues;
}

/** Versioned coordinator over existing local/cloud APIs. Receipts never replace authoritative data. */
export function createPlanImportService(options: Options) {
  const file = join(options.directory, 'plan-import-receipts.json');
  const previews = new Map<string, Preview>();
  let serial: Promise<unknown> = Promise.resolve();
  const locked = <T>(work: () => Promise<T>) => { const next = serial.then(work, work); serial = next.catch(() => {}); return next; };
  function load(): Store { const bytes = readPrivate(file, 16 * 1024 * 1024); return bytes ? StoreSchema.parse(JSON.parse(bytes.toString('utf8'))) : { version: 1, plans: [], pending: null }; }
  function save(store: Store) { const content = JSON.stringify(StoreSchema.parse(store)); if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw Error('导入回执已达到容量限制，未继续写入'); writePrivate(file, content); }
  function receipt(store: Store, plan: PlanFile, scope: string): Receipt {
    const prior = store.plans.find(value => value.planId === plan.planId);
    if (prior && prior.scope !== scope) throw Error('该计划属于另一设备、连接或资料代际，已停止自动重放。请先核对恢复后的资料，再明确使用新的 planId 发起新导入');
    if (prior && prior.fingerprint !== hash(plan)) throw Error('相同 planId 的内容已改变；原计划只能原样续导。新计划请使用新的 planId');
    if (store.pending && (store.pending.planId !== plan.planId || store.pending.scope !== scope)) throw Error('另一份计划仍有未核对的写入，请先重新打开原计划文件完成核对');
    return prior ?? { planId: plan.planId, scope, fingerprint: hash(plan), entries: [] };
  }
  async function readSnapshot(scope: string) {
    if (await options.scope() !== scope) throw Error('资料连接或身份已改变，请重新预览，未继续导入');
    const result = SnapshotSchema.parse(await options.snapshot());
    if (await options.scope() !== scope) throw Error('读取期间资料身份已改变，未继续导入');
    return result;
  }
  async function currentSource(plan: PlanFile): Promise<PlanSource | null> {
    if (plan.version === 1 || !options.source) return null;
    try { return PlanSourceSchema.parse(await options.source()); } catch { return null; }
  }
  function pendingProof(plan: PlanFile, scope: string, snapshot: Snapshot, store: Store, source: PlanSource | null) {
    const pending = store.pending;
    if (!pending || pending.planId !== plan.planId || pending.scope !== scope || plan.version !== 1 && (!source || hash(source) !== hash(plan.basis!.source))) return null;
    const item = items(plan).find(value => keyOf(value) === pending.key);
    if (!item || pending.request.operationId !== operationId(plan, item)) return null;
    const journal = snapshot.journal.find(value => value.operationId === pending.request.operationId);
    const change = journal?.changes[0];
    if (!journal || journal.changes.length !== 1 || change?.entity !== item.kind || change.action !== 'create') return null;
    return { pending, item, journal, entityId: change.id };
  }
  function revisionProof(plan: PlanFile, scope: string, snapshot: Snapshot, store: Store, source: PlanSource | null) {
    const pending = store.pending, saved = store.plans.find(value => value.planId === plan.planId);
    if (!hasRevisions(plan) || !saved?.revision || pending?.key !== REVISION_KEY || pending.planId !== plan.planId || pending.scope !== scope
      || !source || hash(source) !== hash(plan.basis!.source) || pending.request.operationId !== revisionOperationId(plan)) return null;
    const journal = snapshot.journal.find(value => value.operationId === revisionOperationId(plan));
    return journal && revisionChangesMatch(plan, journal.changes) ? { pending, journal, saved } : null;
  }
  function revisionState(plan: PlanFile, snapshot: Snapshot, saved: Receipt, pending: Store['pending']) {
    if (!hasRevisions(plan)) return { baseline: snapshot, projected: snapshot, rows: [] as PlanImportRow[], error: null as string | null, effective: undefined as RevisionReceipt | undefined };
    let effective = saved.revision, error: string | null = null;
    const journal = snapshot.journal.find(value => value.operationId === revisionOperationId(plan));
    if (!effective && journal) error = '发现此修订的旧操作记录，但本机缺少修改前回执；保留当前资料，请重新导出后制定新的修订';
    if (effective && !effective.transactionId && journal) {
      if (revisionChangesMatch(plan, journal.changes)) effective = recordRevisionAfter(plan, effective, snapshot, journal.id);
      else error = '原修订操作记录与文件不一致，已停止重放';
    }
    if (effective?.transactionId && !revisionReceiptValid(plan, effective, snapshot)) error = '已修订记录后来被编辑、删除或撤销；保留现状，不覆盖或重建';
    if (effective && !effective.transactionId && effective.before.some(before => hash(entity(snapshot, before.kind, before.record.id)) !== hash(before.record))) error = '待核对修订的原记录已变化，保留原请求，未重放';
    const baseline = effective?.transactionId && !error ? restoreRevisionBefore(snapshot, effective) : snapshot;
    const prepared = prepareRevision(plan, baseline);
    const rows = prepared.rows.map(row => {
      if (error) return { ...row, state: 'blocked' as const, detail: error };
      if (effective?.transactionId && row.state !== 'blocked') return { ...row, state: pending?.key === REVISION_KEY ? row.action as 'update' | 'delete' : 'existing' as const,
        detail: pending?.key === REVISION_KEY ? '原修订已保存，先核对原请求回执，不会再次修改' : '修订已保存，跳过' };
      return row;
    });
    return { baseline, projected: effective?.transactionId || error ? snapshot : prepared.projected, rows, error, effective };
  }
  function build(plan: PlanFile, scope: string, snapshot: Snapshot, store: Store, source: PlanSource | null): Preview {
    const saved = receipt(store, plan, scope), entries = structuredClone(saved.entries), recovered: Entry[] = [], rows: PlanImportRow[] = [];
    const revision = revisionState(plan, snapshot, saved, store.pending);
    for (const item of items(plan)) {
      let entry = entries.find(value => value.key === keyOf(item));
      const prior = snapshot.journal.find(value => value.operationId === operationId(plan, item));
      if (!entry && prior) {
        const change = prior.changes.find(value => value.entity === item.kind && value.action === 'create');
        if (change) {
          const record = entity(snapshot, item.kind, change.id);
          entry = { key: keyOf(item), entityId: change.id, fingerprint: !prior.undoneAt && record?.version === 1 && matches(record, values(plan, item, entries)) ? hash(record) : null };
          entries.push(entry); recovered.push(entry);
        }
      }
      const record = entry && entity(snapshot, item.kind, entry.entityId);
      let state: PlanImportRow['state'] = entry ? record && entry.fingerprint === hash(record) ? 'existing' : 'blocked' : 'new';
      let reason = state === 'existing' ? '已导入，跳过' : state === 'blocked' ? '已导入记录被编辑、删除或撤销；保留现状，不覆盖或重建' : store.pending?.key === keyOf(item) ? '上次写入待核对，将先核对原请求' : '新增';
      if (store.pending?.key === keyOf(item) && prior) {
        state = entry?.fingerprint && record && entry.fingerprint === hash(record) ? 'new' : 'blocked';
        reason = state === 'new' ? '上次操作已记入日志，仍须核对原请求回执；不会重复创建' : '原操作已保存，但事项后来已改变、删除或撤销；只能核对原回执，不重建事项';
      }
      if (state === 'new') {
        const source = item.kind === 'task' ? plan.tasks.find(value => value.id === item.id)! : item.kind === 'block' ? plan.blocks.find(value => value.id === item.id)! : null;
        const dependency = source && ('goalRef' in source && source.goalRef ? `goal:${source.goalRef}` : 'taskRef' in source && source.taskRef ? `task:${source.taskRef}` : null);
        const brokenInternal = dependency && rows.some(row => `${row.kind}:${row.localId}` === dependency && row.state === 'blocked');
        const missingExternal = source && ('goalId' in source && source.goalId && !snapshot.goals.some(value => value.id === source.goalId) || 'taskId' in source && source.taskId && !snapshot.tasks.some(value => value.id === source.taskId) || 'courseId' in source && source.courseId && !snapshot.courses.some(value => value.id === source.courseId));
        if (brokenInternal || missingExternal) { state = 'blocked'; reason = '关联目标、任务或课程已不存在或已改变，请先核对'; }
      }
      const block = item.kind === 'block' ? plan.blocks.find(value => value.id === item.id)! : null;
      rows.push({ kind: item.kind, localId: item.id, title: item.title, state, ...(plan.version === 3 ? { action: 'create' as const } : {}), detail: [reason, detail(plan, item, snapshot)].filter(Boolean).join('；'), ...(entry ? { existingId: entry.entityId } : {}), ...(block ? { start: block.start, end: block.end } : {}) });
    }
    rows.unshift(...revision.rows);
    const basis = basisIssues(plan, revision.baseline, entries, source);
    for (const row of rows) if (['new', 'update', 'delete'].includes(row.state)) {
      const reason = revision.error ?? basis.reason ?? (row.action === 'update' || row.action === 'delete' ? undefined : basis.rows.get(`${row.kind}:${row.localId}`));
      if (reason) { row.state = 'blocked'; row.detail = `${reason}；${row.detail}`; }
    }
    const canVerifyPending = rows.some(row => row.state === 'blocked') && Boolean(pendingProof(plan, scope, snapshot, store, source) || revisionProof(plan, scope, snapshot, store, source));
    const facts = conflicts(revision.projected, plan, rows, entries), token = randomUUID(), expires = Date.now() + 10 * 60_000;
    const view: PlanImportPreview = { token, planId: plan.planId, title: plan.title, expiresAt: new Date(expires).toISOString(), rows, conflicts: facts.map(value => value.message), resources: plan.resources, ...(canVerifyPending ? { canVerifyPending: true } : {}),
      ...(rows.some(row => row.state === 'delete') ? { requiresDeletionApproval: true } : {}),
      warnings: [plan.version === 3 ? '按真实编号修订现有目标；未列出的字段与记录保留。既有修改和删除先作为一组保存，再新增任务和时段；中断后保留原文件续导。' : '文件只新增记录。同名事项不会自动合并；如需沿用已有目标、任务或课程，请在计划文件中引用该事项。', ...(basis.reason ? [basis.reason] : []), ...(store.pending ? [canVerifyPending ? '操作日志已确认上次保存成功，可仅核对原操作解除待确认保护；不会执行任何其它新增步骤。' : basis.reason ? '上次保存请求仍受保护，当前上下文不匹配，未重放原请求。请回原资料连接核对原云端操作，勿删除回执或用新计划重复创建。' : '上次保存结果尚未核对，确认后会先核对原操作，不重复创建。'] : []), ...(rows.some(row => row.state === 'blocked') ? ['存在被阻止的记录，本次不会继续写入；请先核对已编辑、删除或失效的关联。'] : [])] };
    const preview = { plan, scope, signature: signature(snapshot), expires, facts, view, recovered };
    for (const [key, value] of previews) if (value.expires <= Date.now()) previews.delete(key);
    if (previews.size >= 20) previews.delete(previews.keys().next().value!);
    previews.set(token, preview); return preview;
  }
  async function fresh(plan: PlanFile, scope: string) { return build(plan, scope, await readSnapshot(scope), load(), await currentSource(plan)); }
  return {
    preview(input: unknown): Promise<PlanImportPreview> { return locked(async () => { const plan = canonical(input), scope = await options.scope(); return (await fresh(plan, scope)).view; }); },
    confirm(input: z.input<typeof PlanImportConfirmSchema>): Promise<PlanImportResult> { return locked(async () => {
      const { token, allowConflicts, allowDeletions } = PlanImportConfirmSchema.parse(input), approved = previews.get(token);
      if (!approved || approved.expires <= Date.now()) throw Error('导入预览已失效，请重新打开文件预览');
      previews.delete(token);
      const { plan, scope } = approved; let applied = 0;
      const partial = async (message: string): Promise<PlanImportResult> => {
        try {
          const next = await fresh(plan, scope);
          return { status: 'partial', message, applied, remaining: next.view.rows.filter(row => row.state !== 'existing').length, preview: next.view };
        } catch {
          return { status: 'partial', message: `${message}；暂时无法读取最新预览，请连接恢复后重新打开原文件核对`, applied, remaining: Math.max(0, approved.view.rows.filter(row => row.state !== 'existing').length - applied) };
        }
      };
      let snapshot = await readSnapshot(scope);
      if (signature(snapshot) !== approved.signature) return partial('预览后资料已改变，请核对最新预览后再次确认');
      if (approved.view.canVerifyPending) {
        const revisionStore = load(), revisionSaved = receipt(revisionStore, plan, scope), revisionSuccess = revisionProof(plan, scope, snapshot, revisionStore, await currentSource(plan));
        if (revisionSuccess) {
          try {
            const result = await options.mutate(revisionSuccess.pending.request);
            if (result.status !== 'applied' || result.transactionId !== revisionSuccess.journal.id || !revisionChangesMatch(plan, result.changes)) return partial('原修订回执与成功记录不一致，保留原请求，未继续导入');
            const after = await readSnapshot(scope);
            if (hash(await currentSource(plan)) !== hash(plan.basis!.source)) return partial('核对期间资料来源已改变，保留原请求，未继续导入');
            revisionSaved.revision = recordRevisionAfter(plan, revisionSaved.revision!, after, result.transactionId);
            revisionStore.pending = null; save(revisionStore);
            return partial('已核对原修订并解除待确认保护，未再次修改或继续新增。请重新导出当前目标上下文后规划');
          } catch (error) { return partial(`${error instanceof Error ? error.message : '原修订核对中断'}；保留原请求，未继续修改`); }
        }
        const store = load(), saved = receipt(store, plan, scope), proof = pendingProof(plan, scope, snapshot, store, await currentSource(plan));
        if (!proof) return partial('原操作的成功证据或资料来源已改变，保留待核对请求，未重放');
        try {
          const result = await options.mutate(proof.pending.request);
          if (result.status !== 'applied' || result.transactionId !== proof.journal.id || result.changes.length !== 1 || result.changes[0]?.entity !== proof.item.kind || result.changes[0]?.action !== 'create' || result.changes[0]?.id !== proof.entityId) return partial('原操作回执与成功记录不一致，保留待核对请求，未继续导入');
          const after = await readSnapshot(scope);
          if (plan.version !== 1 && hash(await currentSource(plan)) !== hash(plan.basis!.source)) return partial('核对期间资料来源已改变，保留原请求，未继续导入');
          const record = entity(after, proof.item.kind, proof.entityId), desired = values(plan, proof.item, saved.entries);
          saved.entries = saved.entries.filter(entry => entry.key !== keyOf(proof.item));
          saved.entries.push({ key: keyOf(proof.item), entityId: proof.entityId, fingerprint: record?.version === 1 && matches(record, desired) ? hash(record) : null });
          store.pending = null; save(store);
          return partial('已核对原保存操作并解除待确认保护，未执行任何新增步骤。请重新导出当前目标上下文后规划');
        } catch (error) { return partial(`${error instanceof Error ? error.message : '原操作核对中断'}；保留原请求，未执行新增步骤`); }
      }
      if (approved.view.rows.some(row => row.state === 'blocked')) return partial('存在被阻止的记录，未继续写入，请先核对');
      if (approved.facts.length && !allowConflicts) return partial('存在时间冲突，请明确勾选允许这些冲突后再确认');
      if (approved.view.requiresDeletionApproval && !allowDeletions) return partial('请明确勾选已核对删除清单后再确认；尚未修改任何事项');
      let store = load(), saved = receipt(store, plan, scope);
      const latest = build(plan, scope, snapshot, store, await currentSource(plan));
      if (latest.view.rows.some(row => row.state === 'blocked')) return partial('当前资料来源或上下文已改变，未继续写入，请先核对');
      if (!store.plans.some(value => value.planId === plan.planId)) store.plans.push(saved);
      for (const entry of approved.recovered) if (!saved.entries.some(value => value.key === entry.key) && store.pending?.key !== entry.key) saved.entries.push(entry);
      save(store);
      try {
        let expected = signature(snapshot);
        if (hasRevisions(plan) && (!saved.revision?.transactionId || store.pending?.key === REVISION_KEY)) {
          const before = snapshot, current = build(plan, scope, snapshot, store, await currentSource(plan));
          if (current.view.rows.some(row => row.state === 'blocked')) return partial('当前上下文或原记录已改变，未执行修订');
          if (!saved.revision) saved.revision = { before: prepareRevision(plan, snapshot).before, after: [] };
          const request = store.pending?.key === REVISION_KEY ? store.pending.request : revisionRequest(plan);
          store.pending = { planId: plan.planId, scope, key: REVISION_KEY, request }; save(store);
          let result = await options.mutate(request);
          if (result.status === 'preview') {
            const immediate = current.facts.filter(fact => fact.participants.some(participant => revisionItems(plan).some(item => item.kind === 'block' && participant === `block:${item.targetId}`)));
            const knownConflicts = result.conflicts.every(conflict => conflict.kind === 'time' && conflict.conflictingIds.every(id => immediate.some(fact => [conflict.id, id].every(value => fact.participants.some(participant => participant.slice(participant.indexOf(':') + 1) === value)))));
            const allowed = !result.conflicts.length || allowConflicts && immediate.every(fact => approved.facts.some(original => original.key === fact.key));
            if (!safeRevisionPreview(plan, saved.revision, result, request) || !allowed || !knownConflicts) { store.pending = null; save(store); return partial('后端修订或冲突超出本次批准范围，未确认修改，请重新预览'); }
            if (signature(await readSnapshot(scope)) !== expected || hash(await currentSource(plan)) !== hash(plan.basis!.source)) { store.pending = null; save(store); return partial('后端预览后资料已改变，未确认修订'); }
            store.pending.request = MutationRequestSchema.parse({ ...request, confirmed: true, confirmationToken: result.confirmationToken }); save(store);
            result = await options.mutate(store.pending.request);
          }
          if (result.status !== 'applied') { store.pending = null; save(store); return partial(result.message || '修订尚未保存，请重新预览'); }
          if (!revisionChangesMatch(plan, result.changes)) throw Error('修订回执超出文件中的修改与删除清单，已停止后续导入');
          const after = await readSnapshot(scope);
          if (hash(await currentSource(plan)) !== hash(plan.basis!.source)) return partial('保存后资料来源已变化，保留原请求待核对');
          saved.revision = recordRevisionAfter(plan, saved.revision, after, result.transactionId);
          store.pending = null; save(store);
          if (!revisionReceiptValid(plan, saved.revision, after)) return partial('已保存修订后来被编辑、删除或撤销；保留现状，不覆盖或重建');
          applied += revisionItems(plan).length;
          // A replay may start from the already-applied state; its before-images remain in the durable receipt.
          const alreadyApplied = before.journal.some(journal => journal.operationId === revisionOperationId(plan) && !journal.undoneAt);
          if (signature(alreadyApplied ? after : restoreRevisionBefore(after, saved.revision)) !== signature(before)) return partial('修订期间其它资料已改变，已保存修订保留；请核对后继续新增');
          snapshot = after; expected = signature(after);
        }
        const ordered = items(plan);
        if (store.pending) ordered.sort((a, b) => Number(keyOf(b) === store.pending!.key) - Number(keyOf(a) === store.pending!.key));
        for (const item of ordered) {
          snapshot = await readSnapshot(scope);
          if (signature(snapshot) !== expected) return partial('导入期间资料已改变，已保存的部分保留；请核对最新预览后继续');
          const current = build(plan, scope, snapshot, store, await currentSource(plan)), row = current.view.rows.find(value => value.kind === item.kind && value.localId === item.id && value.action !== 'update' && value.action !== 'delete')!;
          if (current.view.rows.some(value => value.state === 'blocked')) return partial('当前资料来源、上下文或关联事项已改变，未继续写入');
          if (row.state !== 'new' && store.pending?.key !== keyOf(item)) continue;
          if (row.state === 'blocked' && store.pending?.key === keyOf(item)) return partial('待核对事项或其依赖已改变，未继续重放；请先核对原操作');
          const desired = values(plan, item, saved.entries);
          const request = store.pending?.key === keyOf(item) ? store.pending.request : MutationRequestSchema.parse({ operationId: operationId(plan, item), origin: 'manual', mutations: [{ type: 'create', entity: item.kind, values: desired }] });
          const before = snapshot;
          store.pending = { planId: plan.planId, scope, key: keyOf(item), request }; save(store);
          let result = await options.mutate(request);
          if (result.status === 'preview') {
            const proposed = result.details[0];
            const safeChange = result.details.length === 1 && proposed?.entity === item.kind && !proposed.before && proposed.after && matches(proposed.after, desired)
              && hash({ operationId: result.proposedRequest.operationId, mutations: result.proposedRequest.mutations }) === hash({ operationId: request.operationId, mutations: request.mutations });
            const immediate = current.facts.filter(fact => fact.participants.includes(`new:${item.id}`));
            const allowed = allowConflicts && immediate.every(fact => approved.facts.some(original => original.key === fact.key));
            const knownConflicts = result.conflicts.every(conflict => conflict.kind === 'time' && conflict.conflictingIds.every(id => immediate.some(fact => {
              // The backend may place a course first; compare IDs against the preflight participants after replacing its generated block ID.
              const pair = [conflict.id, id].map(value => value === proposed?.id ? `new:${item.id}` : value);
              return pair.every(value => fact.participants.some(participant => participant === value || participant.slice(participant.indexOf(':') + 1) === value));
            })));
            if (!safeChange || !allowed || !knownConflicts) { store.pending = null; save(store); return partial('后端要求的确认超出本次批准范围，请核对最新预览后继续'); }
            if (signature(await readSnapshot(scope)) !== expected) { store.pending = null; save(store); return partial('后端预览后资料已改变，请重新确认'); }
            store.pending.request = MutationRequestSchema.parse({ ...request, confirmed: true, confirmationToken: result.confirmationToken }); save(store);
            result = await options.mutate(store.pending.request);
          }
          if (result.status !== 'applied') { store.pending = null; save(store); return partial(result.message || '该项尚未保存，请重新预览'); }
          const changes = result.changes.filter(change => change.action === 'create' && change.entity === item.kind);
          if (changes.length !== 1 || result.changes.length !== 1) throw Error('导入回执与单项新增不一致，已停止后续导入');
          const entityId = changes[0]!.id;
          const after = await readSnapshot(scope), record = entity(after, item.kind, entityId);
          const valid = record?.version === 1 && matches(record, desired);
          saved.entries = saved.entries.filter(entry => entry.key !== keyOf(item)); saved.entries.push({ key: keyOf(item), entityId, fingerprint: valid ? hash(record) : null });
          store.pending = null; save(store);
          if (!valid) return partial('已保存事项后来被修改、删除或撤销；不会覆盖或重建，请核对');
          applied++;
          const untouched = structuredClone(after);
          if (!entity(before, item.kind, entityId)) {
            if (item.kind === 'goal') untouched.goals = untouched.goals.filter(value => value.id !== entityId);
            if (item.kind === 'task') untouched.tasks = untouched.tasks.filter(value => value.id !== entityId);
            if (item.kind === 'block') untouched.blocks = untouched.blocks.filter(value => value.id !== entityId);
          }
          if (signature(untouched) !== signature(before)) return partial('保存期间其他资料已改变，已保存部分保留，请核对后继续');
          expected = signature(after);
        }
        const next = await fresh(plan, scope), remaining = next.view.rows.filter(row => row.state !== 'existing').length;
        return { status: remaining ? 'partial' : 'complete', message: remaining ? '有效事项已保存，部分记录仍需核对' : applied ? '计划导入完成' : '该计划已导入，无需重复创建', applied, remaining, ...(remaining ? { preview: next.view } : {}) };
      } catch (error) {
        // A transport or receipt-write failure retains the exact request, including a backend confirmation token.
        const message = error instanceof Error ? error.message : '导入中断';
        return partial(`${message}；已保存部分保留，可重新确认继续核对`);
      }
    }); },
  };
}
