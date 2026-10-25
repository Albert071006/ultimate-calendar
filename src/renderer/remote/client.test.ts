import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createRemoteService } from '../../server/service';
import { RemoteFault } from '../../server/state';
import { RemoteMethodSchema, RemoteRequestSchema } from '../../shared/remote';
import { BlockInputSchema, MutationRequestSchema, TaskInputSchema } from '../../shared/contracts';
import { LedgerEntryDraftSchema, LedgerMutationRequestSchema } from '../../shared/ledger';
import { createRemoteClient } from './client';
import { createMemoryStorage, type OfflineStorage } from './storage';
import type { RemoteController } from './types';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const origin='https://synthetic-calendar.example';
const taskInput=(title:string,operationId=crypto.randomUUID())=>MutationRequestSchema.parse({operationId,origin:'manual',mutations:[{type:'create',entity:'task',values:TaskInputSchema.parse({title})}]});

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'ultimate-calendar-client-'));
  cleanup.push(async()=>{const part=relative(tmpdir(),directory);if(!part||part.startsWith('..')||isAbsolute(part))throw Error('Test cleanup escaped temporary directory');rmSync(directory,{recursive:true,force:true});});
  const service=createRemoteService({dataDirectory:directory,backupDirectory:join(directory,'synthetic-backups'),getApiKey:async()=>null,controller:{fetch:async()=>{throw Error('This integration test must never call AI or the internet');}}});
  cleanup.push(()=>service.close());
  function browser(storage:OfflineStorage=createMemoryStorage()){
    let token:string|undefined,online=true,dropWrite=false;
    const calls:{path:string;method:string;input:unknown}[]=[];
    const fetcher:typeof fetch=async(input,init={})=>{
      if(!online)throw TypeError('Synthetic phone network is offline');
      const url=new URL(input instanceof Request?input.url:String(input));if(url.origin!==origin)throw Error('No external request allowed');
      const method=init.method??'GET';const payload=typeof init.body==='string'?JSON.parse(init.body):undefined;
      calls.push({path:url.pathname,method,input:payload});
      const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
      try{
        if(url.pathname==='/api/v1/pair'){
          const paired=service.state.pair(payload.code,payload.name);token=paired.token;
          return json({paired:true,identity:service.state.identity(),device:paired.device,csrfToken:paired.csrfToken,aiConfigured:false});
        }
        const current=service.state.session(token);
        if(url.pathname==='/api/v1/session')return json(current?{paired:true,identity:service.state.identity(),device:current.device,csrfToken:current.csrfToken,aiConfigured:false}:{paired:false});
        if(!current)return json({ok:false,error:{message:'Synthetic authorization expired'}},401);
        const rpc=/^\/api\/v1\/rpc\/([^/]+)$/.exec(url.pathname);
        if(rpc){
          const rpcMethod=RemoteMethodSchema.parse(rpc[1]);const request=RemoteRequestSchema.parse(payload);
          const result=await service.rpc(rpcMethod,request,current.device.id);
          if(dropWrite&&!['snapshot','ledgerSnapshot'].includes(rpcMethod)){dropWrite=false;online=false;throw TypeError('Synthetic response lost after server commit');}
          return json(result);
        }
        const operation=/^\/api\/v1\/operations\/(.+)$/.exec(url.pathname);
        if(operation)return json(service.state.operation(decodeURIComponent(operation[1]!),current.device.id));
        if(url.pathname==='/api/v1/devices')return json({devices:service.state.devices()});
        if(url.pathname==='/api/v1/logout'){service.state.revoke(current.device.id);token=undefined;return json({ok:true});}
        throw Error('Unexpected synthetic route: '+url.pathname);
      }catch(error){if(error instanceof RemoteFault)return json({ok:false,error:{message:error.message}},error.status);throw error;}
    };
    function open(){const controller=createRemoteClient({origin,storage,fetch:fetcher,timeoutMs:2000});cleanup.push(async()=>controller.dispose());return controller;}
    return{storage,calls,open,setOnline:(value:boolean)=>{online=value;},loseNextWriteResponse:()=>{dropWrite=true;},expireAuthorization:()=>{const current=service.state.session(token);if(current)service.state.revoke(current.device.id);}};
  }
  async function pair(controller:RemoteController,name='合成手机'){await controller.initialize();expect(controller.getState().status).toBe('unpaired');await controller.pair(service.state.createPairingCode(),name);expect(controller.getState().status).toBe('online');}
  return{directory,service,browser,pair};
}

