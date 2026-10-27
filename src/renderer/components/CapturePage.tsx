import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ApiResult, Source } from '../../shared/contracts';
import { CaptureConfigSchema, type AttachmentSummary, type CaptureBatchView, type CaptureConfig, type CaptureGroup, type CaptureMessageView, type CaptureSnapshot } from '../../shared/capture';
import type { CaptureDesktopAPI } from '../../shared/capture-api';
import type { PlannerUI } from '../hooks/usePlanner';
import { useAccount } from '../hooks/useAccount';
import { displayInstant } from '../calendar-layout';
import { Modal } from './Modal';
import { QQSearchActions } from './QQSearchActions';
import './CapturePage.css';

type Page<T> = { items: T[]; total: number; offset: number; limit: number };
type Chunks = Extract<Awaited<ReturnType<CaptureDesktopAPI['captureChunks']>>, { ok: true }>['data'];
const batchLabels = { pending: '等待分析', preparing: '准备资料', requesting: 'AI 分析中', uncertain: '响应未知 · 需确认', 'result-ready': '等待保存候选', applied: '已整理', failed: '分析失败' };
const attachmentLabels = { pending: '等待读取', downloading: '下载中', extracting: '提取正文', ready: '正文已提取', unsupported: '需手动查看', failed: '读取失败', 'too-large': '超过处理限额', encrypted: '文件已加密', deleted: '原附件已清理' };
const coverageLabels = { 'not-started': '尚未补采', fetching: '正在补采', complete: '已取得目标范围', partial: '覆盖不完整', failed: '补采失败' };
const emptyPage = <T,>(): Page<T> => ({ items: [], total: 0, offset: 0, limit: 30 });
const analysisStartedNotice = '已开启自动分析。';
const wechatSetupUrl = 'https://github.com/Albert071006/ultimate-calendar/blob/v0.6.0/docs/wechat-capture.md';
function sizeLabel(bytes: number) { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

export function CapturePage({ ui, initialReference, platform = 'qq' }: { ui: PlannerUI; initialReference?: NonNullable<Source['captureRef']>; platform?: 'qq' | 'wechat' }) {
  const wechat = platform === 'wechat', label = wechat ? '微信' : 'QQ';
  const connections = { disconnected: '尚未连接', connecting: '正在连接', online: `${label} 已在线`, error: '连接异常', 'account-changed': `${label} 账号已变化` };
  const api = useMemo(() => {
    const host = ui.host; if (!host || !wechat) return host;
    return { ...host, captureSnapshot: host.wechatCaptureSnapshot, captureConfigure: host.wechatCaptureConfigure,
      captureConnect: host.wechatCaptureConnect, captureGroups: host.wechatCaptureGroups, captureMessages: host.wechatCaptureMessages,
      captureBatches: host.wechatCaptureBatches, captureAction: host.wechatCaptureAction, captureChunks: host.wechatCaptureChunks,
      captureCleanup: host.wechatCaptureCleanup, onCaptureChanged: host.onWechatCaptureChanged };
  }, [ui.host, wechat]);
  const cloudMode = ui.snapshot?.keyStatus?.scope === 'cloud';
  const account = useAccount(api);
  const model = ui.snapshot?.settings.model;
  const modelModalities = account.state?.models.data?.find(item => item.id === model)?.inputModalities;
  const [snapshot, setSnapshot] = useState<CaptureSnapshot | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState('ws://127.0.0.1:43131');
  const [flavor, setFlavor] = useState<'napcat' | 'snowluma'>('napcat');
  const token = useRef<HTMLInputElement>(null);
  const [groups, setGroups] = useState<CaptureGroup[]>([]), [chosen, setChosen] = useState<string[]>([]), [search, setSearch] = useState('');
  const [tab, setTab] = useState<'messages' | 'batches' | 'history'>('messages'), [groupFilter, setGroupFilter] = useState('');
  const [batchMessageId, setBatchMessageId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Page<CaptureMessageView>>(emptyPage), [batches, setBatches] = useState<Page<CaptureBatchView>>(emptyPage);
  const [messagesOwner, setMessagesOwner] = useState<string | null>(null), [batchesOwner, setBatchesOwner] = useState<string | null>(null);
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [attachment, setAttachment] = useState<AttachmentSummary | null>(null), [chunks, setChunks] = useState<Chunks | null>(null);
  const [attachmentAccount, setAttachmentAccount] = useState<string | null>(null);
  const [chunkOffset, setChunkOffset] = useState(0), [retry, setRetry] = useState<CaptureBatchView | null>(null);
  const [reanalysis, setReanalysis] = useState(false);
  const [focusedReference, setFocusedReference] = useState(initialReference);
  const openedReferenceAttachment = useRef<string | null>(null);
  const [cleanupGroup, setCleanupGroup] = useState(''), [cleanupBefore, setCleanupBefore] = useState(''), [confirmCleanup, setConfirmCleanup] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const accountRevision = useRef(0);
  const snapshotRevision = useRef(0), pendingRequests = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const acceptSnapshot = useCallback((next: CaptureSnapshot) => {
    snapshotRevision.current++;
    setSnapshot(next); setRevision(n => n + 1);
    if (!next.config.analysisEnabled) setNotice(current => current === analysisStartedNotice ? '' : current);
  }, []);
  const request = useCallback(async <T,>(job: () => Promise<ApiResult<T>>, success?: (value: T) => void) => {
    pendingRequests.current++;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await job();
      if (!mounted.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      success?.(result.data); return result.data;
    } catch { if (mounted.current) setError('本地采集服务暂时不可用，请重试。'); }
    finally { pendingRequests.current--; if (mounted.current) setBusy(pendingRequests.current > 0); }
  }, []);
  const requestSnapshot = useCallback((job: () => Promise<ApiResult<CaptureSnapshot>>, success?: (value: CaptureSnapshot) => void) => {
    const started = ++snapshotRevision.current;
    return request(job, next => {
      if (started !== snapshotRevision.current) return;
      acceptSnapshot(next); success?.(next);
    });
  }, [request, acceptSnapshot]);
  useEffect(() => {
    if (!api) return;
    let alive = true, reading = false;
    const refresh = async () => {
      if (reading || pendingRequests.current) return;
      reading = true;
      const started = snapshotRevision.current;
      try {
        const result = await api.captureSnapshot();
        if (!alive || started !== snapshotRevision.current) return;
        if (result.ok) acceptSnapshot(result.data); else setError(result.error.message);
      } catch { if (alive && started === snapshotRevision.current) setError(`无法读取${label}采集状态。`); }
      finally { reading = false; }
    };
    // Cloud events are unversioned echoes of other snapshot reads, not live collector updates.
    // Use this page's guarded reads so a late global poll cannot undo a newer operation.
    const unsubscribe = cloudMode ? () => {} : api.onCaptureChanged(value => { if (alive) acceptSnapshot(value); });
    void refresh();
    const timer = cloudMode ? window.setInterval(() => { void refresh(); }, 2000) : undefined;
    return () => { alive = false; if (timer !== undefined) window.clearInterval(timer); unsubscribe(); };
  }, [api, cloudMode, acceptSnapshot, label]);
  const configuredAccount = snapshot?.config.accountId;
  const recordAccount = focusedReference?.accountId ?? configuredAccount ?? null;
  const messageScope = recordAccount ? JSON.stringify([recordAccount, groupFilter, focusedReference?.messageId ?? null, offset]) : null;
  const batchScope = recordAccount ? JSON.stringify([recordAccount, groupFilter, batchMessageId, offset]) : null;
  const visibleMessages = messageScope && messagesOwner === messageScope ? messages : emptyPage<CaptureMessageView>();
  const visibleBatches = batchScope && batchesOwner === batchScope ? batches : emptyPage<CaptureBatchView>();
  const chosenKey = snapshot?.config.groupIds.join('\0');
  useEffect(() => { setChosen(snapshot?.config.groupIds ?? []); }, [configuredAccount, chosenKey]);
  useLayoutEffect(() => {
    accountRevision.current += 1;
    setGroups([]); setCleanupGroup(''); setConfirmCleanup(false); setConfirmDisconnect(false);
  }, [configuredAccount]);
  useEffect(() => {
    setMessages(emptyPage()); setBatches(emptyPage()); setMessagesOwner(null); setBatchesOwner(null);
    setGroupFilter(focusedReference?.groupId ?? ''); setOffset(0); setAttachment(null); setAttachmentAccount(null); setChunks(null);
    setRetry(null); setReanalysis(false);
    setBatchMessageId(null);
    openedReferenceAttachment.current = null;
  }, [recordAccount]);
  useEffect(() => {
    setFocusedReference(initialReference);
    setBatchMessageId(null);
    if (!initialReference) return;
    setGroupFilter(initialReference.groupId); setTab('messages'); setOffset(0); setAttachment(null); setAttachmentAccount(null); setChunks(null); openedReferenceAttachment.current = null;
  }, [initialReference]);
  useLayoutEffect(() => { if (snapshot) setEndpoint(snapshot.config.endpoint); }, [snapshot?.config.endpoint]);
  useLayoutEffect(() => { if (snapshot) setFlavor(snapshot.config.flavor); }, [snapshot?.config.flavor]);
  useEffect(() => {
    if (!api || !snapshot || tab === 'history' || !recordAccount) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      const messageId = tab === 'messages' ? focusedReference?.messageId : batchMessageId;
      const options = { accountId: recordAccount, ...(groupFilter ? { groupId: groupFilter } : {}), ...(messageId ? { messageId } : {}), offset, limit: 30 };
      const job = tab === 'messages' ? api.captureMessages(options).then(result => {
        if (alive) { if (result.ok) { setMessages(result.data); setMessagesOwner(messageScope); } else setError(result.error.message); }
      }) : api.captureBatches(options).then(result => {
        if (alive) { if (result.ok) { setBatches(result.data); setBatchesOwner(batchScope); } else setError(result.error.message); }
      });
      void job.catch(() => { if (alive) setError('记录加载失败，请重试。'); });
    }, 120);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [api, !!snapshot, recordAccount, messageScope, batchScope, focusedReference, groupFilter, batchMessageId, offset, tab, revision]);
  useEffect(() => {
    const target = focusedReference?.attachmentId;
    if (!target || target === openedReferenceAttachment.current) return;
    const found = visibleMessages.items.flatMap(message => message.attachments).find(item => item.id === target);
    if (found && found.status !== 'deleted') { openedReferenceAttachment.current = target; setAttachment(found); setAttachmentAccount(recordAccount); setChunkOffset(0); }
  }, [focusedReference, visibleMessages, recordAccount]);
  useEffect(() => {
    if (!api || !attachment || attachmentAccount !== recordAccount || !recordAccount) return;
    let alive = true; setChunks(null);
    void api.captureChunks({ attachmentId: attachment.id, offset: chunkOffset, limit: 5 }).then(result => {
      if (alive) { if (result.ok) setChunks(result.data); else setError(result.error.message); }
    }).catch(() => { if (alive) setError('附件正文加载失败。'); });
    return () => { alive = false; };
  }, [api, attachment?.id, attachmentAccount, recordAccount, chunkOffset]);

  async function configure(change: Partial<CaptureConfig>, message: string) {
    if (!api || !snapshot) return;
    let value: CaptureConfig;
    try { value = CaptureConfigSchema.parse({ ...snapshot.config, ...change }); }
    catch { setError('请检查本机地址、账号与群选择。'); return; }
    await requestSnapshot(() => api.captureConfigure(value), next => { setNotice(message === analysisStartedNotice && !next.config.analysisEnabled ? '' : message); });
  }
  async function connect(detect: boolean) {
    if (!api || !snapshot) return;
    if (!wechat && !detect && (endpoint !== snapshot.config.endpoint || flavor !== snapshot.config.flavor)) {
      try {
        const config = CaptureConfigSchema.parse({ ...snapshot.config, endpoint, flavor, enabled: false, analysisEnabled: false });
        const saved = await requestSnapshot(() => api.captureConfigure(config)); if (!saved) return;
      } catch { setError('请填写有效的本机回环地址，例如 ws://127.0.0.1:43131。'); return; }
    }
    const entered = token.current?.value.trim();
    const pending = api.captureConnect(wechat ? {} : { detect, ...(!detect && entered ? { token: entered } : {}) });
    if (token.current) token.current.value = '';
    await requestSnapshot(() => pending, value => { setEndpoint(value.config.endpoint); setFlavor(value.config.flavor); setNotice(value.connection === 'online' ? `连接成功，请核对 ${label} 账号、选群以及收集和自动分析开关。` : '已检查连接，请查看当前状态。'); });
  }
  async function action(action: 'analyze' | 'backfill' | 'retry' | 'reanalyze' | 'pause-analysis', batchId?: string) {
    if (!api) return;
    await requestSnapshot(() => api.captureAction({ action, ...(batchId ? { batchId } : {}) }), () => {
      setRetry(null); setReanalysis(false);
      setNotice(action === 'backfill' ? '已安排最近 7 天的补采，请在历史覆盖中查看结果。' : action === 'retry' ? '已安排重试，将复用已经保存的分析结果。' : action === 'reanalyze' ? '已安排重新分析，已有候选仍保留。' : '已安排分析，候选整理后会进入待判断。');
    });
  }
  async function cleanupRecords() {
    if (!api || !configuredAccount || (!cleanupGroup && !cleanupBefore)) return;
    await requestSnapshot(() => api.captureCleanup({ accountId: configuredAccount, ...(cleanupGroup ? { groupId: cleanupGroup } : {}), ...(cleanupBefore ? { before: `${cleanupBefore}T00:00:00+08:00` } : {}) }), () => {
      setConfirmCleanup(false); setNotice('原文与附件已清理。已有候选和任务仍保留。');
    });
  }
  async function disconnectAccount() {
    if (!api || !snapshot || snapshot.config.enabled) return;
    await requestSnapshot(() => api.captureAction({ action: 'disconnect' }), () => {
      setConfirmDisconnect(false);
      setNotice('账号绑定已解除。原消息、附件与日历事项均保留；重新连接后请再次选择重要群。');
    });
  }
  async function readGroups() {
    if (!api || !configuredAccount) return;
    const revision = accountRevision.current;
    await request(() => api.captureGroups(), value => {
      if (revision !== accountRevision.current) return;
      setGroups(value); setNotice(`已读取 ${value.length} 个群，请勾选要收集的群。`);
    });
  }
  function nameOf(id: string) { return groups.find(group => group.id === id)?.name || `群 ${id}`; }
  function attachmentStatus(status: AttachmentSummary['status']) { return wechat && status === 'downloading' ? '读取本机文件' : attachmentLabels[status]; }
  const selectionGroups = [...groups, ...chosen.filter(id => !groups.some(group => group.id === id)).map(id => ({ id, name: `群 ${id}` }))];
  const availableGroups = focusedReference && !selectionGroups.some(group => group.id === focusedReference.groupId) ? [...selectionGroups, { id: focusedReference.groupId, name: `来源群 ${focusedReference.groupId}` }] : selectionGroups;
  const groupChoices = selectionGroups.filter(group => `${group.name} ${group.id}`.includes(search.trim()));
  const page = tab === 'batches' ? visibleBatches : visibleMessages;
  const attachmentMessage = attachment ? visibleMessages.items.find(message => message.attachments.some(item => item.id === attachment.id)) : undefined;
  if (!api) return <div className="empty-state">请在 Windows 桌面应用中打开{label}采集。</div>;
  if (!snapshot) return <div className="capture-page"><p role="status">{error || `正在读取${label}采集状态…`}</p></div>;
  const analysisPausedReason = !snapshot.config.analysisEnabled ? snapshot.error : null;

  return <div className="capture-page">
    <div className="a2-me-h"><h2 title="每群每 2 分钟整理一次，提取要做的事、收益和时间，进入待判断后由你决定。">{wechat ? '微信采集' : 'QQ 采集'}</h2>
      <span className={`capture-status ${snapshot.connection === 'online' ? 'is-online' : ''}`}>{connections[snapshot.connection]}</span>
    </div>
    {error && <div className="error capture-alert" role="alert">{error}</div>}
    {notice && <div className="success capture-alert" role="status">{notice}</div>}
    {snapshot.error && !analysisPausedReason && <div className="warning capture-alert" role="status">{snapshot.error}</div>}
    <section className="settings-card capture-connection">
      <div className="capture-card-heading"><h3>{wechat ? '本机微信连接' : '日历专用 QQ 连接'}</h3><span className="hint">{wechat ? '本机只读采集' : snapshot.config.flavor === 'snowluma' ? 'SnowLuma' : 'NapCat'} · {connections[snapshot.connection]}</span></div>
      <div className="capture-account-identity"><div><span className="hint">{snapshot.connection === 'account-changed' ? '组件返回昵称' : '账号昵称'}</span><strong>{snapshot.accountName || (snapshot.connection === 'online' ? '组件未提供昵称' : '等待连接确认')}</strong></div><div><span className="hint">{wechat ? (snapshot.connection === 'account-changed' ? '旧绑定微信账号' : '已绑定微信账号') : (snapshot.connection === 'account-changed' ? '旧绑定 QQ 号' : '已绑定 QQ 号')}</span><strong>{configuredAccount || '尚未绑定'}</strong></div></div>
      {!wechat && <div className="form-grid"><label>日历专用桥接类型<select value={flavor} onChange={event => setFlavor(event.target.value as 'napcat' | 'snowluma')}><option value="napcat">NapCat</option><option value="snowluma">SnowLuma（日历专用实例）</option></select></label><label>本机桥接地址<input value={endpoint} onChange={event => setEndpoint(event.target.value)} spellCheck={false} /></label>
        <label>桥接访问令牌<input ref={token} type="password" autoComplete="off" placeholder={snapshot.credentialConfigured ? '已保存，无需重填；填写可更换' : '连接组件要求的访问令牌'} /></label>
      </div>}
      <div className="toolbar"><button className="primary" disabled={busy} onClick={() => void connect(true)}>{wechat ? '连接本机微信' : '检测日历专用 QQ 组件'}</button>{!wechat && <button disabled={busy} onClick={() => void connect(false)}>连接此地址</button>}</div>
      {snapshot.connection === 'account-changed' && <div className="warning"><p>组件返回的账号与旧绑定不一致，已暂停原账号的收集和分析。解除绑定后重新连接，再为新账号选择群。</p></div>}
      {configuredAccount && !snapshot.config.enabled && <button disabled={busy} onClick={() => { setError(''); setConfirmDisconnect(true); }}>解除账号绑定…</button>}
      {wechat && <div className="fine-print"><p>首次使用需要单独配置本机微信读取环境。若提示“组件尚未配置”，请按指南完成配置后重新打开日历。</p><button type="button" disabled={busy} onClick={() => {
        if (!api?.resourceOpen) { setNotice(`请在浏览器打开配置指南：${wechatSetupUrl}`); return; }
        void request(() => api.resourceOpen!({ resource: { id: 'wechat-setup-guide', kind: 'web', name: '微信采集配置指南', url: wechatSetupUrl } }), () => setNotice('已在 Edge 打开微信采集配置指南。'));
      }}>微信采集配置指南</button></div>}
      <p className="fine-print">{wechat ? '电脑微信需要保持登录。只采集你选定的群，不发送微信消息；微信更新或退出登录后，可能需要重新连接。只读取本机已有记录，未同步到电脑的消息无法补采。' : '连接为日历单独配置的 QQ 桥接。采集器只读取选定群，不发送 QQ 消息。令牌由本机安全服务保存。'}</p>
    </section>
    <div className="capture-top-grid">
      <section className="settings-card">
        <div className="capture-card-heading"><h3>选择重要群</h3><button disabled={busy || !configuredAccount || snapshot.connection !== 'online'} onClick={() => void readGroups()}>读取群列表</button></div>
        <label>筛选群<input value={search} onChange={event => setSearch(event.target.value)} placeholder="输入群名或群号" /></label>
        <div className="capture-group-list">{groupChoices.length ? groupChoices.map(group => <label key={group.id} className="capture-group-option"><input type="checkbox" checked={chosen.includes(group.id)} disabled={busy} onChange={event => setChosen(values => event.target.checked ? [...values, group.id] : values.filter(id => id !== group.id))} /><span><strong>{group.name || `群 ${group.id}`}</strong><small>{group.id}</small></span></label>) : <p className="hint">{groups.length ? '没有匹配的群。' : '连接后读取群列表，再勾选班级群、课程群等重要群。'}</p>}</div>
        <div className="toolbar"><button className="primary" disabled={busy || !configuredAccount} onClick={() => void configure({ groupIds: chosen, ...(chosen.length ? {} : { enabled: false }) }, '群选择已保存。')}>保存群选择</button><span className="hint">已勾选 {chosen.length} 个群</span></div>
      </section>
      <section className="settings-card">
        <h3>收集与分析</h3>
        {model && <div className="capture-model-info"><p className="hint">当前 DeepSeek 模型：{model}</p><p className={modelModalities && !modelModalities.includes('image') ? 'warning' : 'hint'}>{modelModalities ? modelModalities.includes('image') ? '模型接口标注支持图片输入，图片与扫描页会送交该模型识别。' : '当前模型不支持图片输入。图片与扫描页会保留并提示处理失败；请在设置中选择支持图片的模型后重读资料。' : '接口尚未说明图片能力。图片会保留在请求中；模型拒绝时显示错误，不会当作已读完。'}</p>{account.error && <p className="warning">{account.error}</p>}<button disabled={account.refreshing} onClick={() => void account.refresh()}>{account.refreshing ? '正在刷新模型信息…' : '刷新模型信息'}</button></div>}
        <div className="capture-switch-row"><div><strong>{snapshot.config.enabled ? '正在收集选定群' : '收集已暂停'}</strong><p className="hint">最近收到：{snapshot.lastReceivedAt ? displayInstant(snapshot.lastReceivedAt) : '尚未收到消息'}</p></div><button disabled={busy || (!snapshot.config.enabled && (snapshot.connection !== 'online' || !snapshot.config.groupIds.length))} onClick={() => void configure({ enabled: !snapshot.config.enabled }, snapshot.config.enabled ? '已暂停收集。' : '已启用选定群收集。')}>{snapshot.config.enabled ? '暂停收集' : '开始收集'}</button></div>
        {snapshot.cloudKeySync && <p className={snapshot.cloudKeySync.state === 'error' ? 'warning' : 'hint'} role="status">{snapshot.cloudKeySync.state === 'ready' ? snapshot.cloudKeySync.configured ? '密钥已与云端同步；手机或电脑修改后会自动更新。' : '云端密钥已清除；保存新密钥后会自动同步。' : snapshot.cloudKeySync.state === 'syncing' ? '正在同步云端密钥…' : snapshot.cloudKeySync.message || '密钥暂未同步，连接恢复后会自动重试。'}</p>}
        <div className="capture-switch-row"><div><strong>{snapshot.config.analysisEnabled ? '自动分析已开启' : snapshot.analysisWaitingForKey ? '等待有效密钥，更新后自动继续' : '自动分析已暂停'}</strong><p className="hint">暂停分析后继续收集；已发出的请求会保存结果。</p>{analysisPausedReason && <p className="warning" role="alert">暂停原因：{analysisPausedReason}</p>}</div><button disabled={busy} onClick={() => snapshot.analysisWaitingForKey ? void action('pause-analysis') : void configure({ analysisEnabled: !snapshot.config.analysisEnabled }, snapshot.config.analysisEnabled ? '已暂停新的 AI 分析请求。' : analysisStartedNotice)}>{snapshot.config.analysisEnabled ? '暂停分析' : snapshot.analysisWaitingForKey ? '停止等待密钥' : '开启分析'}</button></div>
        <div className="capture-stats"><div><strong>{snapshot.stats.messages}</strong><span>已收消息</span></div><div><strong>{snapshot.stats.pendingBatches}</strong><span>待处理批次</span></div><div><strong>{snapshot.stats.failedAttachments}</strong><span>附件待查看</span></div></div>
        <div className="toolbar"><button disabled={busy || !configuredAccount || !snapshot.config.analysisEnabled} onClick={() => void action('analyze')}>立即分析</button><button disabled={busy || snapshot.connection !== 'online' || !snapshot.config.enabled} onClick={() => void action('backfill')}>补采最近 7 天</button></div>
        <p className="fine-print">自动分析不设每日预算上限，沿用设置中的 DeepSeek 模型与真实余额。{wechat ? '可分析文字、卡片标题，以及电脑微信已缓存或下载的图片和文件；尚未下载时，请先在微信中打开或下载，再重试对应批次。最近 7 天曾未读到的附件，也可点“补采最近 7 天”重新检查。语音、视频和压缩包需手动查看。' : '语音、视频和压缩包需手动查看。'}</p>
      </section>
    </div>
    <section className="settings-card capture-records">
      <div className="capture-card-heading"><div className="tabs">{([['messages', '消息原文'], ['batches', '分析批次'], ['history', '历史覆盖']] as const).map(([id, label]) => <button key={id} className={tab === id ? 'selected' : ''} onClick={() => { setTab(id); setBatchMessageId(null); setOffset(0); }}>{label}</button>)}</div><button disabled={busy} onClick={() => setRevision(n => n + 1)}>刷新记录</button></div>
      <label className="capture-filter">按群查看<select value={groupFilter} onChange={event => { setFocusedReference(undefined); setBatchMessageId(null); setGroupFilter(event.target.value); setOffset(0); }}><option value="">当前账号已收录的全部群</option>{availableGroups.map(group => <option key={group.id} value={group.id}>{group.name || group.id}</option>)}</select></label>
      {focusedReference && <div className="capture-card-heading"><p className="hint">正在查看来源账号 {label} {focusedReference.accountId} 的指定消息 · {focusedReference.locator}</p><button onClick={() => { setFocusedReference(undefined); setBatchMessageId(null); setRevision(n => n + 1); }}>{configuredAccount ? '返回当前账号消息' : '结束来源查看'}</button></div>}
      {tab === 'batches' && batchMessageId && <div className="capture-card-heading"><p className="hint">正在查看这条消息的分析批次。</p><button onClick={() => { setBatchMessageId(null); setOffset(0); }}>返回批次列表</button></div>}
      {!recordAccount && <p className="hint">尚未绑定 {label} 账号，暂不读取消息和批次。已收集的数据仍保留在本机。</p>}
      {tab === 'messages' && (visibleMessages.items.length ? <div className="capture-message-list">{visibleMessages.items.map(message => <article className="capture-message" key={message.id}>
        <div className="capture-message-heading"><strong>{message.groupName || nameOf(message.groupId)}</strong><span>{message.senderName || '群成员'} · {displayInstant(message.sentAt)}</span></div>
        {message.changed && <p className="warning">来源已发生撤回或更正，请核对已整理的事项。</p>}
        {message.deleted ? <p className="hint">原文已清理</p> : <details><summary>{message.text.slice(0, 160) || '附件消息'}{message.text.length > 160 ? '…' : ''}</summary><pre>{message.text || '这条消息没有文字正文。'}</pre></details>}
        <QQSearchActions evidence={{ platform, groupId: message.groupId, groupName: message.groupName || nameOf(message.groupId), senderName: message.senderName, sentAt: message.sentAt, text: message.deleted ? '' : message.text }} />
        {!!message.attachments.length && <div className="capture-attachments">{message.attachments.map(item => <button key={item.id} disabled={item.status === 'deleted'} onClick={() => { setAttachment(item); setAttachmentAccount(recordAccount); setChunkOffset(0); }}><strong>{item.name || '未命名附件'}</strong><span>{attachmentStatus(item.status)}{item.size !== null ? ` · ${sizeLabel(item.size)}` : ''}</span>{item.error && <small className="warning">{item.error}</small>}</button>)}</div>}
      </article>)}</div> : <div className="empty-state"><p>这里还没有收录消息。</p><p>连接{label}、保存群选择并开始收集后，原文会显示在这里。</p></div>)}
      {tab === 'batches' && (visibleBatches.items.length ? <div className="capture-batch-list">{visibleBatches.items.map(batch => <article key={batch.id} className="capture-batch"><div><strong>{nameOf(batch.groupId)}</strong><p className="hint">{batch.messageCount} 条消息 · {displayInstant(batch.createdAt)} · 已发出 {batch.attemptCount} 次请求</p><p className={['failed', 'uncertain'].includes(batch.status) ? 'warning' : 'hint'}>{batchLabels[batch.status]}{batch.error ? `：${batch.error}` : ''}</p></div>{['failed', 'uncertain'].includes(batch.status) ? <div className="toolbar"><button disabled={busy} onClick={() => { setReanalysis(false); if (batch.status === 'uncertain') setRetry(batch); else void action('retry', batch.id); }}>重试此批</button><button disabled={busy} onClick={() => { setReanalysis(true); setRetry(batch); }}>重读资料…</button></div> : batch.status === 'applied' ? <button disabled={busy} onClick={() => { setReanalysis(true); setRetry(batch); }}>重新分析…</button> : null}</article>)}</div> : <div className="empty-state">还没有分析批次。消息收下后每 2 分钟合并，或点击“立即分析”。</div>)}
      {tab === 'history' && <div className="capture-coverage"><p className="hint">“完整”需要实际取得目标时间范围的证据。没有返回历史或接口返回空列表时，不会当作已经补齐。</p>{snapshot.coverage.filter(item => !groupFilter || item.groupId === groupFilter).map(item => <article key={`${item.accountId}:${item.groupId}`}><div className="capture-card-heading"><strong>{nameOf(item.groupId)}</strong><span className={item.status === 'complete' ? 'success' : 'warning'}>{coverageLabels[item.status]}</span></div><p>目标：{displayInstant(item.windowStart)} 至 {displayInstant(item.windowEnd)}</p><p className="hint">已取 {item.fetchedCount} 条 · 最早：{item.earliestAt ? displayInstant(item.earliestAt) : '尚未取得'}</p>{item.error && <p className="warning">{item.error}</p>}</article>)}{!snapshot.coverage.length && <p className="hint">首次启用收集后会尝试补采最近 7 天，也可手动开始。</p>}</div>}
      {tab !== 'history' && <div className="capture-pagination"><span>共 {page.total} 条{page.total ? ` · ${offset + 1}–${Math.min(offset + page.items.length, page.total)}` : ''}</span><div><button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>上一页</button><button disabled={offset + 30 >= page.total} onClick={() => setOffset(offset + 30)}>下一页</button></div></div>}
    </section>
    <section className="settings-card"><h3>本机原文与附件</h3><p className="hint">已存 {snapshot.stats.attachments} 个附件，内容占用 {sizeLabel(snapshot.stats.attachmentBytes)}。补采 7 天不代表只保留 7 天；需要时可自行清理。</p><div className="form-grid"><label>清理范围<select value={cleanupGroup} onChange={event => setCleanupGroup(event.target.value)}><option value="">当前账号所有群（需指定日期）</option>{availableGroups.map(group => <option key={group.id} value={group.id}>{group.name || group.id}</option>)}</select></label><label>删除此日期之前的原文<input type="date" value={cleanupBefore} onChange={event => setCleanupBefore(event.target.value)} /></label></div><p className="fine-print">按北京时间当天 00:00 截止。清理会删除原文和文件正文，保留去重标记；已经整理的候选与任务不会删除。</p><button disabled={busy || !configuredAccount || (!cleanupGroup && !cleanupBefore)} onClick={() => setConfirmCleanup(true)}>清理所选原文与附件…</button></section>
    {attachment && recordAccount && attachmentAccount === recordAccount && <Modal title={attachment.name || '附件正文'} wide onClose={() => setAttachment(null)}><div className="capture-chunk-view"><p className="hint">{attachmentStatus(attachment.status)}{attachment.error ? `：${attachment.error}` : ''}</p>
      {wechat && ['image', 'file'].includes(attachment.kind) && <div className="capture-media-recovery">{attachment.status !== 'ready' && <p className="hint">若提示尚未下载，请先在电脑微信中打开或下载，再到对应分析批次点“重试此批”。缺少附件的批次会先等待读取，不会把未读取的内容当作已分析。</p>}<button disabled={!attachmentMessage} onClick={() => { if (!attachmentMessage) return; setBatchMessageId(attachmentMessage.id); setGroupFilter(attachmentMessage.groupId); setOffset(0); setTab('batches'); setAttachment(null); }}>查看对应分析批次</button></div>}
      {chunks ? chunks.items.length ? chunks.items.map(chunk => <article key={chunk.id}><h3>{chunk.locator}</h3>{chunk.error && <p className="warning">{chunk.error}</p>}{chunk.imageDataUrl && <img src={chunk.imageDataUrl} alt={chunk.locator} />}<pre>{chunk.text || '此处尚未取得文字正文。'}</pre></article>) : <p>尚无可显示正文。请查看附件处理状态。</p> : <p>正在读取正文…</p>}{chunks && <div className="capture-pagination"><span>共 {chunks.total} 个位置</span><div><button disabled={!chunkOffset} onClick={() => setChunkOffset(Math.max(0, chunkOffset - 5))}>上一组</button><button disabled={chunkOffset + 5 >= chunks.total} onClick={() => setChunkOffset(chunkOffset + 5)}>下一组</button></div></div>}</div></Modal>}
    {retry && <Modal title={reanalysis ? '重新读取资料并分析' : '重试响应未知的分析'} onClose={() => setRetry(null)}><p>{reanalysis ? '会重新读取可用资料，使用当前模型从头分析并产生新的费用。已有候选和任务保留，失败附件会再次尝试读取。此前成功的分析分片不会复用。' : '上一次请求已经发出，但没有保存到结果。重试可能产生重复费用；已经保存成功的分片会复用。'}</p><p className="hint">{nameOf(retry.groupId)} · {retry.messageCount} 条消息</p>{error && <p className="error" role="alert">{error}</p>}<div className="toolbar"><button onClick={() => setRetry(null)}>暂不重试</button><button className="primary" disabled={busy} onClick={() => void action(reanalysis ? 'reanalyze' : 'retry', retry.id)}>确认重试</button></div></Modal>}
    {confirmCleanup && <Modal title="确认清理原文与附件" onClose={() => setConfirmCleanup(false)}><p>范围：{cleanupGroup ? nameOf(cleanupGroup) : '当前账号所有群'}{cleanupBefore ? `，${cleanupBefore} 00:00（北京时间）之前` : '，全部时间'}。</p><p>原文与文件正文清理后无法在这里重新打开。已有候选、任务与安排会保留。</p><div className="toolbar"><button onClick={() => setConfirmCleanup(false)}>取消</button><button className="primary" disabled={busy} onClick={() => void cleanupRecords()}>确认清理</button></div></Modal>}
    {confirmDisconnect && <Modal title={`解除 ${label} 账号绑定`} onClose={() => setConfirmDisconnect(false)}><p>解除 {label} {configuredAccount} 的绑定，停止本次组件连接并清空当前选群，收集与自动分析都会暂停。</p><p>不会删除已经收集的消息、附件、候选或日历事项。{!wechat && '组件访问令牌仍保存在本机，可在重新连接时使用。'}</p><p className="hint">如有批次正在处理，请等待当前批次完成后再解除。</p>{error && <p className="error" role="alert">{error}</p>}<div className="toolbar"><button onClick={() => setConfirmDisconnect(false)}>取消</button><button className="primary" disabled={busy || snapshot.config.enabled} onClick={() => void disconnectAccount()}>确认解除绑定</button></div></Modal>}
  </div>;
}
