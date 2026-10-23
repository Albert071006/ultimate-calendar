import type { Candidate } from '../shared/contracts';

export type CandidateExpiry = { expired: boolean; basis: 'deadline' | 'eventEnd' | 'eventStartDay' | 'availability' | null; reason: string | null };
export type CandidateDisposition = Candidate['status'] | 'snoozed' | 'expired';
const current = (): CandidateExpiry => ({ expired: false, basis: null, reason: null });

function statedNewDeadline(candidate: Candidate): boolean {
  const deadline = candidate.deadline;
  if (!deadline) return false;
  const [year, month, day] = deadline.date.split('-').map(Number) as [number, number, number];
  const datePattern = `(?:${deadline.date}|${year}[/.]0?${month}[/.]0?${day}(?!\\d)|(?:${year}年)?0?${month}月0?${day}[日号])`;
  const newEnd = new RegExp(`(?:延期|延长|补交|补报|补报名)(?:期限)?(?:至|到)\\s*${datePattern}`);
  const chinese = (number: number) => number < 10 ? '零一二三四五六七八九'[number]! : `${number >= 20 ? '零一二三四五六七八九'[Math.floor(number / 10)] : ''}十${number % 10 ? '零一二三四五六七八九'[number % 10] : ''}`;
  return [candidate.sourceQuote, ...candidate.temporalEvidence.filter(e => e.field === 'deadline' && e.basis !== 'unknown').map(e => e.quote)].some(quote => {
    if (/预计|可能|左右|待定|暂定/.test(quote)) return false;
    const match = newEnd.exec(quote);
    if (!match) return false;
    if (!deadline.time) return true;
    const [hour, minute] = deadline.time.split(':').map(Number) as [number, number];
    const afterDate = quote.slice(match.index + match[0].length).split(/[。；;\n，,]/)[0]!;
    const numeric = new RegExp(`^\\s*(?:上午|下午|晚上|中午|早上)?\\s*0?${hour}[:：]${String(minute).padStart(2, '0')}(?!\\d)`);
    const periods = hour >= 13 ? '(?:下午|晚上|傍晚)' : hour < 12 ? '(?:上午|早上|凌晨)' : '(?:中午)';
    const clockHour = hour > 12 ? hour - 12 : hour;
    const minutes = minute === 0 ? '(?:整)?' : minute === 30 ? '(?:半|三十(?:分)?)' : `(?:${minute}|${chinese(minute)})(?:分)?`;
    const words = new RegExp(`^\\s*(?:${periods}\\s*(?:${clockHour}|${chinese(clockHour)})|${hour > 12 ? `${hour}|${chinese(hour)}` : '(?!)'})[点时]${minutes}(?!半|刻|[零〇一二两三四五六七八九十\\d])`);
    return numeric.test(afterDate) || words.test(afterDate);
  });
}

function uncertain(candidate: Candidate, field: 'deadline' | 'eventStart' | 'eventEnd'): boolean {
  if (candidate.temporalEvidence.some(item => item.field === field && item.basis === 'unknown')) return true;
  const terms = field === 'deadline' ? /截止|DDL|报名日期|报名时间/i : field === 'eventEnd' ? /结束|散场/ : /开始|举办|活动日期|活动时间/;
  return candidate.uncertainties.some(text => {
    if (!/不确定|未明确|未确定|待定|待确认|需(?:要)?(?:确认|核对|校对)|有歧义|存在歧义|可能有误/.test(text)) return false;
    if (terms.test(text)) return true;
    return /年份|年月日|日期|时间/.test(text) && !/截止|DDL|报名|结束|散场|开始|举办|活动日期|活动时间|时长|钟点/i.test(text);
  });
}

