import { mondayWeekday, type Candidate, type Snapshot } from "../../../shared/contracts";
import { dayDistance } from "../../../domain/time";

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];

/** Use the same available source for the visible date and chronological ordering. */
export function noticeSource(snapshot: Snapshot, candidate: Candidate) {
  return candidate.sourceIds.map(id => snapshot.sources.find(source => source.id === id)).find(Boolean);
}

export function noticeArrival(snapshot: Snapshot, candidate: Candidate): string {
  const source = noticeSource(snapshot, candidate);
  return source?.sentAt ?? source?.importedAt ?? candidate.createdAt;
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
