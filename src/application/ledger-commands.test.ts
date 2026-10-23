import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepository, type Repository } from '../storage/repository';
import { createPlanner } from '../domain/planner';
import { createLedgerService, type LedgerService } from '../ledger/service';
import { createController } from './controller';
import { WorkflowError } from '../ai/deepseek';
import { LedgerEntryDraftSchema } from '../shared/ledger';

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
describe('main assistant local ledger commands',()=>{
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
    expect((await controller.command(request)).ok).toBe(false);
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
});
