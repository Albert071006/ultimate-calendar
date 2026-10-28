import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { AiConfigurationStatus } from '../../shared/ai-configuration';
import type { RemoteIdentity } from '../../shared/remote';
import type { PushSubscriptionSummary } from '../../shared/push';
import type { DeviceSummary, RecoveryArchive, RemoteClientState, RemoteController } from './types';
import { ArchiveList } from './readable';
import { CloudModelSettings } from './CloudModelSettings';

type Tone = 'ok' | 'warn' | 'error';
type Message = { tone: Tone; text: string } | null;
const httpStatus = (error: unknown) => (error as { status?: number } | null)?.status;
const reason = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const Note = ({ message }: { message: Message }) => message && <p className={`m-note ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>;
export const connectionNames: Record<RemoteClientState['status'], string> = { connecting: '正在连接云端', online: '云端已连接', offline: '离线', unpaired: '尚未配对', expired: '设备授权已失效', error: '云端连接异常' };

// Mirrors AiApiKeySchema so the form can say what is wrong before anything is sent.
const validKey = (value: string) => /^[\x21-\x7e]{16,512}$/.test(value.trim());
interface AiConfiguration { ok: true; identity: RemoteIdentity; configuration: AiConfigurationStatus }

/**
 * DeepSeek key for the whole data service (docs/backend-api.md). The key is typed, sent once and cleared;
 * it is never read back, cached or queued, and an unclear result is re-read rather than resent.
 */
export function AiKeyPage({ controller, online }: { controller: RemoteController; online: boolean }) {
  const [config, setConfig] = useState<AiConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState(''), [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false), [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<Message>(null), [unclear, setUnclear] = useState(false);
  async function read(keepMessage = false) {
    setLoading(true); if (!keepMessage) setMessage(null);
    try { setConfig(await controller.request<AiConfiguration>('/api/v1/ai/config')); setUnclear(false); }
    catch (error) { setMessage({ tone: 'error', text: reason(error, '暂时读不到云端的 Key 状态。') }); }
    finally { setLoading(false); }
  }
  useEffect(() => { void read(); }, []);
  async function write(method: 'PUT' | 'DELETE') {
    if (!config) return;
    setBusy(true); setMessage(null);
    const base = { identity: config.identity, expectedRevision: config.configuration.revision };
    try {
      const next = await controller.request<AiConfiguration>('/api/v1/ai/config', method === 'PUT' ? { ...base, apiKey: key.trim() } : base, method);
      setConfig(next); setKey(''); setVisible(false); setConfirmClear(false); setUnclear(false);
      setMessage({ tone: 'ok', text: method === 'PUT' ? '已保存，之后的助手请求会使用这个 Key。' : '已清除，助手不再使用这个 Key。' });
    } catch (error) {
      const status = httpStatus(error);
      if (status === 409) { await read(true); setMessage({ tone: 'warn', text: 'Key 刚在其他设备改过，已刷新状态，请核对后再操作。' }); }
      else if (status === 403) { await read(true); setMessage({ tone: 'error', text: reason(error, '云端拒绝了这次修改。') }); }
      else if (status === 400 || status === 413 || status === 415) setMessage({ tone: 'error', text: 'Key 格式不对：应为 16–512 位，不含空格。' });
      else if (status !== 401) { setUnclear(true); setMessage({ tone: 'warn', text: `${method === 'PUT' ? '保存' : '清除'}结果待核对：连接中断或云端暂时不可用。` }); }
    } finally { setBusy(false); }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); if (validKey(key)) void write('PUT'); };
  const current = config?.configuration;
  const state = !current ? (loading ? '正在读取…' : '状态未知') : current.source === 'external' ? '由服务器管理' : current.configured ? '已配置' : '未配置';
  return (
    <div className="m-settings">
      <CloudModelSettings controller={controller} online={online} />
      <div className="m-kv"><span>DeepSeek API Key</span><b className={current?.configured ? 'ok' : ''}>{state}</b></div>
      <Note message={message} />
      {unclear && <button className="m-btn" disabled={busy || loading} onClick={() => void read(true)}>核对云端状态</button>}
      {current && !current.editable && <p className="m-hint">{current.source === 'external' ? 'Key 由服务器管理员配置，手机不能修改或清除。' : '云端没有开放手机填写 Key，需要在服务器上配置。'}</p>}
      {current?.editable && <form className="m-form" onSubmit={submit} autoComplete="off">
        <label htmlFor="ai-key">{current.configured ? '换一个 Key' : '粘贴 Key'}</label>
        <div className="m-secret">
          <input id="ai-key" type={visible ? 'text' : 'password'} value={key} onChange={event => setKey(event.target.value)} placeholder="sk-…"
            autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" disabled={busy} />
          <button type="button" className="m-icon" aria-label={visible ? '隐藏 Key' : '显示 Key'} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</button>
        </div>
        {key.trim() && !validKey(key) && <p className="m-note error">应为 16–512 位，不含空格。</p>}
        <p className="m-hint">{current.configured ? '已保存的 Key 不会显示。' : '保存只检查格式，不会产生费用。'}</p>
        <button type="submit" className="m-btn primary" disabled={busy || !online || !validKey(key)}>{busy ? '正在保存…' : online ? '保存' : '联网后才能保存'}</button>
      </form>}
      {current?.editable && current.configured && (confirmClear
        ? <div className="m-confirm"><p>清除后助手停止使用这个 Key；DeepSeek 那边的 Key 不会被删除。</p>
            <div><button className="m-btn" onClick={() => setConfirmClear(false)}>取消</button><button className="m-btn danger" disabled={busy || !online} onClick={() => void write('DELETE')}>确认清除</button></div></div>
        : <button className="m-link danger" disabled={busy || !online} onClick={() => setConfirmClear(true)}>清除 Key</button>)}
    </div>
  );
}

interface PushState { enabled: boolean; publicKey: string | null; subscriptions: PushSubscriptionSummary[] }
function applicationKey(value: string) { const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
async function browserSubscription() { const registration = await navigator.serviceWorker?.getRegistration('/sw.js'); return registration?.pushManager.getSubscription() ?? null; }
async function subscriptionId(subscription: PushSubscription) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint)); return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join(''); }
const installedApp = () => (navigator as { standalone?: boolean }).standalone === true || (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
const appleTouch = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/** Web Push on this phone. Permission is asked only from the button; nothing is sent as a test. */
export function ReminderPage({ controller, online }: { controller: RemoteController; online: boolean }) {
  const [push, setPush] = useState<PushState | null>(null), [mine, setMine] = useState<PushSubscriptionSummary | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>(null);
  async function refresh() {
    const result = await controller.request<PushState>('/api/v1/push'); setPush(result);
    const local = await browserSubscription().catch(() => null), id = local ? await subscriptionId(local) : null;
    setMine(result.subscriptions.find(item => item.active && item.id === id) ?? null);
    return result;
  }
  useEffect(() => { void refresh().catch(error => setMessage({ tone: 'error', text: reason(error, '暂时读不到提醒状态。') })); }, []);
  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true); setMessage(null);
    try { await action(); if (done) setMessage({ tone: 'ok', text: done }); }
    catch (error) { setMessage({ tone: 'error', text: reason(error, '没有完成，请重试。') }); }
    finally { setBusy(false); }
  }
  async function enable() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw Error('这个浏览器不支持网页提醒。请先添加到主屏幕，再从主屏幕打开。');
    // Ask for permission first, straight from the tap, before any network wait.
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw Error(permission === 'denied' ? '通知权限被拒绝了，可以在 iPhone 设置里打开。' : '还没有允许通知。');
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    const config = await refresh();
    if (!config.enabled || !config.publicKey) throw Error('云端暂未开启推送。');
    const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(config.publicKey) });
    await controller.request('/api/v1/push/subscribe', { subscription: subscription.toJSON(), showDetails: false }, 'POST');
    await refresh();
  }
  async function details(showDetails: boolean) {
    const local = await browserSubscription();
    if (!local || !mine || await subscriptionId(local) !== mine.id) throw Error('这台手机的提醒已变化，请先关闭再重新开启。');
    await controller.request('/api/v1/push/subscribe', { subscription: local.toJSON(), showDetails }, 'POST'); await refresh();
  }
  async function disable() {
    if (!mine) return;
    await controller.request('/api/v1/push/unsubscribe', { subscriptionId: mine.id }, 'POST');
    const local = await browserSubscription(); if (local && await subscriptionId(local) === mine.id) await local.unsubscribe();
    await refresh();
  }
  const needsInstall = appleTouch() && !installedApp();
  return (
    <div className="m-settings">
      <div className="m-kv"><span>这台手机</span><b className={mine ? 'ok' : ''}>{!push ? '正在读取…' : !push.enabled ? '云端未开启推送' : mine ? '已开启' : '未开启'}</b></div>
      <Note message={message} />
      {needsInstall && !mine && push?.enabled && <p className="m-hint">先用 Safari 的分享按钮「添加到主屏幕」，从主屏幕打开后才能开启提醒。</p>}
      {push?.enabled && (mine ? <>
        <label className="m-switch"><input type="checkbox" checked={mine.showDetails} disabled={busy || !online} onChange={event => void run(() => details(event.target.checked))} />
          <span>通知里显示事项内容<small>关闭时只显示「有一项安排需要查看」。</small></span></label>
        <button className="m-btn" disabled={busy || !online} onClick={() => void run(disable, '已关闭这台手机的提醒。')}>关闭提醒</button>
      </> : <button className="m-btn primary" disabled={busy || !online} onClick={() => void run(enable, '已开启提醒。')}>开启提醒</button>)}
    </div>
  );
}

/** This device, other authorised devices, cache and sign-out, and archives kept from an earlier pairing. */
export function DevicePage({ controller, state }: { controller: RemoteController; state: RemoteClientState }) {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null), [archives, setArchives] = useState<RecoveryArchive[]>([]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>(null), [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    void controller.devices().then(setDevices).catch(() => setDevices(null));
    void controller.archives().then(setArchives).catch(() => setArchives([]));
  }, [controller]);
  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true); setMessage(null); setConfirm(null);
    try { await action(); if (done) setMessage({ tone: 'ok', text: done }); }
    catch (error) { setMessage({ tone: 'error', text: reason(error, '没有完成，请重试。') }); }
    finally { setBusy(false); }
  }
  const twoStep = (id: string, label: string, action: () => void, danger = false) => confirm === id
    ? <button className={`m-btn${danger ? ' danger' : ''}`} disabled={busy} onClick={action}>确认{label}</button>
    : <button className="m-btn" disabled={busy} onClick={() => setConfirm(id)}>{label}</button>;
  return (
    <div className="m-settings">
      <div className="m-kv"><span>{state.session?.device.name ?? '此设备'}</span><b className={state.status === 'online' ? 'ok' : 'warn'}>{connectionNames[state.status]}</b></div>
      {state.status !== 'online' && <button className="m-btn" disabled={busy} onClick={() => void run(() => controller.reconnect())}>重新连接</button>}
      <Note message={message} />
      <h3 className="m-subhead">已授权的设备</h3>
      {!devices ? <p className="m-empty">{state.status === 'online' ? '正在读取…' : '联网后可以查看。'}</p> : <ul className="m-list">
        {devices.map(device => <li key={device.id} className="m-row">
          <span>{device.name}{device.current && <small>此设备</small>}</span>
          {!device.current && twoStep(`revoke:${device.id}`, '撤销', () => void run(async () => { await controller.revokeDevice(device.id); setDevices(await controller.devices()); }, `已撤销「${device.name}」。`), true)}
        </li>)}
      </ul>}
      <h3 className="m-subhead">这台手机</h3>
      <p className="m-hint">有待提交的修改时，不能清理缓存或退出。</p>
      <div className="m-actions">
        {twoStep('cache', '清理缓存', () => void run(() => controller.clearCache(), '缓存已清理，正在重新读取。'))}
        {twoStep('logout', '退出此设备', () => void run(() => controller.logout()), true)}
      </div>
      {archives.length > 0 && <>
        <h3 className="m-subhead">本机档案</h3>
        <p className="m-hint">以前配对时没提交的修改，只保存在这台手机上，不会自动提交。</p>
        <ArchiveList archives={archives} />
      </>}
    </div>
  );
}
