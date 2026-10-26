import type { CaptureEntry } from './candidate-batch';

/** Only a document's own original text establishes its subject; a filename alone never does. */
export interface PracticeUnit {
  id: string; messageId: string; accountId: string; groupId: string; attachmentId: string | null;
  locator: string; text: string;
}

export interface PracticeGroup {
  rootEntryId: string;
  title: string;
  summary: string;
  step: string;
}
export interface PracticeClassification extends Omit<PracticeGroup, 'rootEntryId'> { scopeKey: string }

const exerciseMarker = /(?:练习(?:题|\s*[一二三四五六七八九十\d]+)?|习题|思考(?:题)?|课堂作业|课后作业)/g;
const learningContext = /教材|课件|例题|课堂|课后|教学|学习目标|知识点|解题|示例代码|测试代码|编程|算法|定理|证明/;
const exerciseInstruction = /(?:练习(?:题|\s*[一二三四五六七八九十\d]+)?|习题|思考(?:题)?|作业)[\s\S]{0,400}(?:完成|编写|测试|求|计算|实现|修改|增加|验证|证明|回答|解答|课件|教材|例\s*\d)/;
const separateSubmission = /单独(?:提交|上交|交付|验收)|分别(?:提交|上交|交付|验收)|各自(?:提交|上交)|独立(?:提交|考核|验收)|另(?:行|外)(?:提交|上交)|(?:第一次|第二次|第三次|第[一二三四五六七八九十\d]+次)作业/;
const otherPurpose = /报名|领奖|认领|开会|会议|讲座|竞赛|比赛|招聘|值班|签到|交费|缴费|报销|申请|投票/;
const scopedAudience = /(?:第?[一二三四五六七八九十\d]+组|[A-Za-z甲乙丙丁]组|教师|老师|助教|组长|负责人|班长).{0,12}(?:完成|提交|检查|负责|练习)|(?:仅限|只限|限于|仅面向)/;
const explicitUnmappedDate = /\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}|明天|后天|本周|下周|周[一二三四五六日天]/;

const documentKey = (unit: PracticeUnit) => JSON.stringify([unit.accountId, unit.groupId, unit.messageId, unit.attachmentId]);

function subject(text: string): string | null {
  const lines = text.slice(0, 2000).split(/[\r\n]+/).map(line => line.trim()).filter(Boolean).slice(0, 24);
  const heading = (line: string) => line.replace(/^(?:第[一二三四五六七八九十百\d]+[章节]|\d+(?:[.．]\d+){0,3}[、.．\s])\s*/, '')
    .replace(/^(?:主题|本章|本节|学习内容)[：:]\s*/, '').trim();
  const valid = (line: string) => line.length >= 2 && line.length <= 28 && /[\u3400-\u9fff]/.test(line)
    && !/[。！？；：:={}<>\/\\]/.test(line) && !/\.(?:docx?|pdf|pptx?)$/i.test(line)
    && !/^(?:练习|思考|作业|习题|例\s*\d|例如|注意|要求|输入|输出|解答|答案|目录|学习目标|教学目标|请|需|通过|掌握|了解|理解|能够|能)/.test(line)
    && !/完成|提交|上交|截止/.test(line);
  for (const line of lines) {
    if (!/^(?:第[一二三四五六七八九十百\d]+[章节]|\d+(?:[.．]\d+){0,3}[、.．\s]|主题[：:]|本章[：:]|本节[：:]|学习内容[：:])/.test(line)) continue;
    const value = heading(line); if (valid(value)) return value;
  }
  // The first short line is often the chapter heading. Never search arbitrary later prose for a title.
  const first = lines[0]; return first && valid(first) ? first : null;
}

function teachingDocument(units: PracticeUnit[]) {
  if (!units.length || !units[0]!.attachmentId || !/\.(?:docx?|pdf|pptx?)(?:\s|·|$)/i.test(units[0]!.locator)) return null;
  const text = units.map(unit => unit.text).join('\n');
  if (!learningContext.test(text) || [...text.matchAll(exerciseMarker)].length < 2) return null;
  // A bundle of assignments with separate submission obligations must remain separate.
  if (separateSubmission.test(text)) return null;
  return { subject: subject(text) };
}

