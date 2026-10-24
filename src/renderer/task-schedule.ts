import type { Block, Snapshot } from '../shared/contracts';
import { displayInstant } from './calendar-layout';
import { recoverCandidateTiming } from '../domain/temporal-evidence';
import { effectiveActivityEnd } from '../domain/activity-duration';

export interface TaskNoticeTiming { start: string; end: string | null; location: string; source?: 'reminder' }

/** Read-only fallback for older accepted notices that never created their fixed event. */
export function taskNoticeTiming(snapshot: Pick<Snapshot, 'tasks' | 'candidates' | 'sources'>, taskId: string): TaskNoticeTiming | null {
  const task = snapshot.tasks.find(value => value.id === taskId);
  const candidate = snapshot.candidates.find(value => value.id === task?.candidateId)
    ?? snapshot.candidates.find(value => value.taskId === taskId);
  if (!candidate) {
    // Earlier reminder commands stored the requested instant in a deadline.
    // Only the full generated reminder marker qualifies; ordinary deadlines
    // (including tasks whose titles mention reminders) are not activity times.
    if (!task?.candidateId && task?.deadline?.time &&
        /^提醒[：:]/.test(task.title) && /^提醒备忘[：:]/.test(task.description) &&
        /[（(]仅提醒，不记账[）)]\s*$/.test(task.description) &&
        task.reminders.enabled && task.reminders.leadMinutes?.length === 1 && task.reminders.leadMinutes[0] === 0) {
      return { start: `${task.deadline.date}T${task.deadline.time}:00+08:00`, end: null, location: '', source: 'reminder' };
    }
    return null;
  }
  const recovered = recoverCandidateTiming(candidate, snapshot.sources);
  const start = candidate.eventStart ?? recovered.eventStart;
  if (!start) return null;
  return { start, end: candidate.eventEnd ?? recovered.eventEnd ?? null, location: candidate.location };
}

export function noticeTimePassed(timing: TaskNoticeTiming, now: number): boolean {
  return Date.parse(effectiveActivityEnd(timing.start, timing.end)) <= now;
}

export function taskNoticeSummary(timing: TaskNoticeTiming, now: number): string {
  return `${timing.source === 'reminder' ? '提醒时间' : '原通知'} · ${displayInstant(timing.start)} – ${displayInstant(effectiveActivityEnd(timing.start, timing.end))}${timing.end ? '' : ' · 默认30分钟'}${noticeTimePassed(timing, now) ? ' · 已结束' : ''}`;
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

/** All saved arrangements, including work sessions and cancelled history. */
export function taskArrangements(snapshot: Pick<Snapshot, 'blocks'>, taskId: string): Block[] {
  return snapshot.blocks
    .filter(block => block.taskId === taskId)
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** Prefer the next active arrangement; ended unfinished sessions remain editable. */
export function nextTaskArrangement(blocks: Block[], now: number): Block | undefined {
  const active = blocks.filter(block => !block.cancelled);
  return active.find(block => !block.completed && !noticeTimePassed(block, now))
    ?? active.filter(block => !block.completed).at(-1)
    ?? active.at(-1);
}

export function taskArrangementSummary(blocks: Block[], now = Date.now()): string {
  const onlyEvents = blocks.every(block => block.kind === 'event');
  const next = nextTaskArrangement(blocks, now);
  if (!next) return blocks.length ? `${onlyEvents ? '活动' : '安排'}已全部取消 · 历史记录保留` : '';
  const remaining = blocks.filter(block => !block.cancelled && !block.completed && !noticeTimePassed(block, now)).length;
  return `${onlyEvents ? '已加入日历' : '已安排'} · ${eventTimeLabel(next)}${onlyEvents ? '' : ` · ${next.kind === 'work' ? '执行时段' : '固定活动'}`}${next.completed ? ' · 本次已完成' : ''}${blocks.length > 1 && remaining > 0 ? ` · 剩余${remaining}次` : ''}`;
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
