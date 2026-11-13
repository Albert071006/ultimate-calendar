import { useLayoutEffect, useRef, type RefObject, type UIEvent } from 'react';
import type { ConversationEntry } from './assistant-conversation';

/** Follow sends, show a long answer from its beginning, and leave an older reading position alone. */
export function useAssistantScroll(threadRef: RefObject<HTMLDivElement | null>, history: ConversationEntry[], open: boolean) {
  const position = useRef(0), followLatest = useRef(true), initialized = useRef(false);
  const latestUser = useRef<string | undefined>(undefined), previousReply = useRef<ConversationEntry | undefined>(undefined);
  const unseenReply = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const userId = history.findLast(entry => entry.role === 'user')?.id;
    const sent = userId !== latestUser.current; latestUser.current = userId;
    const reply = history.findLast(entry => entry.role === 'assistant');
    const received = reply?.id === previousReply.current?.id && previousReply.current?.status === 'pending' && reply?.status !== 'pending';
    if (received) unseenReply.current = reply?.id;
    previousReply.current = reply;
    const thread = threadRef.current;
    if (!open || !thread) return;
    if (sent || followLatest.current) {
      const latestMessage = Array.from(thread.querySelectorAll<HTMLElement>('[data-assistant-entry]')).at(-1);
      const bounds = latestMessage?.getBoundingClientRect();
      if (!sent && (unseenReply.current === reply?.id || !initialized.current) && bounds && thread.clientHeight > 0 && bounds.height > thread.clientHeight) {
        const top = bounds.top - thread.getBoundingClientRect().top + thread.scrollTop;
        thread.scrollTop = Math.max(0, Math.min(top, thread.scrollHeight - thread.clientHeight));
        followLatest.current = false;
      } else {
        thread.scrollTop = thread.scrollHeight;
        followLatest.current = true;
      }
    } else thread.scrollTop = position.current;
    position.current = thread.scrollTop;
    initialized.current = true;
    unseenReply.current = undefined;
  }, [history, open, threadRef]);

  return (event: UIEvent<HTMLDivElement>) => {
    const thread = event.currentTarget;
    position.current = thread.scrollTop;
    followLatest.current = thread.scrollHeight - thread.clientHeight - thread.scrollTop < 32;
  };
}
