import { z } from 'zod';
import { FocusSettingsSchema, IdSchema, TitleSchema, type FocusSessionInput, type MutationInput, type Settings, type Snapshot } from '../../shared/contracts';
import { instantAt } from '../../domain/time';
import { operationId } from '../calendar-layout';

const draftSchema = z.object({
  title: TitleSchema, mode: z.enum(['pomodoro', 'stopwatch']), plannedMinutes: z.number().int().min(1).max(480).optional(),
  taskId: IdSchema.nullish(), blockId: IdSchema.nullish(), courseId: IdSchema.nullish(), goalId: IdSchema.nullish(),
});
export type FocusDraft = z.infer<typeof draftSchema>;
const stamp = z.number().int().nonnegative().max(253402214399999);
const phase = z.enum(['running', 'paused', 'settlement', 'breakGuide', 'breakRunning', 'breakPaused', 'breakEnded']);
const savedState = z.object({
  id: IdSchema, phase, draft: draftSchema, start: stamp, since: stamp, elapsed: z.number().nonnegative().max(86400000),
  end: stamp.nullable(), rounds: z.number().int().nonnegative(), breakMinutes: z.number().int().min(1).max(240),
  longBreak: z.boolean(), next: draftSchema.nullable(),
}).refine(s => s.draft.mode !== 'pomodoro' || s.draft.plannedMinutes !== undefined)
  .refine(s => s.phase !== 'settlement' || (s.end !== null && s.end > s.start && s.elapsed >= 60000));
const deviceState = z.union([savedState, z.strictObject({ phase: z.literal('idle'), rounds: z.number().int().nonnegative() })]);
type TimerState = Readonly<z.infer<typeof savedState>>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Preferences = Pick<Settings, keyof typeof FocusSettingsSchema.shape>;
export type TimerEvent = 'focusComplete' | 'breakComplete' | 'tooShort';
export const isBreak = (s: TimerState) => s.phase.startsWith('break');
export const isTicking = (s: TimerState) => s.phase === 'running' || s.phase === 'breakRunning';
const limit = (s: TimerState) => isBreak(s) ? s.breakMinutes * 60000 : s.draft.mode === 'pomodoro' ? s.draft.plannedMinutes! * 60000 : 86400000;
export function elapsedMs(s: TimerState, now: number) {
  return Math.min(limit(s), s.elapsed + (isTicking(s) ? Math.max(0, now - s.since) : 0));
}
export function displayMs(s: TimerState, now: number) {
  if (s.phase === 'breakEnded') return 0;
  if (s.phase === 'settlement' || (!isBreak(s) && s.draft.mode === 'stopwatch')) return elapsedMs(s, now);
  return limit(s) - elapsedMs(s, now);
}

export function linkedCompletion(draft: FocusDraft, snapshot: Snapshot): MutationInput | undefined {
  if (draft.blockId) {
    const block = snapshot.blocks.find(b => b.id === draft.blockId);
    if (block && !block.cancelled && !block.completed && block.kind === 'work') return { type: 'finishBlock', id: block.id, expectedVersion: block.version, completed: true };
    if (block?.kind === 'work') return;
  }
  const task = snapshot.tasks.find(t => t.id === draft.taskId);
  if (task?.status === 'open') return { type: 'finishTask', id: task.id, expectedVersion: task.version, completed: true };
}

