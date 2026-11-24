import { mondayWeekday, type Candidate, type Source, type Snapshot } from "../../../shared/contracts";
import { dayDistance } from "../../../domain/time";
import { candidateDates } from '../../../domain/candidate-dates';
import { candidateWithRecoveredTiming } from '../../../domain/temporal-evidence';

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];

/** Hide the ordinary-body chunk locator, retaining useful file/page locations. */
export function displaySourceLabel(label: string): string {
  return label.replace(/\s*·\s*消息正文\s+\d+\s*$/, '').trim();
}

export interface InboxNotice {
  candidate: Candidate;
  source: Source | undefined;
  arrivedAt: string;
  arrivalTime: number;
  creationTime: number;
  activityDay: string | null;
}

/** Project only the sources linked to each notice; sorting and row rendering share these keys. */
export function indexInbox(snapshot: Pick<Snapshot, 'sources' | 'candidates'>) {
  const sources = new Map(snapshot.sources.map(source => [source.id, source]));
  const notices = new Map<string, InboxNotice>();
  const merged = new Map<string, number>();
  for (const saved of snapshot.candidates) {
    const linked = saved.sourceIds.map(id => sources.get(id)).filter((source): source is Source => !!source);
    const candidate = candidateWithRecoveredTiming(saved, linked);
    const dates = !candidate.eventStart && candidate.temporalEvidence.some(e => e.field === 'eventStart')
      ? candidateDates(candidate, linked).eventStart : undefined;
    const source = linked[0], arrivedAt = source?.sentAt ?? source?.importedAt ?? candidate.createdAt;
    notices.set(candidate.id, { candidate, source, arrivedAt, creationTime: Date.parse(candidate.createdAt),
      arrivalTime: Date.parse(arrivedAt), activityDay: dates && dates.length === 1 ? dates[0]! : null });
    if (candidate.duplicateOfId) merged.set(candidate.duplicateOfId, (merged.get(candidate.duplicateOfId) ?? 0) + 1);
  }
  return { sources, notices, merged };
}

export function sourceLine({ source, arrivedAt }: InboxNotice, today: string, missingLabel = '原文已删除') {
  if (!source) return { label: missingLabel, at: "" };
  return { label: displaySourceLabel(source.label) || (source.kind === "image" ? "截图" : "粘贴的消息"), at: arrival(arrivedAt, today) };
}

/** 今天 / 明天 / 昨天 / 周五 (later this week) / 10月27日. */
export function dayWord(date: string, today: string): string {
  const diff = dayDistance(today, date);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  if (diff > 1 && diff < 7 && mondayWeekday(date) > mondayWeekday(today)) return `周${weekdays[mondayWeekday(date) - 1]}`;
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
}

/** 10月23日 周五 */
export function fullDay(date: string): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日 周${weekdays[mondayWeekday(date) - 1]}`;
}

/** When a message arrived: a clock time today, otherwise a day word. */
export function arrival(instant: string, today: string): string {
  return instant.slice(0, 10) === today ? instant.slice(11, 16) : dayWord(instant.slice(0, 10), today);
}
