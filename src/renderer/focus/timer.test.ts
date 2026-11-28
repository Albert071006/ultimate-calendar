import { describe, expect, it, vi } from 'vitest';
import { FocusSessionInputSchema, FocusSettingsSchema, type Snapshot } from '../../shared/contracts';
import { FocusTimer } from './timer';

const snapshot = { tasks: [], blocks: [], goals: [], courses: [] } as unknown as Snapshot;
const pomodoro = { title: '合成练习', mode: 'pomodoro' } as const;
function fixture(initial?: string) {
  const data = new Map<string, string>(initial ? [['device', initial]] : []);
  let now = Date.parse('2030-11-01T23:58:00+08:00');
  const settings = FocusSettingsSchema.parse({ focusMinutes: 2 });
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k,v); }, removeItem: (k: string) => { data.delete(k); } };
  const load = (key = 'device') => new FocusTimer(key, store, settings, () => now);
  return { timer: load(), load, advance(ms: number) { now += ms; }, data };
}
describe('device wall clock focus timer', () => {
  it('deducts every pause including a restart, then clamps an overdue pomodoro at the real target instant', () => {
    const f = fixture(); f.timer.requestStart(pomodoro);
    f.advance(30500); f.timer.pause(); f.advance(3600000);
    const resumed = f.load(); expect(resumed.elapsedMilliseconds).toBe(30500); resumed.resume();
    f.advance(31000); resumed.pause(); f.advance(10000); resumed.resume(); f.advance(12 * 3600000);
    const settled = f.load(); settled.onEvent = vi.fn(); settled.tick(); settled.tick();
    expect(settled.onEvent).toHaveBeenCalledExactlyOnceWith('focusComplete');
    expect(FocusSessionInputSchema.parse(settled.record(snapshot))).toMatchObject({ mode: 'pomodoro', plannedMinutes: 2, durationSeconds: 120,
      start: '2030-11-01T23:58:00+08:00', end: '2030-11-02T01:00:10+08:00', completedTarget: true });
    expect(f.load().activeState?.phase).toBe('settlement');
  });
  it.each(['pomodoro','stopwatch'] as const)('discards below the minute and settles exactly 60 seconds in %s mode', mode => {
    const f = fixture(); f.timer.onEvent = vi.fn(); f.timer.requestStart({ ...pomodoro, mode });
    f.advance(59999); f.timer.finish(); expect(f.timer.activeState).toBeNull(); expect(f.timer.onEvent).toHaveBeenCalledWith('tooShort');
    f.timer.requestStart({ ...pomodoro, mode }); f.advance(60000); f.timer.pause(); f.advance(10000); f.timer.finish();
    expect(f.timer.record(snapshot)).toMatchObject({ durationSeconds: 60, completedTarget: mode === 'stopwatch', plannedMinutes: mode === 'pomodoro' ? 2 : null });
    f.timer.discard(); expect(f.load().activeState).toBeNull();
  });
  it('caps very long stopwatches at the persistence limit', () => {
    const f = fixture(); f.timer.requestStart({ ...pomodoro, mode: 'stopwatch' }); f.advance(3 * 86400000); f.timer.tick();
    expect(FocusSessionInputSchema.parse(f.timer.record(snapshot)).durationSeconds).toBe(86400);
  });
  it('requires explicit rest, offers long rest on round four, and never creates a break record', () => {
    const f = fixture(); f.timer.requestStart({ ...pomodoro, plannedMinutes: 1 });
    for (let round = 1; round <= 4; round++) {
      f.advance(60000); f.timer.tick(); f.timer.saved(f.timer.activeState!.id);
      expect(f.timer.activeState).toMatchObject({ rounds: round, phase: 'breakGuide', breakMinutes: round === 4 ? 15 : 5 });
      f.advance(60000); f.timer.tick(); expect(f.timer.activeState?.phase).toBe('breakGuide');
      f.timer.startBreak(); f.advance(10000); f.timer.pause(); f.advance(300000); expect(f.timer.elapsedMilliseconds).toBe(10000);
      f.timer.resume(); f.advance(900000); f.timer.tick(); expect(f.timer.activeState?.phase).toBe('breakEnded');
      expect(f.timer.record(snapshot)).toBeNull(); f.timer.nextRound();
    }
  });
  it('carries completed rounds through a dismissed guide and relaunch, without counting a discarded focus', () => {
    const f = fixture(); let timer = f.timer;
    for (let round = 1; round <= 4; round++) {
      timer.requestStart({ ...pomodoro, plannedMinutes: 1 }); f.advance(60000); timer.tick(); timer.saved(timer.activeState!.id);
      expect(timer.activeState?.longBreak).toBe(round === 4);
      timer.discard(); timer = f.load(); expect(timer.activeState).toBeNull();
      timer.requestStart(pomodoro); timer.discard();
    }
  });
  it('keeps the original during a conflict, with separate continue, discard-switch and save-switch decisions', () => {
    const f = fixture(); f.timer.requestStart(pomodoro); const next = { title: '合成阅读', mode: 'stopwatch' } as const;
    expect(f.timer.requestStart(next)).toBe('conflict'); expect(f.load().activeState?.draft).toMatchObject(pomodoro);
    f.timer.continueCurrent(); expect(f.timer.activeState?.next).toBeNull(); f.timer.requestStart(next); f.timer.discard();
    expect(f.timer.activeState?.draft).toMatchObject(next); f.advance(70000);
    f.timer.requestStart(pomodoro); f.timer.finish(); const id = f.timer.activeState!.id;
    expect(f.timer.record(snapshot)?.title).toBe(next.title); f.timer.saved('different'); expect(f.timer.activeState?.id).toBe(id);
    f.timer.saved(id); expect(f.timer.activeState?.draft).toMatchObject(pomodoro); expect(f.timer.elapsedMilliseconds).toBe(0);
  });
  it('isolates instances and tolerates invalid or inaccessible storage', () => {
    for (const bad of ['null', '{', '{"phase":"running"}']) expect(fixture(bad).timer.activeState).toBeNull();
    const f = fixture(); f.timer.requestStart(pomodoro); expect(f.load('other-generation').activeState).toBeNull();
    const fail = () => { throw Error('storage disabled'); };
    const timer = new FocusTimer('private', { getItem: fail, setItem: fail, removeItem: fail }, FocusSettingsSchema.parse({}));
    expect(timer.requestStart(pomodoro)).toBe('started'); timer.discard(); expect(timer.activeState).toBeNull();
  });
});
