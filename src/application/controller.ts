import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ImportSourceRequestSchema, AnalyzeSourceRequestSchema, CommandRequestSchema, CommandIntentSchema, CourseImportRequestSchema, SaveSettingsRequestSchema, WorkflowReceiptSchema, SourceSchema, CandidateSchema, InstantSchema, type PlannerService, type Source, type ApiResult, type AnalysisResult, type CommandResult, type CourseImportResult, type Settings, type WorkflowReceipt, type ImportSourceRequest, type AnalyzeSourceRequest, type CommandRequest, type CourseImportRequest } from '../shared/contracts';
import { type Repository, type StoredState, newEntity, findEntity, records, updateEntity } from '../storage/repository';
import { automaticBackup } from '../storage/backups';
import { nowInstant } from '../domain/time';
import { buildCalendar } from '../domain/calendar';
import { completeJson, safeError, WorkflowError } from '../ai/deepseek';
import { ExtractionSchema } from '../ai/schemas';
import { extractionMessages, commandMessages, courseMessages } from '../ai/prompts';
import { buildCommandContext, validateCommandReferences } from '../ai/commands';
import { groundTimedCommand } from '../ai/timed-commands';
import { groundResourceCommand, selectedCommandResources } from '../ai/resource-commands';
import { commandMutationReply } from './command-reply';
import { normalizeCandidate, candidateFingerprint, supplementCandidate } from '../imports/messages';
import { parseCourseFile, parseCsv, previewCourseRows, type SelectedCourseFile } from '../imports/courses';
import type { PriceQuote } from '../shared/account';
import type { ModelRequestRunner } from '../ai/request-queue';
import type { LedgerService } from '../ledger/service';
import { LedgerIntentSchema, LedgerCommandProposalSchema } from '../shared/ledger-command';
import { ledgerChanges, ledgerContext, ledgerMessages, ledgerQueryReply, ledgerSavedReply } from '../ai/ledger';
import { ledgerToday } from '../shared/ledger';

