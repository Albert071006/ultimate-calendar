import { useId, useRef, useState } from 'react';
import type { PlanImportDesktopAPI, PlanImportPreview, PlanImportResult } from '../../shared/plan-import';
import type { BusyExportDesktopAPI } from '../../shared/busy-context';
import type { PlannerUI } from '../hooks/usePlanner';
import { Modal } from './Modal';
import { BusyExportPanel, hasBusyExport } from './BusyExportPanel';
import './plan-import.css';

export function hasPlanImport(host: Partial<PlanImportDesktopAPI> | undefined): host is PlanImportDesktopAPI {
  return Boolean(host && typeof host.planImportOpen === 'function' && typeof host.planImportConfirm === 'function' && typeof host.planImportTemplate === 'function');
}

const kindNames = { goal: '目标', task: '任务', block: '时段' };
const stateNames = { new: '待新增', existing: '已存在', blocked: '需处理' };
function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function PlanImportDialog({ host, ui, onClose }: {
  host: PlanImportDesktopAPI & Partial<BusyExportDesktopAPI>;
  ui: Pick<PlannerUI, 'refresh' | 'setNotice'>;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<PlanImportPreview | null>(null);
  const [report, setReport] = useState<PlanImportResult | null>(null);
  const [allowConflicts, setAllowConflicts] = useState(false);
  const [busy, setBusy] = useState<'open' | 'confirm' | 'template' | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busyExportOpen, setBusyExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const exporting = useRef(false);
  const busyPanelId = useId();
  const busyHost = hasBusyExport(host) ? host : undefined;
  const locked = Boolean(busy) || exportBusy;
  const working = useRef(false);
  const counts = { new: 0, existing: 0, blocked: 0 };
  preview?.rows.forEach(row => { counts[row.state] += 1; });
  const verifyPending = preview?.canVerifyPending === true;
  const confirmable = Boolean(preview && (verifyPending || (counts.new > 0 && counts.blocked === 0 && (!preview.conflicts.length || allowConflicts))));
  const close = () => { if (!working.current && !exporting.current) onClose(); };

  async function run(action: NonNullable<typeof busy>, job: () => Promise<void>) {
    if (working.current || exporting.current) return;
    working.current = true; setBusy(action); setError(''); setFeedback('');
    try { await job(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试。'); }
    finally { working.current = false; setBusy(null); }
  }
  const chooseFile = () => run('open', async () => {
    const result = await host.planImportOpen();
    if (!result.ok) { setPreview(null); setAllowConflicts(false); setError(result.error.message); return; }
    if (result.data) {
      setPreview(result.data); setReport(null); setAllowConflicts(false);
    }
  });
  const saveTemplate = () => run('template', async () => {
    const result = await host.planImportTemplate();
    if (!result.ok) setError(result.error.message);
    else if (result.data.saved) setFeedback('示例 JSON 已保存，可交给外部智能体按相同格式生成计划。');
  });
  const confirm = () => {
    if (!preview || !confirmable) return;
    return run('confirm', async () => {
      const result = await host.planImportConfirm({ token: preview.token, allowConflicts: verifyPending ? false : allowConflicts });
      if (!result.ok) { setError(result.error.message); return; }
      const receipt = result.data;
      setReport(receipt); setPreview(receipt.preview ?? null); setAllowConflicts(false);
      ui.setNotice(receipt.message);
      try { await ui.refresh(); }
      catch { ui.setNotice(`${receipt.message} 页面刷新失败，请重新载入。`); }
      if (receipt.status === 'complete') onClose();
    });
  };

  return <Modal wide title="导入计划" onClose={close} closeDisabled={locked}>
    <div className="editor-form plan-import" aria-busy={locked}>
      <p className="plan-import-intro">首次新建可整份导入目标、任务、学习时段和资料引用，核对后一次确认保存。</p>
      <p className="hint">已有目标续排，请从目标的“导出给外部智能体”获取上下文，避免重建。选择文件只生成预览；中断后使用原文件继续。</p>
      <div className="plan-import-file-actions">
        <button disabled={locked} onClick={() => void chooseFile()}>{busy === 'open' ? '正在读取…' : preview ? '重新选择 JSON 文件' : '选择 JSON 文件'}</button>
        <button disabled={locked} onClick={() => void saveTemplate()}>{busy === 'template' ? '正在保存…' : '保存示例文件'}</button>
        {busyHost && <button disabled={locked} aria-expanded={busyExportOpen} aria-controls={busyPanelId} onClick={() => { if (!working.current && !exporting.current) setBusyExportOpen(open => !open); }}>导出忙碌时间</button>}
      </div>
      {busyExportOpen && busyHost && <div id={busyPanelId}><BusyExportPanel host={busyHost} disabled={Boolean(busy)} onBusyChange={value => { exporting.current = value; setExportBusy(value); }} onSaved={ui.setNotice} /></div>}
      {feedback && <p role="status">{feedback}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {report?.status === 'partial' && <section className="warning plan-import-receipt" role="status" aria-label="导入进度">
        <strong>已保存 {report.applied} 条 · 未完成 {report.remaining} 条</strong>
        <p>{report.message}</p>
        <p>{verifyPending ? '请先核对上次已保存的结果。' : preview ? '请核对最新预览，再继续导入未完成的条目。' : '请重新选择同一份原始 JSON 文件，核对预览后继续。'}</p>
      </section>}
      {preview ? <>
        <section className="plan-import-summary" aria-label="计划预览">
          <h3>{preview.title}</h3>
          <p className="hint">计划编号：{preview.planId}</p>
          <div className="plan-import-counts" aria-label="条目统计">
            <span>待新增 <b>{counts.new}</b></span><span>已存在 <b>{counts.existing}</b></span><span>需处理 <b>{counts.blocked}</b></span>
          </div>
          <p className="hint">共 {preview.rows.length} 条：目标 {preview.rows.filter(row => row.kind === 'goal').length} · 任务 {preview.rows.filter(row => row.kind === 'task').length} · 时段 {preview.rows.filter(row => row.kind === 'block').length}。所有时间按北京时间显示。</p>
        </section>
        <ol className="plan-import-rows" aria-label="导入条目">
          {preview.rows.map(row => <li key={`${row.kind}:${row.localId}`} className={`plan-import-row ${row.state}`}>
            <div className="plan-import-row-heading"><span className="plan-import-kind">{kindNames[row.kind]}</span><strong>{row.title}</strong><span className="plan-import-state">{stateNames[row.state]}</span></div>
            <p>{row.detail}</p>
            {(row.start || row.end) && <p className="plan-import-time">{row.start && `开始：${displayTime(row.start)}`}{row.start && row.end && ' · '}{row.end && `结束：${displayTime(row.end)}`}</p>}
          </li>)}
        </ol>
        {preview.resources.length > 0 && <section className="plan-import-resources" aria-label="资料引用">
          <h3>资料引用 · {preview.resources.length}</h3>
          <ul>{preview.resources.map(resource => <li key={resource.id}>
            <strong>{resource.name}</strong>
            <span>{resource.kind === 'web' ? resource.url : `${resource.kind === 'file' ? '本地文件' : '本地文件夹'} · ${resource.deviceName}`}</span>
          </li>)}</ul>
          <p className="hint">导入保存资料引用，本地文件仍由所属设备管理。</p>
        </section>}
        {preview.warnings.length > 0 && <section className="warning" aria-label="导入提醒"><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></section>}
        {verifyPending && <p className="warning" role="status">只核对上次已保存的结果，不继续新增；之后重新导出最新计划。</p>}
        {counts.blocked > 0 && !verifyPending && <p className="warning" role="alert">有 {counts.blocked} 条需要处理，暂时无法导入。请核对上方原因后重新选择文件。</p>}
        {preview.conflicts.length > 0 && <section className="warning plan-import-conflicts" aria-label="时间冲突">
          <h3>时间冲突 · {preview.conflicts.length}</h3>
          <ul>{preview.conflicts.map((conflict, index) => <li key={index}>{conflict}</li>)}</ul>
          <label className="check"><input type="checkbox" disabled={locked || verifyPending} checked={!verifyPending && allowConflicts} onChange={event => setAllowConflicts(event.target.checked)} />我已核对以上时间冲突，仍按文件导入</label>
        </section>}
        {counts.new === 0 && counts.blocked === 0 && !verifyPending && <p role="status">这些条目已全部存在，无需再次导入。</p>}
      </> : !report && <div className="plan-import-empty"><p>还未选择计划文件</p><p className="hint">支持 JSON 格式，单个文件不超过 1 MB、最多 500 条目标、任务和时段。</p></div>}
      <footer className="form-footer">
        <button disabled={locked} onClick={close}>取消</button>
        <button className="primary" disabled={locked || !confirmable} onClick={() => void confirm()}>{busy === 'confirm' ? verifyPending ? '正在核对，请稍候…' : '正在导入，请稍候…' : verifyPending ? '仅核对已保存操作' : report?.status === 'partial' && preview ? '继续导入未完成条目' : '确认批量导入'}</button>
      </footer>
    </div>
  </Modal>;
}
