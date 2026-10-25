import { useRef, useState } from 'react';
import { addCalendarDays } from '../../shared/contracts';
import { PlanExportRequestSchema, type PlanExportDesktopAPI, type PlanExportPreview } from '../../shared/plan-context';
import { todayDate } from '../calendar-layout';
import { Modal } from './Modal';
import './plan-export.css';

export function hasPlanExport(host: Partial<PlanExportDesktopAPI> | undefined): host is PlanExportDesktopAPI {
  return Boolean(host && typeof host.planExportPreview === 'function' && typeof host.planExportSave === 'function');
}

export function PlanExportDialog({ host, goal, onClose, onSaved }: {
  host: PlanExportDesktopAPI;
  goal: { id: string; title: string };
  onClose: () => void;
  onSaved?: (message: string) => void;
}) {
  const [fromDate, setFromDate] = useState(todayDate);
  const [toDate, setToDate] = useState(() => addCalendarDays(todayDate(), 6));
  const [instructions, setInstructions] = useState('');
  const [hideBusyTitles, setHideBusyTitles] = useState(true);
  const [preview, setPreview] = useState<PlanExportPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const working = useRef(false);
  const request = PlanExportRequestSchema.safeParse({ goalId: goal.id, fromDate, toDate, instructions, includeBusyTitles: !hideBusyTitles });
  const validationError = request.success ? '' : request.error.issues[0]?.message;
  const close = () => { if (!working.current) onClose(); };
  const updateParameters = (update: () => void) => {
    if (working.current) return;
    update(); setPreview(null); setError(''); setFeedback('');
  };
  async function run(action: NonNullable<typeof busy>, job: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(action); setError(''); setFeedback('');
    try { await job(); }
    catch (failure) { setPreview(null); setError(failure instanceof Error ? failure.message : '导出失败，请重新预览后重试。'); }
    finally { working.current = false; setBusy(null); }
  }
  const previewExport = () => {
    if (!request.success) return;
    return run('preview', async () => {
      setPreview(null);
      const result = await host.planExportPreview(request.data);
      if (!result.ok) { setError(result.error.message); return; }
      setPreview(result.data);
    });
  };
  const save = () => {
    if (!preview) return;
    return run('save', async () => {
      const result = await host.planExportSave({ token: preview.token });
      if (!result.ok) { setPreview(null); setError(result.error.message); return; }
      if (!result.data.saved) { setFeedback('已取消保存，未生成上下文文件。'); return; }
      const message = result.data.filename ? `已保存上下文文件：${result.data.filename}` : '上下文文件已保存。';
      setFeedback(message); setPreview(null); onSaved?.(message);
    });
  };

  return <Modal title="导出给外部智能体" onClose={close} closeDisabled={Boolean(busy)}>
    <div className="editor-form plan-export" aria-busy={Boolean(busy)}>
      <h3>{goal.title}</h3>
      <p className="plan-export-intro">导出此目标、全部关联任务、已有时段和资料引用，供外部智能体继续规划。</p>
      <div className="plan-export-range">
        <label>规划开始日期<input type="date" value={fromDate} disabled={Boolean(busy)} onChange={event => updateParameters(() => setFromDate(event.target.value))} /></label>
        <label>规划结束日期<input type="date" value={toDate} disabled={Boolean(busy)} onChange={event => updateParameters(() => setToDate(event.target.value))} /></label>
      </div>
      <p className="hint">日期范围含首尾两天，最多 366 天，时间均为北京时间。范围只限制忙碌区间；目标关联任务及已有时段会完整导出。</p>
      {validationError && <p className="error" role="alert">{validationError}</p>}
      <label>续排要求（选填）<textarea rows={3} maxLength={10000} value={instructions} disabled={Boolean(busy)} placeholder="例如：保留已有安排，为尚未安排的任务补充 4 个学习时段，每次 45 分钟。" onChange={event => updateParameters(() => setInstructions(event.target.value))} /></label>
      <label className="check"><input type="checkbox" checked={hideBusyTitles} disabled={Boolean(busy)} onChange={event => updateParameters(() => setHideBusyTitles(event.target.checked))} />隐藏其他日程名称，仅提供忙碌时间</label>
      <p className="hint">只保存本地上下文文件，不会上传给外部智能体，也不会调用 AI。文件包含目标和任务内容，请按需交给你选择的智能体。</p>
      {error && <p className="error" role="alert">{error}</p>}
      {feedback && <p className="plan-export-feedback" role="status">{feedback}</p>}
      {preview && <section className="plan-export-summary" aria-label="导出内容预览">
        <h3>{preview.title}</h3>
        <dl className="plan-export-counts">
          <div><dt>目标</dt><dd>1</dd></div>
          <div><dt>关联任务</dt><dd>{preview.counts.tasks}</dd></div>
          <div><dt>已完成任务</dt><dd>{preview.counts.completedTasks}</dd></div>
          <div><dt>已有时段</dt><dd>{preview.counts.blocks}</dd></div>
          <div><dt>忙碌区间</dt><dd>{preview.counts.busyIntervals}</dd></div>
          <div><dt>资料引用</dt><dd>{preview.counts.resources}</dd></div>
        </dl>
        <dl className="plan-export-meta">
          <dt>规划范围</dt><dd>{preview.fromDate} 至 {preview.toDate}（含首尾）</dd>
          <dt>资料来源</dt><dd>{preview.sourceKind === 'cloud' ? '云端资料' : '本机资料'}</dd>
          <dt>其他日程名称</dt><dd>{hideBusyTitles ? '隐藏' : '包含'}</dd>
        </dl>
        {preview.warnings.length > 0 && <div className="warning"><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        <p className="hint">预览有效期为 10 分钟。保存前会核对资料是否变化；如有变化，请重新预览。</p>
      </section>}
      <p className="hint">上下文文件供智能体读取；智能体返回的增量计划仍需到“导入计划”核对后保存。当前支持补充新增内容，已有时段请在日历中编辑。</p>
      <footer className="form-footer">
        <button disabled={Boolean(busy)} onClick={close}>取消</button>
        <button disabled={Boolean(busy) || !request.success} onClick={() => void previewExport()}>{busy === 'preview' ? '正在预览…' : '预览导出内容'}</button>
        <button className="primary" disabled={Boolean(busy) || !preview} onClick={() => void save()}>{busy === 'save' ? '正在保存…' : '保存上下文文件'}</button>
      </footer>
    </div>
  </Modal>;
}
