import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { MobileApp } from '../mobile/MobileApp';
import { Preview } from '../components/Preview';
import type { PushSubscriptionSummary } from '../../shared/push';
import type { DeviceSummary, PendingWrite, RecoveryArchive, RemoteClientState, RemoteController } from './types';
import './remote.css';

const states: Record<RemoteClientState['status'], string> = { connecting: '正在连接资料服务', online: '资料服务已连接', offline: '当前离线 · 未连接资料服务', unpaired: '尚未配对', expired: '设备会话已失效', error: '资料服务连接异常' };
const shortStates: Record<RemoteClientState['status'], string> = { connecting: '正在连接云端', online: '云端已连接', offline: '离线', unpaired: '尚未配对', expired: '设备授权已失效', error: '云端连接异常' };
const shortQueueStates: Record<PendingWrite['status'], string> = { queued: '待提交', sending: '正在提交', uncertain: '结果待核对', conflict: '有冲突', review: '待确认', failed: '未保存', blocked: '等待前一项' };
const queueStates: Record<PendingWrite['status'], string> ={ queued: '待提交 · 仅在此手机暂存', sending: '正在发送 · 等待服务确认', uncertain: '结果未知 · 须查询原操作', conflict: '版本冲突 · 尚未保存', review: '待确认预览 · 尚未保存', failed: '提交失败 · 尚未保存', blocked: '等待前置操作或人工处理' };
const fields: Record<string, string> = { title:'名称',description:'说明',date:'日期',start:'开始时间',end:'结束时间',deadline:'截止时间',time:'时刻',kind:'类型',status:'状态',completed:'是否完成',location:'地点',taskId:'关联任务',goalId:'所属目标',courseId:'所属课程',expectedVersion:'基于版本',version:'版本',values:'修改内容',mutations:'修改事项',entries:'账目',entry:'账目',amountCents:'金额（分）',personalCents:'个人开销（分）',incomeCents:'收入（分）',cashflows:'账户资金变化',accountId:'账户',deltaCents:'变化金额（分）',reminders:'提醒',enabled:'启用',leadMinutes:'提前分钟',dateOnlyTime:'仅日期提醒时刻',frequency:'重复频率',scope:'修改范围',note:'备注',type:'操作',entity:'资料类型',before:'资料服务当前值',after:'拟保存值',changes:'具体变更',conflicts:'冲突',reason:'原因',id:'记录',createdAt:'创建时间',updatedAt:'更新时间',sourceIds:'来源',blocks:'执行时段',tasks:'任务',courses:'课程',goals:'目标',record:'记录',base:'修改前资料',records:'相关资料',seriesId:'重复系列',recurrence:'重复规则',cancelled:'是否取消',value:'内容',month:'月份',category:'分类',relatedEntryIds:'关联账目',dateNote:'日期说明',occurredAt:'发生时刻',transactionId:'操作记录',recordedAt:'登记时刻' };
const values: Record<string,string> = { work:'执行时段',event:'固定活动',task:'任务',block:'时段',course:'课程',goal:'目标',candidate:'候选事项',create:'新建',update:'修改',delete:'删除',open:'未完成',done:'已完成',active:'进行中',paused:'已暂停',completed:'已完成',single:'仅本次','this-and-following':'本次及以后',expense:'开销',income:'收入',transfer:'转账',manual:'手动操作' };
const hiddenField = /(?:token|password|secret|api.?key|imageDataUrl|originalText|sourceQuote|captureRef|^text$|^history$|wireInput|operationId|requestId|identity)/i;
const resultUnknown = (item:PendingWrite) => ['uncertain','sending','interrupted'].includes(item.status);
function readableDate(value: string | null | undefined) {
  if (!value) return '尚无已确认缓存';
  if (!/^\d{4}-\d\d-\d\dT/.test(value)) return value;
  const date=new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value)?value:`${value}+08:00`);
  return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date);
}
function Readable({value,depth=0}: {value:unknown;depth?:number}): ReactNode {
  if (value === null || value === undefined) return <span className="remote-muted">未提供</span>;
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return values[value] ?? readableDate(value);
  if (typeof value === 'number') return String(value);
  if (depth > 5) return '更多详细内容请核对资料服务预览';
  if (Array.isArray(value)) return value.length ? <ol className="remote-readable-list">{value.slice(0,30).map((item,index)=><li key={index}><Readable value={item} depth={depth+1}/></li>)}</ol> : '无';
  if (typeof value === 'object') { const entries=Object.entries(value).filter(([key])=>!hiddenField.test(key)); return entries.length ? <dl className="remote-readable">{entries.map(([key,item])=><div key={key}><dt>{fields[key] ?? '其他资料'}</dt><dd><Readable value={item} depth={depth+1}/></dd></div>)}</dl> : '无可展示的字段'; }
  return '未提供';
}

