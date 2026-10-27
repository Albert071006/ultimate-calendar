import { useEffect, useRef, type FormEvent } from 'react';
import { ArrowUp, X } from 'lucide-react';
import type { CommandRequest } from '../../shared/contracts';
import type { PlannerUI } from '../hooks/usePlanner';
import type { Selection } from '../components/Calendar';
import { canContinueUnsent, useAssistantConversation, type ConversationEntry, type UnsentClarificationDraft } from '../components/shell/assistant-conversation';
import { AssistantImageButton, AssistantImageDraft, AssistantMessageImage } from '../components/shell/assistant-image-input';
import type { RemoteClientState } from '../remote/types';

const KEEP_ENTRIES = 20, KEEP_MS = 24 * 3600_000;

/** The last day's conversation, kept only on this phone. A reply still pending when the page closed is not resent. */
function load(key: string | undefined): { entries: ConversationEntry[]; draft?: UnsentClarificationDraft } {
  if (!key) return { entries: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { savedAt: number; entries: ConversationEntry[]; draft?: UnsentClarificationDraft } | null;
    if (!saved || Date.now() - saved.savedAt > KEEP_MS || !Array.isArray(saved.entries)) return { entries: [] };
    const entries = saved.entries.map(({ image, request: _request, ...entry }) => ({
      ...entry,
      ...(image ? { imageUnavailable: true } : {}),
      ...(entry.status === 'pending' ? { text: '页面关闭前没有收到结果。请先在日历或账单核对，再决定要不要重发。', status: 'failed' as const, delivery: 'unknown' as const } : {}),
    }));
    const draft = saved.draft;
    const validDraft = draft && typeof draft.text === 'string' && draft.text.length <= 10_000
      && entries.at(-1)?.id === draft.replyId && entries.at(-1)?.status === 'failed' && entries.at(-1)?.delivery === 'not-sent'
      && entries.findLast(entry => entry.role === 'assistant' && !entry.status)?.outcome?.phase === 'clarification';
    return { entries, ...(validDraft ? { draft } : {}) };
  } catch { return { entries: [] }; }
}
function save(key: string | undefined, entries: ConversationEntry[], draft?: UnsentClarificationDraft) {
  if (!key) return;
  try {
    if (!entries.length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), ...(draft ? { draft } : {}), entries: entries.slice(-KEEP_ENTRIES).map(({ request: _request, image, ...entry }) => ({
      ...entry, ...(image ? { imageUnavailable: true } : {}),
    })) }));
  } catch { /* Storage may be unavailable in private browsing; the conversation then lasts for this page only. */ }
}

/**
 * The phone assistant: one resident entry line above the tabs, and a full-screen conversation with a close button.
 * The page stays mounted (transparent) while closed so the entry tap can focus the composer in the same
 * gesture, which is what lets iOS raise the keyboard at once.
 */
