import { useEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../shared/contracts';
import type { HostCapabilities } from '../../shared/client';
import { SpacePolicySchema, type SpacePolicy, type SpaceSnapshot } from '../../shared/space';
import { displayInstant } from '../calendar-layout';
import './SpaceManagement.css';

function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const numericFields = [
  ['autoBackupKeep', '自动备份保留', '份', 1, 30],
  ['safetyBackupKeep', '更新或恢复前的备份保留', '份', 1, 20],
  ['backupBudgetMiB', '备份最多占用', 'MB', 256, 65536],
  ['attachmentDays', '已处理附件保留', '天', 7, 365],
  ['attachmentBudgetMiB', 'QQ 附件最多占用', 'MB', 128, 65536],
] as const;

export function SpaceManagement({ host, active = true, plannerBusy = false }: {
  host?: HostCapabilities;
  active?: boolean;
  plannerBusy?: boolean;
}) {
  const supported = !!host && ['spaceSnapshot', 'spaceConfigure', 'spaceCleanup']
    .every(method => typeof host[method as keyof HostCapabilities] === 'function');
  const [snapshot, setSnapshot] = useState<SpaceSnapshot | null>(null);
  const [policy, setPolicy] = useState<SpacePolicy>(SpacePolicySchema.parse({}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [clearCache, setClearCache] = useState(false);
  const dirty = snapshot !== null && JSON.stringify(policy) !== JSON.stringify(snapshot.policy);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!active || !supported || !host) return;
    let alive = true;
    setBusy(true);
    void host.spaceSnapshot().then(result => {
      if (!alive) return;
      if (result.ok) { setSnapshot(result.data); if (!dirtyRef.current) setPolicy(result.data.policy); setError(''); }
      else setError(result.error.message);
    }).catch(() => { if (alive) setError('空间信息读取失败，请重试。'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [active, supported, host]);

  if (!supported) return null;

  async function run(work: () => Promise<ApiResult<SpaceSnapshot>>, success: (value: SpaceSnapshot) => void) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await work();
      if (result.ok) { setSnapshot(result.data); success(result.data); }
      else setError(result.error.message);
    } catch { setError('操作未完成，请检查本机服务后重试。'); }
    finally { setBusy(false); }
  }
  function change(key: keyof SpacePolicy, value: number | boolean) {
    setPolicy(previous => ({ ...previous, [key]: value }));
    setConfirm(false); setNotice('');
  }
  function savePolicy() {
    const parsed = SpacePolicySchema.safeParse(policy);
    if (!parsed.success) { setError('请按标注范围填写整数，容量单位为 MB。'); return; }
    setConfirm(false);
    void run(() => host!.spaceConfigure(parsed.data), value => {
      setPolicy(value.policy); setNotice('清理规则已保存。');
    });
  }
  const disabled = busy || plannerBusy;
  const canClean = !!snapshot && (snapshot.removableBackupCount > 0 || snapshot.attachments.selectedAttachments > 0
    || snapshot.reusableBytes > 0 || (clearCache && snapshot.cacheBytes > 0));
  const reclaim = snapshot ? snapshot.removableBackupBytes + snapshot.attachments.reclaimableBytes : 0;
  const pieces = snapshot ? [
    snapshot.removableBackupCount ? `${snapshot.removableBackupCount} 份旧备份` : '',
    snapshot.attachments.selectedAttachments ? `${snapshot.attachments.selectedAttachments} 个已处理附件` : '',
  ].filter(Boolean) : [];
  return <section className="space-management" aria-labelledby="space-management-title" aria-busy={busy}>
    <div className="space-h">
      <h4 id="space-management-title">空间占用</h4>
      <button type="button" className="ui-btn sm ghost" disabled={disabled} onClick={() => {
        setConfirm(false);
        void run(() => host!.spaceSnapshot(), value => { if (!dirty) setPolicy(value.policy); });
      }}>{busy ? '正在处理…' : '刷新'}</button>
    </div>
    {snapshot && <>
      <dl className="space-usage">
        <div><dt>数据库</dt><dd>{size(snapshot.databaseBytes)}</dd>{snapshot.reusableBytes > 0 && <small>其中 {size(snapshot.reusableBytes)} 可回收</small>}</div>
        <div><dt>QQ 附件</dt><dd>{size(snapshot.attachments.totalBytes)}</dd>{snapshot.attachments.protectedBytes > 0 && <small>{size(snapshot.attachments.protectedBytes)} 仍在使用</small>}</div>
        <div><dt>本机备份</dt><dd>{size(snapshot.backupBytes)}</dd>{snapshot.unmanagedBackupBytes > 0 && <small>手动导出 {size(snapshot.unmanagedBackupBytes)}，不会自动删除</small>}</div>
        <div><dt>界面缓存</dt><dd>{size(snapshot.cacheBytes)}</dd><small>可随时清理</small></div>
      </dl>
      <p className="space-muted" style={{ overflowWrap: 'anywhere' }}>备份位置：{snapshot.backupDirectory}</p>

      <h4 className="space-sub">立即清理</h4>
      <div className="space-now">
        <p>{pieces.length ? `可清理 ${pieces.join('、')}，约 ${size(reclaim)}` : '暂时没有可清理的备份或附件'}</p>
        <label className="space-check"><input type="checkbox" checked={clearCache} disabled={disabled}
          onChange={event => { setClearCache(event.target.checked); setConfirm(false); }} />本次同时清理界面缓存</label>
        <button type="button" className="ui-btn sm" disabled={disabled || dirty || !canClean} onClick={() => {
          void run(() => host!.spaceSnapshot(), () => setConfirm(true));
        }}>预览清理</button>
      </div>
      {confirm && <div className="space-confirm" role="region" aria-label="确认空间清理">
        <p>将清理 {snapshot.removableBackupCount} 份旧备份和 {snapshot.attachments.selectedAttachments} 个已处理附件，预计回收 {size(reclaim)}{clearCache ? `，另清理 ${size(snapshot.cacheBytes)} 界面缓存` : ''}。清理无法撤销，正式数据保留。</p>
        <div className="space-buttons"><button type="button" className="ui-btn sm" disabled={disabled} onClick={() => setConfirm(false)}>取消</button>
          <button type="button" className="ui-btn sm primary" disabled={disabled || dirty} onClick={() => {
            void run(() => host!.spaceCleanup({ clearCache }), () => { setConfirm(false); setNotice('空间清理已完成。'); });
          }}>确认清理</button></div>
      </div>}

      <div className="space-h space-sub">
        <h4>自动清理</h4>
        <label className="space-check"><input type="checkbox" checked={policy.enabled} disabled={disabled}
          onChange={event => change('enabled', event.target.checked)} />开启<span className="space-muted">应用运行时每小时空闲检查一次</span></label>
      </div>
      <ul className="space-rules">
        {numericFields.map(([key, label, unit, min, max]) => <li key={key}>
          <span className="k">{label}</span>
          <span className="v"><input type="number" aria-label={label} title={`${min}–${max} ${unit}`} value={Number.isFinite(policy[key]) ? policy[key] : ''}
            min={min} max={max} step={1} disabled={disabled} onChange={event => change(key, event.target.value === '' ? NaN : Number(event.target.value))} />
            <span className="u">{unit}</span><small>{min}–{max}</small></span>
        </li>)}
      </ul>
      <div className="space-rule-actions">
        <span className="space-muted">{dirty ? '规则已修改，保存后才能预览清理' : ''}</span>
        <button type="button" className={`ui-btn sm${dirty ? ' primary' : ''}`} disabled={disabled || !dirty} onClick={savePolicy}>保存清理规则</button>
      </div>
      <details className="space-scope"><summary>哪些内容会被清理</summary>
        <p>账单、任务、课表和消息正文不会被清理。待分析、待判断或未完成任务还在用的附件也会保留，容量上限不会强制删除这些内容。</p>
        <p>备份只轮换程序自动生成的备份，并始终保留必要的有效备份；手动导出的备份和其他文件不会自动删除。</p>
        <p>附件按保存天数和容量从旧到新清理，连同解析文本和重复的处理缓存；已提炼出的事项仍保留。清理后原附件无法再查看或分析。</p>
      </details>

      {!!snapshot.warnings.length && <ul className="space-warnings">{snapshot.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {(snapshot.lastRunAt || snapshot.lastResult) && <p className="space-last-run">{snapshot.lastRunAt && `上次清理 ${displayInstant(snapshot.lastRunAt)}`}{snapshot.lastRunAt && snapshot.lastResult ? ' · ' : ''}{snapshot.lastResult}</p>}
    </>}
    {!snapshot && !error && <p className="space-muted">正在读取空间占用…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="space-notice" role="status">{notice}</p>}
  </section>;
}
