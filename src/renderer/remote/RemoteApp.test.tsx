// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PendingWrite, RecoveryArchive, RemoteClientState, RemoteController } from './types';
import { RemoteApp } from './RemoteApp';

vi.mock('../App',()=>({App:({remoteStatus,remoteSettings}:{remoteStatus:ReactNode;remoteSettings:ReactNode})=><main>{remoteStatus}{remoteSettings}</main>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();delete (navigator as unknown as Record<string,unknown>).serviceWorker;});
const identity={protocolVersion:1 as const,dataInstanceId:'11111111-1111-4111-8111-111111111111',generation:1};
const session={paired:true as const,identity,device:{id:'22222222-2222-4222-8222-222222222222',name:'合成手机'},csrfToken:'synthetic',aiConfigured:true};
function fake(initial:Partial<RemoteClientState>={}){
  let state:RemoteClientState={status:'online',session,cachedAt:'2026-10-24T14:12:00+08:00',pending:[],message:'',storageError:'',...initial};
  const listeners=new Set<()=>void>();
  const controller={client:{},getState:()=>state,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},initialize:vi.fn(async()=>{}),pair:vi.fn(async()=>{}),reconnect:vi.fn(async()=>{}),resolve:vi.fn(async()=>{}),logout:vi.fn(async()=>{}),devices:vi.fn(async()=>[{id:'synthetic-device',name:'合成设备',current:true}]),revokeDevice:vi.fn(async()=>{}),request:vi.fn(async()=>({enabled:true,publicKey:'BA',subscriptions:[]})),clearCache:vi.fn(async()=>{}),dispose:vi.fn()} as unknown as RemoteController;
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
    expect(screen.getByText(/没有公开注册入口/)).toBeTruthy();
  });
  it('requires an explicit durable archive choice before pairing again, and can inspect or export the archive locally',async()=>{
    const old=pending('uncertain');const archive:RecoveryArchive={id:'synthetic-archive',createdAt:'2026-10-24T14:30:00+08:00',reason:'原授权已失效',identity,device:session.device,cachedAt:'2026-10-24T14:12:00+08:00',pending:[old]};
    const f=fake({status:'expired',session:null,pending:[old]});
    f.controller.exportPending=vi.fn(async()=>archive);f.controller.archives=vi.fn(async()=>[archive]);
    f.controller.archivePending=vi.fn(async()=>{f.change({status:'unpaired',session:null,pending:[]});return archive;});
    const createUrl=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:synthetic-private-export');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
    render(<RemoteApp controller={f.controller}/>);
    expect((screen.getByRole('button',{name:'配对此设备'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'保留隔离档案并继续配对'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'导出旧队列（私密 JSON）'}));await waitFor(()=>expect(f.controller.exportPending).toHaveBeenCalledTimes(1));await waitFor(()=>expect(createUrl).toHaveBeenCalledTimes(1));
    expect(f.controller.archivePending).not.toHaveBeenCalled();expect(f.controller.pair).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('我选择将旧修改保留为本机隔离档案，不自动提交到新配对'));
    fireEvent.click(screen.getByRole('button',{name:'保留隔离档案并继续配对'}));await waitFor(()=>expect(f.controller.archivePending).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('隔离档案 · 合成手机')).toBeTruthy();expect(screen.getByText(/此项可能已在原服务执行/)).toBeTruthy();
    expect((screen.getByRole('button',{name:'配对此设备'}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'导出此隔离档案'}));await waitFor(()=>expect(createUrl).toHaveBeenCalledTimes(2));
    expect(f.controller.request).not.toHaveBeenCalled();expect(f.controller.resolve).not.toHaveBeenCalled();
  });
  it('leaves the old queue in place when isolation storage fails',async()=>{
    const f=fake({status:'expired',session:null,pending:[pending('queued')]});f.controller.archivePending=vi.fn(async()=>{throw Error('隔离档案储存失败，旧修改仍保留');});
    render(<RemoteApp controller={f.controller}/>);fireEvent.click(screen.getByLabelText('我选择将旧修改保留为本机隔离档案，不自动提交到新配对'));fireEvent.click(screen.getByRole('button',{name:'保留隔离档案并继续配对'}));await screen.findByRole('alert');
    expect((screen.getByRole('button',{name:'配对此设备'}) as HTMLButtonElement).disabled).toBe(true);expect(f.controller.pair).not.toHaveBeenCalled();expect(f.controller.resolve).not.toHaveBeenCalled();
  });
  it('renders exact live connection/cache state and prevents discarding uncertain or sending operations',async()=>{
    const writes=[pending('queued'),pending('uncertain'),pending('sending'),pending('conflict')];
    const f=fake({status:'offline',pending:writes});render(<RemoteApp controller={f.controller}/>);
    expect(screen.getByText('当前离线 · 未连接资料服务',{selector:'strong'})).toBeTruthy();
    expect(screen.getByText(/最后确认刷新：2026-10-24 14:12/)).toBeTruthy();
    for(const status of ['uncertain','sending']){const row=screen.getByRole('heading',{name:`合成修改-${status}`}).closest('article')!;expect(within(row).queryByRole('button',{name:'放弃这条手机修改'})).toBeNull();fireEvent.click(within(row).getByRole('button',{name:'查询原操作结果'}));await waitFor(()=>expect(f.controller.resolve).toHaveBeenCalledWith(status,'retry'));}
    const conflict=screen.getByRole('heading',{name:'合成修改-conflict'}).closest('article')!;
    expect(within(conflict).getByText('基于版本')).toBeTruthy();
    fireEvent.click(within(conflict).getByRole('button',{name:'按本机修改重新提交'}));await waitFor(()=>expect(f.controller.resolve).toHaveBeenCalledWith('conflict','use-local'));
    act(()=>f.change({status:'online'}));expect(screen.getByText('资料服务已连接',{selector:'strong'})).toBeTruthy();
    act(()=>f.change({status:'expired'}));expect(screen.getByRole('heading',{name:'重新连接此设备'})).toBeTruthy();
  });
  it('shows controller refusal to clear pending work and supports device list/revocation',async()=>{
    const f=fake({pending:[pending('queued')]});vi.mocked(f.controller.clearCache).mockRejectedValue(Error('仍有未提交修改，不能清理缓存'));
    render(<RemoteApp controller={f.controller}/>);
    fireEvent.click(screen.getByRole('button',{name:'清理手机缓存'}));await screen.findAllByText('仍有未提交修改，不能清理缓存');
    expect(f.controller.resolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'查看授权设备'}));await screen.findByText('合成设备（此设备）');
    fireEvent.click(screen.getByRole('button',{name:'撤销授权'}));await waitFor(()=>expect(f.controller.revokeDevice).toHaveBeenCalledWith('synthetic-device'));
  });
  it('lets the user abandon an unconfirmed preview and does not retry terminal failures',async()=>{
    const f=fake({pending:[pending('review'),pending('failed')]});render(<RemoteApp controller={f.controller}/>);
    const review=screen.getByRole('heading',{name:'合成修改-review'}).closest('article')!;
    fireEvent.click(within(review).getByRole('button',{name:'放弃预览'}));await waitFor(()=>expect(f.controller.resolve).toHaveBeenCalledWith('review','discard'));
    const failed=screen.getByRole('heading',{name:'合成修改-failed'}).closest('article')!;
    expect(within(failed).queryByRole('button',{name:'重试原操作'})).toBeNull();
    expect(within(failed).getByRole('button',{name:'放弃这条手机修改'})).toBeTruthy();
  });
  it('allows discarding a blocked dependency only when it has never received wire input',async()=>{
    const unsent={...pending('blocked'),id:'blocked-unsent',label:'尚未发送的依赖修改'};
    const sent={...pending('blocked'),id:'blocked-sent',label:'已有发送内容的依赖修改',wireInput:{operationId:'synthetic-original-request'}};
    const f=fake({pending:[unsent,sent]});render(<RemoteApp controller={f.controller}/>);
    const unsentRow=screen.getByRole('heading',{name:unsent.label}).closest('article')!;
    const sentRow=screen.getByRole('heading',{name:sent.label}).closest('article')!;
    expect(within(sentRow).queryByRole('button',{name:'放弃这条手机修改'})).toBeNull();
    fireEvent.click(within(unsentRow).getByRole('button',{name:'放弃这条手机修改'}));
    await waitFor(()=>expect(f.controller.resolve).toHaveBeenCalledWith('blocked-unsent','discard'));
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
    expect(permission).not.toHaveBeenCalled();expect(register).not.toHaveBeenCalled();expect(f.controller.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'启用通知'}));
    await waitFor(()=>expect(f.controller.request).toHaveBeenCalledWith('/api/v1/push/subscribe',expect.objectContaining({showDetails:false}),'POST'));
    expect(register).toHaveBeenCalledWith('/sw.js');expect(order[0]).toBe('permission');expect(subscribe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.controller.request).mock.calls.some(([path])=>path==='/api/v1/push/test')).toBe(false);
    expect(screen.getByText(/分析失败时暂存不超过 24 小时/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button',{name:'查看订阅状态'}));await screen.findByLabelText('通知显示事项细节');
    fireEvent.click(screen.getByLabelText('通知显示事项细节'));
    await waitFor(()=>expect(f.controller.request).toHaveBeenCalledWith('/api/v1/push/subscribe',expect.objectContaining({showDetails:true}),'POST'));
    await waitFor(()=>expect((screen.getByLabelText('通知显示事项细节') as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole('button',{name:'关闭此订阅'}));
    await waitFor(()=>expect(f.controller.request).toHaveBeenCalledWith('/api/v1/push/unsubscribe',{subscriptionId:id},'POST'));
    await waitFor(()=>expect(unsubscribe).toHaveBeenCalledTimes(1));
  });
});