export interface ControllerOptions { automaticBackup?(repository: Repository): void; planner: PlannerService; repository: Repository; ledger?: LedgerService; getApiKey(): Promise<string | null>; getPriceQuote?(model: string, currency: 'CNY' | 'USD'): PriceQuote | null; getModelInputModalities?(model: string): string[] | null; runModel?: ModelRequestRunner; afterModelRequest?(): void; fetch?: typeof fetch; now?(): string; selectCourseFile?(): Promise<SelectedCourseFile | null> }
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function createController(options: ControllerOptions) {
  const { repository, planner } = options; const running = new Map<string, { fingerprint: string; promise: Promise<unknown> }>(); const analyzing = new Map<string, Promise<ApiResult<AnalysisResult>>>();
  // One controller is created at main-process startup. A crashed request must never
  // strand the UI in processing or silently trigger another paid model call.
  repository.transact(state => { for (const source of records(state, 'source')) if (source.status === 'processing') updateEntity(state, 'source', source.id, { status: 'failed', error: '上次分析已中断，请点击重试；尚未自动重新请求' }); });
  const now = () => InstantSchema.parse(options.now?.() ?? nowInstant());
  function receipt(state: StoredState, id: string, fingerprint: string): WorkflowReceipt | null {
    const entry = state.operations.find(o => o.id === id); if (!entry) return null;
    if (entry.fingerprint !== fingerprint) throw new WorkflowError('CONFLICT', 'operationId 已用于不同操作，请重新发起');
    return WorkflowReceiptSchema.parse(entry.result);
  }
  function save(state: StoredState, id: string, fingerprint: string, result: WorkflowReceipt) {
    const parsed = WorkflowReceiptSchema.parse(result); const existing = state.operations.find(o => o.id === id);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new WorkflowError('CONFLICT', 'operationId 已用于不同操作'); existing.result = parsed; }
    else state.operations.push({ id, fingerprint, result: parsed });
  }
  function execute<T>(id: string, input: unknown, work: (id: string, fingerprint: string) => Promise<T>): Promise<ApiResult<T>> {
    const fingerprint = hash(input); const current = running.get(id);
    if (current) return current.fingerprint === fingerprint ? current.promise as Promise<ApiResult<T>> : Promise.resolve({ ok: false, error: safeError(new WorkflowError('CONFLICT', 'operationId 已用于不同操作')) });
    const promise = (async (): Promise<ApiResult<T>> => { try { return { ok: true, data: await work(`workflow:${hash(id)}`, fingerprint) }; } catch (error) { return { ok: false, error: safeError(error) }; } finally { (options.automaticBackup ?? automaticBackup)(repository); } })();
    running.set(id, { fingerprint, promise }); void promise.finally(() => running.delete(id)); return promise;
  }
  async function model<T>(schema: z.ZodType<T>, messages: Parameters<typeof completeJson>[0]['messages'], operationId: string, purpose: 'source' | 'command' | 'courses') {
    const request = async () => {
      const settings = planner.snapshot().settings;
      const modalities = options.getModelInputModalities?.(settings.model);
      if (modalities && !modalities.includes('image') && messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) {
        throw new WorkflowError('VALIDATION', '当前模型不支持图片输入，请在设置中选择支持图片的模型后重试；原始图片已保留');
      }
      try {
        const result = await completeJson({ key: await options.getApiKey(), settings, autoQuote: options.getPriceQuote?.(settings.model, settings.pricingCurrency), messages, schema, operationId: `request:${hash(operationId)}:${randomUUID()}`, purpose, now: now(), fetch: options.fetch, onUsage: usage => repository.addUsage(usage) });
        return result.value;
      } finally { options.afterModelRequest?.(); }
    };
    return options.runModel ? options.runModel(request) : request();
  }
  const controller = {
    importSource(input: ImportSourceRequest): Promise<ApiResult<Source>> {
      return execute(input.operationId, input, async (id, fingerprint) => {
        const parsed = ImportSourceRequestSchema.parse(input);
        return repository.transact(state => {
          const previous = receipt(state, id, fingerprint); if (previous) { if (previous.kind !== 'source') throw new WorkflowError('CONFLICT', '操作类型不匹配'); const source = findEntity(state, 'source', previous.sourceId); if (!source) throw new WorkflowError('NOT_FOUND', '来源已删除'); return source; }
          const source = SourceSchema.parse(newEntity(state, 'source', { ...parsed.source, importedAt: now() })); save(state, id, fingerprint, { kind: 'source', sourceId: source.id }); return source;
        });
      });
    },
    analyzeSource(input: AnalyzeSourceRequest): Promise<ApiResult<AnalysisResult>> {
      const existing = analyzing.get(input.sourceId); if (existing) return existing;
      const promise = execute(input.operationId, input, async (id, fingerprint) => {
        const request = AnalyzeSourceRequestSchema.parse(input); let source: Source;
        const cached = repository.transact(state => {
          const prior = receipt(state, id, fingerprint); if (prior && prior.kind !== 'analysis') throw new WorkflowError('CONFLICT', '操作类型不匹配');
          if (prior?.result && prior.result.status !== 'failed') return prior.result;
          const saved = findEntity(state, 'source', request.sourceId); if (!saved) throw new WorkflowError('NOT_FOUND', '来源不存在');
          if (saved.captureRef) throw new WorkflowError('VALIDATION', '这是 QQ 采集的候选依据，请到 QQ 采集的分析批次中重试，以保留原始上下文和已完成进度');
          if (saved.purpose === 'courses') throw new WorkflowError('VALIDATION', '这是课表原图，请从课表导入预览重试');
          const priorSuccess = state.operations.find(o => { const r = WorkflowReceiptSchema.safeParse(o.result); return r.success && r.data.kind === 'analysis' && r.data.sourceId === saved.id && r.data.result && r.data.result.status !== 'failed'; });
          if (priorSuccess) { const result = WorkflowReceiptSchema.parse(priorSuccess.result); if (result.kind === 'analysis' && result.result) { save(state, id, fingerprint, result); return result.result; } }
          source = SourceSchema.parse(updateEntity(state, 'source', saved.id, { status: 'processing', error: null })); save(state, id, fingerprint, { kind: 'analysis', sourceId: saved.id, result: null }); return null;
        });
        if (cached) return cached;
        try {
          const context = planner.snapshot();
          const extracted = await model(ExtractionSchema, extractionMessages(source!, context.candidates, context.settings), input.operationId, 'source');
          return repository.transact(state => {
            const saved = findEntity(state, 'source', input.sourceId); if (!saved || saved.text !== source!.text || saved.imageDataUrl !== source!.imageDataUrl || saved.sentAt !== source!.sentAt) throw new WorkflowError('CONFLICT', '分析期间来源已改变或被删除');
            const candidateIds: string[] = []; let review = false;
            // Normalize every response before writing any candidates.
            const normalized = extracted.candidates.map(c => ({ ...normalizeCandidate(c, saved, records(state, 'candidate')), relation: c.relation }));
            for (const item of normalized) {
              if (item.relation.kind === 'supplement' && item.relation.candidateId) {
                const target = findEntity(state, 'candidate', item.relation.candidateId)!;
                if (target.status === 'ignored') { candidateIds.push(target.id); continue; }
                const merged = supplementCandidate(target, item.values);
                if (target.status === 'pending' && !merged.conflicts) {
                  updateEntity(state, 'candidate', target.id, { ...merged.values,
                    status: target.status, taskId: target.taskId, snoozedUntil: target.snoozedUntil,
                    revisionOfId: target.revisionOfId, duplicateOfId: target.duplicateOfId, sourceQuote: target.sourceQuote,
                  });
                  candidateIds.push(target.id); review ||= merged.values.uncertainties!.length > 0;
                } else {
                  const candidate = newEntity(state, 'candidate', { ...merged.values, revisionOfId: target.id, duplicateOfId: null });
                  candidateIds.push(candidate.id); review = true;
                }
                continue;
              }
              const duplicate = item.duplicate ? findEntity(state, 'candidate', item.duplicate.id)! : records(state, 'candidate').find(c => c.sourceIds.includes(saved.id) && candidateFingerprint(c) === candidateFingerprint(item.values));
              if (duplicate) {
                const temporalEvidence = [...new Map([...duplicate.temporalEvidence, ...(item.values.temporalEvidence ?? [])].map(e => [JSON.stringify(e), e])).values()];
                const uncertainties = [...new Set([...duplicate.uncertainties, ...(item.values.uncertainties ?? [])])];
                const sourceIds = [...new Set([...duplicate.sourceIds, saved.id])];
                if (CandidateSchema.safeParse({ ...duplicate, sourceIds, uncertainties, temporalEvidence }).success) {
                  updateEntity(state, 'candidate', duplicate.id, { sourceIds, uncertainties, temporalEvidence });
                  candidateIds.push(duplicate.id); review ||= uncertainties.length > 0 || !!duplicate.revisionOfId;
                } else {
                  // Each notice is valid on its own. Keep both complete records when their
                  // union exceeds bounds; duplicate acceptance links the original task.
                  const incomingUncertainties = item.values.uncertainties ?? [];
                  const linked = newEntity(state, 'candidate', { ...item.values, duplicateOfId: duplicate.id, revisionOfId: null,
                    uncertainties: incomingUncertainties.length < 100 ? [...incomingUncertainties, '重复通知的信息超过单条合并上限，已完整保留为关联候选，请核对'] : incomingUncertainties });
                  candidateIds.push(linked.id); review = true;
                }
              } else { const candidate = newEntity(state, 'candidate', item.values); candidateIds.push(candidate.id); review ||= (item.values.uncertainties?.length ?? 0) > 0 || !!item.values.revisionOfId; }
            }
            const result: AnalysisResult = { sourceId: saved.id, status: review ? 'needs-review' : 'succeeded', candidateIds: [...new Set(candidateIds)], message: review ? '已保留候选，请核对不确定信息' : '分析完成，可查看候选与原文' };
            updateEntity(state, 'source', saved.id, { status: result.status, error: null }); save(state, id, fingerprint, { kind: 'analysis', sourceId: saved.id, result }); return result;
          });
        } catch (error) {
          const safe = safeError(error);
          repository.transact(state => { const saved = findEntity(state, 'source', input.sourceId); if (saved) updateEntity(state, 'source', saved.id, { status: 'failed', error: safe.message }); save(state, id, fingerprint, { kind: 'analysis', sourceId: input.sourceId, result: { sourceId: input.sourceId, status: 'failed', candidateIds: [], message: safe.message } }); });
          throw error;
        }
      });
      analyzing.set(input.sourceId, promise); void promise.finally(() => analyzing.delete(input.sourceId)); return promise;
    },
    command(input: CommandRequest): Promise<ApiResult<CommandResult>> {
      return execute(input.operationId, input, async (id, fingerprint) => {
        const request = CommandRequestSchema.parse(input); const prior = repository.transact(state => receipt(state, id, fingerprint));
        if (prior && prior.kind !== 'command') throw new WorkflowError('CONFLICT', '操作类型不匹配');
        if (prior?.result && prior.result.mutationResult?.status !== 'preview') return prior.result;
        const context = { ...buildCommandContext(planner.snapshot(), request, now()), currentUiDomain: request.domain ?? 'calendar',
          availableServices: { ledger: !!options.ledger }, currentLedgerView: request.domain === 'ledger' ? request.ledgerView : undefined };
        let intent = prior?.intent ?? await model(CommandIntentSchema, commandMessages(context, request.text, request.history), input.operationId, 'command');
        if (!prior?.intent) intent = groundResourceCommand(groundTimedCommand(intent, request, context.now), context, planner.snapshot());
        if (intent.kind === 'ledger') {
          const ledger = options.ledger;
          if (!ledger) throw new WorkflowError('VALIDATION', '账本服务尚未连接，请重新打开应用');
          ledger.ensureMonthlyAllowance();
          const currentMonth = ledgerToday(new Date(now())).slice(0,7);
          const defaultQueryMonth = request.domain === 'ledger' ? request.ledgerView?.month ?? currentMonth : currentMonth;
          const snapshot = ledger.snapshot(defaultQueryMonth);
          const ledgerView = ledgerContext(snapshot, request, now());
          const proposal: z.infer<typeof LedgerCommandProposalSchema> = prior?.ledgerProposal ?? { intent: await model(LedgerIntentSchema, ledgerMessages(ledgerView, request), `${input.operationId}:ledger`, 'command'), revision: snapshot.revision };
          // Resolve the visible ledger range once, so a retried query stays on the
          // same month. Calendar selection never changes a transaction's date.
          if (proposal.intent.kind === 'query' && !proposal.intent.query.month && !proposal.intent.query.from && !proposal.intent.query.to) {
            proposal.intent.query = { ...proposal.intent.query, month: defaultQueryMonth };
          }
          if (proposal.intent.kind === 'mutate' && !proposal.mutationRequest) {
            const changes = ledgerChanges(proposal.intent,snapshot,request,new Set(ledgerView.entries.map(entry=>entry.id)),now());
            const months = [...new Set(changes.flatMap(change => change.type === 'putEntry' ? [change.entry.month] : []))];
            proposal.mutationRequest = {operationId:`ai-ledger:${hash(input.operationId)}`,expectedRevision:proposal.revision,changes,month:months.length === 1 ? months[0] : currentMonth};
          }
          repository.transact(state => save(state, id, fingerprint, { kind:'command', intent, result:null, ledgerProposal:proposal }));
          const savedReply = (result: ReturnType<LedgerService['mutate']>) => {
            const beforeAccounts = snapshot.entries.filter(entry=>result.entryIds.includes(entry.id)).flatMap(entry=>entry.cashflows.flatMap(flow=>flow.accountId ? [flow.accountId] : []));
            const snapshotAccounts = proposal.mutationRequest?.changes.flatMap(change=>change.type === 'setBalance' ? [change.snapshot.accountId] : []) ?? [];
            const mainReply = ledgerSavedReply(result.snapshot,result.entryIds,result.message,[...new Set([...beforeAccounts,...snapshotAccounts])]);
            const touched = result.snapshot.entries.filter(entry=>result.entryIds.includes(entry.id));
            const related = new Set(touched.flatMap(entry=>entry.adjustments.flatMap(adjustment=>adjustment.targetEntryIds)));
            const months = new Set([...touched,...snapshot.entries.filter(entry=>result.entryIds.includes(entry.id)),...result.snapshot.entries.filter(entry=>related.has(entry.id))].map(entry=>entry.month));
            const otherMonths = [...months].filter(month=>month!==result.snapshot.summary.month).sort();
            return [mainReply,...otherMonths.map(month=>`${month} 个人开销 ¥${(ledger.snapshot(month).summary.personalCents/100).toFixed(2)}。`)].join('\n');
          };
          let reply: string;
          if (proposal.intent.kind === 'clarification') reply = proposal.intent.question;
          else if (proposal.intent.kind === 'query') {
            const query = proposal.intent.query;
            const latest = ledger.query(query);
            reply = ledgerQueryReply(query, { ...latest, rules:ledger.snapshot(currentMonth).rules }, proposal.intent.detail);
          } else if (proposal.intent.kind === 'undo') {
            const result = ledger.undo({ operationId:`ai-ledger:${hash(input.operationId)}`,expectedRevision:proposal.revision,month:currentMonth });
            reply = savedReply(result);
          } else {
            const result = ledger.mutate(proposal.mutationRequest!);
            reply = savedReply(result);
          }
          const result: CommandResult = { reply, mutationResult:null, items:[], conversationState:{domain:'ledger',phase:proposal.intent.kind === 'clarification' ? 'clarification' : proposal.intent.kind === 'query' ? 'query' : 'saved'} };
          repository.transact(state => save(state,id,fingerprint,{kind:'command',intent,result,ledgerProposal:proposal}));
          return result;
        }
        // A saved intent passed this check before persistence. Its target may now be deleted
        // by its own committed operation; PlannerService replays the durable exact result.
        if (intent.kind === 'mutate' && !prior?.intent) validateCommandReferences(intent.mutations, context);
        if (intent.kind === 'undo' && intent.transactionId && !prior?.intent) { const targetId = intent.transactionId; if (!context.journal.some(j => j.id === targetId)) throw new WorkflowError('AI_RESPONSE', 'AI 引用了上下文之外的撤销记录，请重新选择'); }
        if (intent.kind === 'undo' && !intent.transactionId) {
          const target = repository.read().journal.findLast(j => j.undoable && !j.undoneAt);
          intent = target ? { ...intent, transactionId: target.id } : { kind: 'clarification', reply: '没有可撤销的操作', questions: ['当前没有可撤销的操作'] };
        }
        repository.transact(state => save(state, id, fingerprint, { kind: 'command', intent, result: null }));
        let result: CommandResult;
        if (intent.kind === 'query') {
          const from = intent.fromDate ?? context.fromDate; const to = intent.toDate ?? context.toDate;
          if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400_000) throw new WorkflowError('AI_RESPONSE', 'AI 查询时间范围无效');
          // Task/goal answers do not implicitly request the default fortnight of calendar items.
          const calendarRequested = intent.fromDate !== undefined || intent.toDate !== undefined;
          result = { reply: intent.reply, mutationResult: null, items: calendarRequested ? buildCalendar(planner.snapshot(), from, to, true) : [] };
        }
        else if (intent.kind === 'resource_open') {
          const resourcesToOpen = selectedCommandResources(intent.resourceIds, context);
          result = { reply: `已找到资料：${resourcesToOpen.map(resource => resource.name).join('、')}。`, mutationResult: null, items: [], resourcesToOpen };
        }
        else if (intent.kind === 'resource_attach') throw new WorkflowError('AI_RESPONSE', '资料关联提案尚未转换，请重试');
        else if (intent.kind === 'clarification') result = { reply: [intent.reply, ...intent.questions].join('\n'), mutationResult: null, items: [] };
        else if (intent.kind === 'undo') {
          // Target is durable before undo. Reconstruct an already committed undo after a crash.
          const replay = intent.transactionId ? repository.read().journal.find(j => j.operationId === `undo:${intent.transactionId}`) : undefined;
          result = { reply: intent.reply, mutationResult: replay ? { status: 'applied', transactionId: replay.id, message: replay.message, changes: replay.changes, conflicts: [] } : planner.undo(intent.transactionId), items: [] };
        }
        else {
          const mutationResult = planner.mutate({ operationId: `ai:${hash(input.operationId)}`, origin: 'ai', confirmed: false, mutations: intent.mutations });
          result = { reply: commandMutationReply(mutationResult, planner.snapshot()), mutationResult, items: [] };
        }
        result.conversationState = { domain:'calendar', phase:result.mutationResult?.status === 'preview' ? 'preview' : intent.kind === 'clarification' || result.mutationResult?.status === 'clarification' ? 'clarification' : result.mutationResult?.status === 'applied' ? 'saved' : 'query' };
        repository.transact(state => save(state, id, fingerprint, { kind: 'command', intent, result })); return result;
      });
    },
    importCourses(input: CourseImportRequest): Promise<ApiResult<CourseImportResult>> {
      return execute(input.operationId, input, async (id, fingerprint) => {
        const request = CourseImportRequestSchema.parse(input); const prior = repository.transact(state => receipt(state, id, fingerprint));
        if (prior) { if (prior.kind !== 'courses') throw new WorkflowError('CONFLICT', '操作类型不匹配'); if (prior.result) return prior.result; }
        const settings = planner.snapshot().settings; let result: CourseImportResult;
        if (request.kind === 'file') { const file = await options.selectCourseFile?.(); if (!file) throw new WorkflowError('CANCELLED', '未选择课表文件'); result = await parseCourseFile(file, settings); }
        else if (request.kind === 'text') result = previewCourseRows(parseCsv(request.text), settings);
        else {
          // Retain selected originals before obtaining a key or touching the network.
          const source = repository.transact(state => {
            const sourceId = request.kind === 'source' ? request.sourceId : prior?.sourceId;
            const original = sourceId ? findEntity(state, 'source', sourceId) : undefined;
            if (sourceId && !original) throw new WorkflowError('NOT_FOUND', '课表原图已删除');
            if (original?.captureRef) throw new WorkflowError('VALIDATION', 'QQ 采集依据请在采集批次中处理；导入课表时请选择独立课表文件或原图');
            if (original && (original.purpose !== 'courses' || original.kind !== 'image' || !original.imageDataUrl)) throw new WorkflowError('VALIDATION', '请选择已保存的课表原图');
            const saved = original ? updateEntity(state, 'source', original.id, { status: 'processing', error: null }) : newEntity(state, 'source', { kind: 'image', imageDataUrl: request.kind === 'image' ? request.imageDataUrl : null, purpose: 'courses', label: '课表原图', importedAt: now(), status: 'processing' });
            save(state, id, fingerprint, { kind: 'courses', sourceId: saved.id, result: null }); return SourceSchema.parse(saved);
          });
          try {
            const parsed = await model(z.strictObject({ rows: z.array(z.array(z.string().max(2000)).length(8)).max(500), uncertainties: z.array(z.string().max(2000)).max(100) }), courseMessages(source.imageDataUrl!, settings.termStart, settings.periodMap), input.operationId, 'courses');
            result = { ...previewCourseRows(parsed.rows, settings, parsed.uncertainties, false), sourceId: source.id };
            repository.transact(state => { const original = findEntity(state, 'source', source.id); if (!original) throw new WorkflowError('CONFLICT', '分析期间课表原图已删除'); updateEntity(state, 'source', source.id, { status: result.drafts.some(r => r.errors.length) || result.uncertainties.length ? 'needs-review' : 'succeeded', error: null }); save(state, id, fingerprint, { kind: 'courses', sourceId: source.id, result }); });
            return result;
          } catch (error) {
            repository.transact(state => { if (findEntity(state, 'source', source.id)) updateEntity(state, 'source', source.id, { status: 'failed', error: safeError(error).message }); });
            throw error;
          }
        }
        repository.transact(state => save(state, id, fingerprint, { kind: 'courses', sourceId: null, result })); return result;
      });
    },
    saveSettings(input: z.input<typeof SaveSettingsRequestSchema>): Promise<ApiResult<Settings>> { return Promise.resolve().then(() => { try { return { ok: true as const, data: repository.saveSettings(SaveSettingsRequestSchema.parse(input).settings) }; } catch (error) { return { ok: false as const, error: safeError(error) }; } }); },
  };
  return controller;
}
export type Controller = ReturnType<typeof createController>;
