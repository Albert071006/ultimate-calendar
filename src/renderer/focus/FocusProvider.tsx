import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { FocusSettingsSchema } from '../../shared/contracts';
import type { PlannerUI } from '../hooks/usePlanner';
import { FocusTimer, isTicking, linkedCompletion, type FocusDraft } from './timer';
import './focus.css';

function audioCue() {
  let context: AudioContext | undefined;
  return {
    unlock() {
      try {
        context ??= new AudioContext();
        void context.resume().catch(() => {});
      } catch { /* Sound is optional. */ }
    },
    ring() {
      try {
        context ??= new AudioContext();
        if (context.state !== 'running') return;
        const osc = context.createOscillator(), volume = context.createGain(), at = context.currentTime;
        osc.type = 'sine'; osc.frequency.value = 640;
        volume.gain.setValueAtTime(0.001, at); volume.gain.exponentialRampToValueAtTime(0.10, at + 0.035);
        volume.gain.exponentialRampToValueAtTime(0.001, at + 0.55);
        osc.connect(volume); volume.connect(context.destination); osc.start(at); osc.stop(at + 0.6);
      } catch { /* The audio device may have been disconnected during sleep. */ }
    },
    close() { if (context) void context.close().catch(() => {}); context = undefined; },
  };
}
async function notifyCompletion(message: string, title?: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const options = { body: title, silent: true };
  try { new Notification(message, options); }
  catch {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.showNotification(message, options);
  }
}
function localStore() { try { return window.localStorage; } catch { return null; } }
export interface FocusControls {
  readonly scope: string | null;
  getStatus: FocusTimer['getStatus'];
  continueCurrent(): void; startBreak(): void; nextRound(): void;
  activeState: FocusTimer['activeState'];
  requestStart(draft: FocusDraft): 'started' | 'conflict';
  pause(): void; resume(): void; finish(): void; discard(): void;
  save(completeLinked?: boolean): Promise<void>;
  open: boolean; show(): void; hide(): void; statistics(): void;
}
const FocusContext = createContext<FocusControls | null>(null);
export const useFocusTimer = () => useContext(FocusContext);

export function FocusProvider({ scope, ui, openStats, children }: { scope: string | null; ui: PlannerUI; openStats(): void; children: ReactNode }) {
  const timer = useMemo(() => new FocusTimer('ultimate-calendar:focus:v1:' + scope, scope ? localStore() : null, FocusSettingsSchema.parse({})), [scope]);
  const [audio] = useState(audioCue);
  const [panel, setPanel] = useState<FocusTimer | null>(null);
  const open = panel === timer;
  const setOpen = (visible: boolean) => setPanel(visible ? timer : null);
  const state = useSyncExternalStore(timer.subscribe, () => timer.activeState);
  const saving = useRef(false);
  const requestedNotifications = useRef(false);
  timer.settings = ui.snapshot?.settings ?? FocusSettingsSchema.parse({});
  const notice = ui.setNotice;
  useEffect(() => {
    timer.onEvent = event => {
      if (event === 'tooShort') { notice('专注不足 1 分钟，未保存记录'); return; }
      const message = event === 'breakComplete' ? '休息结束，可以开始下一轮了' : '刚才的 ' + Math.floor(timer.elapsedMilliseconds / 60000) + ' 分钟专注已完成，是否保存记录？';
      notice(message);
      if (timer.settings.focusSoundEnabled) audio.ring();
      void notifyCompletion(message, timer.activeState?.draft.title).catch(() => {});
    };
    return () => { timer.onEvent = undefined; };
  }, [timer, audio, notice]);
  useEffect(() => {
    timer.tick();
    if (timer.activeState?.phase === 'settlement' || timer.activeState?.next) setPanel(timer);
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === 'ultimate-calendar:focus:v1:' + scope) { timer.reload(); timer.tick(); }
    };
    window.addEventListener('storage', changed);
    return () => { window.removeEventListener('storage', changed); audio.close(); };
  }, [timer, audio, scope]);
  useEffect(() => {
    if (!state || !isTicking(state)) return;
    const tick = () => timer.tick();
    tick();
    const id = window.setInterval(tick, 500);
    document.addEventListener('visibilitychange', tick); window.addEventListener('pageshow', tick);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', tick); window.removeEventListener('pageshow', tick); };
  }, [timer, state]);
  // The same receipt can arrive through a preview confirmation, an SSE refresh or a replay after restart.
  useEffect(() => {
    if (state?.phase === 'settlement' && (ui.lastWriteId === state.id || ui.snapshot?.journal.some(j => j.operationId === state.id))) timer.saved(state.id);
  }, [ui.lastWriteId, ui.snapshot?.journal, timer, state]);
  function unlock() {
    if (timer.settings.focusSoundEnabled) audio.unlock();
    try {
      if (!requestedNotifications.current && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        requestedNotifications.current = true;
        void Notification.requestPermission().catch(() => {});
      }
    } catch { /* Permission is not required to start. */ }
  }
  async function save(completeLinked = false) {
    if (saving.current || !ui.snapshot) return;
    timer.finish();
    const s = timer.activeState, values = timer.record(ui.snapshot);
    if (!values || !s) return;
    const completion = completeLinked && linkedCompletion(s.draft, ui.snapshot);
    saving.current = true;
    try {
      const result = await ui.mutate([{ type: 'createFocusSession', values }, ...(completion ? [completion] : [])], undefined, s.id);
      if (result?.status === 'applied' || result?.status === 'queued') timer.saved(s.id);
    } finally { saving.current = false; }
  }
  const controls: FocusControls = { scope, activeState: state, getStatus: () => timer.getStatus(),
    continueCurrent: () => timer.continueCurrent(), startBreak: () => { unlock(); timer.startBreak(); }, nextRound: () => { unlock(); timer.nextRound(); }, open, show: () => setOpen(true), hide: () => setOpen(false),
    statistics: () => { setOpen(false); openStats(); },
    requestStart(draft) { unlock(); const result = timer.requestStart(draft); setOpen(true); return result; },
    pause: () => timer.pause(), resume: () => { unlock(); timer.resume(); }, finish: () => { timer.finish(); setOpen(!!timer.activeState); },
    discard: () => { timer.discard(); setOpen(!!timer.activeState); }, save };
  return <FocusContext.Provider value={ui.snapshot ? controls : null}>{children}</FocusContext.Provider>;
}
