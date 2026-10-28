import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ChevronUp, MessageSquare, Paperclip } from "lucide-react";
import type { CommandRequest } from "../../../shared/contracts";
import type { PlannerUI } from "../../hooks/usePlanner";
import type { Selection } from "../Calendar";
import { assistantRetryLabel, canContinueUnsent, canReanalyze, useAssistantConversation } from "./assistant-conversation";
import { ResourceFields } from '../resources/ResourcePanel';
import { AssistantImageButton, AssistantImageDraft, AssistantMessageImage } from './assistant-image-input';

/** One-line assistant at the bottom of every page; its conversation opens upward over the page. */
export function Assistant({ ui, selected, date, domain, ledgerView }: {
  ui: PlannerUI;
  selected: Selection | null;
  date: string;
  domain?: 'ledger';
  ledgerView?: CommandRequest['ledgerView'];
}) {
  const [expanded, setExpanded] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const { text, setText, history, running, send, retry, resources, setResources, unsentDraft, continueUnsent,
    image, imageReading, imageError, selectImage, readImageFile, pasteImage, removeImage } = useAssistantConversation({ ui, selected, date, domain, ledgerView, onStart: () => setExpanded(true) });
  const conversation = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (conversation.current)
      conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [history, expanded]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setExpanded(true);
        input.current?.focus();
      } else if (event.key === "Escape" && root.current?.contains(document.activeElement)) {
        setExpanded(false);
        input.current?.blur();
      }
    };
    const outside = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setExpanded(false);
    };
    window.addEventListener("keydown", key);
    document.addEventListener("mousedown", outside);
    return () => { window.removeEventListener("keydown", key); document.removeEventListener("mousedown", outside); };
  }, []);

  return (
    <section ref={root} className={`a2-assist${expanded ? " open" : ""}`} aria-label="生活助手">
      {expanded && (
        <div className="a2-assist-panel ui-overlay">
          <div className="a2-assist-head">
            <strong>生活助手</strong>
            <span className="ui-hint">{running ? "正在处理…" : selected ? "已携带选中事项" : "Esc 收起"}</span>
          </div>
          <div className="conversation" aria-live="polite" ref={conversation}>
            {history.length ? (
              history.map((entry) => (
                <div className={`message ${entry.role}`} key={entry.id} aria-busy={entry.status === "pending"}>
                  <small>{entry.role === "user" ? "你" : "助手"}</small>
                  <AssistantMessageImage image={entry.image} unavailable={entry.imageUnavailable} />
                  {entry.text}
                  {!ui.host?.resourceOpen && entry.resources?.filter(resource => resource.kind === 'web').map(resource =>
                    resource.kind === 'web' && <a key={resource.id} href={resource.url} target="_blank" rel="noopener noreferrer">{resource.name}</a>)}
                  {entry.status === "failed" && entry.request && <>
                    {" "}<button className="ui-btn sm" disabled={running || imageReading || ui.busy} onClick={() => retry(entry)}>{assistantRetryLabel(entry)}</button>
                    {canReanalyze(entry) && <small className="ui-hint">会再次请求 AI，并使用 API 额度。</small>}
                  </>}
                  {entry.id === history.at(-1)?.id && canContinueUnsent(entry) && <button className="ui-btn sm" disabled={running || imageReading || ui.busy}
                    onClick={() => { continueUnsent(entry); input.current?.focus(); }}>继续补充</button>}
                </div>
              ))
            ) : (
              <p className="ui-hint">例如"明天下午有空吗""午饭 20 元，支付宝""这个月花了多少"。不明确的操作会继续询问，批量变更先预览。</p>
            )}
          </div>
          {(showResources || resources.length > 0) && <div className="a2-assist-resources"><ResourceFields title="待关联资料" value={resources} onChange={setResources} host={ui.host} disabled={running || ui.busy} /></div>}
        </div>
      )}
      {unsentDraft && <p className="ui-hint" role="status">这条补充尚未发送，可在输入框继续补充后发送。</p>}
      <AssistantImageDraft image={image} reading={imageReading} error={imageError} remove={removeImage} disabled={running || ui.busy} />
      <form className="a2-assist-bar" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <MessageSquare aria-hidden="true" />
        <textarea
          ref={input}
          aria-label="自然语言指令"
          rows={1}
          value={text}
          onFocus={() => setExpanded(true)}
          onChange={(e) => setText(e.target.value)}
          onPaste={pasteImage}
          placeholder="说一句就行：周五晚上留两小时写报告"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
        />
        <span className="ui-kbd" aria-hidden="true">Ctrl K</span>
        <AssistantImageButton selectImage={selectImage} readImageFile={readImageFile} disabled={running || imageReading || ui.busy} />
        <button type="button" className="ui-btn ghost icon" aria-label="选择指令中的资料" title="关联文件、文件夹或网页" onClick={() => { setExpanded(true); setShowResources(value => !value); }}>
          <Paperclip aria-hidden="true" />
        </button>
        <button type="button" className="ui-btn ghost icon" aria-label={expanded ? "收起对话" : "展开对话"} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
        </button>
        <button type="submit" className="ui-btn primary icon" disabled={running || imageReading || ui.busy || (!text.trim() && !image)} aria-label="发送指令" title={running ? "处理中…" : "发送"}>
          <ArrowRight aria-hidden="true" />
        </button>
      </form>
    </section>
  );
}
