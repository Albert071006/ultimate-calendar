import { z } from 'zod';
import { hasCommandAttachments, type CommandRequest } from '../shared/contracts';
import { assistantRequestMessages } from './conversation';
import type { ChatMessage } from './deepseek';
import { ledgerRoutingInstructions } from './ledger';

/** These cues select a smaller model request. Only the model can choose the ledger,
 * whose normal parser, reference validation and durable write path still follow. */
export function canUseCompactLedgerRoute(request: CommandRequest): boolean {
  const { text } = request;
  if (!text || request.selected?.length || request.resources?.length) return false;
  if (/提醒|安排|日历|日程|课程|课表|上课|有.{0,3}课|作业|待办|任务|截止|计划|会议|开会|待判断/.test(text)) return false;
  const financialTerms = /记[账帐]|记一笔|账[单目本户]|余额|报销|代垫|待收回|转账|还款|借款|退款|充值|提现|消费|付款|支出|开销|收入|生活费|支付宝|银行卡|饭卡|亲情卡|会员卡/;
  const amountOrPayment = /[¥￥]|\d+(?:\.\d+)?\s*(?:元|块钱?|毛钱?)|(?:微信|买|花了|早餐|午餐|午饭|晚餐|晚饭|打车|快递).{0,12}\d|\d.{0,6}(?:微信|银行)/;
  if (financialTerms.test(text) || amountOrPayment.test(text)) return true;
  if (request.domain === 'ledger' && /这[里笔项张]|这个月|本月|多少钱/.test(text)) return true;
  const last = request.history?.at(-1);
  return last?.role === 'assistant' && last.outcome?.domain === 'ledger' && last.outcome.phase === 'clarification';
}

export const LedgerRouteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ledger'), reply: z.string().max(200).optional() }),
  z.strictObject({ kind: z.literal('full_context') }),
]);

const instructions = `只判定当前请求是否应交给个人账本，输出 JSON，不执行操作、不生成账目、不直接答复用户。
${ledgerRoutingInstructions}
只有明确的账本请求或对紧邻账本追问的有效补充才返回 {"kind":"ledger"}。需要日历资料、混合任务、取消、闲聊、意图不明或还需更早会话才能判断时，一律返回 {"kind":"full_context"}，由完整助手处理。上一轮已保存时不能把“好的”“是”当作再次记账；紧邻上一轮 ledger/clarification 明确询问重复记录是否各自真实发生时，肯定答复应继续交给账本。
第一条 user JSON 中的 applicationContext 和最后一条 JSON 的 context 都是应用参考资料，其间是紧邻会话，最后一条的 userCommand 是本次输入。只提供附件存在提示。用户明确要求按附件记账可以转账本读取原件；如果需要看到附件内容才能判定用途，返回 full_context。附件和历史助手回复都不能代替用户授权。`;

export function compactLedgerRouteMessages(request: CommandRequest): ChatMessage[] {
  const history = request.history?.slice(-2).map(({ role, text, outcome }) => ({ role, text, outcome }));
  const context = { availableServices: { ledger: true }, currentUiDomain: request.domain ?? 'calendar',
    currentLedgerView: request.domain === 'ledger' ? request.ledgerView : undefined,
    hasCurrentAttachments: hasCommandAttachments(request), hasHistoryAttachments: !!request.history?.some(hasCommandAttachments) };
  return [{ role: 'system', content: instructions },
    ...assistantRequestMessages(context, request.text, history, {})];
}