describe('durable remote client against a real synthetic authority',()=>{
  it('keeps an HTTP 401 authorization failure sticky when the network subsequently goes offline',async()=>{
    const f=await fixture();const phone=f.browser(),controller=phone.open();await f.pair(controller);phone.expireAuthorization();
    expect(await controller.client.snapshot()).toMatchObject({ok:false,error:{code:'AUTH'}});expect(controller.getState().status).toBe('expired');
    phone.setOnline(false);await controller.reconnect();expect(controller.getState().status).toBe('expired');
    expect(await controller.client.mutate(taskInput('不得越过授权的离线任务'))).toMatchObject({ok:false,error:{code:'AUTH'}});
    expect(controller.getState().pending).toHaveLength(0);expect(f.service.snapshot().tasks).toHaveLength(0);
  });
  it('retains but does not extend the old outbox after paired:false followed by a network outage',async()=>{
    const f=await fixture();const phone=f.browser(),controller=phone.open();await f.pair(controller);
    phone.setOnline(false);await controller.reconnect();await controller.client.mutate(taskInput('失效前已暂存的合成任务'));const requestId=controller.getState().pending[0]!.requestId;
    phone.expireAuthorization();phone.setOnline(true);await controller.reconnect();expect(controller.getState().status).toBe('expired');
    phone.setOnline(false);await controller.reconnect();expect(controller.getState().status).toBe('expired');
    expect(await controller.client.mutate(taskInput('失效后禁止新增离线队列'))).toMatchObject({ok:false,error:{code:'AUTH'}});
    expect(controller.getState().pending).toHaveLength(1);expect(controller.getState().pending[0]!.requestId).toBe(requestId);expect(f.service.snapshot().tasks).toHaveLength(0);
  });
  it('persists an offline task and dependent execution block, then resolves local identifiers once for a second device',async()=>{
    const f=await fixture();const phone=f.browser(),controller=phone.open();await f.pair(controller);
    phone.setOnline(false);await controller.reconnect();expect(controller.getState().status).toBe('offline');
    const result=await controller.client.mutate(taskInput('合成离线任务'));expect(result).toMatchObject({ok:true,data:{status:'queued'}});
    const projected=await controller.client.snapshot();expect(projected.ok).toBe(true);if(!projected.ok)throw Error('No projected cache');
    const task=projected.data.tasks.find(value=>value.title==='合成离线任务')!;expect(task.id).toMatch(/^local:/);
    const block=MutationRequestSchema.parse({operationId:crypto.randomUUID(),origin:'manual',mutations:[{type:'create',entity:'block',values:BlockInputSchema.parse({title:'合成执行时段',kind:'work',taskId:task.id,start:'2030-01-10T15:10:00+08:00',end:'2030-01-10T15:55:00+08:00'})}]});
    expect(await controller.client.mutate(block)).toMatchObject({ok:true,data:{status:'queued'}});
    const queue=controller.getState().pending;expect(queue).toHaveLength(2);expect(queue[1]!.dependencies).toContain(queue[0]!.id);
    expect(f.service.snapshot().tasks).toHaveLength(0);expect(f.service.snapshot().blocks).toHaveLength(0);
    phone.setOnline(true);await controller.reconnect();
    expect(controller.getState().pending).toHaveLength(0);const canonical=f.service.snapshot();expect(canonical.tasks).toHaveLength(1);expect(canonical.blocks).toHaveLength(1);expect(canonical.blocks[0]!.taskId).toBe(canonical.tasks[0]!.id);
    expect(canonical.tasks[0]!.id).not.toMatch(/^local:/);expect(phone.calls.filter(call=>call.path==='/api/v1/rpc/mutate')).toHaveLength(2);
    const other=f.browser(),second=other.open();await f.pair(second,'合成第二设备');const seen=await second.client.snapshot();expect(seen.ok&&seen.data.tasks[0]?.id).toBe(canonical.tasks[0]!.id);expect(seen.ok&&seen.data.blocks[0]?.taskId).toBe(canonical.tasks[0]!.id);
  });

  it('recovers a committed write with a lost response after reopening by querying the same request id',async()=>{
    const f=await fixture();const phone=f.browser();const first=phone.open();await f.pair(first);
    phone.loseNextWriteResponse();await first.client.mutate(taskInput('合成回执丢失任务'));
    expect(f.service.snapshot().tasks).toHaveLength(1);expect(first.getState().pending).toHaveLength(1);expect(first.getState().pending[0]!.status).toBe('uncertain');
    const requestId=first.getState().pending[0]!.requestId;first.dispose();
    const reopened=phone.open();await reopened.initialize();expect(reopened.getState().status).toBe('offline');expect(reopened.getState().pending[0]!.requestId).toBe(requestId);
    phone.setOnline(true);await reopened.reconnect();
    expect(phone.calls.some(call=>call.path==='/api/v1/operations/'+requestId)).toBe(true);
    expect(phone.calls.filter(call=>call.path==='/api/v1/rpc/mutate')).toHaveLength(1);
    expect(reopened.getState().pending).toHaveLength(0);expect(f.service.snapshot().tasks).toHaveLength(1);
    const snapshot=await reopened.client.snapshot();expect(snapshot.ok&&snapshot.data.tasks).toHaveLength(1);
  });

  it('isolates old queued work after a service generation change and never replays it into restored data',async()=>{
    const f=await fixture();const phone=f.browser(),controller=phone.open();await f.pair(controller);
    phone.setOnline(false);await controller.reconnect();await controller.client.mutate(taskInput('合成旧代际手机任务'));
    const old=controller.getState().pending[0]!;f.service.state.advanceGeneration();phone.setOnline(true);
    await expect(controller.reconnect()).rejects.toThrow(/代际|授权/);
    expect(controller.getState().status).toBe('expired');expect(controller.getState().pending[0]!.requestId).toBe(old.requestId);expect(controller.getState().pending[0]!.identity.generation).toBe(old.identity.generation);
    expect(phone.calls.filter(call=>call.path==='/api/v1/rpc/mutate')).toHaveLength(0);expect(f.service.snapshot().tasks).toHaveLength(0);
    await expect(controller.clearCache()).rejects.toThrow(/未提交|未知/);await expect(controller.logout()).rejects.toThrow(/未提交|未知/);
  });

  it('does not send an online mutation unless the phone outbox was durably stored',async()=>{
    const f=await fixture();const memory=createMemoryStorage();let fail=false;
    const storage:OfflineStorage={read:memory.read,remove:memory.remove,write:async(key,value)=>{if(fail)throw Error('Synthetic quota exceeded');await memory.write(key,value);}};
    const phone=f.browser(storage),controller=phone.open();await f.pair(controller);fail=true;
    const input=taskInput('合成储存失败任务');const result=await controller.client.mutate(input);
    expect(result).toMatchObject({ok:false,error:{code:'STORAGE'}});expect(controller.getState().storageError).toContain('储存');expect(controller.getState().pending).toHaveLength(0);
    expect(phone.calls.filter(call=>call.path==='/api/v1/rpc/mutate')).toHaveLength(0);expect(f.service.snapshot().tasks).toHaveLength(0);
    fail=false;expect(await controller.client.mutate(input)).toMatchObject({ok:true,data:{status:'applied'}});expect(f.service.snapshot().tasks).toHaveLength(1);
  });

  it('keeps an offline expense draft out of formal account balances until the authority confirms it',async()=>{
    const f=await fixture();const phone=f.browser(),controller=phone.open();await f.pair(controller);
    const before=await controller.client.ledgerSnapshot({month:'2020-01'});if(!before.ok)throw Error('Missing synthetic ledger');
    phone.setOnline(false);await controller.reconnect();
    const entry=LedgerEntryDraftSchema.parse({id:'synthetic-expense',kind:'expense',date:'2020-01-10',month:'2020-01',title:'合成午餐',category:'餐饮',amountCents:1800,personalCents:1800,cashflows:[{accountId:'wechat',deltaCents:-1800}]});
    const input=LedgerMutationRequestSchema.parse({operationId:crypto.randomUUID(),expectedRevision:before.data.revision,month:'2020-01',changes:[{type:'putEntry',entry,expectedVersion:null}]});
    expect(await controller.client.ledgerMutate(input)).toMatchObject({ok:true,data:{status:'queued'}});
    const offline=await controller.client.ledgerSnapshot({month:'2020-01'});expect(offline.ok&&offline.data.summary).toEqual(before.data.summary);expect(offline.ok&&offline.data.entries).toEqual(before.data.entries);expect(controller.getState().pending).toHaveLength(1);
    phone.setOnline(true);await controller.reconnect();expect(controller.getState().pending).toEqual([]);
    const after=await controller.client.ledgerSnapshot({month:'2020-01'});if(!after.ok)throw Error('Missing confirmed ledger');expect(after.data.entries.some(value=>value.id===entry.id)).toBe(true);expect(after.data.summary.personalCents).toBe(before.data.summary.personalCents+1800);expect(after.data.summary.accounts.find(value=>value.id==='wechat')!.periodChangeCents).toBe(-1800);
  });

  it('does not overwrite a second device edit when an offline update reaches a newer version',async()=>{
    const f=await fixture();const one=f.browser(),first=one.open();await f.pair(first);await first.client.mutate(taskInput('合成跨设备任务'));const task=f.service.snapshot().tasks[0]!;
    const two=f.browser(),second=two.open();await f.pair(second,'第二台合成手机');
    const update=(title:string)=>MutationRequestSchema.parse({operationId:crypto.randomUUID(),origin:'manual',mutations:[{type:'update',entity:'task',id:task.id,expectedVersion:task.version,values:{title}}]});
    one.setOnline(false);await first.reconnect();expect(await first.client.mutate(update('第一台离线修改'))).toMatchObject({ok:true,data:{status:'queued'}});
    expect(await second.client.mutate(update('第二台已经保存'))).toMatchObject({ok:true,data:{status:'applied'}});
    one.setOnline(true);await first.reconnect();expect(first.getState().pending[0]!.status).toBe('conflict');expect(f.service.snapshot().tasks[0]!.title).toBe('第二台已经保存');
    await first.resolve(first.getState().pending[0]!.id,'discard');expect(first.getState().pending).toHaveLength(0);expect(f.service.snapshot().tasks[0]!.title).toBe('第二台已经保存');
  });
});


