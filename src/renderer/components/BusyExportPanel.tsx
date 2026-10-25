import { useRef, useState } from 'react';
import { addCalendarDays } from '../../shared/contracts';
import { BusyExportRequestSchema, type BusyExportDesktopAPI, type BusyExportPreview } from '../../shared/busy-context';
import { todayDate } from '../calendar-layout';
import './busy-export.css';

export function hasBusyExport(host: Partial<BusyExportDesktopAPI> | undefined): host is BusyExportDesktopAPI {
  return Boolean(host && typeof host.busyExportPreview === 'function' && typeof host.busyExportSave === 'function');
}

export function BusyExportPanel({ host, disabled = false, onBusyChange, onSaved }: {
  host: BusyExportDesktopAPI;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  onSaved?: (message: string) => void;
}) {
  const [fromDate, setFromDate] = useState(todayDate);
  const [toDate, setToDate] = useState(() => addCalendarDays(fromDate, 6));
  const [instructions, setInstructions] = useState('');
  const [hideTitles, setHideTitles] = useState(true);
  const [preview, setPreview] = useState<BusyExportPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const working = useRef(false);
  const locked = disabled || Boolean(busy);
  const request = BusyExportRequestSchema.safeParse({ fromDate, toDate, includeBusyTitles: !hideTitles, instructions });
  const updateParameters = (update: () => void) => {
    if (working.current || disabled) return;
    update(); setPreview(null); setError(''); setFeedback('');
  };
  async function run(action: NonNullable<typeof busy>, job: () => Promise<void>) {
    if (working.current || disabled) return;
    working.current = true; setBusy(action); onBusyChange(true); setError(''); setFeedback('');
    try { await job(); }
    catch (failure) { setPreview(null); setError(failure instanceof Error ? failure.message : '导出失败，请重新预览后重试。'); }
    finally { working.current = false; setBusy(null); onBusyChange(false); }
  }
  const previewExport = () => {
    if (!request.success) return;
    return run('preview', async () => {
      setPreview(null);
      const result = await host.busyExportPreview(request.data);
      if (!result.ok) { setError(result.error.message); return; }
      setPreview(result.data);
    });
  };
  const save = () => {
    if (!preview) return;
    return run('save', async () => {
      const result = await host.busyExportSave({ token: preview.token });
      if (!result.ok) { setPreview(null); setError(result.error.message); return; }
      if (!result.data.saved) { setFeedback('已取消保存，可继续使用当前预览。'); return; }
      const message = result.data.filename ? `已保存忙碌时间：${result.data.filename}` : '忙碌时间文件已保存。';
      setFeedback(message); setPreview(null); onSaved?.(message);
    });
  };

  return <section className="busy-export" aria-label="导出忙碌时间" aria-busy={Boolean(busy)}>
    <h3>导出忙碌时间</h3>
    <p className="hint">交给外部智能体作为排期参考，再生成完整目标、任务和时段。</p>
    <div className="busy-export-range">
      <label>忙碌时间开始日期<input type="date" value={fromDate} disabled={locked} onChange={event => updateParameters(() => setFromDate(event.target.value))} /></label>
      <label>忙碌时间结束日期<input type="date" value={toDate} disabled={locked} onChange={event => updateParameters(() => setToDate(event.target.value))} /></label>
    </div>
    <p className="hint">北京时间，包含首尾两天，最多 366 天。</p>
    {!request.success && <p className="error" role="alert">{request.error.issues[0]?.message}</p>}
    <label>规划要求（选填）<textarea rows={2} maxLength={10000} value={instructions} disabled={locked} placeholder="例如：请规划一个月的学习目标，每次学习 45 分钟，避开已有课程。" onChange={event => updateParameters(() => setInstructions(event.target.value))} /></label>
    <label className="check"><input type="checkbox" checked={hideTitles} disabled={locked} onChange={event => updateParameters(() => setHideTitles(event.target.checked))} />隐藏日程名称，仅保留忙碌时间</label>
    {error && <p className="error" role="alert">{error}</p>}
    {feedback && <p role="status" className="busy-export-feedback">{feedback}</p>}
    {preview && <section className="busy-export-summary" aria-label="忙碌时间预览">
      <dl className="busy-export-counts">
        <div><dt>忙碌区间</dt><dd>{preview.counts.intervals}</dd></div>
        <div><dt>课程时段</dt><dd>{preview.counts.courses}</dd></div>
        <div><dt>执行时段</dt><dd>{preview.counts.work}</dd></div>
        <div><dt>固定活动</dt><dd>{preview.counts.events}</dd></div>
      </dl>
      <p className="hint">{preview.sourceKind === 'cloud' ? '云端资料' : '本机资料'} · {preview.fromDate} 至 {preview.toDate} · 日程名称{hideTitles ? '隐藏' : '包含'}</p>
      {preview.warnings.length > 0 && <div className="warning"><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    </section>}
    <div className="busy-export-actions">
      <button disabled={locked || !request.success} onClick={() => void previewExport()}>{busy === 'preview' ? '正在预览忙碌时间…' : '预览忙碌时间'}</button>
      <button disabled={locked || !preview} onClick={() => void save()}>{busy === 'save' ? '正在保存忙碌时间…' : '保存忙碌时间文件'}</button>
    </div>
    <p className="hint">仅保存 .calendar-busy.json 文件，不上传、不调用 AI。此参考文件不能直接导入；请导入智能体生成的计划文件。</p>
  </section>;
}
