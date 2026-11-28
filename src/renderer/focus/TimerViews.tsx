import { useEffect, useState } from 'react';
import { Timer, Pause, Play, Square } from 'lucide-react';
import type { Snapshot } from '../../shared/contracts';
import { summarizeFocusSessions } from '../../domain/focus';
import { todayDate } from '../calendar-layout';
import { Toast } from '../components/shell/Toast';
import { Modal } from '../components/Modal';
import { Sheet } from '../mobile/Sheet';
import type { PlannerUI } from '../hooks/usePlanner';
import { useFocusTimer } from './FocusProvider';
import { displayMs, elapsedMs, isBreak, isTicking, linkedCompletion, type FocusDraft, type FocusTimer } from './timer';

export function durationText(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? minutes + ' 分钟' : Math.floor(minutes / 60) + ' 小时' + (minutes % 60 ? ' ' + minutes % 60 + ' 分钟' : '');
}
function useClock(s: FocusTimer['activeState']) {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!s || !isTicking(s)) return;
    const tick = () => redraw(n => n + 1);
    const id = window.setInterval(tick, 500); document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [s]);
  return Date.now();
}
function face(s: NonNullable<FocusTimer['activeState']>, now: number) {
  const ms = displayMs(s, now), seconds = !isBreak(s) && s.draft.mode === 'stopwatch' ? Math.floor(ms / 1000) : Math.ceil(ms / 1000);
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}
const phases = { running: '专注中', paused: '已暂停', settlement: '待保存', breakGuide: '休息安排', breakRunning: '休息中', breakPaused: '休息已暂停', breakEnded: '休息结束' };

