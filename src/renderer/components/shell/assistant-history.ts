import type { ConversationEntry } from './assistant-conversation';

/** Never make a stale question look pending by silently removing an intervening failure. */
export function assistantRequestHistory(history: ConversationEntry[], editingReplyId?: string): ConversationEntry[] {
  let start = 0;
  for (let index = 0; index < history.length; index++) {
    const entry = history[index]!;
    if (entry.role !== 'assistant' || !entry.status) continue;
    const editingUnsent = index === history.length - 1 && entry.id === editingReplyId && entry.status === 'failed' && entry.delivery === 'not-sent';
    if (!editingUnsent) start = index + 1;
  }
  return history.slice(start).flatMap((entry, index, tail) => {
    const reply = tail[index + 1];
    return entry.role === 'user' && reply?.role === 'assistant' && !reply.status ? [entry, reply] : [];
  }).slice(-20);
}
