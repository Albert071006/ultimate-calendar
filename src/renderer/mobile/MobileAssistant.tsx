import { useEffect, useRef, type FormEvent } from 'react';
import { ArrowUp, X } from 'lucide-react';
import type { CommandRequest } from '../../shared/contracts';
import type { PlannerUI } from '../hooks/usePlanner';
import type { Selection } from '../components/Calendar';
import { useAssistantConversation, type ConversationEntry } from '../components/shell/assistant-conversation';

const KEEP_ENTRIES = 20, KEEP_MS = 24 * 3600_000;

/** The last day's conversation, kept only on this phone. A reply still pending when the page closed is not resent. */
function load(key: string | undefined): ConversationEntry[] {
  if (!key) return [];
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { savedAt: number; entries: ConversationEntry[] } | null;
    if (!saved || Date.now() - saved.savedAt > KEEP_MS || !Array.isArray(saved.entries)) return [];
    return saved.entries.map(entry => entry.status === 'pending'
      ? { id: entry.id, role: entry.role, text: '页面关闭前没有收到结果。请先在日历或账单核对，再决定要不要重发。', status: 'failed' }
      : entry);
  } catch { return []; }
}
function save(key: string | undefined, entries: ConversationEntry[]) {
  if (!key) return;
  try {
    if (!entries.length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), entries: entries.slice(-KEEP_ENTRIES).map(({ request: _request, ...entry }) => entry) }));
  } catch { /* Storage may be unavailable in private browsing; the conversation then lasts for this page only. */ }
}

/**
 * The phone assistant: one entry line above the tabs, and a full-screen conversation with a close button.
 * The page stays mounted (transparent) while closed so the entry tap can focus the composer in the same
 * gesture, which is what lets iOS raise the keyboard at once.
 */
export function MobileAssistant({ ui, selected, date, domain, ledgerView, storageKey, open, setOpen }: {
  ui: PlannerUI; selected: Selection | null; date: string; domain?: 'ledger'; ledgerView?: CommandRequest['ledgerView'];
  storageKey?: string; open: boolean; setOpen: (open: boolean) => void;
}) {
  const conversation = useAssistantConversation({ ui, selected, date, domain, ledgerView, initial: load(storageKey) });
  const { text, setText, history, running, send, retry } = conversation;
  const input = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const configured = ui.snapshot?.keyStatus.configured !== false;
  useEffect(() => save(storageKey, history), [storageKey, history]);
  useEffect(() => { if (thread.current) thread.current.scrollTop = thread.current.scrollHeight; }, [history, open]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) === layer.current) { event.preventDefault(); setOpen(false); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open, setOpen]);
  const submit = (event: FormEvent) => { event.preventDefault(); send(); input.current?.focus(); };
  const close = () => { input.current?.blur(); setOpen(false); };

  return <>
    <button className="m-assist-entry" onClick={() => { input.current?.focus({ preventScroll: true }); setOpen(true); }}>
      <span className="m-spark" aria-hidden="true">✧</span>
      <span>{configured ? '问问生活助手，或调整安排' : '生活助手 · 云端未配置 API Key'}</span>
    </button>
    <div ref={layer} className={`m-assistant${open ? ' open' : ''}`} role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-label="生活助手" aria-hidden={!open || undefined}>
      <header className="m-assistant-head">
        <div><h2>生活助手</h2>{(running || selected) && <small>{running ? '正在处理…' : '已带上选中的事项'}</small>}</div>
        <button className="m-icon" onClick={close} aria-label="关闭生活助手" tabIndex={open ? 0 : -1}><X aria-hidden="true" /></button>
      </header>
      <div className="m-assistant-thread" ref={thread} aria-live="polite">
        {history.length ? history.map(entry => (
          <div key={entry.id} className={`m-msg ${entry.role}${entry.status ? ` ${entry.status}` : ''}`} aria-busy={entry.status === 'pending'}>
            <p>{entry.text}</p>
            {entry.status === 'failed' && entry.request && <button className="m-link" disabled={running || ui.busy} onClick={() => retry(entry)}>重试这条指令</button>}
          </div>
        )) : <div className="m-assistant-intro">
          {configured ? <>
            <p>说一句就行，比如：</p>
            <ul><li>明天下午有空吗</li><li>周五晚上留两小时写报告</li><li>午饭 20 元，支付宝</li></ul>
            <p className="m-hint">不确定的操作会先问你，批量修改会先给你预览。</p>
          </> : <p>云端还没有配置 DeepSeek API Key，助手暂时不能回答。</p>}
        </div>}
      </div>
      {open && ui.error && <p className="m-assistant-error" role="alert">{ui.error}</p>}
      <form className="m-assistant-compose" onSubmit={submit}>
        <textarea ref={input} rows={1} value={text} aria-label="对生活助手说" placeholder="说一句话…" enterKeyHint="send" tabIndex={open ? 0 : -1}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
          }} />
        <button type="submit" className="m-send" disabled={running || ui.busy || !text.trim()} aria-label="发送" tabIndex={open ? 0 : -1}><ArrowUp aria-hidden="true" /></button>
      </form>
    </div>
  </>;
}
