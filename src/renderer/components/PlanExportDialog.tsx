import { useRef, useState } from 'react';
import { addCalendarDays } from '../../shared/contracts';
import { PlanExportRequestSchema, type PlanExportDesktopAPI, type PlanExportPreview } from '../../shared/plan-context';
import { todayDate } from '../calendar-layout';
import { Modal } from './Modal';
import './plan-export.css';
import { formatFriendlyRange } from '../../shared/display-time';

// These two older server messages are instructions, covered by the help below.
// Actual export warnings remain visible above the confirmation buttons.
const legacyHelp = new Set([
  '将导出目标和关联任务的全部已有时段；规划范围用于检查课表与其他日程的占用。',
  '将此文件交给外部智能体生成增量计划，保留文件中的状态标记；上下文文件本身不能导入。',
]);

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
  const warnings = preview?.warnings.filter(warning => !legacyHelp.has(warning)) ?? [];
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
      <p className="plan-export-intro"><strong>{goal.title}</strong><span className="hint">把这个目标的任务和已有安排存成文件，交给外部 AI 帮你继续规划。</span></p>
      <div className="plan-export-range">
        <label>规划开始日期<input type="date" value={fromDate} disabled={Boolean(busy)} onChange={event => updateParameters(() => setFromDate(event.target.value))} /></label>
        <label>规划结束日期<input type="date" value={toDate} disabled={Boolean(busy)} onChange={event => updateParameters(() => setToDate(event.target.value))} /></label>
      </div>
      <p className="hint">选择希望 AI 参考的日程范围，时间均为北京时间。</p>
      {validationError && <p className="error" role="alert">{validationError}</p>}
      <label>续排要求（选填）<textarea rows={3} maxLength={10000} value={instructions} disabled={Boolean(busy)} placeholder="例如：保留已有安排，为尚未安排的任务补充 4 个学习时段，每次 45 分钟。" onChange={event => updateParameters(() => setInstructions(event.target.value))} /></label>
      <label className="check"><input type="checkbox" checked={hideBusyTitles} disabled={Boolean(busy)} onChange={event => updateParameters(() => setHideBusyTitles(event.target.checked))} />隐藏其他日程名称，仅提供忙碌时间</label>
      {error && <p className="error" role="alert">{error}</p>}
      {feedback && <p className="plan-export-feedback" role="status">{feedback}</p>}
      {preview && <section className="plan-export-summary" aria-label="导出内容预览">
        <dl className="plan-export-counts">
          <div><dt>目标</dt><dd>1</dd></div>
          <div><dt>关联任务</dt><dd>{preview.counts.tasks}</dd></div>
          <div><dt>已完成任务</dt><dd>{preview.counts.completedTasks}</dd></div>
          <div><dt>已有时段</dt><dd>{preview.counts.blocks}</dd></div>
          <div><dt>忙碌区间</dt><dd>{preview.counts.busyIntervals}</dd></div>
          <div><dt>资料引用</dt><dd>{preview.counts.resources}</dd></div>
        </dl>
        <dl className="plan-export-meta">
          <dt>规划范围</dt><dd>{formatFriendlyRange(preview.fromDate, preview.toDate)}</dd>
          <dt>资料来源</dt><dd>{preview.sourceKind === 'cloud' ? '云端资料' : '本机资料'}</dd>
          <dt>其他日程名称</dt><dd>{hideBusyTitles ? '隐藏' : '包含'}</dd>
        </dl>
        {warnings.length > 0 && <div className="warning"><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      </section>}
      <p className="hint plan-export-note">保存后，把文件交给你使用的 AI；拿到它生成的计划，再回到“导入计划”核对保存。</p>
      <details className="plan-export-help"><summary>文件内容与使用说明</summary>
        <p>包含这个目标的全部任务、已有安排和资料链接；所选日期用于提供课表及其他日程的忙碌时间，含首尾两天，最多 366 天。</p>
        <p>不会上传给外部智能体，也不会调用 AI。导出的文件是给 AI 参考的资料，请导入 AI 生成的计划文件。</p>
        <p>让 AI 保留文件中的记录编号和已有安排信息，方便核对修改、避免重复创建。删除内容会单独请你确认。</p>
        <p>如果预览后资料有变化，或超过 10 分钟，请重新预览再保存。</p>
      </details>
      <footer className="form-footer">
        <button disabled={Boolean(busy)} onClick={close}>取消</button>
        <button disabled={Boolean(busy) || !request.success} onClick={() => void previewExport()}>{busy === 'preview' ? '正在预览…' : '预览导出内容'}</button>
        <button className="primary" disabled={Boolean(busy) || !preview} onClick={() => void save()}>{busy === 'save' ? '正在保存…' : '保存上下文文件'}</button>
      </footer>
    </div>
  </Modal>;
}