/** Derived classification only: never changes a user's decision or generates feedback. */
export function candidateExpiry(candidate: Candidate, now: number | string = Date.now()): CandidateExpiry {
  const ms = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(ms)) return current();
  const today = new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
  const wording = [candidate.title, candidate.action, candidate.sourceQuote].join(' ');
  const positiveWording = wording.replace(/不(?:再)?(?:允许|可(?:以)?)补(?:交|报)|不能补(?:交|报)|禁止补(?:交|报)|不会(?:再|重新)?开放|未(?:再|重新)?开放|不(?:再)?(?:延期|延长)/g, '');
  const reopened = /(?:仍(?:然)?可|还可)(?:以)?(?:报名|提交|补交|补报|参加|申请)|可(?:以)?(?:在[^，。；\n]{0,30})?补(?:交|报)|允许补(?:交|报)|重新开放|延期(?:至|到)|延长(?:至|到)|已(?:延期|延长)|补报名|补交渠道/.test(positiveWording);
  const deadline = candidate.deadline;
  const deadlineEnd = deadline ? Date.parse(`${deadline.date}T${deadline.time ?? '00:00'}:00+08:00`) + (deadline.time ? 0 : 86_400_000) : null;
  const oldTime = deadlineEnd !== null && (deadline?.time ? ms > deadlineEnd : ms >= deadlineEnd)
    || !!candidate.eventEnd && ms >= Date.parse(candidate.eventEnd)
    || !!candidate.eventStart && candidate.eventStart.slice(0, 10) < today;
  if (reopened && oldTime && !statedNewDeadline(candidate)) return { expired: false, basis: null, reason: '原文说明仍可补办、补交或已延期，先保留待判断；已有时间可能是旧截止，请校对新的可办理时间' };
  if (!reopened && /已过期|已截止|已结束|已关闭/.test(candidate.title) && /不会再(?:开放|受理)|不再(?:开放|接受|受理)|已(?:截止|结束|关闭)|无法(?:补交|报名)/.test(candidate.sourceQuote)) {
    return { expired: true, basis: 'availability', reason: '事项已明确标注过期或关闭，原文也说明已结束或不再开放；未发现可补交或重新开放的说明' };
  }
  if (deadline && !uncertain(candidate, 'deadline')) {
    const end = deadlineEnd!;
    if (deadline.time ? ms > end : ms >= end) return { expired: true, basis: 'deadline', reason: deadline.time ? `明确截止时间 ${deadline.date} ${deadline.time} 已过（北京时间）` : `截止日期 ${deadline.date} 已结束（按北京时间当天结束计算）` };
  }
  if (candidate.eventEnd && !uncertain(candidate, 'eventEnd') && !uncertain(candidate, 'eventStart') && ms >= Date.parse(candidate.eventEnd)) {
    return { expired: true, basis: 'eventEnd', reason: `明确活动结束时间 ${candidate.eventEnd.slice(0, 16).replace('T', ' ')} 已过（北京时间）` };
  }
  if (!candidate.eventEnd && candidate.eventStart && !uncertain(candidate, 'eventStart')) {
    // A later submission deadline or evidence of an ongoing/multiday activity makes start alone insufficient.
    const ongoing = /持续|多日|跨天|跨日|连续\s*[一二两三四五六七八九十\d]+\s*天|长期|为期|结束(?:时间)?(?:不确定|待定|待确认)/.test([candidate.action, candidate.sourceQuote, ...candidate.uncertainties].join(' '));
    if (!deadline && !ongoing && candidate.eventStart.slice(0, 10) < today) {
      return { expired: true, basis: 'eventStartDay', reason: `活动开始日期 ${candidate.eventStart.slice(0, 10)} 已早于今天；原文未提供结束时间，按已过日期活动归档，可校对后恢复` };
    }
  }
  return current();
}

export function candidateDisposition(candidate: Candidate, now: number | string = Date.now()): CandidateDisposition {
  if (candidate.status !== 'pending') return candidate.status;
  if (candidateExpiry(candidate, now).expired) return 'expired';
  const ms = typeof now === 'number' ? now : Date.parse(now);
  return candidate.snoozedUntil && Date.parse(candidate.snoozedUntil) > ms ? 'snoozed' : 'pending';
}

export const isPendingCandidate = (candidate: Candidate, now: number | string = Date.now()) => candidateDisposition(candidate, now) === 'pending';
