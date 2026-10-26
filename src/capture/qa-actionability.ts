import type { CaptureEntry } from './candidate-batch';
import type { RecipientAudience } from './recipients';

export interface QuestionEvidence {
  id: string;
  text: string;
  attachmentId: string | null;
  imageDataUrl?: string | null;
  recipient?: { audience: RecipientAudience; sender: 'self' | 'other' | 'unknown' };
}

const clarificationAction = /^(?:(?:向|找|联系).{1,24}?)?(?:确认|核实|询问|咨询|了解|弄清|查明|问清)/;
const informationQuestion = /[?？]|(?:请问|想问|是否|是不是|有没有|能不能|可不可以|多少|几分|几秒|几点|多久|什么|怎么|如何|哪[个些里种]|为啥|啥意思)|(?:吗|么|嘛)(?:[，,。！？!?\s]|还是|$)/;
// A question mark does not make a request passive. Preserve solicitations, personal address,
// announcements and new obligations, even when they happen inside a question/answer exchange.
const actionOrAddress = /请(?!问|教)|麻烦|帮忙|帮我|帮一下|代我|替我|劳驾|拜托|务必|必须|记得|别忘|不要忘|需要(?:大家|你|您|各位|所有)|要求(?:大家|你|您|各位|所有)|大家|全体|所有人|各位|同学们|你|您|咱们|我们|谁能|哪位|有没有人|有人(?:能|可以|愿意)|通知|公告|提醒|更正|调整|改为|改到|推迟|延期|取消|补交|补报|重新提交|上交|集合|签到|报到|截止|最晚|之前|前提交/;
const dateOrClock = /\d{4}[-/.年]\d|\d{1,2}月\d{1,2}|\d{1,2}[:：]\d{2}|(?:今天|明天|后天|今晚|明晚|本周|下周|周[一二三四五六日天]|星期[一二三四五六日天])|(?:上午|下午|晚上|中午).{0,6}[点时]/;
const acknowledgement = /^(?:可以|不可以|能|不能|行|不行|对|是|不是|有|没有|没|会|不会|好|嗯|谢谢|收到|了解|明白)(?:的|啊|呀|哈|哦|噢|呢|啦|了|嗯|好|谢谢)*$/;

function passiveReply(text: string): boolean {
  const compact = text.replace(/[\s，,。.!！~～]/g, '');
  if (acknowledgement.test(compact)) return true;
  // Conditional eligibility/reward explanations, not an imperative to carry out that condition.
  // Keep this deliberately narrow: an unrecognized reply is retained for semantic extraction.
  return /(?:参加|参与|通过|成功|完成|符合|只要|只有).{0,50}(?:就|才)(?:有|算|能|可以|行|可|给)/.test(text)
    || /(?:时长|长度|人数|数量|积分|学分|加分|得分).{0,25}(?:是|为|不超过|不少于|最多|至少|需要).{1,30}/.test(text);
}

/**
 * A narrow fallback for invented "confirm the rules" to-dos from other members' plain Q&A.
 * The model still decides general actionability. This must not suppress real requests merely
 * because they use a question, nor alter entries/receipts or infer that the user joined an event.
 */
export function shouldSuppressPassiveQuestion(entry: CaptureEntry, evidence: readonly QuestionEvidence[]): boolean {
  const item = entry.candidate;
  if (!['new', 'uncertain'].includes(item.relation.kind) || item.relation.candidateId
    || item.deadline || item.eventStart || item.eventEnd || item.location.trim()
    || ![item.title.trim(), item.action.trim()].some(value => clarificationAction.test(value))) return false;
  if (item.sourceIds.length !== 1) return false;
  const references = [{ sourceId: item.sourceIds[0]!, quote: item.sourceQuote }, ...entry.supportingSources];
  const byId = new Map(evidence.map(unit => [unit.id, unit]));
  const units = references.map(reference => byId.get(reference.sourceId));
  if (!units.length || new Set(references.map(reference => reference.sourceId)).size !== references.length) return false;
  for (const [index, unit] of units.entries()) {
    if (!unit || unit.attachmentId || unit.imageDataUrl || unit.recipient?.sender !== 'other'
      || unit.recipient.audience !== 'unspecified' || !unit.text.includes(references[index]!.quote)) return false;
  }
  const texts = units.map(unit => unit!.text.trim());
  if (texts.some(text => !text || text.length > 600 || actionOrAddress.test(text) || dateOrClock.test(text))) return false;
  if (!texts.some(text => informationQuestion.test(text))) return false;
  return texts.every(text => informationQuestion.test(text) || passiveReply(text));
}
