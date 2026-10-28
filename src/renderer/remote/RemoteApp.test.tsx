// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PendingWrite, RecoveryArchive, RemoteClientState, RemoteController } from './types';
import { RemoteApp } from './RemoteApp';

vi.mock('../mobile/MobileApp',()=>({MobileApp:({settingsPages,pendingView}:{settingsPages:{id:string;label:string;content:ReactNode}[];pendingView:ReactNode})=><main><aside data-testid="pending">{pendingView}</aside>{settingsPages.map(page=><section key={page.id} aria-label={page.label}>{page.content}</section>)}</main>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();delete (navigator as unknown as Record<string,unknown>).serviceWorker;});
const identity={protocolVersion:1 as const,dataInstanceId:'11111111-1111-4111-8111-111111111111',generation:1};
const session={paired:true as const,identity,device:{id:'22222222-2222-4222-8222-222222222222',name:'合成手机'},csrfToken:'synthetic',aiConfigured:true};
function fake(initial:Partial<RemoteClientState>={}){
  let state:RemoteClientState={status:'online',session,cachedAt:'2026-10-24T14:12:00+08:00',pending:[],message:'',storageError:'',...initial};
  const listeners=new Set<()=>void>();
  const controller={client:{},getState:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},initialize:vi.fn(async()=>{}),pair:vi.fn(async()=>{}),reconnect:vi.fn(async()=>{}),resolve:vi.fn(async()=>{}),logout:vi.fn(async()=>{}),devices:vi.fn(async()=>[{id:'synthetic-current',name:'合成手机',current:true},{id:'synthetic-device',name:'合成设备'}]),archives:vi.fn(async()=>[]),revokeDevice:vi.fn(async()=>{}),request:vi.fn(async()=>({enabled:true,publicKey:'BA',subscriptions:[]})),clearCache:vi.fn(async()=>{}),dispose:vi.fn()} as unknown as RemoteController;
  return {controller,change:(next:Partial<RemoteClientState>)=>{state={...state,...next};for(const listener of listeners)listener();}};
}
function pending(status:PendingWrite['status'],id=status):PendingWrite{return{id,requestId:id,method:'mutate',input:{mutations:[{type:'update',entity:'task',expectedVersion:12,values:{title:'手机修改',deadline:{date:'2026-10-25',time:'22:00'}}}]},identity,createdAt:'2026-10-24T14:15:00+08:00',status,label:`合成修改-${status}`,message:'',dependencies:[],targets:['synthetic-task'],base:{title:'原名称',version:12}};}