export function FocusShortcut({ mobile = false }: { mobile?: boolean }) {
  const f = useFocusTimer(), s = f?.activeState ?? null, now = useClock(s);
  if (!f || (mobile && !s)) return null;
  const canPause = s && (isTicking(s) || s.phase === 'paused' || s.phase === 'breakPaused');
  return <aside aria-label={s ? '迷你计时条' : '专注快捷入口'} className={mobile ? 'm-focus-strip' : 'focus-shortcut'}>
    <button className={mobile ? 'm-focus-launch focus-launch' : 'focus-launch'} onClick={f.open ? f.hide : f.show} aria-label={s ? '展开专注计时' : '专注'}>
      <Timer size={16} aria-hidden="true" /><span>{s ? phases[s.phase] : '专注'}</span>{s && <time>{face(s, now)}</time>}{mobile && s && <small>{s.draft.title}</small>}
    </button>
    {!mobile && canPause && <div className="focus-mini-actions">
      <button aria-label={isTicking(s) ? '暂停计时' : '继续计时'} onClick={isTicking(s) ? f.pause : f.resume}>{isTicking(s) ? <Pause size={14}/> : <Play size={14}/>}</button>
      <button aria-label="结束计时" onClick={f.finish}><Square size={13}/></button>
    </div>}
  </aside>;
}
export function FocusStart({ snapshot, taskId, blockId, close }: { snapshot: Snapshot; taskId?: string; blockId?: string; close?(): void }) {
  const f = useFocusTimer(), block = snapshot.blocks.find(b => b.id === blockId);
  const task = snapshot.tasks.find(t => t.id === (taskId ?? block?.taskId));
  if (!f || (!task && !block)) return null;
  return <button className="focus-task-start" aria-label={'开始专注 · ' + (block?.title ?? task!.title)} onClick={() => {
    close?.(); f.requestStart({ mode: 'pomodoro', title: block?.title ?? task!.title, blockId, taskId: task?.id, courseId: task?.courseId, goalId: task?.goalId });
  }}><Timer size={14} aria-hidden="true"/>开始专注</button>;
}
export function TodayFocus({ snapshot }: { snapshot: Snapshot }) {
  const f = useFocusTimer();
  if (!f) return null;
  const summary = summarizeFocusSessions(snapshot.focusSessions ?? [], snapshot, { period: 'day', date: todayDate() });
  return <section className="focus-today" aria-label="今日专注"><div><h2>今日专注</h2><p><strong>{durationText(summary.totalSeconds)}</strong> · 完成 {summary.completedPomodoros} 个番茄</p></div>
    <div className="focus-actions"><button className="ui-btn sm" onClick={f.show}>{f.activeState ? '查看计时' : '开始专注'}</button><button className="ui-btn sm ghost" onClick={f.statistics}>查看统计</button></div></section>;
}
function StartForm({ snapshot, submit }: { snapshot: Snapshot; submit(draft: FocusDraft): void }) {
  const [mode, setMode] = useState<FocusDraft['mode']>('pomodoro');
  return <form className="focus-form" onSubmit={e => {
    e.preventDefault(); const fields = new FormData(e.currentTarget);
    const task = snapshot.tasks.find(t => t.id === fields.get('taskId'));
    submit({ title: String(fields.get('title') ?? '').trim() || task?.title || '自由专注', mode, taskId: task?.id, goalId: task?.goalId, courseId: task?.courseId, plannedMinutes: mode === 'pomodoro' ? Number(fields.get('minutes')) : undefined });
  }}>
    <div className="focus-segments">{(['pomodoro','stopwatch'] as const).map(m => <button type="button" key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'pomodoro' ? '番茄倒计时' : '正向计时'}</button>)}</div>
    <label>专注内容<input name="title" placeholder="自由专注" maxLength={500}/></label>
    {snapshot.tasks.some(t => t.status === 'open') && <label>关联任务<select name="taskId"><option value="">无</option>{snapshot.tasks.filter(t => t.status === 'open').map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>}
    {mode === 'pomodoro' && <label>本次目标（分钟）<input name="minutes" type="number" min={1} max={480} defaultValue={snapshot.settings.focusMinutes} required/></label>}
    <button className="ui-btn dark">开始计时</button>
  </form>;
}
export function PlannerToast({ ui }: { ui: PlannerUI }) {
  const focus = useFocusTimer();
  return focus?.open && !ui.preview ? null : <Toast notice={ui.toast} dismiss={ui.dismissNotice}/>;
}
export function FocusPanel({ ui, mobile = false }: { ui: PlannerUI; mobile?: boolean }) {
  const f = useFocusTimer(), s = f?.activeState ?? null, now = useClock(f?.open ? s : null);
  const [newDraft, setNewDraft] = useState(false);
  if (!f?.open || !ui.snapshot || ui.preview) return null;
  const Dialog = mobile ? Sheet : Modal;
  const close = () => { setNewDraft(false); f.hide(); };
  const duration = s ? durationText(Math.floor(elapsedMs(s, now) / 1000)) : '';
  const completion = s && linkedCompletion(s.draft, ui.snapshot);
  let content;
  if (s?.next) {
    content = <section>
      <p>切换到「{s.next.title}」？</p>
      <div className="focus-actions">
        {!isBreak(s) && elapsedMs(s, now) >= 60000 &&
          <button className="ui-btn dark" disabled={ui.busy} onClick={() => void f.save()}>保存当前（已专注 {duration}）并切换</button>}
        <button className="ui-btn" disabled={ui.busy} onClick={f.discard}>放弃当前并切换</button>
        <button className="ui-btn ghost" onClick={f.continueCurrent}>继续当前计时</button>
      </div>
    </section>;
  } else if (!s || (newDraft && s.phase !== 'settlement')) {
    content = <StartForm snapshot={ui.snapshot} submit={draft => { setNewDraft(false); f.requestStart(draft); }}/>;
  } else if (s.phase === 'settlement') {
    const reached = s.draft.mode === 'pomodoro' && s.elapsed >= s.draft.plannedMinutes! * 60000;
    content = <section>
      <p>{reached ? '刚才的 ' + duration + '专注已完成，是否保存记录？' : '本次有效专注 ' + duration}</p>
      <div className="focus-actions">
        <button className="ui-btn dark" disabled={ui.busy} onClick={() => void f.save()}>{reached ? '保存记录' : '保存已专注 ' + duration}</button>
        {completion && <button className="ui-btn" disabled={ui.busy} onClick={() => void f.save(true)}>
          保存并标记{completion.type === 'finishBlock' ? '时段' : '任务'}已完成
        </button>}
        <button className="ui-btn ghost" disabled={ui.busy} onClick={f.discard}>放弃本次</button>
      </div>
    </section>;
  } else if (s.phase === 'breakGuide' || s.phase === 'breakEnded') {
    content = <div className="focus-actions">
      {s.phase === 'breakGuide' && <button className="ui-btn dark" onClick={f.startBreak}>开始 {s.breakMinutes} 分钟{s.longBreak ? '长休' : '短休'}</button>}
      <button className="ui-btn" onClick={f.nextRound}>直接开下一轮</button>
      <button className="ui-btn ghost" onClick={f.discard}>结束本轮</button>
    </div>;
  } else {
    content = <div className="focus-actions">
      <button className="ui-btn dark" onClick={isTicking(s) ? f.pause : f.resume}>{isTicking(s) ? '暂停' : '继续'}</button>
      <button className="ui-btn" onClick={f.finish}>结束{isBreak(s) ? '休息' : '专注'}</button>
      <button className="ui-btn ghost" onClick={() => setNewDraft(true)}>开始另一项专注</button>
    </div>;
  }
  return <Dialog title="专注计时" onClose={close}>
    <div className="focus-panel">
      {s && <header><small>{phases[s.phase]}</small><h3>{s.draft.title}</h3><time className="focus-face">{face(s, now)}</time></header>}
      {content}
      {ui.error && <p role="status" className="error">{ui.error}</p>}
      <Toast notice={ui.toast} dismiss={ui.dismissNotice}/>
      <footer><button className="focus-text" onClick={() => { setNewDraft(false); f.statistics(); }}>查看专注统计</button></footer>
    </div>
  </Dialog>;
}
