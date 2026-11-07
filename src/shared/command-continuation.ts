import type { CommandRequest } from './contracts';

type Request = Pick<CommandRequest, 'text' | 'history' | 'image' | 'images' | 'documents' | 'resources' | 'selected'>;
type History = NonNullable<CommandRequest['history']>;
const newTopic = /^(?:换(?:个|一个)?(?:话题|问题)|另一个(?:问题|话题)|另一件事|另外[，,\s]*(?:记|问|查|说|安排|提醒)|重新问|取消|算了|不用了|不记了|先不|停止)/;

/** Retain every user answer in the current unfinished chain, never a completed action. */
export function pendingClarificationHistory(request: Pick<CommandRequest, 'text' | 'history'>): History {
  const history = request.history ?? [];
  if (newTopic.test(request.text.trim())) return [];
  let start = history.length;
  for (let index = history.length - 1; index >= 1; index -= 2) {
    const question = history[index], user = history[index - 1];
    if (question?.role !== 'assistant' || question.outcome?.phase !== 'clarification' || user?.role !== 'user') break;
    start = index - 1;
    // A new explicit subject may itself need clarification; older requests no longer belong to it.
    if (newTopic.test(user.text.trim())) break;
  }
  return history.slice(start);
}

/** Account grounding uses user facts from the whole pending chain, never assistant suggestions. */
export function pendingUserEvidence(request: Pick<CommandRequest, 'text' | 'history'>): string {
  return [...pendingClarificationHistory(request).filter(turn => turn.role === 'user').map(turn => turn.text), request.text].join('\n');
}

/** This selects the ledger parser only; it does not create or confirm a mutation. */
export function isLedgerClarificationAnswer(request: Request): boolean {
  if (request.image || request.images?.length || request.documents?.length || request.resources?.length || request.selected?.length) return false;
  const history = pendingClarificationHistory(request), last = history.at(-1);
  if (last?.outcome?.domain !== 'ledger') return false;
  const text = request.text.trim().replace(/[。.!！]$/, '').trim();
  if (!text || text.length > 80) return false;
  if (/提醒|安排|日历|日程|课表|上课|课程|任务|会议|开会|待办|截止|计划|取消|撤销|改成|改为|不是|不对|不要/.test(text)) return false;
  if (/^(?:是|是的|对|对的|没错|确认|确定|可以|就是这个|都是不同笔|确实是另一笔|确认重复仍记|是，?单独新建)$/.test(text)) return true;
  if (/^(?:选(?:择)?\s*)?(?:第\s*)?[1-5一二两三四五]\s*(?:个|项|种|条)$/.test(text)) return true;
  const amount = '(?:[¥￥]\\s*)?\\d+(?:\\.\\d{1,2})?\\s*(?:元|块钱?|毛钱?)?';
  const account = '(?:支付宝(?:余额)?|微信(?:余额|零钱)?|饭卡|校园卡|亲情卡|现金|银行卡|储蓄卡|(?:[\\p{Script=Han}]{2,12}银行|中行|招行|工行|农行|建行|交行|邮储)(?:卡|账户|余额)?(?:尾号\\s*\\d{2,6})?)';
  if (new RegExp(`^(?:一共|总共|金额(?:是)?|实际(?:支付)?|实付|是)?\\s*${amount}$`, 'u').test(text)) return true;
  if (new RegExp(`^(?:用|从|到|打到|收到|付到)?\\s*${account}$`, 'u').test(text)) return true;
  return new RegExp(`^(?:${amount}[，,\\s]*${account}|${account}[，,\\s]*${amount})$`, 'u').test(text);
}