describe('remote browser shell',()=>{
  it('initializes and pairs explicitly with a generated code and device name',async()=>{
    const f=fake({status:'unpaired',session:null});render(<RemoteApp controller={f.controller}/>);
    await waitFor(()=>expect(f.controller.initialize).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('配对码'),{target:{value:'synthetic-high-entropy-code'}});
    fireEvent.change(screen.getByLabelText('设备名称'),{target:{value:'测试手机'}});
    fireEvent.submit(screen.getByRole('button',{name:'配对此设备'}).closest('form')!);
    await waitFor(()=>expect(f.controller.pair).toHaveBeenCalledWith('synthetic-high-entropy-code','测试手机'));
    expect(screen.getByText(/10 分钟内有效/)).toBeTruthy();
  });
  it('requires an explicit durable archive choice before pairing again, and can inspect or export the archive locally',async()=>{
    const old=pending('uncertain');const archive:RecoveryArchive={id:'synthetic-archive',createdAt:'2026-10-24T14:30:00+08:00',reason:'原授权已失效',identity,device:session.device,cachedAt:'2026-10-24T14:12:00+08:00',pending:[old]};
    const f=fake({status:'expired',session:null,pending:[old]});let archived=false;
    f.controller.exportPending=vi.fn(async()=>archive);f.controller.archives=vi.fn(async()=>archived?[archive]:[]);
    f.controller.archivePending=vi.fn(async()=>{archived=true;f.change({status:'unpaired',session:null,pending:[]});return archive;});
    const createUrl=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:synthetic-private-export');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
    render(<RemoteApp controller={f.controller}/>);
    expect((screen.getByRole('button',{name:'配对此设备'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'保存档案并继续'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'导出为文件'}));await waitFor(()=>expect(f.controller.exportPending).toHaveBeenCalledTimes(1));await waitFor(()=>expect(createUrl).toHaveBeenCalledTimes(1));
    expect(f.controller.archivePending).not.toHaveBeenCalled();expect(f.controller.pair).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('保存为本机档案，不提交到新配对'));
    fireEvent.click(screen.getByRole('button',{name:'保存档案并继续'}));await waitFor(()=>expect(f.controller.archivePending).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('合成手机 · 1 项')).toBeTruthy();expect(screen.getByText(/可能已在原云端执行/)).toBeTruthy();
    expect((screen.getByRole('button',{name:'配对此设备'}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'导出'}));await waitFor(()=>expect(createUrl).toHaveBeenCalledTimes(2));
    expect(f.controller.request).not.toHaveBeenCalled();expect(f.controller.resolve).not.toHaveBeenCalled();
  });
  it('leaves the old queue in place when isolation storage fails',async()=>{
    const f=fake({status:'expired',session:null,pending:[pending('queued')]});f.controller.archivePending=vi.fn(async()=>{throw Error('隔离档案储存失败，旧修改仍保留');});
    render(<RemoteApp controller={f.controller}/>);fireEvent.click(screen.getByLabelText('保存为本机档案，不提交到新配对'));fireEvent.click(screen.getByRole('button',{name:'保存档案并继续'}));await screen.findByRole('alert');
    expect((screen.getByRole('button',{name:'配对此设备'}) as HTMLButtonElement).disabled).toBe(true);expect(f.controller.pair).not.toHaveBeenCalled();expect(f.controller.resolve).not.toHaveBeenCalled();
  });
  it('names the live connection state and prevents discarding uncertain or sending operations',async()=>{
    const writes=[pending('queued'),pending('uncertain'),pending('sending'),pending('conflict')];
    const f=fake({status:'offline',pending:writes});render(<RemoteApp controller={f.controller}/>);
    const panel=within(screen.getByTestId('pending'));
    expect(panel.getByText(/^离线/)).toBeTruthy();
    for(const status of ['uncertain','sending']){const row=panel.getByText(`合成修改-${status}`).closest('article')!;expect(within(row).queryByRole('button',{name:'放弃'})).toBeNull();fireEvent.click(within(row).getByRole('button',{name:'查询结果'}));await waitFor(()=>expect(f.controller.resolve).toHaveBeenCalledWith(status,'retry'));}
    const conflict=panel.getByText('合成修改-conflict').closest('article')!;
    expect(within(conflict).getByText('有冲突')).toBeTruthy();expect(within(conflict).getByText('基于版本')).toBeTruthy();
    fireEvent.click(within(conflict).getByRole('button',{name:'按我的修改重新提交'}));await waitFor(()=>expect(f.controller.resolve).toHaveBeenCalledWith('conflict','use-local'));
    act(()=>f.change({status:'online'}));expect(panel.getByText(/^云端已连接/)).toBeTruthy();
    act(()=>f.change({status:'expired'}));expect(screen.getByRole('heading',{name:'重新连接这台手机'})).toBeTruthy();
  });
  it('shows controller refusal to clear pending work and revokes another device only after confirming',async()=>{
    const f=fake({pending:[pending('queued')]});vi.mocked(f.controller.clearCache).mockRejectedValue(Error('仍有未提交修改，不能清理缓存'));
    render(<RemoteApp controller={f.controller}/>);
    const device=within(screen.getByRole('region',{name:'设备与连接'}));
    fireEvent.click(device.getByRole('button',{name:'清理缓存'}));fireEvent.click(device.getByRole('button',{name:'确认清理缓存'}));
    await device.findByText('仍有未提交修改，不能清理缓存');expect(f.controller.resolve).not.toHaveBeenCalled();
    await device.findByText('合成设备');expect(device.getAllByRole('button',{name:'撤销'})).toHaveLength(1);
    fireEvent.click(device.getByRole('button',{name:'撤销'}));expect(f.controller.revokeDevice).not.toHaveBeenCalled();
    fireEvent.click(device.getByRole('button',{name:'确认撤销'}));await waitFor(()=>expect(f.controller.revokeDevice).toHaveBeenCalledWith('synthetic-device'));
  });
  it('lets the user abandon an unconfirmed preview and does not retry terminal failures',async()=>{
    const f=fake({pending:[pending('review'),pending('failed')]});render(<RemoteApp controller={f.controller}/>);
    const panel=within(screen.getByTestId('pending'));
    const review=panel.getByText('合成修改-review').closest('article')!;
    fireEvent.click(within(review).getByRole('button',{name:'放弃'}));await waitFor(()=>expect(f.controller.resolve).toHaveBeenCalledWith('review','discard'));
    const failed=panel.getByText('合成修改-failed').closest('article')!;
    expect(within(failed).queryByRole('button',{name:'重试'})).toBeNull();
    expect(within(failed).getByRole('button',{name:'放弃'})).toBeTruthy();
  });
  it('allows discarding a blocked dependency only when it has never received wire input',async()=>{
    const unsent={...pending('blocked'),id:'blocked-unsent',label:'尚未发送的依赖修改'};
    const sent={...pending('blocked'),id:'blocked-sent',label:'已有发送内容的依赖修改',wireInput:{operationId:'synthetic-original-request'}};
    const f=fake({pending:[unsent,sent]});render(<RemoteApp controller={f.controller}/>);
    const panel=within(screen.getByTestId('pending'));
    const unsentRow=panel.getByText(unsent.label).closest('article')!;
    const sentRow=panel.getByText(sent.label).closest('article')!;
    expect(within(sentRow).queryByRole('button',{name:'放弃'})).toBeNull();
    fireEvent.click(within(unsentRow).getByRole('button',{name:'放弃'}));
    await waitFor(()=>expect(f.controller.resolve).toHaveBeenCalledWith('blocked-unsent','discard'));
  });
  it('drops a definitively failed assistant request from the queue but keeps other failures for review',async()=>{
    const command={...pending('failed'),id:'failed-command',method:'command' as const,label:'生活助手请求'};
    const f=fake({pending:[command,pending('failed')]});render(<RemoteApp controller={f.controller}/>);
    await waitFor(()=>expect(f.controller.resolve).toHaveBeenCalledWith('failed-command','discard'));
    expect(f.controller.resolve).not.toHaveBeenCalledWith('failed','discard');
  });
  it('never asks notification permission on render, and subscribes only after the explicit button click',async()=>{
    const f=fake();const order:string[]=[];
    const permission=vi.fn(async()=>{order.push('permission');return 'granted';});
    const subscribe=vi.fn(async()=>({endpoint:'https://web.push.apple.com/synthetic',toJSON:()=>({endpoint:'https://web.push.apple.com/synthetic',keys:{p256dh:'synthetic',auth:'synthetic'}})}));
    const registration={pushManager:{getSubscription:vi.fn(async()=>null),subscribe}};
    const register=vi.fn(async()=>registration);
    Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register,ready:Promise.resolve(registration)}});
    vi.stubGlobal('PushManager',class{});vi.stubGlobal('Notification',{requestPermission:permission});
    vi.mocked(f.controller.request).mockImplementation(async(path)=>{order.push(path);return {enabled:true,publicKey:'BA',subscriptions:[]} as never;});
    render(<RemoteApp controller={f.controller}/>);
    const page=within(screen.getByRole('region',{name:'手机提醒'}));
    const button=await page.findByRole('button',{name:'开启提醒'});
    expect(permission).not.toHaveBeenCalled();expect(register).not.toHaveBeenCalled();
    expect(vi.mocked(f.controller.request).mock.calls.every(([path])=>path==='/api/v1/push'||path==='/api/v1/ai/config'||path==='/api/v1/rpc/snapshot')).toBe(true);
    order.length=0;
    fireEvent.click(button);
    await waitFor(()=>expect(f.controller.request).toHaveBeenCalledWith('/api/v1/push/subscribe',expect.objectContaining({showDetails:false}),'POST'));
    expect(register).toHaveBeenCalledWith('/sw.js');expect(order[0]).toBe('permission');expect(subscribe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.controller.request).mock.calls.some(([path])=>path==='/api/v1/push/test')).toBe(false);
  });
  it('updates notification detail preferences and cancels the matching browser subscription',async()=>{
    const f=fake();const id='00'.repeat(32);let active=true,showDetails=false;
    const unsubscribe=vi.fn(async()=>true);
    const subscription={endpoint:'https://web.push.apple.com/synthetic',toJSON:()=>({endpoint:'https://web.push.apple.com/synthetic'}),unsubscribe};
    Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{getRegistration:vi.fn(async()=>({pushManager:{getSubscription:vi.fn(async()=>subscription)}}))}});
    vi.stubGlobal('crypto',{subtle:{digest:vi.fn(async()=>new Uint8Array(32).buffer)}});
    vi.mocked(f.controller.request).mockImplementation(async(path,input)=>{
      if(path==='/api/v1/push/subscribe')showDetails=(input as {showDetails:boolean}).showDetails;
      if(path==='/api/v1/push/unsubscribe')active=false;
      return {enabled:true,publicKey:'BA',subscriptions:active?[{id,deviceId:'synthetic',active:true,showDetails,createdAt:'2026-10-24T14:00:00+08:00',updatedAt:'2026-10-24T14:00:00+08:00'}]:[]} as never;
    });
    render(<RemoteApp controller={f.controller}/>);
    const page=within(screen.getByRole('region',{name:'手机提醒'}));
    fireEvent.click(await page.findByLabelText(/通知里显示事项内容/));
    await waitFor(()=>expect(f.controller.request).toHaveBeenCalledWith('/api/v1/push/subscribe',expect.objectContaining({showDetails:true}),'POST'));
    await waitFor(()=>expect((page.getByLabelText(/通知里显示事项内容/) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(page.getByRole('button',{name:'关闭提醒'}));
    await waitFor(()=>expect(f.controller.request).toHaveBeenCalledWith('/api/v1/push/unsubscribe',{subscriptionId:id},'POST'));
    await waitFor(()=>expect(unsubscribe).toHaveBeenCalledTimes(1));
  });
  it('saves a phone-managed key with the read revision, clears the field and never echoes the key',async()=>{
    const f=fake();let configuration={provider:'deepseek',configured:false,editable:true,source:'none',revision:null as string|null};
    vi.mocked(f.controller.request).mockImplementation(async(path,_input,method)=>{
      if(path!=='/api/v1/ai/config')return {enabled:false,publicKey:null,subscriptions:[]} as never;
      if(method==='PUT')configuration={...configuration,configured:true,source:'managed',revision:'33333333-3333-4333-8333-333333333333'};
      return {ok:true,identity,configuration} as never;
    });
    render(<RemoteApp controller={f.controller}/>);
    const page=within(screen.getByRole('region',{name:'生活助手'}));
    await page.findByText('未配置');
    const field=page.getByLabelText('粘贴 Key') as HTMLInputElement;
    fireEvent.change(field,{target:{value:'short'}});
    expect(page.getByText('应为 16–512 位，不含空格。')).toBeTruthy();expect((page.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field,{target:{value:'  synthetic-example-key-do-not-use  '}});
    fireEvent.click(page.getByRole('button',{name:'保存'}));
    await waitFor(()=>expect(f.controller.request).toHaveBeenCalledWith('/api/v1/ai/config',{identity,expectedRevision:null,apiKey:'synthetic-example-key-do-not-use'},'PUT'));
    await page.findByText('已配置');expect((page.getByLabelText('换一个 Key') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText(/synthetic-example-key/)).toBeNull();
  });
  it('re-reads after a revision conflict and asks to check, without resending, when the result is unclear',async()=>{
    const f=fake();let puts=0;const conflict=Object.assign(Error('配置已变化'),{status:409});
    vi.mocked(f.controller.request).mockImplementation(async(path,_input,method)=>{
      if(path!=='/api/v1/ai/config')return {enabled:false,publicKey:null,subscriptions:[]} as never;
      if(method==='PUT'){puts++;throw puts===1?conflict:TypeError('Load failed');}
      return {ok:true,identity,configuration:{provider:'deepseek',configured:false,editable:true,source:'none',revision:null}} as never;
    });
    render(<RemoteApp controller={f.controller}/>);
    const page=within(screen.getByRole('region',{name:'生活助手'}));
    fireEvent.change(await page.findByLabelText('粘贴 Key'),{target:{value:'synthetic-example-key-do-not-use'}});
    fireEvent.click(page.getByRole('button',{name:'保存'}));await page.findByText(/刚在其他设备改过/);
    fireEvent.click(page.getByRole('button',{name:'保存'}));await page.findByText(/保存结果待核对/);
    expect(puts).toBe(2);
    const reads=()=>vi.mocked(f.controller.request).mock.calls.filter(([path,,method])=>path==='/api/v1/ai/config'&&!method).length,before=reads();
    fireEvent.click(page.getByRole('button',{name:'核对云端状态'}));await waitFor(()=>expect(reads()).toBe(before+1));expect(puts).toBe(2);
  });
  it('shows an administrator-provided key as read-only',async()=>{
    const f=fake();
    vi.mocked(f.controller.request).mockImplementation(async(path)=>path==='/api/v1/ai/config'?{ok:true,identity,configuration:{provider:'deepseek',configured:true,editable:false,source:'external',revision:null}} as never:{enabled:false,publicKey:null,subscriptions:[]} as never);
    render(<RemoteApp controller={f.controller}/>);
    const page=within(screen.getByRole('region',{name:'生活助手'}));
    await page.findByText('由服务器管理');expect(page.queryByRole('textbox')).toBeNull();expect(page.queryByRole('button',{name:'清除 Key'})).toBeNull();
  });
});
