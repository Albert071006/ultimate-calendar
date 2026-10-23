import { addCalendarDays, isRealDate, mondayWeekday, type CandidateInput, type Source } from '../shared/contracts';

function relativeDate(quote: string, sentAt: string): string | null {
  const base = sentAt.slice(0, 10);
  // These phrases do not identify an exact calendar day, even with sentAt.
  if (/明后天|(?:大后天|后天|明天|今天|昨天|(?:周|星期)[一二三四五六日天])(?:之?[前后]|左右)/.test(quote)) return null;
  const dates = new Set<string>();
  const offsets: Record<string, number> = { 大后天: 3, 后天: 2, 明天: 1, 今天: 0, 昨天: -1 };
  const days = /(?<![今明昨后大])(大后天|后天|明天|今天|昨天)/g;
  const weeks = /(?<![上下本这])(本|这|下)?(?:周|星期)([一二三四五六日天])/g;
  // A recognized token cannot justify ignoring another temporal expression.
  // Conservatively retain such mixed evidence for review, regardless of its
  // conjunction (or/and/list punctuation); this is a bounded date resolver.
  const remainder = quote.replace(days, ' ').replace(weeks, ' ');
  if (/(?:[零〇一二两三四五六七八九十百几数\d]+(?:个)?(?:天|日|周|星期|礼拜|月|年)|[上下本这]+(?:个)?(?:周|星期|礼拜|月)|(?:周|星期|礼拜)[一二三四五六日天末]|[今明昨前后大]+天|[今明去后]年|近期|最近|稍后|随后|以后|之前|之后|改天|改日|择日|日后|月底|月末|月初|年初|年底)/.test(remainder)) return null;
  for (const match of quote.matchAll(days)) dates.add(addCalendarDays(base, offsets[match[1]!]!));
  for (const match of quote.matchAll(weeks)) {
    const weekday = '一二三四五六日'.indexOf(match[2] === '天' ? '日' : match[2]!) + 1;
    // A bare weekday earlier than the sending day might mean last/next week.
    if (!match[1] && weekday < mondayWeekday(base)) return null;
    dates.add(addCalendarDays(base, weekday - mondayWeekday(base) + (match[1] === '下' ? 7 : 0)));
  }
  return dates.size === 1 ? [...dates][0]! : null;
}
function smallNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes('十')) { const [tens, ones] = value.split('十'); return (tens ? digits[tens] ?? NaN : 1) * 10 + (ones ? digits[ones] ?? NaN : 0); }
  return digits[value] ?? NaN;
}
export function evidenceTimes(quote: string, requireUnambiguousPeriod = false): string[] {
  const times = new Set<string>(); let period = '';
  const clocks = /(?:(凌晨|早晨|上午|早上|下午|晚上|傍晚|中午))?\s*([零〇一二两三四五六七八九十\d]{1,3})(?:[:：](\d{2})|[点时](?:(半|一刻|三刻)|([零〇一二两三四五六七八九十\d]{1,3})分?)?)/g;
  for (const match of quote.matchAll(clocks)) {
    if (match[1]) period = match[1];
    let hour = smallNumber(match[2]!);
    if (requireUnambiguousPeriod && !period && !match[3] && hour >= 1 && hour <= 12) continue;
    if (['下午', '晚上', '傍晚'].includes(period) && hour < 12) hour += 12;
    if (period === '中午' && hour >= 1 && hour <= 2) hour += 12;
    if (period === '凌晨' && hour === 12) hour = 0;
    if (period === '晚上' && hour === 12) continue; // Midnight may belong to the following date.
    const minute = match[3] ? Number(match[3]) : match[4] === '半' ? 30 : match[4] === '一刻' ? 15 : match[4] === '三刻' ? 45 : match[5] ? smallNumber(match[5]) : 0;
    if (Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isInteger(minute) && minute >= 0 && minute < 60) times.add(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }
  return [...times];
}

/** Bounded grounding in the message's own sending date; never uses import time. */
export function evidenceDate(quote: string, sentAt: string | null): string | null {
  const exact = new Set<string>();
  const fullDates = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|号)?/g;
  for (const m of quote.matchAll(fullDates)) {
    const date = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
    if (isRealDate(date)) exact.add(date);
  }
  if (exact.size) return exact.size === 1 && !/\d{1,2}月\d{1,2}(?:日|号)/.test(quote.replace(fullDates, '')) ? [...exact][0]! : null;
  if (!sentAt) return null;
  const partial = [...quote.matchAll(/(?<![\d年/-])(\d{1,2})月(\d{1,2})(?:日|号)/g)];
  if (partial.length) {
    const dates = new Set(partial.map(m => `${sentAt.slice(0, 4)}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`));
    if (dates.size !== 1) return null;
    const date = [...dates][0]!;
    if (!isRealDate(date) || Math.abs(Date.parse(`${date}T00:00:00Z`) - Date.parse(`${sentAt.slice(0, 10)}T00:00:00Z`)) > 183 * 86400_000) return null;
    const weekday = /(?:周|星期)([一二三四五六日天])/.exec(quote);
    if (weekday && mondayWeekday(date) !== '一二三四五六日'.indexOf(weekday[1] === '天' ? '日' : weekday[1]!) + 1) return null;
    return date;
  }
  return relativeDate(quote, sentAt);
}

