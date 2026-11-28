import { useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { Modal } from '../components/Modal';
import { Sheet } from '../mobile/Sheet';
import { useMobile } from '../mobile/layout';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addCalendarDays, FocusSessionInputSchema, type FocusSession, type Snapshot } from '../../shared/contracts';
import { instantAt } from '../../domain/time';
import { summarizeFocusSessions, type FocusDetailFilter } from '../../domain/focus';
import { operationId, todayDate } from '../calendar-layout';
import type { PlannerUI } from '../hooks/usePlanner';
import { durationText } from './TimerViews';

type Props = { snapshot: Snapshot; ui: PlannerUI };
type Period = 'day' | 'week' | 'month';
const modeText = (s: FocusSession) => s.mode === 'manual' ? '补录' : s.mode === 'stopwatch' ? '正向' : s.completedTarget ? '番茄' : '提前结束';
const localField = (instant: string) => instant.slice(0, -6);
const clockField = (instant: string) => instant.slice(11, 16);
const exactDuration = (seconds: number) => durationText(seconds) + (seconds % 60 ? ' ' + seconds % 60 + ' 秒' : '');

function SessionForm({ snapshot, ui, session, date, close }: Props & { session?: FocusSession; date: string; close(): void }) {
  const [kind, setKind] = useState<'duration' | 'end'>(session ? 'end' : 'duration');
  const [error, setError] = useState('');
  const [requestId] = useState(operationId);
  const [start, setStart] = useState(session ? localField(session.start) : date + 'T09:00');
  const [end, setEnd] = useState(session ? localField(session.end) : date + 'T09:25');
  const [minutes, setMinutes] = useState(String(Math.floor((session?.durationSeconds ?? 1500) / 60)));
  const [seconds, setSeconds] = useState(String((session?.durationSeconds ?? 0) % 60));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    const startMs = Date.parse(start + '+08:00'), elapsed = Number(minutes) * 60 + Number(seconds);
    const endMs = kind === 'duration' ? startMs + elapsed * 1000 : Date.parse(end + '+08:00');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) { setError('请填写有效的起止时间。'); return; }
    const durationSeconds = !session && kind === 'end' ? Math.floor((endMs - startMs) / 1000) : elapsed;
    const id = (name: string) => String(fields.get(name) ?? '') || null;
    let completedTarget = session?.completedTarget ?? true;
    if (session?.mode === 'pomodoro' && durationSeconds !== session.durationSeconds) completedTarget = durationSeconds >= session.plannedMinutes! * 60;
    const parsed = FocusSessionInputSchema.safeParse({
      title: fields.get('title'), note: fields.get('note'), mode: session?.mode ?? 'manual', start: instantAt(startMs), end: instantAt(endMs), durationSeconds,
      plannedMinutes: session?.plannedMinutes ?? null, completedTarget,
      courseId: id('courseId'), goalId: id('goalId'), taskId: id('taskId'), blockId: id('blockId'),
    });
    if (!parsed.success) { setError('请核对标题和时间。有效时长须在 1 分钟至 24 小时之间，且不能超过起止时间差。'); return; }
    setError('');
    const values = parsed.data;
    const result = await ui.mutate([session ? { type: 'updateFocusSession', id: session.id, expectedVersion: session.version, values } : { type: 'createFocusSession', values }], undefined, requestId);
    if (result && (result.status === 'applied' || result.status === 'queued' || result.status === 'preview')) close();
  }
  return <form className="focus-form focus-editor" aria-label={session ? '编辑专注记录' : '手动补录'} onSubmit={submit}>
    <label>专注标题<input name="title" required maxLength={500} defaultValue={session?.title}/></label>
    <label>开始时间<input type="datetime-local" step="any" required value={start} onChange={e => setStart(e.target.value)}/></label>
    {!session && <label>填写方式<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="duration">按时长</option><option value="end">按结束时间</option></select></label>}
    {kind === 'end' && <label>结束时间<input type="datetime-local" step="any" required value={end} onChange={e => setEnd(e.target.value)}/></label>}
    {(session || kind === 'duration') && <div className="focus-fields"><label>有效分钟<input type="number" min={1} max={1440} value={minutes} required onChange={e => setMinutes(e.target.value)}/></label>
      <label>余秒<input type="number" min={0} max={59} required value={seconds} onChange={e => setSeconds(e.target.value)}/></label></div>}
    <div className="focus-fields">{([['courseId','关联课程',snapshot.courses],['goalId','关联目标',snapshot.goals],['taskId','关联任务',snapshot.tasks]] as const).map(([key,label,rows]) =>
      <label key={key}>{label}<select name={key} defaultValue={session?.[key] ?? ''}><option value="">无</option>{rows.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label>)}</div>
    {session?.blockId && <label>关联时段<select name="blockId" defaultValue={session.blockId}><option value="">无</option>
      {snapshot.blocks.filter(b => b.kind === 'work' || b.id === session.blockId).map(b => <option key={b.id} value={b.id}>{b.title} · {b.start.slice(0, 16).replace('T', ' ')}</option>)}
    </select></label>}
    <label>备注<textarea name="note" rows={2} maxLength={2000} defaultValue={session?.note}/></label>
    {error && <p role="alert">{error}</p>}
    <div className="focus-actions"><button className="ui-btn dark" disabled={ui.busy}>保存专注记录</button><button className="ui-btn" type="button" onClick={close}>取消</button></div>
  </form>;
}
export function FocusStats({ snapshot, ui }: Props) {
  const [period, setPeriod] = useState<Period>('week'), [date, setDate] = useState(todayDate);
  const [chartDay, setChartDay] = useState<string>();
  const [filter, setFilter] = useState<FocusDetailFilter>();
  const [editor, setEditor] = useState<FocusSession | 'new' | null>(null);
  const data = useMemo(() => summarizeFocusSessions(snapshot.focusSessions ?? [], snapshot, { period, date }, filter), [snapshot, period, date, filter]);
  const selectedDay = data.daily.find(d => d.date === chartDay);
  const max = Math.max(60, ...data.daily.map(d => d.durationSeconds));
  function navigate(offset: number) {
    setDate(!offset ? todayDate() : addCalendarDays(offset < 0 ? data.from : data.to, offset));
    setFilter(undefined);
  }
  return <section className="focus-stats" aria-label="时间账单">
    <header className="focus-stats-head"><h2>时间账单</h2><button className="ui-btn" onClick={() => setEditor('new')}>手动补录</button></header>
    <div className="focus-stats-nav"><div className="focus-segments">{(['day','week','month'] as const).map((p, i) => <button key={p} aria-pressed={period === p} onClick={() => { setPeriod(p); setFilter(undefined); }}>{['日','周','月'][i]}</button>)}</div>
      <div className="focus-actions"><button aria-label="上一周期" onClick={() => navigate(-1)}><ChevronLeft size={16}/></button><button onClick={() => navigate(0)}>今天</button><button aria-label="下一周期" onClick={() => navigate(1)}><ChevronRight size={16}/></button></div></div>
    <p className="focus-period">{data.from}{data.to !== data.from && ' — ' + data.to}</p>
    <dl className="focus-totals"><div><dt>总专注时长</dt><dd>{durationText(data.totalSeconds)}</dd></div><div><dt>完成番茄</dt><dd>{data.completedPomodoros}</dd></div><div><dt>专注次数</dt><dd>{data.sessionCount}</dd></div></dl>
    <section><div className="focus-stats-head"><h3>每日专注</h3><small>{selectedDay ? selectedDay.date + ' · ' + exactDuration(selectedDay.durationSeconds) : '峰值 ' + exactDuration(Math.max(...data.daily.map(d => d.durationSeconds)))}</small></div><div className="focus-chart">{data.daily.map(({ date: day, durationSeconds: sec }, i) =>
      <button type="button" key={day} aria-pressed={selectedDay?.date === day} onClick={() => setChartDay(selectedDay?.date === day ? undefined : day)} aria-label={day + ' · ' + exactDuration(sec)} title={day + ' · ' + exactDuration(sec)}><i style={{ height: (sec / max * 100) + '%' }}/><small>{data.daily.length <= 7 || i % 5 === 0 ? day.slice(-2) : ''}</small></button>)}</div></section>
    <section><h3>按归属分布</h3>{!data.byBelonging.length && <p>本周期暂无专注记录。</p>}
      {data.byBelonging.map(b => {
        const f: FocusDetailFilter = b.kind === 'course' ? { courseId: b.id } : b.kind === 'goal' ? { goalId: b.id } : { unassigned: true };
        const selected = JSON.stringify(f) === JSON.stringify(filter);
        return <button className="focus-distribution" key={b.kind + b.id} aria-pressed={selected} onClick={() => setFilter(selected ? undefined : f)}>
          <span>{b.name}</span><span>{durationText(b.durationSeconds)} · {Math.round(b.share * 100)}%</span><i style={{ width: b.share * 100 + '%', background: b.color ?? 'var(--ink-3)' }}/></button>;
      })}</section>
    <section><h3>专注明细</h3>{filter && <button className="focus-text" onClick={() => setFilter(undefined)}>清除归属筛选</button>}
      {!data.details.length && <p>暂无明细</p>}{data.details.map(group => <div key={group.date}><h4>{group.date}</h4>{group.entries.map(({ session: s, belonging }) =>
        <article className="focus-entry" key={s.id}><div><small>{clockField(s.start)}–{s.start.slice(0, 10) !== s.end.slice(0, 10) ? s.end.slice(0, 10) + ' ' : ''}{clockField(s.end)} · {modeText(s)}</small>
          <strong>{s.title}</strong><span><i className="ui-dot" style={{ '--c': belonging.color ?? 'var(--ink-3)' } as CSSProperties}/> {belonging.name} · {exactDuration(s.durationSeconds)}</span>{s.note && <p>{s.note}</p>}</div>
          <div className="focus-actions"><button className="focus-text" onClick={() => setEditor(s)}>编辑</button>
          <button className="focus-text" disabled={ui.busy} onClick={() => void ui.mutate([{ type: 'deleteFocusSession', id: s.id, expectedVersion: s.version }])}>删除</button></div></article>)}</div>)}</section>
    {editor && <SessionDialog session={editor === 'new' ? undefined : editor} snapshot={snapshot} ui={ui} date={date} close={() => setEditor(null)}/>}
  </section>;
}
function SessionDialog(props: Parameters<typeof SessionForm>[0]) {
  const Dialog = useMobile() ? Sheet : Modal;
  return <Dialog title={props.session ? '编辑专注' : '补录专注'} onClose={props.close}><SessionForm {...props}/></Dialog>;
}
