import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createLedgerService, LedgerError, type LedgerService } from '../ledger/service';
import { createController } from './controller';
import { WorkflowError } from '../ai/deepseek';
import { DEFAULT_LEDGER_RULES, LedgerEntryDraftSchema, LedgerEntrySchema, type LedgerEntry } from '../shared/ledger';
import type { CommandRequest } from '../shared/contracts';

const at = '2026-10-23T21:30:00+08:00';
const disposables: Array<Repository|LedgerService> = [];
afterEach(()=>{for(const item of disposables.splice(0))item.close();vi.restoreAllMocks();});
const envelope = (intent:unknown) => new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(intent)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}),{status:200});
function setup(intents: unknown[]) {
  const repository = createRepository(':memory:'); const ledger = createLedgerService(':memory:',{now:()=>new Date(at)});disposables.push(repository,ledger);
  const payloads: Array<{messages:Array<{role:string;content:string}>}> = [];
  const controller = createController({repository,planner:createPlanner(repository),ledger,now:()=>at,getApiKey:async()=>'synthetic-key',fetch:async(_url,init)=>{payloads.push(JSON.parse(String(init?.body)));const next=intents.shift();if(!next)throw Error('unexpected model call');return envelope(next);}});
  return {repository,ledger,controller,payloads,intents};
}
const route = {kind:'ledger',reply:'交由账本处理'};
function expense(accountId:'alipay'|null = null) {return {kind:'mutate',changes:[{type:'createEntry',key:'new:0',values:{kind:'expense',date:'2026-10-23',month:'2026-10',title:'午饭',category:'餐饮',amountCents:2000,personalCents:2000,cashflows:[{accountId,deltaCents:-2000}]}}]};}
function syntheticEntry(id: string, values: Partial<LedgerEntry> = {}): LedgerEntry {
  return LedgerEntrySchema.parse({ id, kind: 'expense', date: '2026-10-20', month: '2026-10', title: `合成记录 ${id}`, category: '其他', amountCents: 100, personalCents: 100,
    cashflows: [{ accountId: 'alipay', deltaCents: -100 }], version: 1, createdAt: at, updatedAt: at, ...values });
}
function importSynthetic(ledger: LedgerService, entries: LedgerEntry[]) {
  ledger.import({ format: 'ultimate-calendar-ledger', formatVersion: 1, entries, balanceSnapshots: [], rules: DEFAULT_LEDGER_RULES, audit: [], sources: [] }, 'synthetic-receivable-import');
}
describe('main assistant local ledger commands',()=>{
  it('rolls back every proposed entry on business validation failure and explicitly reanalyzes with a new operation only once', async () => {
    const corrected = { kind: 'mutate', changes: Array.from({ length: 4 }, (_, index) => ({ ...expense('alipay').changes[0]!, key: `new:${index}`, values: { ...expense('alipay').changes[0]!.values, title: `合成消费${index}` } })) };
    const invalid = structuredClone(corrected);
    invalid.changes[3]!.values.cashflows[0]!.deltaCents = 2000;
    const { controller, ledger, repository, payloads } = setup([route, invalid, route, corrected]);
    const before = ledger.snapshot();
    const request = { operationId: 'rejected-business-batch', text: '合成四笔消费' };
    const failed = await controller.command(request);
    expect(failed).toMatchObject({ ok: false, error: { code: 'AI_RESPONSE', retryable: false, message: expect.stringContaining('账本校验失败') } });
    if (failed.ok) throw Error('expected rejection');
    expect(failed.error.message).toContain('本次整批账目均未保存');
    expect(failed.error.message).toContain('AI_LEDGER_VALIDATION');
    expect(ledger.snapshot()).toEqual(before);
    expect(repository.snapshot().tokenUsage).toHaveLength(2);
    expect(await controller.command(request)).toEqual(failed);
    expect(payloads).toHaveLength(2);
    const retry = { ...request, operationId: 'reanalyzed-business-batch' };
    const saved = await controller.command(retry);
    expect(saved).toMatchObject({ ok: true, data: { conversationState: { domain: 'ledger', phase: 'saved' } } });
    expect(ledger.snapshot().entries).toHaveLength(4);
    expect(ledger.snapshot().revision).toBe(before.revision + 1);
    expect(await controller.command(retry)).toEqual(saved);
    expect(payloads).toHaveLength(4);
    expect(repository.snapshot().tokenUsage).toHaveLength(4);
  });
  it.each(['VALIDATION', 'CONFLICT', 'STORAGE'] as const)('does not reclassify an unproven %s failure as safely reanalyzable', async code => {
    const { controller, ledger } = setup([route, expense('alipay')]);
    vi.spyOn(ledger, 'mutate').mockImplementation(() => { throw new LedgerError(code, '合成未确认错误'); });
    expect(await controller.command({ operationId: `unproven-${code}`, text: '合成午饭' })).toMatchObject({ ok: false, error: { code } });
  });
  it.each(['命令理解', '账本解析'] as const)('labels %s schema failures without saving a transaction or losing billable usage', async stage => {
    const malformed = expense('alipay'); malformed.changes[0]!.values.amountCents = 2000.5;
    const { controller, ledger, repository, payloads } = setup(stage === '命令理解' ? [{ kind: 'private-invalid-intent', reply: 'private model contents' }] : [route, malformed]);
    const before = ledger.snapshot();
    const result = await controller.command({ operationId: 'synthetic-schema-failure', text: '合成午饭20元支付宝' });
    expect(result).toMatchObject({ ok: false, error: { code: 'AI_RESPONSE', retryable: false, message: expect.stringContaining(`${stage}失败：`) } });
    if (result.ok) throw Error('expected schema rejection');
    expect(result.error.message).toContain('AI_SCHEMA'); expect(result.error.message).not.toContain('private');
    expect(ledger.snapshot().entries).toEqual(before.entries); expect(ledger.snapshot().revision).toBe(before.revision);
    expect(payloads).toHaveLength(stage === '命令理解' ? 1 : 2);
    expect(repository.snapshot().tokenUsage).toHaveLength(payloads.length);
    expect(repository.snapshot().tokenUsage.every(usage => usage.totalTokens === 20)).toBe(true);
  });
  it('continues the screenshot domain clarification with the original purchase facts and saves exactly once',async()=>{
    const clarification = {kind:'clarification',reply:'需要确认操作类型',questions:['这是记账还是安排日历事项？']};
    const {controller,ledger,intents,payloads}=setup([clarification]);
    const first=await controller.command({operationId:'vpn-ambiguous',text:'vpn14 支付宝'});
    expect(first.ok).toBe(true);if(!first.ok)throw Error('failed');
    expect(first.data.conversationState?.phase).toBe('clarification');
    expect(ledger.snapshot().entries.filter(entry=>!entry.ruleKey)).toHaveLength(0);
    intents.push(route,{kind:'mutate',changes:[{type:'createEntry',key:'new:0',values:{kind:'expense',date:'2026-10-23',month:'2026-10',title:'VPN',category:'软件服务',amountCents:1400,personalCents:1400,cashflows:[{accountId:'alipay',deltaCents:-1400}]}}]});
    const secondRequest={operationId:'vpn-bookkeeping-answer',text:'记账',history:[
      {role:'user' as const,text:'vpn14 支付宝'},
      {role:'assistant' as const,text:first.data.reply,outcome:first.data.conversationState},
    ]};
    const second=await controller.command(secondRequest);
    expect(second.ok).toBe(true);if(!second.ok)throw Error('failed');
    expect(second.data.conversationState).toEqual({domain:'ledger',phase:'saved'});
    const entries=ledger.snapshot().entries.filter(entry=>!entry.ruleKey);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({title:'VPN',date:'2026-10-23',amountCents:1400,personalCents:1400,cashflows:[{accountId:'alipay',deltaCents:-1400}]});
    for(const payload of payloads.slice(1)){
      expect(payload.messages.map(message=>message.role)).toEqual(['system','user','assistant','user']);
      expect(payload.messages[1]?.content).toBe('vpn14 支付宝');
      expect(payload.messages[2]?.content).toContain('这是记账还是安排日历事项？');
      expect(JSON.parse(payload.messages.at(-1)!.content)).toMatchObject({userCommand:'记账'});
    }
    expect(await controller.command(secondRequest)).toEqual(second);
    expect(payloads).toHaveLength(3);
    expect(ledger.snapshot().entries.filter(entry=>!entry.ruleKey)).toHaveLength(1);
  });

  it('saves unknown-account consumption, then patches that original on a short answer',async()=>{
    const {controller,ledger,intents,payloads}=setup([route,expense()]);
    const first=await controller.command({operationId:'lunch',text:'午饭20元'});
    expect(first.ok).toBe(true);if(!first.ok)throw Error('failed');
    expect(first.data.reply).toContain('用哪个账户');expect(first.data.mutationResult).toBeNull();
    expect(first.data.conversationState).toEqual({domain:'ledger',phase:'saved'});
    const entry=ledger.snapshot().entries.find(e=>e.title==='午饭')!;
    expect(entry.cashflows[0]?.accountId).toBeNull();expect(ledger.snapshot().summary.personalCents).toBe(2000);
    intents.push(route,{kind:'mutate',changes:[{type:'updateEntry',id:entry.id,expectedVersion:entry.version,patch:{cashflows:[{accountId:'alipay',deltaCents:-2000}]},note:'用户补充支付宝'}]});
    const second=await controller.command({operationId:'account-answer',text:'支付宝',history:[{role:'user',text:'午饭20元'},{role:'assistant',text:first.data.reply,outcome:first.data.conversationState}]});
    expect(second.ok).toBe(true);expect(ledger.snapshot().entries.filter(e=>e.title==='午饭')).toHaveLength(1);
    if(second.ok)expect(second.data.conversationState).toEqual({domain:'ledger',phase:'saved'});
    expect(ledger.snapshot().entries.find(e=>e.id===entry.id)).toMatchObject({version:2,personalCents:2000,cashflows:[{accountId:'alipay',deltaCents:-2000}],originalText:'午饭20元'});
    expect(payloads[1]!.messages[0]!.content).toContain('不能重复扣减');
  });
  it('distinguishes an unfinished ledger question from a saved transaction and does not replay a completed purchase on thanks',async()=>{
    const {controller,ledger,intents,payloads}=setup([route,{kind:'clarification',question:'VPN实际付了多少钱？'}]);
    const question=await controller.command({operationId:'vpn-missing-amount',text:'支付宝买了VPN，记账'});
    expect(question.ok).toBe(true);if(!question.ok)throw Error('failed');
    expect(question.data.conversationState).toEqual({domain:'ledger',phase:'clarification'});
    expect(ledger.snapshot().entries.filter(entry=>!entry.ruleKey)).toHaveLength(0);
    intents.push(route,expense('alipay'));
    const saved=await controller.command({operationId:'separate-lunch',text:'先不记VPN了，午饭20元支付宝'});
    expect(saved.ok).toBe(true);if(!saved.ok)throw Error('failed');
    expect(saved.data.conversationState).toEqual({domain:'ledger',phase:'saved'});
    intents.push({kind:'query',reply:'不客气'});
    const thanks=await controller.command({operationId:'thanks',text:'谢谢',history:[
      {role:'user',text:'先不记VPN了，午饭20元支付宝'},
      {role:'assistant',text:saved.data.reply,outcome:saved.data.conversationState},
    ]});
    expect(thanks.ok).toBe(true);if(!thanks.ok)throw Error('failed');
    expect(thanks.data.conversationState).toEqual({domain:'calendar',phase:'query'});
    expect(payloads).toHaveLength(5);
    expect(payloads.at(-1)!.messages[2]?.content).toContain('saved');
    expect(ledger.snapshot().entries.filter(entry=>!entry.ruleKey)).toHaveLength(1);
  });
  it('does not send bookkeeping records on ordinary calendar requests',async()=>{
    const {ledger,controller,payloads}=setup([{kind:'query',reply:'没有课程'}]);
    ledger.mutate({operationId:'seed',expectedRevision:0,changes:[{type:'putEntry',expectedVersion:null,confirmDuplicate:false,note:'fixture',entry:LedgerEntryDraftSchema.parse({id:'private-entry',kind:'expense',date:'2026-10-22',month:'2026-10',title:'合成保密消费',category:'其他',amountCents:500,personalCents:500,cashflows:[{accountId:'alipay',deltaCents:-500}]})}]});
    expect((await controller.command({operationId:'calendar',text:'明天有什么课'})).ok).toBe(true);
    expect(payloads).toHaveLength(1);expect(JSON.stringify(payloads)).not.toContain('合成保密消费');
  });
  it('retries a commit whose controller receipt was interrupted without another model call or entry',async()=>{
    const {controller,ledger,payloads}=setup([route,expense('alipay')]);
    const real=ledger.mutate.bind(ledger);let didFail=false;
    vi.spyOn(ledger,'mutate').mockImplementation(input=>{const result=real(input);if(input.operationId.startsWith('ai-ledger:')&&!didFail){didFail=true;throw new WorkflowError('STORAGE','合成提交后中断');}return result;});
    const request={operationId:'retry-lunch',text:'午饭20元支付宝'};
    expect(await controller.command(request)).toMatchObject({ ok: false, error: { code: 'STORAGE', retryable: false } });
    expect(ledger.snapshot().entries.filter(e=>e.title==='午饭')).toHaveLength(1);
    expect((await controller.command(request)).ok).toBe(true);
    expect(payloads).toHaveLength(2);expect(ledger.snapshot().entries.filter(e=>e.title==='午饭')).toHaveLength(1);
  });
  it('rejects fabricated original references without writing partial records',async()=>{
    const {controller,ledger}=setup([route,{kind:'mutate',changes:[{type:'updateEntry',id:'not-provided',expectedVersion:1,patch:{title:'changed'},note:'fixture'}]}]);
    const before=ledger.snapshot().entries;
    const result=await controller.command({operationId:'bad-reference',text:'改一下午饭'});
    expect(result).toMatchObject({ok:false,error:{code:'AI_RESPONSE'}});
    expect(ledger.snapshot().entries.filter(e=>!e.ruleKey)).toEqual(before.filter(e=>!e.ruleKey));
  });
  it('queries complete local totals rather than trusting model arithmetic and reuses durable requests',async()=>{
    const {controller,ledger,payloads}=setup([route,expense(),route,{kind:'query',query:{month:'2026-10'},detail:'summary'}]);
    ledger.mutate({operationId:'configure-synthetic-allowance',expectedRevision:0,changes:[{type:'updateRules',rules:{...ledger.snapshot().rules,monthlyAllowance:{enabled:true,amountCents:100_000,accountId:null,startMonth:'2026-10'}},note:'Explicit synthetic allowance fixture'}]});
    await controller.command({operationId:'new-expense',text:'午饭20元'});
    const input={operationId:'summary',text:'这个月一共花了多少钱'};
    const result=await controller.command(input);expect(result.ok).toBe(true);
    if(result.ok){expect(result.data.reply).toContain('个人开销 ¥20.00');expect(result.data.reply).toContain('普通收入 ¥1000.00');expect(result.data.conversationState).toEqual({domain:'ledger',phase:'query'});}
    await controller.command(input);expect(payloads).toHaveLength(4);expect(ledger.snapshot().summary.personalCents).toBe(2000);
  });
  it('explains a visible historical month from the full ledger beyond the model entry window and includes later repayments without changing the ledger', async () => {
    const { controller, ledger, payloads } = setup([route, { kind: 'query', query: {}, detail: 'receivables' }]);
    const old = { date: '2026-09-02', month: '2026-09', createdAt: '2026-09-02T12:00:00+08:00', updatedAt: '2026-09-02T12:00:00+08:00' };
    importSynthetic(ledger, [
      syntheticEntry('old-advance', { ...old, title: '合成活动材料甲', amountCents: 54800, personalCents: 16000, cashflows: [{ accountId: 'alipay', deltaCents: -54800 }] }),
      syntheticEntry('settled-advance', { ...old, title: '合成活动材料乙', amountCents: 12000, personalCents: 2000, cashflows: [{ accountId: 'alipay', deltaCents: -12000 }] }),
      syntheticEntry('later-return', { kind: 'aa_return', title: '合成跨月返款甲', amountCents: 7600, personalCents: 0, cashflows: [{ accountId: 'wechat', deltaCents: 7600 }], relatedEntryIds: ['old-advance'], createdAt: '2026-10-20T12:00:00+08:00', updatedAt: '2026-10-20T12:00:00+08:00' }),
      syntheticEntry('settled-return', { kind: 'aa_return', title: '合成跨月返款乙', amountCents: 10000, personalCents: 0, cashflows: [{ accountId: 'wechat', deltaCents: 10000 }], relatedEntryIds: ['settled-advance'], createdAt: '2026-10-20T12:00:00+08:00', updatedAt: '2026-10-20T12:00:00+08:00' }),
      ...Array.from({ length: 55 }, (_, index) => syntheticEntry(`recent-${index}`)),
    ]);
    const before = ledger.snapshot('2026-09');
    const query = vi.spyOn(ledger, 'query');
    const input: CommandRequest = { operationId: 'historical-receivables', text: '这里待收回的约300块是哪来的', domain: 'ledger', ledgerView: { month: '2026-09', tab: 'flows' }, fromDate: '2026-10-23', toDate: '2026-10-23' };
    const result = await controller.command(input);
    expect(result.ok).toBe(true); if (!result.ok) throw Error('query failed');
    expect(query).toHaveBeenCalledWith({ month: '2026-09' });
    const routing = JSON.parse(payloads[0]!.messages.at(-1)!.content).context;
    expect(routing).toMatchObject({ availableServices: { ledger: true }, currentLedgerView: input.ledgerView });
    expect(JSON.stringify(payloads[0])).not.toContain('合成活动材料甲');
    const context = JSON.parse(payloads[1]!.messages.at(-1)!.content).context;
    expect(context).toMatchObject({ now: at, currentView: input.ledgerView, defaultQueryMonth: '2026-09', summary: { month: '2026-09' } });
    expect(context.entries.some((entry: { id: string }) => entry.id === 'old-advance')).toBe(false);
    for (const evidence of ['合成活动材料甲', '548.00', '160.00', '76.00', '312.00', '合成活动材料乙', '已结清']) expect(result.data.reply).toContain(evidence);
    expect(result.data.reply).not.toContain('待收回 ¥300.00');
    expect(result.data.items).toEqual([]);
    expect(result.data.conversationState).toEqual({ domain: 'ledger', phase: 'query' });
    expect(ledger.snapshot('2026-09')).toEqual(before);
    expect(await controller.command(input)).toEqual(result);
    expect(payloads).toHaveLength(2);
    expect(ledger.snapshot('2026-09')).toEqual(before);
  });
  it.each([
    { query: { month: '2026-10' }, text: '查十月的待收回', title: '合成十月代垫', excluded: '合成九月代垫', cents: '20.00' },
    { query: { from: '2026-09-01', to: '2026-09-30' }, text: '查九月一日至三十日的待收回', title: '合成九月代垫', excluded: '合成十月代垫', cents: '10.00' },
  ])('lets an explicit query range override the visible month: $text', async ({ query, text, title, excluded, cents }) => {
    const { controller, ledger } = setup([route, { kind: 'query', query, detail: 'receivables' }]);
    importSynthetic(ledger, [
      syntheticEntry('sept', { date: '2026-09-12', month: '2026-09', title: '合成九月代垫', amountCents: 1000, personalCents: 0, cashflows: [{ accountId: 'alipay', deltaCents: -1000 }] }),
      syntheticEntry('oct', { title: '合成十月代垫', amountCents: 2000, personalCents: 0, cashflows: [{ accountId: 'alipay', deltaCents: -2000 }] }),
    ]);
    const queryCall = vi.spyOn(ledger, 'query');
    const result = await controller.command({ operationId: `explicit-${title}`, text, domain: 'ledger', ledgerView: { month: '2026-08', tab: 'flows' } });
    expect(result.ok).toBe(true); if (!result.ok) throw Error('query failed');
    expect(queryCall).toHaveBeenCalledWith(query);
    expect(result.data.reply).toContain(title); expect(result.data.reply).toContain(cents); expect(result.data.reply).not.toContain(excluded);
  });
  it('keeps a new expense on today while the user is browsing an earlier ledger month', async () => {
    const { controller, ledger, payloads } = setup([route, expense('alipay')]);
    const result = await controller.command({ operationId: 'today-from-history', text: '今天午饭20元支付宝', domain: 'ledger', ledgerView: { month: '2026-09', tab: 'flows' } });
    expect(result.ok).toBe(true);
    expect(ledger.snapshot().entries).toEqual([expect.objectContaining({ title: '午饭', date: '2026-10-23', month: '2026-10', amountCents: 2000 })]);
    expect(JSON.parse(payloads[1]!.messages.at(-1)!.content).context).toMatchObject({ now: at, defaultQueryMonth: '2026-09' });
    expect(ledger.snapshot('2026-09').summary.personalCents).toBe(0);
  });
  it('still answers a calendar question from the ledger page in one model call without sending bookkeeping records', async () => {
    const { controller, ledger, payloads } = setup([{ kind: 'query', reply: '合成课表查询', fromDate: '2026-10-24', toDate: '2026-10-24' }]);
    importSynthetic(ledger, [syntheticEntry('private-context', { title: '合成隐私账目' })]);
    const before = ledger.snapshot();
    const result = await controller.command({ operationId: 'calendar-on-ledger', text: '明天有什么课', domain: 'ledger', ledgerView: { month: '2026-09', tab: 'accounts' } });
    expect(result.ok).toBe(true); if (!result.ok) throw Error('query failed');
    expect(result.data.conversationState).toEqual({ domain: 'calendar', phase: 'query' });
    expect(payloads).toHaveLength(1);
    expect(JSON.stringify(payloads)).not.toContain('合成隐私账目');
    expect(ledger.snapshot()).toEqual(before);
  });
  it.each([
    { label: 'old client', context: {} },
    { label: 'cross-page query', context: { domain: 'calendar' as const, ledgerView: { month: '2026-09', tab: 'flows' as const } } },
  ])('defaults $label to the current month instead of an absent or stale ledger view', async ({ context }) => {
    const { controller, ledger, payloads } = setup([route, { kind: 'query', query: {}, detail: 'receivables' }]);
    importSynthetic(ledger, [syntheticEntry('current-advance', { title: '合成本月代垫', amountCents: 5000, personalCents: 0, cashflows: [{ accountId: 'alipay', deltaCents: -5000 }] })]);
    const queryCall = vi.spyOn(ledger, 'query');
    const result = await controller.command({ operationId: `current-month-${context.domain ?? 'legacy'}`, text: '我还有哪些代垫没收回', ...context });
    expect(result.ok).toBe(true); if (!result.ok) throw Error('query failed');
    expect(result.data.reply).toContain('合成本月代垫');
    expect(queryCall).toHaveBeenCalledTimes(1);
    const effectiveQuery = queryCall.mock.calls[0]![0];
    expect(effectiveQuery?.month ?? '2026-10').toBe('2026-10');
    const routing = JSON.parse(payloads[0]!.messages.at(-1)!.content).context;
    const ledgerView = JSON.parse(payloads[1]!.messages.at(-1)!.content).context;
    expect(routing.currentLedgerView == null).toBe(true);
    expect(ledgerView.currentView == null).toBe(true);
    expect(ledgerView.defaultQueryMonth).toBe('2026-10');
  });
});
