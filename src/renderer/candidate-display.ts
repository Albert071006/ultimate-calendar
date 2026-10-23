import type { Candidate, Settings } from '../shared/contracts';

const temporal = /\d{1,2}[:：]\d{2}|\d{1,2}月\d{1,2}[日号]|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|[一二两三四五六七八九十\d]+[点时](?:半|\d{1,2}分?)?|(?:周|星期)[一二三四五六日天]|(?:活动|举办|开始|结束|截止|报名|提交|签到)(?:时间|日期)|截止|DDL|今天|明天|后天|上午|下午|晚上/i;

/** Presentation only. Old extractions keep their original fields and all wording remains available. */
export function candidateDisplay(candidate: Candidate, profile?: Pick<Settings, 'campus'>) {
  const timeNotes: string[] = [];
  const conditions: string[] = [];
  for (const condition of candidate.conditions) {
    for (const clause of condition.split(/[；;\n]/).map(text => text.trim()).filter(Boolean)) {
      if (temporal.test(clause)) timeNotes.push(clause);
      else conditions.push(clause);
    }
  }
  for (const evidence of candidate.temporalEvidence) {
    if (!candidate[evidence.field] || evidence.basis === 'unknown') timeNotes.push(evidence.quote);
  }
  const uncertainties = candidate.uncertainties.filter(text => {
    const alternatives = /\d+\s*(?:或(?:者)?|和|及|[/／、])\s*\d+|(?:[东西南北]区|[\u4e00-\u9fffA-Za-z0-9]{1,12}(?:校区|楼|馆|园|室|房))\s*(?:或(?:者)?|[/／、])\s*(?:[东西南北]区|[\u4e00-\u9fffA-Za-z0-9]{1,12}(?:校区|楼|馆|园|室|房))/.test(text);
    const locationOnly = /校区|地点|位置|地址|房间/.test(text)
      && /未说明|未明确|未注明|未提供|不明确|不确定|需(?:要)?(?:确认|核实|核对)|待确认|具体/.test(text)
      && !/冲突|不一致|矛盾|多个|两处|多处|两个|跨校区|另一校区|其他校区/.test(text)
      && !alternatives
      && !temporal.test(text) && !/日期|年份|时长|具体钟点|时间/.test(text);
    if (profile?.campus && candidate.location && locationOnly) return false;
    if (!temporal.test(text) && !/日期|年份|时长|具体钟点|时间/.test(text)) return true;
    timeNotes.push(text); return false;
  });
  return { conditions, timeNotes: [...new Set(timeNotes)], uncertainties };
}
