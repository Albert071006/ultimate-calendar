import type { Block, Snapshot } from '../shared/contracts';
import { displayInstant } from './calendar-layout';
import { recoverCandidateTiming } from '../domain/temporal-evidence';
import { effectiveActivityEnd } from '../domain/activity-duration';

export interface TaskNoticeTiming { start: string; end: string | null; location: string }

/** Read-only fallback for older accepted notices that never created their fixed event. */
export function taskNoticeTiming(snapshot: Pick<Snapshot, 'tasks' | 'candidates' | 'sources'>, taskId: string): TaskNoticeTiming | null {
  const task = snapshot.tasks.find(value => value.id === taskId);
  const candidate = snapshot.candidates.find(value => value.id === task?.candidateId)
    ?? snapshot.candidates.find(value => value.taskId === taskId);
  if (!candidate) return null;
  const recovered = recoverCandidateTiming(candidate, snapshot.sources);
  const start = candidate.eventStart ?? recovered.eventStart;
  if (!start) return null;
  return { start, end: candidate.eventEnd ?? recovered.eventEnd ?? null, location: candidate.location };
}

export function noticeTimePassed(timing: TaskNoticeTiming, now: number): boolean {
  return Date.parse(effectiveActivityEnd(timing.start, timing.end)) <= now;
}

export function taskNoticeSummary(timing: TaskNoticeTiming, now: number): string {
  return `原通知 · ${displayInstant(timing.start)} – ${displayInstant(effectiveActivityEnd(timing.start, timing.end))}${timing.end ? '' : ' · 默认30分钟'}${noticeTimePassed(timing, now) ? ' · 已结束' : ''}`;
}

/** An accepted notice already owns its fixed activity; arranging it must not create a second block. */
export function taskEvents(snapshot: Pick<Snapshot, 'blocks'>, taskId: string): Block[] {
  return snapshot.blocks
    .filter(block => block.taskId === taskId && block.kind === 'event')
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

export function eventTimeLabel(event: Block): string {
  return `${displayInstant(event.start)} – ${displayInstant(effectiveActivityEnd(event.start, event.end))}${event.end ? '' : ' · 默认30分钟'}`;
}

export function nextTaskEvent(events: Block[], now: number): Block | undefined {
  const active = events.filter(event => !event.cancelled);
  return active.find(event => !event.completed && !noticeTimePassed(event, now)) ?? active.at(-1);
}

export function taskEventSummary(events: Block[], now = Date.now()): string {
  const next = nextTaskEvent(events, now);
  if (!next) return events.length ? '活动已全部取消 · 历史记录保留' : '';
  const remaining = events.filter(event => !event.cancelled && !event.completed && !noticeTimePassed(event, now)).length;
  return `已加入日历 · ${eventTimeLabel(next)}${events.length > 1 ? remaining ? ` · 剩余${remaining}次` : ' · 全部已结束' : ''}`;
}