/**
 * A new checkpoint may group ordinary exercises from one teaching document, even when separate model
 * responses call each exercise "new". Original entries and evidence are never changed: the caller
 * opts into this policy, resolves stable root aliases, and protects live user decisions/edited fields.
 */
export function createPracticeClassifier(units: PracticeUnit[]): (entry: CaptureEntry) => PracticeClassification | null {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const documents = new Map<string, PracticeUnit[]>();
  for (const unit of units) if (unit.attachmentId) {
    const key = documentKey(unit), members = documents.get(key) ?? []; members.push(unit); documents.set(key, members);
  }
  const subjects = new Map([...documents].flatMap(([key, members]) => {
    const document = teachingDocument(members); return document ? [[key, document] as const] : [];
  }));
  return entry => {
    const item = entry.candidate, unit = byId.get(item.sourceIds[0] ?? '');
    if (!unit?.attachmentId || item.sourceIds.length !== 1) return null;
    const key = documentKey(unit), document = subjects.get(key);
    if (!document || !exerciseInstruction.test(item.sourceQuote) || !unit.text.includes(item.sourceQuote)) return null;
    if (otherPurpose.test(item.title + item.action + item.sourceQuote)
      || separateSubmission.test([item.sourceQuote, item.action, ...item.conditions].join('\n'))) return null;
    if (scopedAudience.test([item.sourceQuote, item.action, ...item.conditions].join('\n'))) return null;
    // A source from a different document/message can change the assignment's recipient or purpose.
    if (entry.supportingSources.some(source => !byId.has(source.sourceId) || documentKey(byId.get(source.sourceId)!) !== key)) return null;
    // Do not erase unresolved time/place distinctions by treating all null normalized times as equal.
    if (item.temporalEvidence.some(evidence => evidence.basis === 'unknown') || item.uncertainties.some(value =>
      /接收|对象/.test(value) || /截止|日期|时间|地点|提交/.test(value) && !/未(?:明确|提供|提及|说明|注明|指定|给出)|没有(?:注明|说明|提供|给出)/.test(value))) return null;
    if (!item.deadline && !item.eventStart && explicitUnmappedDate.test(item.sourceQuote + item.action)) return null;
    const timing = JSON.stringify([item.deadline, item.eventStart, item.eventEnd, item.location.trim()]);
    const topic = document.subject;
    return { scopeKey: JSON.stringify([key, timing]), title: topic ? `完成${topic}练习` : '完成本次文档练习',
      summary: topic ? `完成${topic}相关练习。` : '完成本次文档中的练习。', step: item.action.trim() || item.sourceQuote.trim() };
  };
}

/** Classifies source content only; deciding whether an explicit live relation may merge stays with the caller. */
export function classifyPracticeEntry(entry: CaptureEntry, units: PracticeUnit[]): PracticeClassification | null {
  return createPracticeClassifier(units)(entry);
}

export function practiceGrouping(entries: CaptureEntry[], units: PracticeUnit[]): Map<string, PracticeGroup> {
  const classify = createPracticeClassifier(units), roots = new Map<string, string>(), result = new Map<string, PracticeGroup>();
  for (const entry of entries) {
    const item = entry.candidate, classification = classify(entry);
    if (!classification) continue;
    const group = classification.scopeKey;
    let rootEntryId = roots.get(group);
    if (item.relation.kind === 'new' && !item.relation.candidateId) {
      rootEntryId ??= entry.id; roots.set(group, rootEntryId);
    } else if ((item.relation.kind === 'supplement' || item.relation.kind === 'duplicate') && item.relation.candidateId) {
      // Only follow an earlier entry in this same grouping pass; never infer a relation to an existing task.
      const earlier = result.get(item.relation.candidateId);
      if (!rootEntryId || earlier?.rootEntryId !== rootEntryId) continue;
    } else continue;
    if (!rootEntryId) continue;
    const { scopeKey: _scopeKey, ...description } = classification;
    result.set(entry.id, { rootEntryId, ...description });
  }
  return result;
}