/** Only transitions write to disk. Display ticks and active durations are derived from the wall clock. */
export class FocusTimer {
  private state: TimerState | null = null;
  private rounds = 0;
  private lastStored: string | null = null;
  private listeners = new Set<() => void>();
  onEvent?: (event: TimerEvent) => void;
  constructor(private key: string, private store: Store | null, public settings: Preferences, private clock = Date.now) {
    this.reload();
  }
  get activeState() { return this.state; }
  /** Read the current duration without waiting for a React render or an interval. */
  getStatus() {
    this.tick();
    const s = this.state;
    return s ? { phase: s.phase, mode: s.draft.mode, title: s.draft.title, elapsedMs: this.elapsedMilliseconds,
      plannedMinutes: s.draft.plannedMinutes ?? null, taskId: s.draft.taskId ?? null, blockId: s.draft.blockId ?? null, switching: !!s.next } as const : null;
  }
  get elapsedMilliseconds() { return this.state ? elapsedMs(this.state, this.clock()) : 0; }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  reload() {
    if (!this.store) return;
    try {
      const raw = this.store.getItem(this.key);
      if (raw === this.lastStored) return;
      const stored = raw ? deviceState.parse(JSON.parse(raw)) : null;
      this.rounds = stored?.rounds ?? 0;
      this.state = stored && stored.phase !== 'idle' ? stored : null;
      this.lastStored = raw;
      this.listeners.forEach(fn => fn());
    } catch { /* Invalid storage must not interrupt an in-memory timer. */ }
  }
  private put(s: TimerState | null) {
    this.state = s;
    this.rounds = s?.rounds ?? this.rounds;
    try {
      // Dismissing the rest guide ends this timer, but the next completed tomato still counts toward long rest.
      const stored = s ?? (this.rounds ? { phase: 'idle', rounds: this.rounds } : null);
      const raw = stored ? JSON.stringify(stored) : null;
      if (raw) this.store?.setItem(this.key, raw); else this.store?.removeItem(this.key);
      this.lastStored = raw;
    } catch { /* Still usable for this visit. */ }
    this.listeners.forEach(fn => fn());
  }
  private start(draft: FocusDraft, rounds: number) {
    const now = this.clock();
    this.put({ id: operationId(), phase: 'running', draft, start: now, since: now, elapsed: 0, end: null, rounds,
      breakMinutes: this.settings.shortBreakMinutes, longBreak: false, next: null });
  }
  requestStart(input: FocusDraft) {
    this.reload();
    const draft = draftSchema.parse({ ...input, plannedMinutes: input.mode === 'pomodoro' ? input.plannedMinutes ?? this.settings.focusMinutes : undefined });
    this.tick();
    if (this.state && !['breakGuide','breakEnded'].includes(this.state.phase)) {
      this.put({ ...this.state, next: draft });
      return 'conflict' as const;
    }
    this.start(draft, this.rounds);
    return 'started' as const;
  }
  tick() {
    const s = this.state;
    if (!s || !isTicking(s) || elapsedMs(s, this.clock()) < limit(s)) return;
    this.put({ ...s, phase: isBreak(s) ? 'breakEnded' : 'settlement', elapsed: limit(s), end: s.since + limit(s) - s.elapsed });
    this.onEvent?.(isBreak(s) ? 'breakComplete' : 'focusComplete');
  }
  pause() {
    this.tick();
    const s = this.state;
    if (s && isTicking(s)) this.put({ ...s, phase: isBreak(s) ? 'breakPaused' : 'paused', elapsed: elapsedMs(s, this.clock()) });
  }
  resume() {
    const s = this.state;
    if (s && (s.phase === 'paused' || s.phase === 'breakPaused')) this.put({ ...s, phase: isBreak(s) ? 'breakRunning' : 'running', since: this.clock() });
  }
  finish() {
    this.tick();
    const s = this.state;
    if (!s || s.phase === 'settlement') return;
    if (isBreak(s)) { this.put({ ...s, phase: 'breakEnded' }); return; }
    const now = this.clock(), elapsed = elapsedMs(s, now);
    if (elapsed < 60000) { this.discard(); return; }
    this.put({ ...s, phase: 'settlement', elapsed, end: Math.max(now, s.start + elapsed) });
  }
  continueCurrent() { if (this.state) this.put({ ...this.state, next: null }); }
  discard() {
    const s = this.state;
    if (s && !isBreak(s) && this.elapsedMilliseconds < 60000) this.onEvent?.('tooShort');
    if (s?.next) this.start(s.next, s.rounds);
    else this.put(null);
  }
  record(snapshot: Snapshot): FocusSessionInput | null {
    const s = this.state;
    if (s?.phase !== 'settlement' || s.end === null) return null;
    const d = s.draft, pomodoro = d.mode === 'pomodoro';
    return { title: d.title, mode: d.mode, plannedMinutes: pomodoro ? d.plannedMinutes : null,
      completedTarget: !pomodoro || s.elapsed >= limit(s), durationSeconds: Math.floor(s.elapsed / 1000),
      start: instantAt(s.start), end: instantAt(s.end), note: '',
      taskId: snapshot.tasks.find(t => t.id === d.taskId)?.id ?? null, blockId: snapshot.blocks.find(b => b.id === d.blockId)?.id ?? null,
      courseId: snapshot.courses.find(c => c.id === d.courseId)?.id ?? null, goalId: snapshot.goals.find(g => g.id === d.goalId)?.id ?? null };
  }
  saved(id: string) {
    const s = this.state;
    if (s?.phase !== 'settlement' || s.id !== id) return;
    const rounds = s.rounds + Number(s.draft.mode === 'pomodoro' && s.elapsed >= limit(s));
    if (s.next) this.start(s.next, rounds);
    else if (s.draft.mode === 'stopwatch') this.put(null);
    else {
      const longBreak = rounds > 0 && rounds % this.settings.pomodorosBeforeLongBreak === 0 && s.elapsed >= limit(s);
      this.put({ ...s, phase: 'breakGuide', rounds, longBreak, elapsed: 0, breakMinutes: longBreak ? this.settings.longBreakMinutes : this.settings.shortBreakMinutes });
    }
  }
  startBreak() {
    if (this.state?.phase === 'breakGuide') this.put({ ...this.state, phase: 'breakRunning', elapsed: 0, since: this.clock() });
  }
  nextRound() {
    const s = this.state;
    if (s && isBreak(s)) this.start(s.draft, s.rounds);
  }
}
