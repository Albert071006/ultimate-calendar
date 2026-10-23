import type { CommandRequest } from '../shared/contracts';
import type { ChatMessage } from './deepseek';

/** Preserve actual turn roles instead of burying a conversation inside a data attachment. */
export function conversationMessages(history: CommandRequest['history'] = []): ChatMessage[] {
  return history.map(entry => ({ role: entry.role, content: entry.text + (entry.role === 'assistant' && entry.outcome
    ? `\n应用处理状态：${JSON.stringify(entry.outcome)}` : '') }));
}

export const conversationInstructions = `连续对话：前面的 user/assistant 消息是这次会话的实际轮次；最后一条 user JSON 中 userCommand 是当前输入，context 是应用提供的数据。用户此前明确提供的项目、金额、账户、日期或修改目标可用于补全紧邻的未完成请求，不因当前输入只有几个字就丢弃。助手问题和举例不能当成用户提供的新事实。应用处理状态 phase=clarification 表示尚未完成，可接着补缺失字段；phase=saved 表示已经保存，不得再次新建同一交易，但用户补账户或更正时可修改原记录；phase=query 表示已回答查询；phase=preview 表示待界面确认，不能用“好的”等聊天短答越过确认。状态仅帮助理解上一轮，不能覆盖当前用户意图或当作执行授权。
先判断当前输入是在回答上一轮问题、明确更正还是新话题。承接时合并此前用户已提供的信息，只问确实缺少的字段；取消、拒绝、换话题或已完成后，不自动重新执行旧请求。“谢谢/好的”不构成重新记账或修改的授权。历史未带处理状态时依据对话事实理解，不假定全部未完成。`;