/** A registration date range has a clear deadline at its right endpoint. */
export function fieldEvidenceDate(quote: string, sentAt: string | null, field: 'deadline' | 'eventStart' | 'eventEnd'): string | null {
  const ranges = [...quote.matchAll(/((?:\d{4}年)?\d{1,2}月\d{1,2}日)\s*(?:—+|–|~|～|至|到|-)\s*((?:\d{4}年)?\d{1,2}月\d{1,2}日)/g)];
  if (field !== 'deadline' || !ranges.length) return evidenceDate(quote, sentAt);
  if (/预计|可能|待定|左右/.test(quote)) return null;
  if (ranges.length !== 1 || /\d{1,2}月\d{1,2}日/.test(quote.replace(ranges[0]![0], ''))) return null;
  const first = evidenceDate(ranges[0]![1]!, sentAt);
  const reference = first && /^\d{4}年/.test(ranges[0]![1]!) ? `${first}T00:00:00+08:00` : sentAt;
  const last = evidenceDate(ranges[0]![2]!, reference);
  return first && last && first <= last ? last : null;
}

/** Repairs only empty structured fields whose saved source evidence resolves uniquely. */
export function recoverCandidateTiming(candidate: Pick<CandidateInput, 'sourceIds' | 'temporalEvidence' | 'deadline' | 'eventStart' | 'eventEnd'>, sources: Source[]): Partial<CandidateInput> {
  const patch: Partial<CandidateInput> = {};
  for (const field of ['deadline', 'eventStart', 'eventEnd'] as const) {
    if (candidate[field]) continue;
    const possibilities = new Map<string, NonNullable<CandidateInput[typeof field]>>();
    for (const e of (candidate.temporalEvidence ?? []).filter(e => e.field === field && e.basis !== 'unknown')) {
      for (const source of sources.filter(s => candidate.sourceIds.includes(s.id) && (s.kind === 'image' || s.text.includes(e.quote)))) {
        const date = fieldEvidenceDate(e.quote, source.sentAt, field); if (!date) continue;
        const times = evidenceTimes(e.quote);
        // “周六五点” does not tell us morning or afternoon. Preserve it for review.
        if (times.length !== evidenceTimes(e.quote, true).length) continue;
        const time = times.length === 1 ? times[0]! : null;
        if (field === 'deadline') {
          if (times.length > 1) continue;
          const value = { date, time }; possibilities.set(JSON.stringify(value), value);
        } else if (time) {
          const value = `${date}T${time}:00+08:00`; possibilities.set(value, value);
        }
      }
    }
    if (possibilities.size === 1) Object.assign(patch, { [field]: [...possibilities.values()][0] });
  }
  const start = patch.eventStart ?? candidate.eventStart, end = patch.eventEnd ?? candidate.eventEnd;
  if (!start || (end && Date.parse(end) <= Date.parse(start))) delete patch.eventEnd;
  return patch;
}
