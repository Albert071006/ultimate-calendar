import { useCallback, useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { MobileApp } from '../mobile/MobileApp';
import { Preview } from '../components/Preview';
import type { PendingWrite, RecoveryArchive, RemoteController } from './types';
import { ArchiveList, Readable, downloadArchive, queueStates, resultUnknown } from './readable';
import { AiKeyPage, DevicePage, ReminderPage, connectionNames } from './AccountPages';
import './remote.css';

const discardable = (item: PendingWrite) => (['queued', 'conflict', 'failed', 'review'] as const).some(value => value === item.status) || (item.status === 'blocked' && item.wireInput === undefined);

export function RemoteApp({ controller }: { controller: RemoteController }) {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller]);
  const getState = useCallback(() => controller.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, getState, getState);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [code, setCode] = useState(''), [name, setName] = useState('我的 iPhone');
  const [archives, setArchives] = useState<RecoveryArchive[] | null>(null), [archiveAck, setArchiveAck] = useState(false);
  // A definitively failed assistant request already shows its failure and retry in the conversation; keeping it
  // in the queue too would hold the banner at "needs handling" for something the user has seen.
  useEffect(() => { for (const item of state.pending) if (item.method === 'command' && item.status === 'failed') void controller.resolve(item.id, 'discard').catch(() => {}); }, [state.pending, controller]);
  useEffect(() => { let live = true; void controller.initialize().catch(reason => { if (live) setError(reason instanceof Error ? reason.message : '连接云端失败'); }); return () => { live = false; }; }, [controller]);
  const unpaired = !state.session || state.status === 'unpaired' || state.status === 'expired';
  useEffect(() => { if (unpaired) void controller.archives().then(setArchives).catch(() => setArchives([])); }, [unpaired, controller]);
  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (success) setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '没有完成，请重试。'); }
    finally { setBusy(false); }
  }
  async function pair(event: FormEvent) {
    event.preventDefault();
    if (state.status === 'expired' && state.pending.length) { setError('请先把旧修改保存为本机档案，再重新配对。'); return; }
    await run(() => controller.pair(code.trim(), name.trim())); setCode('');
  }
  const feedback = <>{error && <p className="m-note error" role="alert">{error}</p>}{notice && <p className="m-note ok" role="status">{notice}</p>}</>;

  const pendingQueue = <section className="m-pending" aria-label="未提交队列">
    {!state.pending.length ? <p className="m-empty">没有待提交的修改。</p> : state.pending.map(item => <article className={`m-pending-item status-${item.status}`} key={item.id}>
      <header><strong>{item.label}</strong><span>{queueStates[item.status] ?? '结果待核对'}</span></header>
      {item.message && <p>{item.message}</p>}
      {resultUnknown(item) && <p>可能已送达云端，先查询结果，不要重新创建。</p>}
      {item.preview && <details><summary>查看预览</summary><Preview value={item.preview} confirm={() => void run(() => controller.resolve(item.id, 'confirm'))} cancel={() => void run(() => controller.resolve(item.id, 'discard'))} busy={busy} /></details>}
      <details><summary>修改内容</summary><div className="remote-comparison"><section><h5>修改前</h5><Readable value={item.base} /></section><section><h5>手机的修改</h5><Readable value={item.input} /></section></div></details>
      <div className="m-pending-actions">
        {discardable(item) && <button className="m-btn" disabled={busy} onClick={() => void run(() => controller.resolve(item.id, 'discard'))}>放弃</button>}
        {item.status === 'conflict' ? <button className="m-btn primary" disabled={busy} onClick={() => void run(() => controller.resolve(item.id, 'use-local'))}>按我的修改重新提交</button>
          : item.status !== 'review' && item.status !== 'failed' && <button className="m-btn" disabled={busy} onClick={() => void run(() => controller.resolve(item.id, 'retry'))}>{resultUnknown(item) ? '查询结果' : '重试'}</button>}
      </div>
    </article>)}
  </section>;
  const connectionLine = <div className="m-connection"><span>{connectionNames[state.status]}{state.session ? ` · ${state.session.device.name}` : ''}</span>
    {state.status !== 'online' && <button className="m-link" disabled={busy} onClick={() => void run(() => controller.reconnect())}>重新连接</button>}</div>;

  if (unpaired) {
    const recoveryRequired = state.status === 'expired' && state.pending.length > 0;
    return <main className="m-pair">
      <div className="m-pair-body">
        <p className="m-pair-brand">终极日历</p>
        <h1>{state.status === 'expired' ? '重新连接这台手机' : '连接云端'}</h1>
        {state.status === 'expired' && !recoveryRequired && <p className="m-hint">这台手机的授权已失效，请用新的配对码重新连接。</p>}
        {feedback}
        {recoveryRequired && <section className="m-recovery" aria-label="旧修改">
          <h2>还有 {state.pending.length} 项修改没提交</h2>
          <p>重新配对前，先把它们保存为本机档案。档案只留在这台手机上，不会提交到新的配对。</p>
          <label className="m-switch"><input type="checkbox" checked={archiveAck} onChange={event => setArchiveAck(event.target.checked)} /><span>保存为本机档案，不提交到新配对</span></label>
          <div className="m-actions">
            <button className="m-btn" disabled={busy} onClick={() => void run(async () => downloadArchive(await controller.exportPending()), '已导出文件，请保存在你信任的位置。')}>导出为文件</button>
            <button className="m-btn primary" disabled={busy || !archiveAck} onClick={() => void run(async () => { await controller.archivePending(); setArchives(await controller.archives()); setArchiveAck(false); }, '已保存为本机档案，现在可以重新配对。')}>保存档案并继续</button>
          </div>
        </section>}
        <form className="m-form" onSubmit={event => void pair(event)}>
          <label htmlFor="pair-code">配对码</label>
          <input id="pair-code" name="code" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} minLength={16} maxLength={100} required value={code} onChange={event => setCode(event.target.value)} />
          <p className="m-hint">在电脑上运行配对命令获得，10 分钟内有效。</p>
          <label htmlFor="pair-name">设备名称</label>
          <input id="pair-name" name="name" autoComplete="nickname" maxLength={80} required value={name} onChange={event => setName(event.target.value)} />
          <button className="m-btn primary" disabled={busy || state.status === 'connecting' || recoveryRequired} type="submit">{busy ? '正在配对…' : '配对此设备'}</button>
        </form>
        {archives && archives.length > 0 && <details className="m-pair-archives"><summary>本机档案 · {archives.length}</summary><ArchiveList archives={archives} /></details>}
      </div>
    </main>;
  }
  const online = state.status === 'online';
  return <MobileApp key={`${state.session!.identity.dataInstanceId}:${state.session!.identity.generation}:${state.session!.device.id}`} client={controller.client} connection={state}
    conversationKey={`ultimate-calendar:assistant:${state.session!.identity.dataInstanceId}:${state.session!.identity.generation}:${state.session!.device.id}`}
    discardPreview={token => { const item = state.pending.find(value => value.status === 'review' && value.preview?.confirmationToken === token); if (item) void controller.resolve(item.id, 'discard').catch(() => {}); }}
    pendingView={<>{feedback}{connectionLine}{pendingQueue}</>}
    settingsPages={[
      { id: 'ai', label: '生活助手', content: <AiKeyPage controller={controller} online={online} /> },
      { id: 'reminders', label: '手机提醒', content: <ReminderPage controller={controller} online={online} /> },
      { id: 'device', label: '设备与连接', summary: connectionNames[state.status], content: <DevicePage controller={controller} state={state} /> },
    ]} />;
}