interface PushState { enabled: boolean; publicKey: string | null; subscriptions: PushSubscriptionSummary[] }
function applicationKey(value: string) { const binary=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)); return Uint8Array.from(binary, char=>char.charCodeAt(0)); }

export function RemoteApp({controller}: {controller:RemoteController}) {
  const subscribe=useCallback((listener:()=>void)=>controller.subscribe(listener),[controller]);
  const getState=useCallback(()=>controller.getState(),[controller]);
  const state=useSyncExternalStore(subscribe,getState,getState);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [code,setCode]=useState(''),[name,setName]=useState('我的 iPhone');
  const [deviceList,setDeviceList]=useState<DeviceSummary[]|null>(null),[push,setPush]=useState<PushState|null>(null);
  const [archiveList,setArchiveList]=useState<RecoveryArchive[]|null>(null),[selectedArchive,setSelectedArchive]=useState<RecoveryArchive|null>(null),[archiveAck,setArchiveAck]=useState(false);
  // A definitively failed assistant request already shows its failure and retry in the conversation; keeping it
  // in the queue too would hold the banner at "needs handling" for something the user has seen.
  useEffect(()=>{for(const item of state.pending)if(item.method==='command'&&item.status==='failed')void controller.resolve(item.id,'discard').catch(()=>{});},[state.pending,controller]);
  useEffect(()=>{let live=true;void controller.initialize().catch(reason=>{if(live)setError(reason instanceof Error?reason.message:'初始化连接失败');});return()=>{live=false;};},[controller]);
  async function run(action:()=>Promise<unknown>,success?:string) { setBusy(true);setError('');setNotice('');try{await action();if(success)setNotice(success);}catch(reason){setError(reason instanceof Error?reason.message:'操作未完成，请重试。');}finally{setBusy(false);} }
  async function pair(event:FormEvent) {event.preventDefault();if(state.status==='expired'&&state.pending.length){setError('请先明确保留旧队列为本机隔离档案，再重新配对。');return;}await run(()=>controller.pair(code.trim(),name.trim()));setCode('');}
  function downloadArchive(archive:RecoveryArchive){
    const payload={format:'ultimate-calendar-isolated-queue',formatVersion:1,warning:'私密本机隔离档案；本次导出未上传，未向新配对重放。这不是自动导入文件。历史操作可能已在原服务执行，结果未知时先查询原操作，不能照抄重新创建。',archive};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`终极日历-本机隔离队列-${archive.createdAt.slice(0,10)}-${archive.id.replace(/[^a-zA-Z0-9-]/g,'').slice(0,12)}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),0);
    setNotice('已生成私密 JSON 下载。请保存在你信任的位置；导出未上传，旧队列未向新配对重放。');
  }
  const archiveControls=<section className="remote-archives" aria-label="本机隔离档案"><h3>本机隔离档案</h3><p className="ui-hint">仅供人工核对，可再次导出；不会自动重放到新配对。结果未知的操作应先查询原资料服务，不可照抄重建重复记录。</p><button className="ui-btn" disabled={busy} onClick={()=>void run(async()=>setArchiveList(await controller.archives()))}>查看本机隔离档案</button>{archiveList&&(!archiveList.length?<p className="ui-hint">暂无本机隔离档案。</p>:<ul className="remote-archive-list">{archiveList.map(archive=><li key={archive.id}><div><strong>{archive.device.name} · {archive.pending.length} 项</strong><small>{readableDate(archive.createdAt)} · 原资料代际 {archive.identity.generation}</small></div><button className="ui-btn" onClick={()=>setSelectedArchive(archive)}>查看档案</button><button className="ui-btn" onClick={()=>void run(async()=>downloadArchive(archive))}>再次导出</button></li>)}</ul>)}{selectedArchive&&<article className="remote-archive-detail"><h4>隔离档案 · {selectedArchive.device.name}</h4><p className="remote-write-status">隔离档案仅存本机 · 未向新配对发送 · 原代际 {selectedArchive.identity.generation}</p><p className="ui-hint">{selectedArchive.reason} · 最后确认缓存 {readableDate(selectedArchive.cachedAt)}</p>{selectedArchive.pending.map(item=><details key={item.id}><summary>{item.label} · {queueStates[item.status]??'结果未知'}</summary><h5>当时的资料依据</h5><Readable value={item.base}/><h5>手机提出的修改</h5><Readable value={item.input}/>{resultUnknown(item)&&<p className="warning">此项可能已在原服务执行。先查询原操作结果，不要重新创建。</p>}</details>)}<div className="remote-actions"><button className="ui-btn" onClick={()=>void run(async()=>downloadArchive(selectedArchive))}>导出此隔离档案</button><button className="ui-btn" onClick={()=>setSelectedArchive(null)}>收起档案</button></div></article>}</section>;
  const recoveryRequired=state.status==='expired'&&state.pending.length>0;
  const recovery=recoveryRequired&&<section className="remote-recovery" aria-label="旧队列恢复"><h2>先保留旧手机修改</h2><p>旧设备授权或资料代际已改变。这 {state.pending.length} 项不会发送到新配对，也不会自动清除。</p><button className="ui-btn" disabled={busy} onClick={()=>void run(async()=>downloadArchive(await controller.exportPending()))}>导出旧队列（私密 JSON）</button><p className="ui-hint">导出包含个人事项与账目，请仅保存在你信任的位置。结果未知的操作先查询原服务，不可直接重新创建。</p><label className="remote-archive-ack"><input type="checkbox" checked={archiveAck} onChange={event=>setArchiveAck(event.target.checked)}/>我选择将旧修改保留为本机隔离档案，不自动提交到新配对</label><button className="ui-btn primary" disabled={busy||!archiveAck} onClick={()=>void run(async()=>{const archive=await controller.archivePending();setSelectedArchive(archive);setArchiveList(await controller.archives());setArchiveAck(false);},'旧修改已保留为本机隔离档案，尚未发送。现在可以重新配对。')}>保留隔离档案并继续配对</button></section>;
  async function refreshPush(){const result=await controller.request<PushState>('/api/v1/push');setPush(result);return result;}
  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw Error('此浏览器尚不支持网页通知。iPhone 请先将终极日历加入主屏幕，再从主屏幕打开。');
    // Permission is requested synchronously from the user's button action, before any network await.
    const permission=await Notification.requestPermission();
    if(permission!=='granted')throw Error(permission==='denied'?'通知权限已被拒绝，请在系统设置中调整。':'尚未允许通知，未建立订阅。');
    await navigator.serviceWorker.register('/sw.js');
    const registration=await navigator.serviceWorker.ready;
    const config=await refreshPush();
    if(!config.enabled||!config.publicKey)throw Error('资料服务尚未配置通知，未建立订阅。');
    const subscription=await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationKey(config.publicKey)});
    await controller.request('/api/v1/push/subscribe',{subscription:subscription.toJSON(),showDetails:false},'POST');
    await refreshPush();setNotice('资料服务已确认订阅；仍需在目标 iPhone 上验证实际提醒送达。');
  }
  async function browserSubscription(){const registration=await navigator.serviceWorker?.getRegistration('/sw.js');return registration?.pushManager.getSubscription();}
  async function localSubscriptionId(subscription:PushSubscription){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(subscription.endpoint));return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');}
  async function updateDetails(item:PushSubscriptionSummary,showDetails:boolean){const subscription=await browserSubscription();if(!subscription||await localSubscriptionId(subscription)!==item.id)throw Error('此条订阅不属于当前浏览器，不能代为修改细节偏好。可关闭旧订阅后，在当前浏览器启用通知。');await controller.request('/api/v1/push/subscribe',{subscription:subscription.toJSON(),showDetails},'POST');await refreshPush();}
  async function disablePush(item:PushSubscriptionSummary){await controller.request('/api/v1/push/unsubscribe',{subscriptionId:item.id},'POST');const subscription=await browserSubscription();if(subscription&&await localSubscriptionId(subscription)===item.id)await subscription.unsubscribe();await refreshPush();}
  const activePush=push?.subscriptions.filter(item=>item.active)??[];
  const status=<div className={`remote-status status-${state.status}`} role="status"><strong>{states[state.status]}</strong><span>最后确认刷新：{readableDate(state.cachedAt)}</span><span>未提交 {state.pending.length} 项{state.pending.length?' · 不代表资料服务已保存':''}</span>{state.message&&<span>{state.message}</span>}{state.storageError&&<span className="error">手机储存异常：{state.storageError}</span>}</div>;
  const feedback=<>{error&&<p className="remote-feedback error" role="alert">{error}</p>}{notice&&<p className="remote-feedback" role="status">{notice}</p>}</>;
  const connectionSection=<section aria-label="资料服务连接"><h3>资料服务与此设备</h3><p>{state.session?.device.name ?? '尚未配对'} · {states[state.status]}</p><div className="remote-actions"><button className="ui-btn" disabled={busy} onClick={()=>void run(()=>controller.reconnect())}>重新连接</button><button className="ui-btn" disabled={busy} onClick={()=>void run(()=>controller.clearCache(),'缓存清理已完成。')}>清理手机缓存</button><button className="ui-btn" disabled={busy} onClick={()=>void run(()=>controller.logout())}>退出此设备</button></div><p className="ui-hint">有未提交或结果未知的操作时，清理缓存和退出将被阻止。不会代你丢弃修改。</p></section>;
  const discardable=(item:PendingWrite)=>(['queued','conflict','failed','review'] as const).some(value=>value===item.status)||(item.status==='blocked'&&item.wireInput===undefined);
  const pendingQueue=<section className="m-pending" aria-label="未提交队列">
    {!state.pending.length?<p className="m-empty">没有待提交的修改。</p>:state.pending.map(item=><article className={`m-pending-item status-${item.status}`} key={item.id}>
      <header><strong>{item.label}</strong><span>{shortQueueStates[item.status]??'结果待核对'}</span></header>
      {item.message&&<p>{item.message}</p>}
      {resultUnknown(item)&&<p>可能已送达云端，先查询结果，不要重新创建。</p>}
      {item.preview&&<details><summary>查看预览</summary><Preview value={item.preview} confirm={()=>void run(()=>controller.resolve(item.id,'confirm'))} cancel={()=>void run(()=>controller.resolve(item.id,'discard'))} busy={busy}/></details>}
      <details><summary>修改内容</summary><div className="remote-comparison"><section><h5>修改前</h5><Readable value={item.base}/></section><section><h5>手机的修改</h5><Readable value={item.input}/></section></div></details>
      <div className="m-pending-actions">
        {discardable(item)&&<button className="m-btn" disabled={busy} onClick={()=>void run(()=>controller.resolve(item.id,'discard'))}>放弃</button>}
        {item.status==='conflict'?<button className="m-btn primary" disabled={busy} onClick={()=>void run(()=>controller.resolve(item.id,'use-local'))}>按我的修改重新提交</button>
          :item.status!=='review'&&item.status!=='failed'&&<button className="m-btn" disabled={busy} onClick={()=>void run(()=>controller.resolve(item.id,'retry'))}>{resultUnknown(item)?'查询结果':'重试'}</button>}
      </div>
    </article>)}
  </section>;
  const connectionLine=<div className="m-connection"><span>{shortStates[state.status]}{state.session?` · ${state.session.device.name}`:''}</span>{state.status!=='online'&&<button className="m-link" disabled={busy} onClick={()=>void run(()=>controller.reconnect())}>重新连接</button>}</div>;
  const settings=<div className="remote-settings">
    {feedback}
    {archiveControls}
    {connectionSection}
    {pendingQueue}
    <section aria-label="授权设备"><h3>账户与设备</h3><button className="ui-btn" disabled={busy} onClick={()=>void run(async()=>setDeviceList(await controller.devices()))}>查看授权设备</button>{deviceList&&<ul className="remote-devices">{deviceList.map(device=><li key={device.id}><div><strong>{device.name}{device.current?'（此设备）':''}</strong><small>授权于 {readableDate(device.createdAt)}</small>{device.expiresAt&&<small>有效至 {readableDate(device.expiresAt)}</small>}</div><button className="ui-btn" disabled={busy} onClick={()=>void run(async()=>{await controller.revokeDevice(device.id);setDeviceList(await controller.devices());})}>撤销授权</button></li>)}</ul>}</section>
    <section aria-label="手机通知"><h3>手机提醒</h3><p className="ui-hint">iPhone 请先通过 Safari 分享菜单将终极日历加入主屏幕，再从主屏幕打开。只有点「启用通知」才申请权限；资料服务运行时，QQ 采集电脑关机不影响手机提醒。</p><div className="remote-actions"><button className="ui-btn primary" disabled={busy||state.status!=='online'} onClick={()=>void run(enablePush)}>启用通知</button><button className="ui-btn" disabled={busy||state.status!=='online'} onClick={()=>void run(refreshPush)}>查看订阅状态</button></div>{push&&<p>{!push.enabled?'资料服务尚未配置推送':activePush.length?`资料服务记录有 ${activePush.length} 个有效订阅`:'此设备暂无有效订阅'}</p>}{activePush.map(item=><div className="remote-push-item" key={item.id}><label><input type="checkbox" checked={item.showDetails} disabled={busy} onChange={event=>void run(()=>updateDetails(item,event.target.checked))}/>通知显示事项细节</label><button className="ui-btn" disabled={busy} onClick={()=>void run(()=>disablePush(item))}>关闭此订阅</button></div>)}<p className="ui-hint">默认隐藏事项细节。系统权限和服务订阅不等于实际送达保证；本页不发送测试推送。</p></section>
    <section className="remote-privacy" aria-label="导入隐私"><h3>消息与截图</h3><p>手机主动导入的文本或图片在分析完成后清除原文；分析失败时暂存不超过 24 小时。QQ 仅上传提炼结果，原文和附件留在采集电脑，电脑离线时无法查看。</p></section>
  </div>;
  if(!state.session||state.status==='unpaired'||state.status==='expired')return <main className="remote-pair"><div className="remote-pair-paper"><p className="remote-pair-kicker">终极日历 · 手机端</p><h1>{state.status==='expired'?'重新连接此设备':'连接你的资料服务'}</h1>{status}{feedback}{recovery}<form onSubmit={event=>void pair(event)}><label>配对码<input name="code" autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={16} maxLength={100} required value={code} onChange={event=>setCode(event.target.value)}/></label><label>设备名称<input name="name" autoComplete="nickname" maxLength={80} required value={name} onChange={event=>setName(event.target.value)}/></label><button className="ui-btn primary" disabled={busy||state.status==='connecting'||recoveryRequired} type="submit">{busy?'正在配对…':'配对此设备'}</button></form><p className="ui-hint">使用资料服务命令行生成的高熵配对码；没有公开注册入口。配对码仅用于建立此设备的授权，不会要求上传电脑数据库。</p>{state.pending.length>0&&<p className="remote-feedback">仍有 {state.pending.length} 条手机修改，恢复原账户连接前不会提交或清除。</p>}<details className="remote-archive-entry" open={Boolean(selectedArchive)}><summary>本机隔离档案（仅人工核对）</summary>{archiveControls}</details></div></main>;
  return <div className="remote-root"><MobileApp client={controller.client} connection={state} settings={settings}
    conversationKey={`ultimate-calendar:assistant:${state.session.identity.dataInstanceId}:${state.session.identity.generation}:${state.session.device.id}`}
    discardPreview={token=>{const item=state.pending.find(value=>value.status==='review'&&value.preview?.confirmationToken===token);if(item)void controller.resolve(item.id,'discard').catch(()=>{});}}
    pendingView={<>{feedback}{connectionLine}{pendingQueue}</>}/>{error&&<div className="remote-global-error" role="alert"><span>{error}</span><button className="ui-btn" onClick={()=>setError('')}>关闭</button></div>}</div>;
}