export function MobileAssistant({ ui, selected, date, domain, ledgerView, storageKey, open, setOpen, connectionStatus }: {
  ui: PlannerUI; selected: Selection | null; date: string; domain?: 'ledger'; ledgerView?: CommandRequest['ledgerView'];
  storageKey?: string; open: boolean; setOpen: (open: boolean) => void;
  connectionStatus?: RemoteClientState['status'];
}) {
  const initial = load(storageKey);
  const conversation = useAssistantConversation({ ui, selected, date, domain, ledgerView, initial: initial.entries, initialDraft: initial.draft });
  const { text, setText, history, running, send, retry, image, imageReading, imageError, selectImage, readImageFile, pasteImage, removeImage, unsentDraft, continueUnsent } = conversation;
  const input = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const configured = ui.snapshot?.keyStatus.configured !== false;
  useEffect(() => save(storageKey, history, unsentDraft), [storageKey, history, unsentDraft?.replyId, unsentDraft?.text]);
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
  const connectionMessage = connectionStatus === 'connecting' ? '正在连接资料服务…'
    : connectionStatus === 'offline' || connectionStatus === 'error' ? '连接中断，发送前会尝试重新连接'
    : connectionStatus === 'expired' || connectionStatus === 'unpaired' ? '设备授权待核对，请先恢复资料服务连接' : '';
  const latest = history.at(-1);
  const errorInConversation = latest?.status === 'failed' && !!ui.error && latest.text.includes(ui.error);

  return <>
    <button className="m-assist-entry" onClick={() => { input.current?.focus({ preventScroll: true }); setOpen(true); }}>
      <span className="m-spark" aria-hidden="true">✧</span>
      <span>{configured ? '问问生活助手' : '生活助手 · 未填 Key'}</span>
    </button>
    <div ref={layer} className={`m-assistant${open ? ' open' : ''}`} role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-label="生活助手" aria-hidden={!open || undefined}>
      <header className="m-assistant-head">
        <div><h2>生活助手</h2>{connectionMessage ? <small role="status">{connectionMessage}</small>
          : (running || selected) && <small>{running ? '正在处理…' : '已带上选中的事项'}</small>}</div>
        <button className="m-icon" onClick={close} aria-label="关闭生活助手" tabIndex={open ? 0 : -1}><X aria-hidden="true" /></button>
      </header>
      <div className="m-assistant-thread" ref={thread} aria-live="polite">
        {history.length ? history.map(entry => (
          <div key={entry.id} className={`m-msg ${entry.role}${entry.status ? ` ${entry.status}` : ''}`} aria-busy={entry.status === 'pending'}>
            <AssistantMessageImage image={entry.image} unavailable={entry.imageUnavailable} />
            <p>{entry.text}</p>
            {entry.resources?.map(resource => resource.kind === 'web'
              ? <a key={resource.id} href={resource.url} target="_blank" rel="noopener noreferrer">{resource.name}</a>
              : <small key={resource.id}>{resource.name} · 需在电脑打开</small>)}
            {entry.status === 'failed' && entry.request && <button className="m-link" disabled={running || imageReading || ui.busy} onClick={() => retry(entry)}>重试这条指令</button>}
            {entry.id === latest?.id && canContinueUnsent(entry) && <button className="m-link" disabled={running || imageReading || ui.busy}
              onClick={() => { continueUnsent(entry); input.current?.focus(); }}>继续补充</button>}
          </div>
        )) : <div className="m-assistant-intro">
          {configured ? <>
            <p>说一句就行，比如：</p>
            <ul><li>明天下午有空吗</li><li>周五晚上留两小时写报告</li><li>午饭 20 元，支付宝</li></ul>
            <p className="m-hint">不确定的操作会先问你，批量修改会先给你预览。</p>
          </> : <p>云端还没有配置 DeepSeek API Key，助手暂时不能回答。</p>}
        </div>}
      </div>
      {open && ui.error && !errorInConversation && <p className="m-assistant-error" role="alert">{ui.error}</p>}
      {unsentDraft && <p className="m-hint m-assistant-draft-hint" role="status">这条补充尚未发送，可在输入框继续补充后发送。</p>}
      <AssistantImageDraft image={image} reading={imageReading} error={imageError} remove={removeImage} disabled={running || ui.busy} tabIndex={open ? 0 : -1} />
      <form className="m-assistant-compose" onSubmit={submit}>
        <AssistantImageButton selectImage={selectImage} readImageFile={readImageFile} disabled={!open || running || imageReading || ui.busy} mobile tabIndex={open ? 0 : -1} />
        <textarea ref={input} rows={1} value={text} aria-label="对生活助手说" placeholder="说一句话…" enterKeyHint="send" tabIndex={open ? 0 : -1}
          onChange={event => setText(event.target.value)}
          onPaste={pasteImage}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
          }} />
        <button type="submit" className="m-send" disabled={running || imageReading || ui.busy || (!text.trim() && !image)} aria-label="发送" tabIndex={open ? 0 : -1}><ArrowUp aria-hidden="true" /></button>
      </form>
    </div>
  </>;
}
